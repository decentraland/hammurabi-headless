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
  createAvatarCommunicationSystem
} = require('../../../../src/lib/decentraland/communications/avatar-communication-system')
const { playerEntityManager } = require('../../../../src/lib/decentraland/communications/player-entity-manager')
const { playerIdentityDataComponent } = require('../../../../src/lib/decentraland/sdk-components/player-identity-data')
const { ReadWriteByteBuffer } = require('../../../../src/lib/decentraland/ByteBuffer')
const { readAllMessages } = require('../../../../src/lib/decentraland/crdt-wire-protocol')
const { CrdtMessageType } = require('../../../../src/lib/decentraland/crdt-wire-protocol/types')
const { robustFetch, readBodyCapped } = require('../../../../src/lib/misc/network')

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
      // Session 1 connects.
      transport.events.emit('PEER_CONNECTED', { address: '0xpeer' })
      liveEntity = playerEntityManager.getEntityForAddress('0xpeer')!
      // The reconnect (session 2) is observed BEFORE session 1's disconnect: both
      // events carry only the LiveKit identity, which is identical across a
      // reconnect, and their relative order is not guaranteed.
      transport.events.emit('PEER_CONNECTED', { address: '0xpeer' })
      // Session 1's disconnect finally lands.
      transport.events.emit('PEER_DISCONNECTED', { address: '0xpeer' })
    })

    it('should keep the entity of the session that is still live', () => {
      // Purging here left a stationary client — one not sending movement packets
      // that would re-allocate it — invisible for the rest of the session.
      expect(playerEntityManager.getEntityForAddress('0xpeer')).toEqual(liveEntity)
    })

    it('should remove the entity once the last live session also disconnects', () => {
      transport.events.emit('PEER_DISCONNECTED', { address: '0xpeer' })

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
