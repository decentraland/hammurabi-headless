import { Scene } from '@dcl/schemas'
import { CreateCapsuleVertexData, Quaternion, TransformNode, Vector3 } from '@babylonjs/core'
import {
  PLAYER_CAPSULE_HALF_HEIGHT,
  PLAYER_HEIGHT,
  StaticEntities
} from '../../../src/lib/babylon/scene/logic/static-entities'
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
    // The player atom holds the CharacterController CAPSULE, whose position is its
    // center (PLAYER_HEIGHT/2 above the feet). Scenes must receive feet, so leaking
    // the raw capsule position puts every scene's view of the player 0.85m too high.
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

  test("PLAYER_CAPSULE_HALF_HEIGHT matches the real geometry of the player capsule", () => {
    // The round-trip tests above hold for ANY offset as long as both sides agree, so
    // they cannot catch the offset being the wrong SIZE. This one can: the constant is
    // only correct because a capsule built the way CharacterController builds it is
    // centered on its origin with total height PLAYER_HEIGHT. That comes from
    // Babylon's capsuleBuilder placing the extreme cap vertices at ±height/2 — an
    // implementation detail of a dependency. If a Babylon upgrade ever changes it,
    // every feet-anchored player position silently shifts, so pin it here.
    // Radius mirrors CharacterController's capsule; the ±height/2 extremes hold for
    // any radius while height >= 2 * radius, which 1.7 >= 0.8 satisfies.
    //
    // Deliberately CreateCapsuleVertexData, not CreateCapsule: the latter needs a
    // Scene and would add a mesh to the one shared by every test in this file, which
    // leaks into the tests that follow. This asserts the same geometry with no scene
    // and nothing to dispose.
    const { positions } = CreateCapsuleVertexData({ height: PLAYER_HEIGHT, radius: 0.4 })
    if (!positions) throw new Error('CreateCapsuleVertexData returned no positions')

    let minY = Infinity
    let maxY = -Infinity
    // positions is a flat [x, y, z, x, y, z, ...] buffer
    for (let i = 1; i < positions.length; i += 3) {
      if (positions[i] < minY) minY = positions[i]
      if (positions[i] > maxY) maxY = positions[i]
    }

    expect(maxY - minY).toBeCloseTo(PLAYER_HEIGHT)
    expect(maxY).toBeCloseTo(PLAYER_CAPSULE_HALF_HEIGHT)
    expect(minY).toBeCloseTo(-PLAYER_CAPSULE_HALF_HEIGHT)
  })

  test("a player standing on a feet-anchored spawn point is reported AT that spawn point", async () => {
    // Pins the round trip startEngine performs: scene.json `spawnPoints` are FEET
    // positions and teleport() takes a capsule CENTER, so the capsule is lifted by
    // PLAYER_CAPSULE_HALF_HEIGHT and updateStaticEntities must subtract exactly the
    // same amount to hand the scene back the spawn point it started from.
    //
    // NOTE what this can and cannot catch: it pins that the two conversions AGREE,
    // not that the offset has the right magnitude — lift and drop by the same wrong
    // number and the round trip still closes. The magnitude is pinned separately by
    // the geometry test above. Both are needed.
    //
    // The spawn point is deliberately off-origin with a non-zero height: at
    // scene-relative (0, 0, 0) the expected value collides with the transform's
    // initial Vector3.Zero(), and updateStaticEntities' "only dirty when it actually
    // moved" guard then emits no message at all, so the assertion would be reached
    // only by accident.
    const spawnFeet = new Vector3(10, 3, 12)
    const capsuleCenter = spawnFeet.add(new Vector3(0, PLAYER_CAPSULE_HALF_HEIGHT, 0))
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
      const sceneRelativeSpawn = spawnFeet.subtract($.ctx.rootNode.position)
      expect(transform.position.x).toBeCloseTo(sceneRelativeSpawn.x)
      expect(transform.position.y).toBeCloseTo(sceneRelativeSpawn.y)
      expect(transform.position.z).toBeCloseTo(sceneRelativeSpawn.z)
    } finally {
      playerEntityAtom.swap(previous as TransformNode)
    }
  })
})
