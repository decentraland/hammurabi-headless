import { Vector3 } from '@babylonjs/core'
import mitt from 'mitt'
import { ReadWriteByteBuffer } from '../../../src/lib/decentraland/ByteBuffer'
import { CommsEvents, CommsTransportWrapper } from '../../../src/lib/decentraland/communications/CommsTransportWrapper'
import { createAvatarCommunicationSystem } from '../../../src/lib/decentraland/communications/avatar-communication-system'
import { StaticEntities } from '../../../src/lib/babylon/scene/logic/static-entities'
import type { SceneContext } from '../../../src/lib/babylon/scene/scene-context'
import { transformComponent } from '../../../src/lib/decentraland/sdk-components/transform-component'
import { readAllMessages } from '../../../src/lib/decentraland/crdt-wire-protocol'

/**
 * Regression test for https://github.com/decentraland/hammurabi-headless/issues/26
 *
 * Remote player positions received from comms are expressed in world/global coordinates.
 * The scene expects `Transform` values to be scene-relative (i.e. relative to the scene's
 * root entity), the same way `updateStaticEntities` converts the local player's position
 * before writing `StaticEntities.PlayerEntity`'s transform.
 */
describe('avatar communication system - scene-relative positions', () => {
  // the scene is placed away from the world origin, e.g. a scene based at parcel 90,-9
  const rootNodeWorldPosition = new Vector3(1440, 0, -144)
  const fakeSceneContext = { rootNode: { position: rootNodeWorldPosition } } as unknown as SceneContext

  function getTransformPut(buffer: Uint8Array) {
    const messages = Array.from(readAllMessages(new ReadWriteByteBuffer(buffer)))
    const message = messages.find((_: any) => _.componentId === transformComponent.componentId) as any
    if (!message) throw new Error('No transform PUT_COMPONENT message found')
    return transformComponent.deserialize(new ReadWriteByteBuffer(message.data))
  }

  test('handlePosition converts the incoming world position into scene-relative coordinates', () => {
    const events = mitt<CommsEvents>()
    const transport = { events } as unknown as CommsTransportWrapper
    const system = createAvatarCommunicationSystem(transport, fakeSceneContext)
    system.update()
    const subscription = system.createSubscription()

    const worldPosition = new Vector3(1456.41, 0.13, -135.11)

    events.emit('position', {
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
    system.update()

    const buffer = new ReadWriteByteBuffer()
    subscription.getUpdates(buffer)
    const transform = getTransformPut(buffer.toBinary())

    const expectedScenePosition = worldPosition.subtract(rootNodeWorldPosition)

    expect(transform.parent).toEqual(StaticEntities.RootEntity)
    expect(transform.position.x).toBeCloseTo(expectedScenePosition.x)
    expect(transform.position.y).toBeCloseTo(expectedScenePosition.y)
    expect(transform.position.z).toBeCloseTo(expectedScenePosition.z)

    system.dispose()
  })

  test('handleMovement converts the incoming world position into scene-relative coordinates', () => {
    const events = mitt<CommsEvents>()
    const transport = { events } as unknown as CommsTransportWrapper
    const system = createAvatarCommunicationSystem(transport, fakeSceneContext)
    system.update()
    const subscription = system.createSubscription()

    const worldPosition = new Vector3(1500, 5, -200)

    events.emit('movement', {
      address: '0xBBB',
      data: {
        positionX: worldPosition.x,
        positionY: worldPosition.y,
        positionZ: worldPosition.z,
        rotationY: 0,
        timestamp: 0
      }
    })
    system.update()

    const buffer = new ReadWriteByteBuffer()
    subscription.getUpdates(buffer)
    const transform = getTransformPut(buffer.toBinary())

    const expectedScenePosition = worldPosition.subtract(rootNodeWorldPosition)

    expect(transform.parent).toEqual(StaticEntities.RootEntity)
    expect(transform.position.x).toBeCloseTo(expectedScenePosition.x)
    expect(transform.position.y).toBeCloseTo(expectedScenePosition.y)
    expect(transform.position.z).toBeCloseTo(expectedScenePosition.z)

    system.dispose()
  })
})
