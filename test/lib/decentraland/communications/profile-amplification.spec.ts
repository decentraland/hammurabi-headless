// NOTE: this project's jest transformer (esbuild) does not hoist `jest.mock`
// above imports, so we register the mock first and then `require` the module
// under test. Type-only imports are erased by esbuild and are safe to keep.

// robustFetch is mocked so no real Catalyst request is made and we can count how
// many outbound profile fetches an untrusted peer's announcements trigger.
jest.mock('../../../../src/lib/misc/network', () => ({ robustFetch: jest.fn() }))

const { robustFetch } = require('../../../../src/lib/misc/network')
const {
  createAvatarCommunicationSystem
} = require('../../../../src/lib/decentraland/communications/avatar-communication-system')
const { playerEntityManager } = require('../../../../src/lib/decentraland/communications/player-entity-manager')
const robustFetchMock = robustFetch as jest.Mock

// The production transport's `.events` IS a mitt emitter (CommsTransportWrapper),
// so the stub uses the same library. mitt itself is not mocked, so requiring it
// after the jest.mock call above is safe. Interop-tolerant: mitt's CJS entry
// exports the function directly, its ESM entry as `default`.
const mittModule = require('mitt')
const mitt = mittModule.default ?? mittModule
const makeEmitter = () => mitt()

describe('avatar profile-fetch amplification guard', () => {
  let system: any
  let transport: any

  beforeEach(() => {
    playerEntityManager.clear()
    robustFetchMock.mockReset()
    // The real profile comes back with a version LOWER than the peer announced,
    // so the announced version is never satisfied by the cache — the exact
    // condition that made the old code refetch on every packet.
    robustFetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ avatars: [{ version: 2, name: 'x' }] }]
    })
    transport = { events: makeEmitter() }
    system = createAvatarCommunicationSystem(transport, (position: any) => position)
  })

  afterEach(() => {
    system.dispose()
  })

  it('fetches at most once even when the announced version is never cacheable', () => {
    transport.events.emit('profileMessage', { address: '0xpeer', data: { profileVersion: 5 } })
    transport.events.emit('profileMessage', { address: '0xpeer', data: { profileVersion: 5 } })
    transport.events.emit('profileMessage', { address: '0xpeer', data: { profileVersion: 3 } })

    // robustFetch is invoked synchronously within emit() (up to its awaited call).
    expect(robustFetchMock).toHaveBeenCalledTimes(1)
  })

  it('rate-limits ever-increasing announced versions within the cooldown window', () => {
    transport.events.emit('profileMessage', { address: '0xpeer', data: { profileVersion: 1 } })
    transport.events.emit('profileMessage', { address: '0xpeer', data: { profileVersion: 2 } })
    transport.events.emit('profileMessage', { address: '0xpeer', data: { profileVersion: 99 } })

    expect(robustFetchMock).toHaveBeenCalledTimes(1)
  })

  it('ignores non-finite announced versions', () => {
    transport.events.emit('profileMessage', { address: '0xpeer', data: { profileVersion: Number.NaN } })
    transport.events.emit('profileMessage', { address: '0xpeer', data: { profileVersion: Infinity } })

    expect(robustFetchMock).not.toHaveBeenCalled()
  })

  it('retries the same version after the cooldown when the first fetch FAILED', async () => {
    let nowVal = 1_000_000
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowVal)
    try {
      robustFetchMock.mockReset()
      robustFetchMock
        .mockRejectedValueOnce(new Error('transient catalyst error'))
        .mockResolvedValue({ ok: true, json: async () => [{ avatars: [{ version: 5 }] }] })

      // First announcement: fetch attempted (and fails).
      transport.events.emit('profileMessage', { address: '0xpeer', data: { profileVersion: 5 } })
      expect(robustFetchMock).toHaveBeenCalledTimes(1)
      await new Promise((r) => setImmediate(r)) // let the failure's catch run

      // Same version again, still within the cooldown → no refetch.
      nowVal += 5_000
      transport.events.emit('profileMessage', { address: '0xpeer', data: { profileVersion: 5 } })
      expect(robustFetchMock).toHaveBeenCalledTimes(1)

      // After the cooldown elapses, the failed fetch is retried (the old code
      // recorded the attempt on failure and never retried).
      nowVal += 6_000
      transport.events.emit('profileMessage', { address: '0xpeer', data: { profileVersion: 5 } })
      expect(robustFetchMock).toHaveBeenCalledTimes(2)
    } finally {
      nowSpy.mockRestore()
    }
  })
})
