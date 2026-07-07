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
 * Decode and validate a base64 storage delegation. Returns undefined (never
 * throws) on malformed input so a bad delegation can't break scene startup or a
 * renewal — the worker just falls back to the guest identity for storage.
 */
export function parseStorageDelegation(encoded: string): StorageDelegation | undefined {
  try {
    const json = typeof Buffer !== 'undefined' ? Buffer.from(encoded, 'base64').toString('utf8') : atob(encoded)
    const parsed = JSON.parse(json)
    const valid =
      parsed &&
      parsed.v === 1 &&
      typeof parsed.world === 'string' &&
      typeof parsed.sceneId === 'string' &&
      typeof parsed.parcel === 'string' &&
      typeof parsed.ephemeral?.privateKey === 'string' &&
      typeof parsed.ephemeral?.publicKey === 'string' &&
      typeof parsed.ephemeral?.address === 'string' &&
      typeof parsed.scope?.payload === 'string' &&
      typeof parsed.scope?.signature === 'string' &&
      // Finite, not just `typeof number`: NaN/Infinity would defeat the expiry
      // guard (Date.now() >= NaN is false → signs forever) and trigger a renewal
      // on every request (Date.now() < NaN is false).
      Number.isFinite(parsed.expiration)
    if (!valid) {
      console.warn('Ignoring malformed storage delegation')
      return undefined
    }
    return parsed as StorageDelegation
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
      // Defense-in-depth: only accept a renewal that stays bound to the same scene
      // this worker already holds. The parent mints per-child, so a differing
      // world/sceneId/parcel means a confused/misrouted reply — reject it rather
      // than silently rebind to another scene's credential.
      const current = storageDelegation.getOrNull()
      const sameScene =
        !current ||
        (parsed?.world === current.world && parsed?.sceneId === current.sceneId && parsed?.parcel === current.parcel)
      if (parsed && sameScene) {
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
