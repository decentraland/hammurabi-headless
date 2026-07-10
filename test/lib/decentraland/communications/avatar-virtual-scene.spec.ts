import { Vector3 } from '@babylonjs/core'
import { ReadWriteByteBuffer } from '../../../../src/lib/decentraland/ByteBuffer'
import { readAllMessages } from '../../../../src/lib/decentraland/crdt-wire-protocol'
import { CrdtMessageType } from '../../../../src/lib/decentraland/crdt-wire-protocol/types'
import { createAvatarCommunicationSystem } from '../../../../src/lib/decentraland/communications/avatar-communication-system'
import { playerEntityManager } from '../../../../src/lib/decentraland/communications/player-entity-manager'
import { transformComponent } from '../../../../src/lib/decentraland/sdk-components/transform-component'

// Replaces the retired comms-virtual-scene-system spec: the avatar
// communication system is now the VirtualScene implementation whose
// per-subscription delta semantics and DELETE_ENTITY tombstones were pinned
// there. Assertions are semantic (decoded messages), not byte-exact, because
// entity allocation moved to the shared playerEntityManager.

function makeEmitter() {
  const handlers: Record<string, Function[]> = {}
  return {
    on(t: string, h: Function) {
      ;(handlers[t] ||= []).push(h)
    },
    off(t: string, h: Function) {
      handlers[t] = (handlers[t] || []).filter((x) => x !== h)
    },
    emit(t: string, e: any) {
      ;(handlers[t] || []).forEach((h) => h(e))
    }
  }
}

function positionData(x: number, y: number, z: number) {
  return { positionX: x, positionY: y, positionZ: z, rotationX: 0, rotationY: 0, rotationZ: 0, rotationW: 1 }
}

function pullMessages(subscription: { getUpdates(writer: ReadWriteByteBuffer): void }) {
  const buf = new ReadWriteByteBuffer()
  subscription.getUpdates(buf)
  return Array.from(readAllMessages(new ReadWriteByteBuffer(buf.toBinary())))
}

describe('avatar communication system as a virtual scene', () => {
  let transport: { events: ReturnType<typeof makeEmitter> }
  let system: ReturnType<typeof createAvatarCommunicationSystem>

  beforeEach(() => {
    playerEntityManager.clear()
    transport = { events: makeEmitter() }
    system = createAvatarCommunicationSystem(transport as any, (position: Vector3) => position.clone())
  })

  afterEach(() => {
    system.dispose()
  })

  describe('when two subscriptions pull at different cadences', () => {
    let eagerSubscription: ReturnType<typeof system.createSubscription>
    let lazySubscription: ReturnType<typeof system.createSubscription>

    beforeEach(() => {
      eagerSubscription = system.createSubscription()
      lazySubscription = system.createSubscription()

      // Two position updates with a commit and an eager pull in between.
      transport.events.emit('position', { address: '0xpeer', data: positionData(1, 2, 3) })
      system.update()
      eagerSubscription.getUpdates(new ReadWriteByteBuffer())

      transport.events.emit('position', { address: '0xpeer', data: positionData(9, 9, 9) })
      system.update()
    })

    it('should give the eager subscription only the delta since its last pull', () => {
      const transformPuts = pullMessages(eagerSubscription).filter(
        (m) => m.type === CrdtMessageType.PUT_COMPONENT && (m as any).componentId === transformComponent.componentId
      )

      expect(transformPuts).toHaveLength(1)
    })

    it('should not re-emit anything on a pull with no new updates', () => {
      pullMessages(eagerSubscription)
      const buf = new ReadWriteByteBuffer()
      eagerSubscription.getUpdates(buf)

      expect(buf.currentWriteOffset()).toEqual(0)
    })

    it('should give the lazy subscription the full state on its first pull', () => {
      const transformPuts = pullMessages(lazySubscription).filter(
        (m) => m.type === CrdtMessageType.PUT_COMPONENT && (m as any).componentId === transformComponent.componentId
      )

      // LWW state dump: one PUT carrying the latest value.
      expect(transformPuts).toHaveLength(1)
    })
  })

  describe('when a peer disconnects', () => {
    let subscriptionA: ReturnType<typeof system.createSubscription>
    let subscriptionB: ReturnType<typeof system.createSubscription>
    let peerEntity: number

    beforeEach(() => {
      subscriptionA = system.createSubscription()
      subscriptionB = system.createSubscription()

      transport.events.emit('position', { address: '0xpeer', data: positionData(1, 2, 3) })
      system.update()
      peerEntity = playerEntityManager.getEntityForAddress('0xpeer')!
      // Both subscriptions have seen the entity before the disconnect.
      subscriptionA.getUpdates(new ReadWriteByteBuffer())
      subscriptionB.getUpdates(new ReadWriteByteBuffer())

      transport.events.emit('PEER_DISCONNECTED', { address: '0xpeer' })
      system.update()
    })

    it('should emit a DELETE_ENTITY tombstone to every subscription', () => {
      const deletesA = pullMessages(subscriptionA).filter((m) => m.type === CrdtMessageType.DELETE_ENTITY)
      const deletesB = pullMessages(subscriptionB).filter((m) => m.type === CrdtMessageType.DELETE_ENTITY)

      expect(deletesA.map((m) => m.entityId)).toEqual([peerEntity])
      expect(deletesB.map((m) => m.entityId)).toEqual([peerEntity])
    })

    it('should emit the tombstone to each subscription exactly once', () => {
      pullMessages(subscriptionA)
      const deletesOnSecondPull = pullMessages(subscriptionA).filter((m) => m.type === CrdtMessageType.DELETE_ENTITY)

      expect(deletesOnSecondPull).toHaveLength(0)
    })
  })
})
