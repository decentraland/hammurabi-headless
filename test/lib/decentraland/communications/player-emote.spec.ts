// rfc4 `playerEmote` is the only signal a headless server gets that a player emoted, and
// `AvatarEmoteCommand` (component 1088, a GrowOnly value set) is the only way scene code
// can observe it. These tests cover the translation and, importantly, that the appends
// reach EVERY live subscription — a single shared drain queue would let the first
// subscription swallow them.
//
// Frame order matters here and mirrors SceneContext: `system.update()` (which commits the
// LWW stores' dirty state and opens the appends for draining) runs in the update phase,
// `subscription.getUpdates()` in the later lateUpdate phase.

// NOTE: this project's jest transformer (esbuild) does not hoist `jest.mock` above
// imports, so register the mock first and then `require` the modules under test.
jest.mock('../../../../src/lib/misc/network', () => ({
  robustFetch: jest.fn(),
  readBodyCapped: jest.fn(),
  readBodyCappedBytes: jest.fn(),
  drainResponse: jest.fn(),
  DEFAULT_MAX_BODY_BYTES: 10 * 1024 * 1024
}))

const {
  createAvatarCommunicationSystem
} = require('../../../../src/lib/decentraland/communications/avatar-communication-system')
const { playerEntityManager } = require('../../../../src/lib/decentraland/communications/player-entity-manager')
const {
  avatarEmoteCommandComponent
} = require('../../../../src/lib/decentraland/sdk-components/avatar-customizations')
const { playerIdentityDataComponent } = require('../../../../src/lib/decentraland/sdk-components/player-identity-data')
const { createEmoteMetadataResolver } = require('../../../../src/lib/decentraland/communications/emote-metadata')
const { ReadWriteByteBuffer } = require('../../../../src/lib/decentraland/ByteBuffer')
const { readAllMessages } = require('../../../../src/lib/decentraland/crdt-wire-protocol')
const { CrdtMessageType } = require('../../../../src/lib/decentraland/crdt-wire-protocol/types')
const { robustFetch, readBodyCapped } = require('../../../../src/lib/misc/network')
const { limitLogger } = require('../../../../src/lib/misc/limit-logger')
const { limits } = require('../../../../src/lib/misc/limits')

const robustFetchMock = robustFetch as jest.Mock
const readBodyCappedMock = readBodyCapped as jest.Mock

// The production transport's `.events` IS a mitt emitter, so the stub uses the same library.
const mittModule = require('mitt')
const mitt = mittModule.default ?? mittModule

type Subscription = { getUpdates(writer: any): void; dispose(): void }

function pullMessages(subscription: Subscription): any[] {
  const buffer = new ReadWriteByteBuffer()
  subscription.getUpdates(buffer)
  return Array.from(readAllMessages(new ReadWriteByteBuffer(buffer.toBinary()))) as any[]
}

function emoteAppends(subscription: Subscription) {
  return pullMessages(subscription)
    .filter(
      (message) =>
        message.type === CrdtMessageType.APPEND_VALUE &&
        message.componentId === avatarEmoteCommandComponent.componentId
    )
    .map((message) => ({
      entityId: message.entityId,
      value: avatarEmoteCommandComponent.deserialize(new ReadWriteByteBuffer(message.data))
    }))
}

describe('avatar communication system player emotes', () => {
  // A scene emote encodes its loop flag in the urn, so these resolve without any lookup.
  let loopingUrn: string
  let oneShotUrn: string
  let transport: { events: any }
  let system: any
  let subscription: Subscription

  beforeEach(() => {
    loopingUrn = 'urn:decentraland:off-chain:scene-emote:test-scene-QmLoop-true'
    oneShotUrn = 'urn:decentraland:off-chain:scene-emote:test-scene-QmOnce-false'
    // playerEntityManager is a process-global singleton shared by every system.
    playerEntityManager.clear()
    // PEER_CONNECTED synthesizes a profile fetch; resolve it to an empty profile list so
    // it completes without writing avatar components.
    robustFetchMock.mockResolvedValue({ ok: true })
    readBodyCappedMock.mockResolvedValue('[]')
    transport = { events: mitt() }
    // A FRESH resolver per test. The production default is a process-wide singleton, so
    // sharing it here would leak cache/debounce/in-flight state between tests — enough to
    // turn a test of the deferred-lookup path into a silent cache hit.
    system = createAvatarCommunicationSystem(
      transport as any,
      (position: any) => position,
      createEmoteMetadataResolver()
    )
    subscription = system.createSubscription()
  })

  afterEach(() => {
    system.dispose()
    playerEntityManager.clear()
    jest.resetAllMocks()
  })

  describe('when a peer plays an emote', () => {
    let entity: number

    beforeEach(() => {
      transport.events.emit('playerEmote', { address: '0xAAA', data: { urn: loopingUrn, timestamp: 0 } })
      entity = playerEntityManager.getEntityForAddress('0xaaa')
      system.update()
    })

    it('should append one AvatarEmoteCommand for that peer entity', () => {
      expect(emoteAppends(subscription)).toEqual([
        { entityId: entity, value: expect.objectContaining({ emoteUrn: loopingUrn }) }
      ])
    })

    it('should carry the loop flag resolved for the urn', () => {
      expect(emoteAppends(subscription)[0].value.loop).toBe(true)
    })

    it('should stamp a host-side monotonic timestamp rather than anything from the packet', () => {
      expect(emoteAppends(subscription)[0].value.timestamp).toBe(1)
    })

    it('should not re-deliver the append on a later drain', () => {
      emoteAppends(subscription)

      expect(emoteAppends(subscription)).toEqual([])
    })

    describe('and the buffer is inspected as a whole', () => {
      let identityPuts: any[]
      let identityAt: number
      let appendAt: number

      beforeEach(() => {
        const messages = pullMessages(subscription)
        const isIdentityPut = (message: any) =>
          message.type === CrdtMessageType.PUT_COMPONENT &&
          message.componentId === playerIdentityDataComponent.componentId
        identityPuts = messages.filter((message) => isIdentityPut(message) && message.entityId === entity)
        identityAt = messages.findIndex(isIdentityPut)
        appendAt = messages.findIndex((message) => message.type === CrdtMessageType.APPEND_VALUE)
      })

      it('should emit the identity PUT for the entity exactly once', () => {
        expect(identityPuts).toHaveLength(1)
      })

      it('should emit that identity PUT at all, not merely absent from the buffer', () => {
        // Guards the ordering assertion below from `-1 < 0`, which is how the first version
        // of that test managed to prove nothing.
        expect(identityAt).toBeGreaterThanOrEqual(0)
      })

      it('should place it before the append, so the entity exists first', () => {
        expect(identityAt).toBeLessThan(appendAt)
      })
    })
  })

  describe('when an emote arrives after the tick already committed', () => {
    beforeEach(() => {
      system.update()
      transport.events.emit('playerEmote', { address: '0xA1A', data: { urn: loopingUrn, timestamp: 0 } })
    })

    it('should hold the append back rather than deliver it ahead of the entity components', () => {
      expect(emoteAppends(subscription)).toEqual([])
    })

    it('should deliver it on the next tick', () => {
      emoteAppends(subscription)
      system.update()

      expect(emoteAppends(subscription)).toHaveLength(1)
    })
  })

  describe('when a peer plays a non-looping emote', () => {
    beforeEach(() => {
      transport.events.emit('playerEmote', { address: '0xBBB', data: { urn: oneShotUrn, timestamp: 0 } })
      system.update()
    })

    it('should append it with loop cleared', () => {
      expect(emoteAppends(subscription)[0].value.loop).toBe(false)
    })
  })

  describe('when the same emote arrives repeatedly', () => {
    let appends: ReturnType<typeof emoteAppends>

    beforeEach(() => {
      // A held looping emote re-sends once per animation cycle. rfc4 declares an
      // `isRepeating` field for exactly this, but the reference client never SETS it (no
      // writer anywhere in that codebase), so on this wire a repeat is indistinguishable
      // from a fresh play — and that client re-writes the component per intent too.
      transport.events.emit('playerEmote', { address: '0xCCC', data: { urn: loopingUrn, timestamp: 0 } })
      transport.events.emit('playerEmote', { address: '0xCCC', data: { urn: loopingUrn, timestamp: 1 } })
      system.update()
      appends = emoteAppends(subscription)
    })

    it('should append every occurrence', () => {
      expect(appends).toHaveLength(2)
    })

    it('should give them increasing timestamps', () => {
      expect(appends[1].value.timestamp).toBeGreaterThan(appends[0].value.timestamp)
    })
  })

  describe('when one emote needs a metadata lookup and the next does not', () => {
    let resolveFetch: (value: any) => void
    let deferredUrn: string
    let appends: ReturnType<typeof emoteAppends>

    beforeEach(async () => {
      // The catalog urn defers on a lookup, so the scene emote behind it is appended
      // FIRST. The ordering key must stay monotonic in DELIVERY order: the value set sorts
      // by it, so a later append carrying a lower key would sort behind values the scene
      // already consumed and a scene tracking the highest key it processed would never see
      // it. (This costs the true play order for these two, which is the trade the
      // reference client makes too — it stamps at write time.)
      deferredUrn = 'urn:decentraland:matic:collections-v2:0xdeferred:7'
      resolveFetch = () => void 0
      robustFetchMock.mockReturnValueOnce(new Promise((resolve) => (resolveFetch = resolve)))
      readBodyCappedMock.mockResolvedValue(JSON.stringify([{ metadata: { emoteDataADR74: { loop: true } } }]))
      transport.events.emit('playerEmote', { address: '0xC1C', data: { urn: deferredUrn, timestamp: 0 } })
      transport.events.emit('playerEmote', { address: '0xC1C', data: { urn: oneShotUrn, timestamp: 1 } })
      resolveFetch({ ok: true })
      await new Promise((resolve) => setImmediate(resolve))
      system.update()
      appends = emoteAppends(subscription)
    })

    it('should append both emotes', () => {
      expect(appends).toHaveLength(2)
    })

    it('should have genuinely deferred the catalog emote behind its lookup', () => {
      // Guards the test itself: a cached or embedded urn would resolve synchronously and
      // silently stop exercising the deferred path.
      expect(appends[0].value.emoteUrn).toBe(oneShotUrn)
    })

    it('should keep the ordering key monotonic in delivery order', () => {
      expect(appends[1].value.timestamp).toBeGreaterThan(appends[0].value.timestamp)
    })

    it('should still resolve the deferred emote loop flag from its metadata', () => {
      expect(appends[1].value).toEqual({ emoteUrn: deferredUrn, loop: true, timestamp: 2 })
    })
  })

  describe('when the packet stops an emote instead of playing one', () => {
    beforeEach(() => {
      transport.events.emit('playerEmote', {
        address: '0xDDD',
        data: { urn: loopingUrn, isStopping: true, timestamp: 0 }
      })
      system.update()
    })

    it('should append nothing, because the component cannot express a stop', () => {
      expect(emoteAppends(subscription)).toEqual([])
    })
  })

  describe('when the packet carries no urn', () => {
    beforeEach(() => {
      transport.events.emit('playerEmote', { address: '0xEEE', data: { urn: '', timestamp: 0 } })
      system.update()
    })

    it('should append nothing', () => {
      expect(emoteAppends(subscription)).toEqual([])
    })
  })

  describe('when the urn names a property inherited from Object.prototype', () => {
    let appends: ReturnType<typeof emoteAppends>

    beforeEach(async () => {
      // A plain-object loop table would return a FUNCTION for this key instead of
      // undefined. The handler's thenable check would then drop the emote (and, if that
      // check were absent too, it would throw out of the transport emit — aborting every
      // later listener for the packet and logging unthrottled once per packet, a
      // peer-triggerable stderr flood). Either way this test fails on the assertion.
      transport.events.emit('playerEmote', { address: '0xF0F', data: { urn: 'constructor', timestamp: 0 } })
      await new Promise((resolve) => setImmediate(resolve))
      system.update()
      appends = emoteAppends(subscription)
    })

    it('should treat it as an ordinary unknown urn, with a boolean loop flag', () => {
      expect(appends).toEqual([
        { entityId: expect.any(Number), value: { emoteUrn: 'constructor', loop: false, timestamp: 1 } }
      ])
    })
  })

  describe('when the loop resolver returns something that is neither a boolean nor a thenable', () => {
    let laterListenerRan: boolean

    beforeEach(() => {
      // Cannot happen through the typed surface, which is the point: if it ever does, the
      // handler must not call `.then` on it. mitt has no per-handler try/catch, so a throw
      // here aborts the emit and skips every later listener for that packet — on a
      // peer-triggerable path, and logging unthrottled once per packet.
      laterListenerRan = false
      const brokenResolver = { resolveLoop: () => 42 as any, cacheSize: 0, inFlightSize: 0 }
      system.dispose()
      system = createAvatarCommunicationSystem(transport as any, (position: any) => position, brokenResolver as any)
      subscription = system.createSubscription()
      transport.events.on('playerEmote', () => (laterListenerRan = true))
      transport.events.emit('playerEmote', { address: '0xB0B', data: { urn: loopingUrn, timestamp: 0 } })
      system.update()
    })

    it('should append nothing', () => {
      expect(emoteAppends(subscription)).toEqual([])
    })

    it('should leave the rest of the transport dispatch intact', () => {
      expect(laterListenerRan).toBe(true)
    })
  })

  describe('when the urn exceeds the byte cap', () => {
    let hit: jest.SpyInstance

    beforeEach(() => {
      hit = jest.spyOn(limitLogger, 'hit').mockImplementation(() => void 0)
      transport.events.emit('playerEmote', {
        address: '0xFFF',
        data: { urn: 'x'.repeat(limits.maxEmoteUrnBytes + 1), timestamp: 0 }
      })
      system.update()
    })

    afterEach(() => hit.mockRestore())

    it('should append nothing, keeping the peer string out of every scene CRDT', () => {
      expect(emoteAppends(subscription)).toEqual([])
    })

    it('should report the limit hit with the peer for context', () => {
      expect(hit).toHaveBeenCalledWith('maxEmoteUrnBytes', '0xFFF')
    })
  })

  describe('when the urn contains control characters or whitespace', () => {
    let hit: jest.SpyInstance
    let appends: ReturnType<typeof emoteAppends>

    beforeEach(() => {
      // No real emote identifier looks like this — urns, legacy names and the client's
      // embedded ids are single tokens. Rejecting it keeps a crafted string from becoming a
      // registry pointer, a cache key and a log line.
      hit = jest.spyOn(limitLogger, 'hit').mockImplementation(() => void 0)
      transport.events.emit('playerEmote', { address: '0xC0C', data: { urn: 'wave\r\ninjected', timestamp: 0 } })
      transport.events.emit('playerEmote', { address: '0xC0C', data: { urn: 'two words', timestamp: 0 } })
      system.update()
      appends = emoteAppends(subscription)
    })

    afterEach(() => hit.mockRestore())

    it('should append nothing for either', () => {
      expect(appends).toEqual([])
    })

    it('should report the rejection with the peer for context', () => {
      expect(hit).toHaveBeenCalledWith('maxEmoteUrnBytes', expect.stringContaining('malformed urn'))
    })

    it('should not have attempted a metadata lookup for them', () => {
      expect(robustFetchMock).not.toHaveBeenCalled()
    })
  })

  describe('when the urn is within the character count but exceeds the cap in bytes', () => {
    let hit: jest.SpyInstance

    beforeEach(() => {
      // 100 astral-plane emoji: 200 UTF-16 units, 400 UTF-8 bytes. The cap is in bytes,
      // so a length check would wave this through.
      hit = jest.spyOn(limitLogger, 'hit').mockImplementation(() => void 0)
      transport.events.emit('playerEmote', { address: '0xE30', data: { urn: '😀'.repeat(100), timestamp: 0 } })
      system.update()
    })

    afterEach(() => hit.mockRestore())

    it('should append nothing', () => {
      expect(emoteAppends(subscription)).toEqual([])
    })
  })

  describe('when a straggler emote arrives from a peer already known to have departed', () => {
    beforeEach(() => {
      transport.events.emit('PEER_CONNECTED', { address: '0xD1D', sid: 'session-1' })
      transport.events.emit('PEER_DISCONNECTED', { address: '0xD1D', sid: 'session-1' })
      transport.events.emit('playerEmote', { address: '0xD1D', data: { urn: loopingUrn, timestamp: 0 } })
      system.update()
    })

    it('should append nothing, rather than resurrect the peer', () => {
      expect(emoteAppends(subscription)).toEqual([])
    })
  })

  describe('when two subscriptions are live', () => {
    let second: Subscription

    beforeEach(() => {
      second = system.createSubscription()
      transport.events.emit('playerEmote', { address: '0x111', data: { urn: loopingUrn, timestamp: 0 } })
      system.update()
    })

    afterEach(() => second.dispose())

    it('should deliver the append to the first subscription', () => {
      expect(emoteAppends(subscription)).toHaveLength(1)
    })

    it('should deliver the same append to the second subscription even after the first drained', () => {
      emoteAppends(subscription)

      expect(emoteAppends(second)).toHaveLength(1)
    })

    it('should survive a tick in which only the first subscription had drained', () => {
      // The per-tick prune may only drop what EVERY subscription has emitted. Pruning to
      // the newest sequence instead would strand the second scene's append here.
      emoteAppends(subscription)
      system.update()

      expect(emoteAppends(second)).toHaveLength(1)
    })
  })

  describe('when a subscription is created while an undrained append is pending', () => {
    let undrained: Subscription
    let late: Subscription

    beforeEach(() => {
      // The incumbent never drains, so the entry SURVIVES the prune — without it this
      // asserts nothing, because an empty log satisfies any cursor.
      undrained = system.createSubscription()
      transport.events.emit('playerEmote', { address: '0x222', data: { urn: loopingUrn, timestamp: 0 } })
      system.update()
      late = system.createSubscription()
    })

    afterEach(() => {
      undrained.dispose()
      late.dispose()
    })

    it('should not replay the backlog to the latecomer, since emotes are events not state', () => {
      expect(emoteAppends(late)).toEqual([])
    })

    it('should still deliver it to the subscription that was live when it arrived', () => {
      expect(emoteAppends(undrained)).toHaveLength(1)
    })
  })

  describe('when a subscription is created after a push but before the next tick', () => {
    let undrained: Subscription
    let late: Subscription
    let firstDrain: ReturnType<typeof emoteAppends>

    beforeEach(() => {
      // The cursor of a latecomer starts ABOVE the commit watermark here: the emote is
      // pushed but not yet committed. Draining now must not lower that cursor to the
      // watermark, or the next tick hands this subscription a backlog from before it
      // existed. An undrained incumbent keeps the entry alive so the replay is observable.
      undrained = system.createSubscription()
      system.update()
      transport.events.emit('playerEmote', { address: '0x2B2', data: { urn: loopingUrn, timestamp: 0 } })
      late = system.createSubscription()
      firstDrain = emoteAppends(late)
      system.update()
    })

    afterEach(() => {
      undrained.dispose()
      late.dispose()
    })

    it('should deliver nothing to the latecomer on the tick it was created', () => {
      expect(firstDrain).toEqual([])
    })

    it('should not replay the backlog to it on the following tick either', () => {
      expect(emoteAppends(late)).toEqual([])
    })

    it('should still deliver the emote to the subscription that was already live', () => {
      expect(emoteAppends(undrained)).toHaveLength(1)
    })
  })

  describe('when every subscription has drained', () => {
    beforeEach(() => {
      transport.events.emit('playerEmote', { address: '0x2A2', data: { urn: loopingUrn, timestamp: 0 } })
      system.update()
      emoteAppends(subscription)
      system.update()
    })

    it('should reclaim the pending entries rather than retain them for the session', () => {
      expect(system.pendingEmoteAppends()).toBe(0)
    })
  })

  describe('when the peer departs before the append is drained', () => {
    beforeEach(() => {
      transport.events.emit('playerEmote', { address: '0x333', data: { urn: loopingUrn, timestamp: 0 } })
      transport.events.emit('PEER_DISCONNECTED', { address: '0x333' })
      system.update()
    })

    it('should drop the queued append for the retired entity', () => {
      expect(emoteAppends(subscription)).toEqual([])
    })
  })

  describe('when the peer departs while its metadata lookup is still in flight', () => {
    let resolveFetch: (value: any) => void
    let pendingBeforeDeparture: number

    beforeEach(async () => {
      // A catalog urn needs a lookup, so the append is deferred until it settles.
      resolveFetch = () => void 0
      robustFetchMock.mockReturnValueOnce(new Promise((resolve) => (resolveFetch = resolve)))
      readBodyCappedMock.mockResolvedValue(JSON.stringify([{ metadata: { emoteDataADR74: { loop: true } } }]))
      transport.events.emit('playerEmote', {
        address: '0x444',
        data: { urn: 'urn:decentraland:matic:collections-v2:0xlate:1', timestamp: 0 }
      })
      pendingBeforeDeparture = system.pendingEmoteAppends()
      transport.events.emit('PEER_DISCONNECTED', { address: '0x444' })
      resolveFetch({ ok: true })
      await new Promise((resolve) => setImmediate(resolve))
      system.update()
    })

    it('should genuinely have deferred the append behind the lookup', () => {
      // Guards the test itself: had the urn resolved synchronously, the append would exist
      // before the departure and be dropped by the purge instead — leaving the assertion
      // below green while testing nothing about the post-lookup ownership re-check.
      expect(pendingBeforeDeparture).toBe(0)
    })

    it('should not append onto the retired entity id', () => {
      expect(emoteAppends(subscription)).toEqual([])
    })
  })

  describe('when the system has been disposed', () => {
    let appendsAfterDisposal: number

    beforeEach(() => {
      // A retained listener keeps the disposed system's whole closure — append log, LWW
      // stores, entity mirror — alive for the transport's lifetime, once per hot reload.
      // The repo has prior art for exactly this leak on the scene message bus.
      const survivor = system.createSubscription()
      system.dispose()
      transport.events.emit('playerEmote', { address: '0x666', data: { urn: loopingUrn, timestamp: 0 } })
      appendsAfterDisposal = system.pendingEmoteAppends()
      survivor.dispose()
    })

    it('should ignore further emote packets rather than keep handling them', () => {
      expect(appendsAfterDisposal).toBe(0)
    })
  })

  describe('when a subscription stalls while emotes keep arriving', () => {
    let hit: jest.SpyInstance

    beforeEach(() => {
      hit = jest.spyOn(limitLogger, 'hit').mockImplementation(() => void 0)
      for (let i = 0; i < limits.maxEmoteAppendLog + 4; i++) {
        transport.events.emit('playerEmote', { address: '0x555', data: { urn: loopingUrn, timestamp: i } })
      }
      system.update()
    })

    afterEach(() => hit.mockRestore())

    it('should bound the pending appends rather than grow without limit', () => {
      expect(emoteAppends(subscription)).toHaveLength(limits.maxEmoteAppendLog)
    })

    it('should report the limit hit', () => {
      expect(hit).toHaveBeenCalledWith('maxEmoteAppendLog')
    })
  })
})
