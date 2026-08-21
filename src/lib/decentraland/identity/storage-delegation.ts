import { storageDelegation, StorageDelegation } from '../state'

// IPC message protocol (worker <-> parent orchestrator) for renewing the
// short-lived storage delegation without restarting the worker.
const STORAGE_DELEGATION_REQUEST = 'storage-delegation:request'
const STORAGE_DELEGATION_RESPONSE = 'storage-delegation:response'
// Renew once the delegation is within this window of expiring, so a storage
// request never has to wait for a renewal it could have done earlier.
const REFRESH_BUFFER_MS = 5 * 60 * 1000
// Give up on a renewal round-trip after this long and fall back to the current
// delegation (which the storage strategy will reject if actually expired).
const RENEWAL_TIMEOUT_MS = 5_000

/**
 * Extract the scene-scope fields from the signed claim `payload` — the single
 * source of truth. This is a LENIENT extraction of a parent-produced (trusted)
 * message, not a security check: the authoritative verification of these fields
 * happens in the world-storage-service. Returns undefined if any field is absent
 * or the expiry isn't a finite date.
 */
function extractClaimFields(
  payload: string
): { world: string; sceneId: string; parcel: string; expiration: number } | undefined {
  const lines = payload.split('\n')
  const valueFor = (prefix: string): string | undefined => {
    const line = lines.find((l) => l.startsWith(prefix))
    return line ? line.slice(prefix.length).trim() : undefined
  }
  const world = valueFor('World:')?.toLowerCase()
  const sceneId = valueFor('SceneId:')
  const parcel = valueFor('Parcel:')
  const expirationIso = valueFor('Expiration:')
  if (!world || !sceneId || !parcel || !expirationIso) return undefined
  // Finite, not just parseable: an invalid date → NaN would defeat the expiry
  // guard (Date.now() >= NaN is false → signs forever) and force a renewal on
  // every request (Date.now() < NaN is false).
  const expiration = Date.parse(expirationIso)
  if (!Number.isFinite(expiration)) return undefined
  return { world, sceneId, parcel, expiration }
}

/**
 * Decode and validate a base64 storage delegation. Returns undefined (never
 * throws) on malformed input so a bad delegation can't break scene startup or a
 * renewal — the worker just falls back to the guest identity for storage.
 *
 * The wire envelope is `{ v, ephemeral, scope }`; the scene-scope fields are
 * DERIVED from the signed `scope.payload` (single source of truth), never from a
 * separate unsigned copy.
 */
export function parseStorageDelegation(encoded: string): StorageDelegation | undefined {
  try {
    const json = typeof Buffer !== 'undefined' ? Buffer.from(encoded, 'base64').toString('utf8') : atob(encoded)
    const parsed = JSON.parse(json)
    const validEnvelope =
      parsed &&
      parsed.v === 1 &&
      typeof parsed.ephemeral?.privateKey === 'string' &&
      typeof parsed.ephemeral?.publicKey === 'string' &&
      typeof parsed.ephemeral?.address === 'string' &&
      typeof parsed.scope?.payload === 'string' &&
      typeof parsed.scope?.signature === 'string'
    if (!validEnvelope) {
      console.warn('Ignoring malformed storage delegation')
      return undefined
    }
    const fields = extractClaimFields(parsed.scope.payload)
    if (!fields) {
      console.warn('Ignoring storage delegation with an unparseable claim payload')
      return undefined
    }
    return { v: parsed.v, ephemeral: parsed.ephemeral, scope: parsed.scope, ...fields }
  } catch {
    // Do NOT log the error detail: a JSON parse error can echo a fragment of the
    // decoded payload, which contains the ephemeral private key.
    console.warn('Failed to parse storage delegation')
    return undefined
  }
}

// Single in-flight renewal, so concurrent storage requests near expiry share one
// IPC round-trip instead of each firing their own.
let inFlightRenewal: Promise<StorageDelegation | null> | null = null

function requestRenewal(): Promise<StorageDelegation | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: StorageDelegation | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.off('message', onMessage)
      resolve(result)
    }
    const onMessage = (message: any) => {
      if (!message || message.type !== STORAGE_DELEGATION_RESPONSE) return
      const parsed = typeof message.delegation === 'string' ? parseStorageDelegation(message.delegation) : undefined
      const current = storageDelegation.getOrNull()
      const sameWorld = !current || parsed?.world === current.world
      if (parsed && sameWorld) {
        if (current && (parsed.sceneId !== current.sceneId || parsed.parcel !== current.parcel)) {
          console.log(
            `Storage delegation renewed with rotated scene identity (sceneId ${current.sceneId} -> ${parsed.sceneId}, parcel ${current.parcel} -> ${parsed.parcel})`
          )
        }
        storageDelegation.swap(parsed)
        finish(parsed)
        return
      }
      finish(null)
    }
    const timer = setTimeout(() => finish(null), RENEWAL_TIMEOUT_MS)
    process.on('message', onMessage)
    // process.send exists only when forked with an IPC channel (the production
    // orchestrator path; guarded by the caller). It can still throw
    // ERR_IPC_CHANNEL_CLOSED if the channel closed since — treat that as a failed
    // renewal (→ fall back to the current delegation) rather than rejecting.
    try {
      process.send!({ type: STORAGE_DELEGATION_REQUEST })
    } catch {
      finish(null)
    }
  })
}

/**
 * Return a currently-valid storage delegation, renewing it over IPC when it is
 * missing-soon (within {@link REFRESH_BUFFER_MS} of expiry). Returns null when
 * this worker has no delegation at all (e.g. a Genesis City worker) so callers
 * skip storage-scoped signing entirely.
 */
export async function getFreshStorageDelegation(): Promise<StorageDelegation | null> {
  const current = storageDelegation.getOrNull()
  // Never set → not a world worker with a delegation; don't attempt IPC (avoids a
  // pointless round-trip/timeout on workers that were never given one).
  if (!current) return null
  if (Date.now() < current.expiration - REFRESH_BUFFER_MS) return current
  // No IPC channel (e.g. CLI/dev run) → keep using what we have.
  if (typeof process.send !== 'function') return current

  if (!inFlightRenewal) {
    inFlightRenewal = requestRenewal().finally(() => {
      inFlightRenewal = null
    })
  }
  const renewed = await inFlightRenewal
  // On renewal failure fall back to the current delegation; if it is actually
  // expired the storage signing strategy will reject it (→ guest → 401) and the
  // next request retries the renewal.
  return renewed ?? current
}
