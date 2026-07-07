import { storageDelegation } from '../../../../src/lib/decentraland/state'
import {
  parseStorageDelegation,
  getFreshStorageDelegation
} from '../../../../src/lib/decentraland/identity/storage-delegation'

function encode(overrides: Record<string, any> = {}): string {
  const delegation = {
    v: 1,
    world: 'boedo.dcl.eth',
    sceneId: 'bafkrei-scene',
    parcel: '5,7',
    ephemeral: { privateKey: '0x1', publicKey: '0x2', address: '0xeph' },
    scope: { payload: 'claim', signature: '0xsig' },
    expiration: Date.now() + 3_600_000,
    ...overrides
  }
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
})
