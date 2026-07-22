import { storageDelegation } from '../../../../src/lib/decentraland/state'
import {
  parseStorageDelegation,
  getFreshStorageDelegation
} from '../../../../src/lib/decentraland/identity/storage-delegation'

const PREFIX = 'Decentraland Authoritative Storage Delegation'

// Build a base64 wire envelope `{ v, ephemeral, scope }`. The scene-scope fields
// (world/sceneId/parcel/expiration) live INSIDE the signed scope.payload — that is
// the single source of truth the worker parses. Overrides:
//   - world/sceneId/parcel/expiration → tweak the payload (undefined omits the line)
//   - ephemeral / scope / v            → tweak the envelope directly
function encode(over: Record<string, any> = {}): string {
  const ephemeral = 'ephemeral' in over ? over.ephemeral : { privateKey: '0x1', publicKey: '0x2', address: '0xeph' }
  const world = 'world' in over ? over.world : 'boedo.dcl.eth'
  const sceneId = 'sceneId' in over ? over.sceneId : 'bafkrei-scene'
  const parcel = 'parcel' in over ? over.parcel : '5,7'
  const expiration = 'expiration' in over ? over.expiration : Date.now() + 3_600_000

  // number → ISO; anything else (bad string, NaN) → verbatim so we can test rejection.
  const expirationValue =
    expiration === undefined
      ? undefined
      : typeof expiration === 'number' && Number.isFinite(expiration)
        ? new Date(expiration).toISOString()
        : String(expiration)

  const line = (label: string, value: unknown): string | null => (value === undefined ? null : `${label}: ${value}`)
  const payload =
    'payload' in over
      ? over.payload
      : [
          PREFIX,
          line('Ephemeral', ephemeral?.address),
          line('World', world),
          line('SceneId', sceneId),
          line('Parcel', parcel),
          line('Expiration', expirationValue)
        ]
          .filter(Boolean)
          .join('\n')

  const scope = 'scope' in over ? over.scope : { payload, signature: '0xsig' }
  const delegation = { v: 'v' in over ? over.v : 1, ephemeral, scope }
  return Buffer.from(JSON.stringify(delegation), 'utf8').toString('base64')
}

const originalSend = process.send

afterEach(() => {
  process.send = originalSend
  process.removeAllListeners('message')
})

describe('parseStorageDelegation', () => {
  it('parses a well-formed delegation', () => {
    const parsed = parseStorageDelegation(encode())
    expect(parsed?.world).toBe('boedo.dcl.eth')
    expect(parsed?.sceneId).toBe('bafkrei-scene')
    expect(parsed?.parcel).toBe('5,7')
    expect(parsed?.ephemeral.address).toBe('0xeph')
  })

  it('rejects a delegation missing the expiration', () => {
    expect(parseStorageDelegation(encode({ expiration: undefined }))).toBeUndefined()
  })

  it('rejects a delegation missing the sceneId or parcel', () => {
    expect(parseStorageDelegation(encode({ sceneId: undefined }))).toBeUndefined()
    expect(parseStorageDelegation(encode({ parcel: undefined }))).toBeUndefined()
  })

  it('rejects an unparseable Expiration line (would defeat the expiry guard)', () => {
    // The expiry is derived from the signed payload's ISO Expiration line; a value
    // that Date.parse can't read → NaN must be rejected.
    expect(parseStorageDelegation(encode({ expiration: Number.NaN }))).toBeUndefined()
    expect(parseStorageDelegation(encode({ expiration: 'soon' as any }))).toBeUndefined()
  })

  it('rejects non-string ephemeral/scope envelope fields', () => {
    expect(parseStorageDelegation(encode({ ephemeral: { privateKey: 1, publicKey: '0x2', address: '0xeph' } }))).toBeUndefined()
    expect(parseStorageDelegation(encode({ scope: { payload: 'claim', signature: 42 } }))).toBeUndefined()
  })

  it('rejects a claim payload missing the scene-scope fields', () => {
    // Well-formed envelope, but the signed payload has no World/SceneId/Parcel lines.
    expect(parseStorageDelegation(encode({ payload: 'just some text' }))).toBeUndefined()
  })

  it('rejects non-base64 / non-JSON input', () => {
    expect(parseStorageDelegation('not-valid')).toBeUndefined()
  })
})

describe('getFreshStorageDelegation', () => {
  // Runs first, before any swap below sets the singleton atom.
  it('returns null when the worker was never given a delegation (no IPC attempted)', async () => {
    process.send = jest.fn() as any
    await expect(getFreshStorageDelegation()).resolves.toBeNull()
    expect(process.send).not.toHaveBeenCalled()
  })

  it('returns the current delegation without IPC while it is well within its TTL', async () => {
    const current = parseStorageDelegation(encode({ expiration: Date.now() + 3_600_000 }))!
    storageDelegation.swap(current)
    process.send = jest.fn() as any

    const result = await getFreshStorageDelegation()

    expect(result).toBe(current)
    expect(process.send).not.toHaveBeenCalled()
  })

  it('falls back to the current delegation (does not reject) when the IPC channel is closed', async () => {
    const current = parseStorageDelegation(encode({ expiration: Date.now() + 60_000 }))!
    storageDelegation.swap(current)
    process.send = jest.fn(() => {
      throw new Error('ERR_IPC_CHANNEL_CLOSED')
    }) as any

    const result = await getFreshStorageDelegation()

    expect(result).toBe(current)
  })

  it('renews over IPC when the current delegation is near expiry and swaps in the fresh one', async () => {
    storageDelegation.swap(parseStorageDelegation(encode({ expiration: Date.now() + 60_000 }))!)
    const renewedExpiration = Date.now() + 3_600_000
    process.send = jest.fn(() => {
      // Simulate the parent orchestrator replying over IPC.
      setImmediate(() =>
        process.emit('message' as any, {
          type: 'storage-delegation:response',
          delegation: encode({ expiration: renewedExpiration })
        })
      )
      return true
    }) as any

    const result = await getFreshStorageDelegation()

    expect(process.send).toHaveBeenCalledWith({ type: 'storage-delegation:request' })
    expect(result?.expiration).toBe(renewedExpiration)
    expect(storageDelegation.getOrNull()?.expiration).toBe(renewedExpiration)
  })

  it('accepts a same-world renewal with a rotated sceneId/parcel (redeploy) and rebinds', async () => {
    const current = parseStorageDelegation(encode({ expiration: Date.now() + 60_000 }))!
    storageDelegation.swap(current)
    const renewedExpiration = Date.now() + 3_600_000
    process.send = jest.fn(() => {
      setImmediate(() =>
        process.emit('message' as any, {
          type: 'storage-delegation:response',
          delegation: encode({ sceneId: 'bafkrei-redeployed', parcel: '6,8', expiration: renewedExpiration })
        })
      )
      return true
    }) as any

    const result = await getFreshStorageDelegation()

    expect(result?.sceneId).toBe('bafkrei-redeployed')
    expect(storageDelegation.getOrNull()?.sceneId).toBe('bafkrei-redeployed')
    expect(storageDelegation.getOrNull()?.parcel).toBe('6,8')
    expect(storageDelegation.getOrNull()?.expiration).toBe(renewedExpiration)
  })

  it('rejects a renewal reply bound to a different world (does not rebind)', async () => {
    const current = parseStorageDelegation(encode({ expiration: Date.now() + 60_000 }))!
    storageDelegation.swap(current)
    process.send = jest.fn(() => {
      setImmediate(() =>
        process.emit('message' as any, {
          type: 'storage-delegation:response',
          delegation: encode({ world: 'other.dcl.eth', expiration: Date.now() + 3_600_000 })
        })
      )
      return true
    }) as any

    const result = await getFreshStorageDelegation()

    // Falls back to the current (near-expiry) delegation; the atom is NOT rebound.
    expect(result).toBe(current)
    expect(storageDelegation.getOrNull()?.world).toBe('boedo.dcl.eth')
  })
})
