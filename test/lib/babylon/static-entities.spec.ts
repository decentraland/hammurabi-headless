import { Scene } from '@dcl/schemas'
import { Quaternion, TransformNode, Vector3 } from '@babylonjs/core'
import { PLAYER_CAPSULE_HALF_HEIGHT, StaticEntities } from '../../../src/lib/babylon/scene/logic/static-entities'
import { ReadWriteByteBuffer } from '../../../src/lib/decentraland/ByteBuffer'
import { CrdtMessageType, PutComponentMessage, readAllMessages } from '../../../src/lib/decentraland/crdt-wire-protocol'
import { engineInfoComponent } from '../../../src/lib/decentraland/sdk-components/engine-info'
import { transformComponent } from '../../../src/lib/decentraland/sdk-components/transform-component'
import { playerEntityAtom } from '../../../src/lib/decentraland/state'
import { testWithEngine } from './babylon-test-helper'

testWithEngine("static entities", {
  baseUrl: '/',
  entity: { content: [], metadata: {} as Scene, type: 'scene' },
  urn: '123',
  enableStaticEntities: true
}, ($) => {
  beforeEach(() => $.startEngine())
  test("ensure CameraEntity transform is being sent to the scene in the initial state (crdtGetState)", async () => {
    const { data } = await $.ctx.crdtGetState()

    const messages = Array.from(readAllMessages(new ReadWriteByteBuffer(data[0])))

    expect(messages).toMatchObject([
      {
        componentId: transformComponent.componentId,
        entityId: StaticEntities.CameraEntity,
        type: CrdtMessageType.PUT_COMPONENT
      },
      {
        componentId: transformComponent.componentId,
        entityId: StaticEntities.PlayerEntity,
        type: CrdtMessageType.PUT_COMPONENT
      },
      {
        componentId: engineInfoComponent.componentId,
        entityId: StaticEntities.RootEntity,
        type: CrdtMessageType.PUT_COMPONENT
      }
    ])
  })

  test("PlayerEntity transform is reported feet-anchored, not at the capsule center", async () => {
    // The player atom holds the CharacterController CAPSULE, whose position is
    // its center (PLAYER_HEIGHT/2 above the feet). Scenes must receive feet —
    // the raw capsule position leaking through was the "~0.85m Y offset"
    // fingerprint from the flag-tag cross-wire investigation.
    const capsuleCenter = new Vector3(8, 1.7, 8)
    const previous = playerEntityAtom.getOrNull()
    playerEntityAtom.swap({
      absolutePosition: capsuleCenter,
      absoluteRotationQuaternion: Quaternion.Identity()
    } as unknown as TransformNode)

    try {
      const { data } = await $.ctx.crdtGetState()
      const messages = Array.from(readAllMessages(new ReadWriteByteBuffer(data[0])))
      const playerPut = messages.find(
        (m): m is PutComponentMessage =>
          m.type === CrdtMessageType.PUT_COMPONENT &&
          (m as PutComponentMessage).entityId === StaticEntities.PlayerEntity &&
          (m as PutComponentMessage).componentId === transformComponent.componentId
      )
      if (!playerPut) throw new Error('No PlayerEntity transform PUT_COMPONENT found')

      const transform = transformComponent.deserialize(new ReadWriteByteBuffer(playerPut.data))
      const sceneRelativeCenter = capsuleCenter.subtract($.ctx.rootNode.position)
      expect(transform.position.x).toBeCloseTo(sceneRelativeCenter.x)
      expect(transform.position.y).toBeCloseTo(sceneRelativeCenter.y - PLAYER_CAPSULE_HALF_HEIGHT)
      expect(transform.position.z).toBeCloseTo(sceneRelativeCenter.z)
    } finally {
      playerEntityAtom.swap(previous as TransformNode)
    }
  })
})
