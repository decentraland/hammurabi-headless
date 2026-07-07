import { Vector3 } from '@babylonjs/core'
import mitt from 'mitt'
import { ReadWriteByteBuffer } from '../../../src/lib/decentraland/ByteBuffer'
import { CommsEvents, CommsTransportWrapper } from '../../../src/lib/decentraland/communications/CommsTransportWrapper'
import { createAvatarCommunicationSystem } from '../../../src/lib/decentraland/communications/avatar-communication-system'
import { StaticEntities } from '../../../src/lib/babylon/scene/logic/static-entities'
import { transformComponent } from '../../../src/lib/decentraland/sdk-components/transform-component'
import { CrdtMessageType, DeleteEntityMessage, PutComponentMessage, readAllMessages } from '../../../src/lib/decentraland/crdt-wire-protocol'

// Regression test for https://github.com/decentraland/hammurabi-headless/issues/26:
// comms positions arrive in world coordinates and must be written scene-relative.
describe('avatar communication system - scene-relative positions', () => {
  const rootNodeWorldPosition = new Vector3(1440, 0, -144)
  const worldToScene = (position: Vector3) => position.subtract(rootNodeWorldPosition)

  function emitAndGetTransform<T extends keyof CommsEvents>(eventName: T, event: CommsEvents[T]) {
    const events = mitt<CommsEvents>()
    const transport = { events } as unknown as CommsTransportWrapper
    const system = createAvatarCommunicationSystem(transport, worldToScene)
    const subscription = system.createSubscription()

    events.emit(eventName, event)
    system.update()

    const buffer = new ReadWriteByteBuffer()
    subscription.getUpdates(buffer)

    const messages = Array.from(readAllMessages(new ReadWriteByteBuffer(buffer.toBinary())))
    const message = messages.find(
      (m): m is PutComponentMessage =>
        m.type === CrdtMessageType.PUT_COMPONENT && m.componentId === transformComponent.componentId
    )
    if (!message) throw new Error('No transform PUT_COMPONENT message found')

    system.dispose()
    return transformComponent.deserialize(new ReadWriteByteBuffer(message.data))
  }

  function expectSceneRelative(transform: ReturnType<typeof transformComponent.deserialize>, worldPosition: Vector3) {
    const expected = worldToScene(worldPosition)
    expect(transform.parent).toEqual(StaticEntities.RootEntity)
    expect(transform.position.x).toBeCloseTo(expected.x)
    expect(transform.position.y).toBeCloseTo(expected.y)
    expect(transform.position.z).toBeCloseTo(expected.z)
  }

  test('handlePosition converts the incoming world position into scene-relative coordinates', () => {
    const worldPosition = new Vector3(1456.41, 0.13, -135.11)

    const transform = emitAndGetTransform('position', {
      address: '0xAAA',
      data: {
        positionX: worldPosition.x,
        positionY: worldPosition.y,
        positionZ: worldPosition.z,
        rotationX: 0,
        rotationY: 0,
        rotationZ: 0,
        rotationW: 1,
        index: 1,
        timestamp: 0
      }
    })

    expectSceneRelative(transform, worldPosition)
  })

  test('handleMovement converts the incoming world position into scene-relative coordinates', () => {
    const worldPosition = new Vector3(1500, 5, -200)

    const transform = emitAndGetTransform('movement', {
      address: '0xBBB',
      data: {
        positionX: worldPosition.x,
        positionY: worldPosition.y,
        positionZ: worldPosition.z,
        rotationY: 0,
        timestamp: 0
      }
    })

    expectSceneRelative(transform, worldPosition)
  })
})

// Regression: a peer that disconnects BETWEEN frames must still produce a
// DELETE_ENTITY, or its avatar lingers in every scene as a frozen ghost. The
// deletion signal must not depend on the per-frame tick (which the disconnect
// races against).
describe('avatar communication system - departed players are removed', () => {
  const worldToScene = (position: Vector3) => position

  function drainDeleteEntities(subscription: { getUpdates(w: ReadWriteByteBuffer): void }): number[] {
    const buffer = new ReadWriteByteBuffer()
    subscription.getUpdates(buffer)
    return Array.from(readAllMessages(new ReadWriteByteBuffer(buffer.toBinary())))
      .filter((m): m is DeleteEntityMessage => m.type === CrdtMessageType.DELETE_ENTITY)
      .map((m) => m.entityId)
  }

  test('emits DELETE_ENTITY for a peer that disconnects after an earlier frame already drained', () => {
    const events = mitt<CommsEvents>()
    const transport = { events } as unknown as CommsTransportWrapper
    const system = createAvatarCommunicationSystem(transport, worldToScene)
    const subscription = system.createSubscription()

    // A peer joins and moves; frame 1 processes and drains updates.
    events.emit('position', {
      address: '0xAAA',
      data: { positionX: 1, positionY: 0, positionZ: 1, rotationX: 0, rotationY: 0, rotationZ: 0, rotationW: 1, index: 1, timestamp: 0 }
    } as any)
    system.update()
    const entityId = drainDeleteEntities(subscription) // no deletes yet
    expect(entityId).toEqual([])

    // Peer disconnects BETWEEN frames (after frame 1's getUpdates already ran).
    events.emit('PEER_DISCONNECTED', { address: '0xAAA' } as any)

    // Frame 2: the tombstone must be delivered exactly once.
    system.update()
    const deleted = drainDeleteEntities(subscription)
    expect(deleted.length).toBe(1)

    // And not re-delivered on subsequent frames.
    system.update()
    expect(drainDeleteEntities(subscription)).toEqual([])

    system.dispose()
  })
})
