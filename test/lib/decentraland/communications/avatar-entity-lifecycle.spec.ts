// Regression tests for the avatar comms entity lifecycle: departed peers must not be
// resurrected by straggler packets, a late disconnect must not purge a live
// reconnected session, one subscription's teardown must not wipe state shared with
// its siblings, and an entity pre-allocated by another system must still receive this
// scene's PlayerIdentityData.

// NOTE: this project's jest transformer (esbuild) does not hoist `jest.mock` above
// imports, so we register the mock first and then `require` the modules under test.
// Type-only imports are erased by esbuild and are safe to keep.

// PEER_CONNECTED synthesizes a profileMessage, which would otherwise reach the real
// Catalyst. The mock resolves an EMPTY profile list so the fetch path completes
// without error and writes no avatar components — these tests observe entity
// lifecycle only.
jest.mock('../../../../src/lib/misc/network', () => ({
  robustFetch: jest.fn(),
  readBodyCapped: jest.fn(),
  readBodyCappedBytes: jest.fn(),
  drainResponse: jest.fn(),
  DEFAULT_MAX_BODY_BYTES: 10 * 1024 * 1024
}))

const {
  createAvatarCommunicationSystem,
  resetAvatarSessionState
} = require('../../../../src/lib/decentraland/communications/avatar-communication-system')
const { playerEntityManager } = require('../../../../src/lib/decentraland/communications/player-entity-manager')
const { playerIdentityDataComponent } = require('../../../../src/lib/decentraland/sdk-components/player-identity-data')
const { ReadWriteByteBuffer } = require('../../../../src/lib/decentraland/ByteBuffer')
const { readAllMessages } = require('../../../../src/lib/decentraland/crdt-wire-protocol')
const { CrdtMessageType } = require('../../../../src/lib/decentraland/crdt-wire-protocol/types')
const { robustFetch, readBodyCapped } = require('../../../../src/lib/misc/network')
const { limitLogger } = require('../../../../src/lib/misc/limit-logger')
const { limits } = require('../../../../src/lib/misc/limits')

const robustFetchMock = robustFetch as jest.Mock
const readBodyCappedMock = readBodyCapped as jest.Mock

// The production transport's `.events` IS a mitt emitter (CommsTransportWrapper), so
// the stub uses the same library instead of a hand-rolled copy of it.
const mittModule = require('mitt')
const mitt = mittModule.default ?? mittModule
const makeEmitter = () => mitt()

function positionData(x: number, y: number, z: number) {
  return { positionX: x, positionY: y, positionZ: z, rotationX: 0, rotationY: 0, rotationZ: 0, rotationW: 1 }
}

function pullMessages(subscription: { getUpdates(writer: any): void }) {
  const buffer = new ReadWriteByteBuffer()
  subscription.getUpdates(buffer)
  return Array.from(readAllMessages(new ReadWriteByteBuffer(buffer.toBinary()))) as any[]
}

function identityPutsFor(subscription: { getUpdates(writer: any): void }, entity: number) {
  return pullMessages(subscription).filter(
    (message) =>
      message.type === CrdtMessageType.PUT_COMPONENT &&
      message.componentId === playerIdentityDataComponent.componentId &&
      message.entityId === entity
  )
}

describe('avatar communication system entity lifecycle', () => {
  let transport: { events: any }
  let system: any

  beforeEach(() => {
    // playerEntityManager is a process-global singleton shared by every system.
    playerEntityManager.clear()
    robustFetchMock.mockResolvedValue({ ok: true })
    readBodyCappedMock.mockResolvedValue('[]')
    transport = { events: makeEmitter() }
    system = createAvatarCommunicationSystem(transport as any, (position: any) => position)
  })

  afterEach(() => {
    system.dispose()
    jest.resetAllMocks()
  })

  describe('when connection churn exceeds the tracked-session bounds', () => {
    let hit: jest.SpyInstance

    beforeEach(() => {
      hit = jest.spyOn(limitLogger, 'hit').mockImplementation(() => void 0)
    })

    afterEach(() => hit.mockRestore())

    it('should evict the oldest tracked address rather than grow without bound', () => {
      // Every connect records an address whether or not that peer ever gets one of the
      // 224 avatar slots, so a comms source churning identities could otherwise grow
      // this for the life of the transport.
      for (let i = 0; i < limits.maxTrackedPeerSessions + 4; i++) {
        transport.events.emit('PEER_CONNECTED', { address: `0xchurn${i}`, sid: `session-${i}` })
      }

      expect(hit).toHaveBeenCalledWith('maxTrackedPeerSessions', expect.any(String))
    })

    it('should bound the sessions tracked for a single address', () => {
      // One address reconnecting with an endless supply of new session ids.
      for (let i = 0; i < limits.maxSessionsPerPeer + 4; i++) {
        transport.events.emit('PEER_CONNECTED', { address: '0xpeer', sid: `session-${i}` })
      }

      expect(hit).toHaveBeenCalledWith('maxSessionsPerPeer', '0xpeer')
    })

    it('should still retire a peer normally after unrelated churn', () => {
      // The peer holds an avatar entity, so eviction must never take ITS record — that
      // is what keeps its retire decision knowable. Asserted through the observable
      // consequence: after enough churn to evict the cap several times over, this peer
      // still retires on its own session's disconnect.
      transport.events.emit('PEER_CONNECTED', { address: '0xpeer', sid: 'session-1' })
      for (let i = 0; i < limits.maxTrackedPeerSessions + 1; i++) {
        transport.events.emit('PEER_CONNECTED', { address: `0xchurn${i}`, sid: `session-${i}` })
      }

      transport.events.emit('PEER_DISCONNECTED', { address: '0xpeer', sid: 'session-1' })

      expect(playerEntityManager.getEntityForAddress('0xpeer')).toBeNull()
    })
  })

  describe('when tracked sessions are churned out from under a live reconnect', () => {
    it('should keep the live entity when the old session’s disconnect finally lands', () => {
      // The reconnect invariant has to survive the cap: a record is only evicted for an
      // address that holds no avatar entity, and a sid-specific disconnect with no record
      // is treated conservatively rather than retiring the address. Without both, churning
      // MAX_TRACKED_PEER_SESSIONS identities between the reconnect and the late disconnect
      // made an active player invisible again.
      transport.events.emit('PEER_CONNECTED', { address: '0xpeer', sid: 'session-old' })
      transport.events.emit('PEER_CONNECTED', { address: '0xpeer', sid: 'session-new' })
      const liveEntity = playerEntityManager.getEntityForAddress('0xpeer')!

      for (let i = 0; i < limits.maxTrackedPeerSessions + 4; i++) {
        transport.events.emit('PEER_CONNECTED', { address: `0xchurn${i}`, sid: `session-${i}` })
      }

      transport.events.emit('PEER_DISCONNECTED', { address: '0xpeer', sid: 'session-old' })

      expect(playerEntityManager.getEntityForAddress('0xpeer')).toEqual(liveEntity)
    })
  })

  describe('when a sid-less connect is followed by a sid-specific disconnect', () => {
    it('should consume the unidentified session and retire the peer', () => {
      // The sid that arrives matches nothing tracked, so it belongs to the session the
      // transport reported without one. Ignoring the disconnect left the entity and its
      // pool slot live until an address-level disconnect happened to arrive.
      transport.events.emit('PEER_CONNECTED', { address: '0xpeer' })
      expect(playerEntityManager.getEntityForAddress('0xpeer')).not.toBeNull()

      transport.events.emit('PEER_DISCONNECTED', { address: '0xpeer', sid: 'session-1' })

      expect(playerEntityManager.getEntityForAddress('0xpeer')).toBeNull()
    })

    it('should still keep a peer whose identified session is the one that ended', () => {
      // A sid that DOES match must not additionally consume an unidentified session:
      // connect(sid) + connect(no sid) then disconnect(sid) leaves the sid-less one live.
      transport.events.emit('PEER_CONNECTED', { address: '0xpeer', sid: 'session-1' })
      const liveEntity = playerEntityManager.getEntityForAddress('0xpeer')!
      transport.events.emit('PEER_CONNECTED', { address: '0xpeer' })

      transport.events.emit('PEER_DISCONNECTED', { address: '0xpeer', sid: 'session-1' })

      expect(playerEntityManager.getEntityForAddress('0xpeer')).toEqual(liveEntity)
    })
  })

  describe('when a transport is reused by a later session', () => {
    let replacement: any

    afterEach(() => replacement?.dispose())

    it('should detach the retired registry instead of leaving its handlers attached', () => {
      const listenersFor = (event: string) => (transport.events.all.get(event) ?? []).length
      const before = listenersFor('PEER_DISCONNECTED')

      resetAvatarSessionState()
      // Same transport, new session: this replaces the retired registry.
      replacement = createAvatarCommunicationSystem(transport as any, (position: any) => position)

      // One live registry's handler, not one per session that ever reused the transport:
      // a retained closure keeps its departed/session maps alive for the transport's life.
      expect(listenersFor('PEER_DISCONNECTED')).toEqual(before)
    })
  })

  describe('when a stale transport emits a disconnect after the session was reset', () => {
    it('should not free a mapping that now belongs to the new session', () => {
      // A registry keeps its transport subscriptions for the life of that transport and
      // never removes them, and resetEngine does not await transport.disconnect() before
      // clearing the allocator and unblocking a restart — so a late departure from the
      // OLD transport can land after a NEW session has already re-allocated the same
      // address. Unguarded, the old registry frees the new session's mapping.
      transport.events.emit('PEER_CONNECTED', { address: '0xpeer', sid: 'session-1' })
      expect(playerEntityManager.getEntityForAddress('0xpeer')).not.toBeNull()

      resetAvatarSessionState()

      // The fresh session allocates the same address.
      const reallocated = playerEntityManager.allocateEntityForPlayer('0xpeer', false)!

      // The old transport finally reports the old session's departure.
      transport.events.emit('PEER_DISCONNECTED', { address: '0xpeer', sid: 'session-1' })

      expect(playerEntityManager.getEntityForAddress('0xpeer')).toEqual(reallocated)
    })
  })

  describe('when a reconnect arrives without a session id', () => {
    it('should keep the peer when a stale disconnect for the old session lands', () => {
      // `sid` is optional on the transport contract, so a reconnect can arrive without
      // one. Recording nothing for it let the stale disconnect below drain the set and
      // retire the session that is actually live.
      transport.events.emit('PEER_CONNECTED', { address: '0xpeer', sid: 'session-1' })
      const liveEntity = playerEntityManager.getEntityForAddress('0xpeer')!
      transport.events.emit('PEER_CONNECTED', { address: '0xpeer' })

      transport.events.emit('PEER_DISCONNECTED', { address: '0xpeer', sid: 'session-1' })

      expect(playerEntityManager.getEntityForAddress('0xpeer')).toEqual(liveEntity)
    })

    it('should still retire the peer on an address-level disconnect', () => {
      // The sid-less live marker must not turn into a peer that can never be retired.
      transport.events.emit('PEER_CONNECTED', { address: '0xpeer', sid: 'session-1' })
      transport.events.emit('PEER_CONNECTED', { address: '0xpeer' })

      transport.events.emit('PEER_DISCONNECTED', { address: '0xpeer' })

      expect(playerEntityManager.getEntityForAddress('0xpeer')).toBeNull()
    })
  })

  describe('when a disconnect arrives without a session id', () => {
    it('should retire the peer even though it has recorded sessions', () => {
      // `sid` is optional on the event, so a transport can report a departure without
      // saying which session ended. Deleting nothing and returning on `size > 0` left
      // the peer live forever, leaking its entity and its pool slot.
      transport.events.emit('PEER_CONNECTED', { address: '0xpeer', sid: 'session-1' })
      expect(playerEntityManager.getEntityForAddress('0xpeer')).not.toBeNull()

      transport.events.emit('PEER_DISCONNECTED', { address: '0xpeer' })

      expect(playerEntityManager.getEntityForAddress('0xpeer')).toBeNull()
    })
  })

  describe("when one scene's retire handler throws", () => {
    let secondSystem: any
    let secondSubscription: any
    let peerEntity: number
    let consoleError: jest.SpyInstance
    let freeEntityForPlayer: jest.SpyInstance

    beforeEach(() => {
      secondSystem = createAvatarCommunicationSystem(transport as any, (position: any) => position)
      const firstSubscription = system.createSubscription()
      secondSubscription = secondSystem.createSubscription()

      transport.events.emit('position', { address: '0xpeer', data: positionData(1, 2, 3) })
      system.update()
      secondSystem.update()
      peerEntity = playerEntityManager.getEntityForAddress('0xpeer')!
      pullMessages(firstSubscription)
      pullMessages(secondSubscription)

      consoleError = jest.spyOn(console, 'error').mockImplementation(() => void 0)
      // Fail BOTH scenes' teardown, so only a path that cannot be skipped by a failing
      // scene is left to release the slot. jest.spyOn calls through once the queued
      // one-off implementations are exhausted.
      freeEntityForPlayer = jest
        .spyOn(playerEntityManager, 'freeEntityForPlayer')
        .mockImplementationOnce(() => {
          throw new TypeError("first scene's teardown failed")
        })
        .mockImplementationOnce(() => {
          throw new TypeError("second scene's teardown failed")
        })

      transport.events.emit('PEER_DISCONNECTED', { address: '0xpeer', sid: 'session-1' })
      system.update()
      secondSystem.update()
    })

    afterEach(() => {
      freeEntityForPlayer.mockRestore()
      consoleError.mockRestore()
      secondSystem.dispose()
    })

    it('should still run the sibling scene’s cleanup', () => {
      // Iterating the callbacks bare meant the first scene's throw skipped every
      // later scene, leaving those scenes with a frozen ghost avatar.
      const tombstones = pullMessages(secondSubscription)
        .filter((message) => message.type === CrdtMessageType.DELETE_ENTITY)
        .map((message) => message.entityId)

      expect(tombstones).toEqual([peerEntity])
    })

    it('should still release the pool slot', () => {
      expect(playerEntityManager.getEntityForAddress('0xpeer')).toBeNull()
    })
  })

  describe('when a packet from a peer arrives after that peer disconnected', () => {
    beforeEach(() => {
      transport.events.emit('PEER_CONNECTED', { address: '0xpeer' })
      transport.events.emit('PEER_DISCONNECTED', { address: '0xpeer' })
    })

    it('should not re-allocate an entity for the departed peer', () => {
      // Data frames and participant events travel different LiveKit paths, so a
      // position packet routinely lands after the departure. Re-allocating here
      // resurrects the peer as a frozen corpse avatar that leaks its pool slot for
      // the rest of the session.
      transport.events.emit('position', { address: '0xpeer', data: positionData(1, 2, 3) })

      expect(playerEntityManager.getEntityForAddress('0xpeer')).toBeNull()
    })

    it('should not re-allocate an entity for a straggler sent with mixed-case address', () => {
      transport.events.emit('position', { address: '0xPeEr', data: positionData(1, 2, 3) })

      expect(playerEntityManager.getEntityForAddress('0xpeer')).toBeNull()
    })

    it('should allocate again once the peer reconnects', () => {
      transport.events.emit('PEER_CONNECTED', { address: '0xpeer' })

      expect(playerEntityManager.getEntityForAddress('0xpeer')).not.toBeNull()
    })
  })

  describe('when a peer was already in the room before we joined', () => {
    it('should allocate an entity on its first packet even though no connect was ever observed', () => {
      // LiveKit does NOT emit ParticipantConnected for peers already in the room, so
      // these peers are discovered only from their first data packet. The
      // departed-peer guard must refuse KNOWN-DEPARTED addresses only; refusing
      // unknown ones would make every peer who joined before us invisible.
      transport.events.emit('position', { address: '0xstranger', data: positionData(4, 5, 6) })

      expect(playerEntityManager.getEntityForAddress('0xstranger')).not.toBeNull()
    })
  })

  describe('when a peer reconnects and the previous session disconnect arrives late', () => {
    let liveEntity: number

    beforeEach(() => {
      // Session 1 connects. The address is identical across a reconnect, so only the
      // transport's per-session id can tell the two sessions apart.
      transport.events.emit('PEER_CONNECTED', { address: '0xpeer', sid: 'session-1' })
      liveEntity = playerEntityManager.getEntityForAddress('0xpeer')!
      // The reconnect (session 2) is observed BEFORE session 1's disconnect: their
      // relative order is not guaranteed.
      transport.events.emit('PEER_CONNECTED', { address: '0xpeer', sid: 'session-2' })
      // Session 1's disconnect finally lands.
      transport.events.emit('PEER_DISCONNECTED', { address: '0xpeer', sid: 'session-1' })
    })

    it('should keep the entity of the session that is still live', () => {
      // Purging here left a stationary client — one not sending movement packets
      // that would re-allocate it — invisible for the rest of the session.
      expect(playerEntityManager.getEntityForAddress('0xpeer')).toEqual(liveEntity)
    })

    it('should remove the entity once the last live session also disconnects', () => {
      transport.events.emit('PEER_DISCONNECTED', { address: '0xpeer', sid: 'session-2' })

      expect(playerEntityManager.getEntityForAddress('0xpeer')).toBeNull()
    })

    it('should ignore a repeated disconnect for a session already retired', () => {
      // Session IDS in a Set, not a counter: re-delivering session 1's disconnect must
      // not retire session 2 as collateral.
      transport.events.emit('PEER_DISCONNECTED', { address: '0xpeer', sid: 'session-1' })

      expect(playerEntityManager.getEntityForAddress('0xpeer')).toEqual(liveEntity)
    })
  })

  describe('when a peer adopted from a data packet reconnects and the old disconnect is late', () => {
    let liveEntity: number

    beforeEach(() => {
      // LiveKit emits no ParticipantConnected for peers already in the room when we
      // joined, so this peer is known ONLY from its first data packet and has no
      // recorded session. A live-session COUNTER reads zero here and lets the stale
      // disconnect below purge the live session.
      transport.events.emit('position', { address: '0xpeer', data: positionData(1, 2, 3) })
      liveEntity = playerEntityManager.getEntityForAddress('0xpeer')!

      transport.events.emit('PEER_CONNECTED', { address: '0xpeer', sid: 'session-2' })
      transport.events.emit('PEER_DISCONNECTED', { address: '0xpeer', sid: 'session-1' })
    })

    it('should keep the entity belonging to the live session', () => {
      expect(playerEntityManager.getEntityForAddress('0xpeer')).toEqual(liveEntity)
    })
  })

  describe('when no live system holds the departing peer locally', () => {
    it('should still release the global allocator slot instead of leaking it', () => {
      // Reachable across a hot reload: the system that had the peer in its local mirror
      // is disposed, its replacement has not seen a packet from it yet, and the peer then
      // leaves. The registry outlives the systems, so the slot must still be released.
      transport.events.emit('position', { address: '0xorphan', data: positionData(1, 2, 3) })
      expect(playerEntityManager.getEntityForAddress('0xorphan')).not.toBeNull()
      system.dispose()

      transport.events.emit('PEER_DISCONNECTED', { address: '0xorphan', sid: 'session-1' })

      expect(playerEntityManager.getEntityForAddress('0xorphan')).toBeNull()
    })
  })

  describe('when a straggler packet arrives for a departed peer whose global mapping survives', () => {
    it('should not adopt the departed peer through the still-present mapping', () => {
      transport.events.emit('PEER_CONNECTED', { address: '0xpeer', sid: 'session-1' })
      transport.events.emit('PEER_DISCONNECTED', { address: '0xpeer', sid: 'session-1' })
      // A sibling system that has not processed the departure yet — or any other
      // holder — leaves a global mapping in place.
      const resurrected = playerEntityManager.allocateEntityForPlayer('0xpeer', false)!
      const subscription = system.createSubscription()

      transport.events.emit('position', { address: '0xpeer', data: positionData(1, 2, 3) })
      system.update()

      // departedPeers must be consulted BEFORE the allocator, or the straggler adopts
      // the peer through the back door and writes components for it again.
      expect(identityPutsFor(subscription, resurrected)).toHaveLength(0)
    })
  })

  describe('when a subscription is created after an entity has already been purged', () => {
    it('should not emit DELETE_ENTITY for a tombstone it was never told about', () => {
      // An incumbent subscription that has NOT consumed the tombstone yet is what keeps
      // it retained: with no live subscription, pruneEmittedTombstones drops it and this
      // assertion would hold no matter how the latecomer's cursor is initialized.
      system.createSubscription()

      transport.events.emit('PEER_CONNECTED', { address: '0xpeer', sid: 'session-1' })
      transport.events.emit('PEER_DISCONNECTED', { address: '0xpeer', sid: 'session-1' })
      system.update()

      // A subscription created now starts from a state dump that never contained the
      // purged entity, so the retained tombstone is not its business.
      const latecomer = system.createSubscription()

      expect(pullMessages(latecomer).filter((message) => message.type === CrdtMessageType.DELETE_ENTITY)).toHaveLength(0)
    })
  })

  describe('when a hot reload replaces the avatar system', () => {
    // Departed markers and pool slots outlive any one system, so a replacement must
    // inherit them. Held per-system, a reload forgot who had left and a straggler could
    // re-adopt a departed peer through the surviving global mapping.
    let replacement: any

    afterEach(() => replacement?.dispose())

    it('should refuse a straggler for a peer that departed before the reload', () => {
      transport.events.emit('PEER_CONNECTED', { address: '0xpeer', sid: 'session-1' })
      transport.events.emit('PEER_DISCONNECTED', { address: '0xpeer', sid: 'session-1' })
      // Something still holds a global mapping for the departed address — a sibling
      // that has not processed the departure, or any other allocation — so the straggler
      // below has a stale entity it could be adopted through.
      const stale = playerEntityManager.allocateEntityForPlayer('0xpeer', false)!

      system.dispose()
      replacement = createAvatarCommunicationSystem(transport as any, (position: any) => position)
      const subscription = replacement.createSubscription()

      transport.events.emit('position', { address: '0xpeer', data: positionData(1, 2, 3) })
      replacement.update()

      expect(identityPutsFor(subscription, stale)).toHaveLength(0)
    })

    it('should retire a peer that disconnects while no system is listening', () => {
      transport.events.emit('PEER_CONNECTED', { address: '0xpeer', sid: 'session-1' })
      expect(playerEntityManager.getEntityForAddress('0xpeer')).not.toBeNull()

      // The reload gap: loadSceneContextFromLocal disposes the old system, sleeps, then
      // creates the replacement. A departure landing in between had no listener at all.
      system.dispose()
      transport.events.emit('PEER_DISCONNECTED', { address: '0xpeer', sid: 'session-1' })

      // The registry owns the transport subscription, so the slot is still released.
      expect(playerEntityManager.getEntityForAddress('0xpeer')).toBeNull()

      // And the replacement inherits the departed marker, so a straggler cannot
      // resurrect the peer.
      replacement = createAvatarCommunicationSystem(transport as any, (position: any) => position)
      transport.events.emit('position', { address: '0xpeer', data: positionData(1, 2, 3) })

      expect(playerEntityManager.getEntityForAddress('0xpeer')).toBeNull()
    })
  })

  describe('when one of several subscriptions is disposed', () => {
    let survivingSubscription: any
    let disposedSubscription: any
    let peerEntity: number

    beforeEach(() => {
      survivingSubscription = system.createSubscription()
      disposedSubscription = system.createSubscription()

      transport.events.emit('position', { address: '0xpeer', data: positionData(1, 2, 3) })
      system.update()
      peerEntity = playerEntityManager.getEntityForAddress('0xpeer')!
      // Both subscriptions have seen the entity before anything is torn down.
      pullMessages(survivingSubscription)
      pullMessages(disposedSubscription)
    })

    it('should keep the live peer mapping in the process-global entity manager', () => {
      disposedSubscription.dispose()

      expect(playerEntityManager.getEntityForAddress('0xpeer')).toEqual(peerEntity)
    })

    it('should still deliver a pending DELETE_ENTITY tombstone to the surviving subscription', () => {
      // The tombstone is the ONLY removal signal (removePlayerEntity purges the
      // components), so wiping the shared tombstone map from one subscription's
      // teardown left the other scene's avatar on screen forever.
      transport.events.emit('PEER_DISCONNECTED', { address: '0xpeer' })
      disposedSubscription.dispose()
      system.update()

      const deletes = pullMessages(survivingSubscription).filter((m) => m.type === CrdtMessageType.DELETE_ENTITY)

      expect(deletes.map((m) => m.entityId)).toEqual([peerEntity])
    })
  })

  describe('when the entity was already allocated by another system sharing the global manager', () => {
    let subscription: any
    let preAllocatedEntity: number

    beforeEach(() => {
      // There is one avatar system per scene, all wired to the same transport and all
      // sharing the process-global playerEntityManager, so a sibling scene's system
      // may have allocated this peer already.
      preAllocatedEntity = playerEntityManager.allocateEntityForPlayer('0xpeer', false)!
      subscription = system.createSubscription()

      transport.events.emit('position', { address: '0xpeer', data: positionData(1, 2, 3) })
      system.update()
    })

    it('should write PlayerIdentityData so the entity is not a Transform belonging to no player', () => {
      expect(identityPutsFor(subscription, preAllocatedEntity)).toHaveLength(1)
    })
  })

  describe('when several avatar systems share one transport and a peer disconnects', () => {
    let secondSystem: any
    let firstSubscription: any
    let secondSubscription: any
    let peerEntity: number

    const tombstonesFrom = (subscription: any) =>
      pullMessages(subscription)
        .filter((message) => message.type === CrdtMessageType.DELETE_ENTITY)
        .map((message) => message.entityId)

    beforeEach(() => {
      // One avatar system per scene, every one wired to the SAME transport and sharing
      // the process-global playerEntityManager, but each owning its own component
      // stores and tombstones.
      secondSystem = createAvatarCommunicationSystem(transport as any, (position: any) => position)
      firstSubscription = system.createSubscription()
      secondSubscription = secondSystem.createSubscription()

      transport.events.emit('position', { address: '0xpeer', data: positionData(1, 2, 3) })
      system.update()
      secondSystem.update()
      peerEntity = playerEntityManager.getEntityForAddress('0xpeer')!
      // Both subscriptions observe the entity before the departure, so a tombstone
      // afterwards is genuinely new to each of them.
      pullMessages(firstSubscription)
      pullMessages(secondSubscription)

      transport.events.emit('PEER_DISCONNECTED', { address: '0xpeer' })
      system.update()
      secondSystem.update()
    })

    afterEach(() => secondSystem.dispose())

    it('should emit DELETE_ENTITY from the system whose listener ran first', () => {
      expect(tombstonesFrom(firstSubscription)).toEqual([peerEntity])
    })

    it('should emit DELETE_ENTITY from every sibling system too, not only the first', () => {
      // The first listener frees the global address mapping, so a sibling resolving the
      // departing peer through the allocator got `null`: it purged none of its own
      // components and emitted no tombstone, leaving that scene with a frozen ghost
      // avatar for the rest of the session.
      expect(tombstonesFrom(secondSubscription)).toEqual([peerEntity])
    })
  })
})

describe('avatar communication system with a tracked-session cap below the avatar pool', () => {
  let transport: { events: any }
  let system: any
  let configuredMaxTrackedPeerSessions: number

  beforeEach(() => {
    configuredMaxTrackedPeerSessions = limits.maxTrackedPeerSessions
    // Bypass readLimits deliberately to exercise recordFor's defence in depth.
    limits.maxTrackedPeerSessions = 1
    playerEntityManager.clear()
    robustFetchMock.mockResolvedValue({ ok: true })
    readBodyCappedMock.mockResolvedValue('[]')
    transport = { events: makeEmitter() }
    system = createAvatarCommunicationSystem(transport as any, (position: any) => position)

    transport.events.emit('PEER_CONNECTED', { address: '0xpeer-a', sid: 'session-a' })
    const peerEntity = playerEntityManager.getEntityForAddress('0xpeer-a')
    if (peerEntity === null) {
      throw new TypeError('peer A must allocate an entity before session-record churn')
    }

    // These peers are live too, so none of their records may be selected for eviction.
    transport.events.emit('PEER_CONNECTED', { address: '0xpeer-b', sid: 'session-b' })
    transport.events.emit('PEER_CONNECTED', { address: '0xpeer-c', sid: 'session-c' })
  })

  afterEach(() => {
    system.dispose()
    limits.maxTrackedPeerSessions = configuredMaxTrackedPeerSessions
    jest.resetAllMocks()
  })

  describe('when the first live peer disconnects by session id after record churn', () => {
    it('should retire its entity and release the pool slot', () => {
      transport.events.emit('PEER_DISCONNECTED', { address: '0xpeer-a', sid: 'session-a' })

      expect(playerEntityManager.getEntityForAddress('0xpeer-a')).toBeNull()
    })
  })
})
