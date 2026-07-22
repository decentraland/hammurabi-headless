import { Quaternion, Vector3 } from '@babylonjs/core'
import { ReadWriteByteBuffer } from '../../../src/lib/decentraland/ByteBuffer'
import { DeleteEntity, PutComponentOperation } from '../../../src/lib/decentraland/crdt-wire-protocol'
import { transformComponent } from '../../../src/lib/decentraland/sdk-components/transform-component'
import { Entity } from '../../../src/lib/decentraland/types'
import { testWithEngine } from './babylon-test-helper'
import { AVATAR_ENTITY_RANGE, StaticEntities } from '../../../src/lib/babylon/scene/logic/static-entities'
import { OTHER_PLAYER_ENTITIES_RANGE } from '../../../src/lib/decentraland/communications/player-entity-manager'
import { Scene } from '@dcl/schemas'

function serializeTransformPut(entityId: Entity): Uint8Array {
  const componentBuffer = new ReadWriteByteBuffer()
  transformComponent.serialize(
    {
      parent: 0 as Entity,
      position: Vector3.Zero(),
      scale: Vector3.One(),
      rotation: Quaternion.Identity()
    },
    componentBuffer
  )
  const buf = new ReadWriteByteBuffer()
  PutComponentOperation.write(
    {
      entityId,
      componentId: transformComponent.componentId,
      timestamp: 1,
      data: componentBuffer.toBinary()
    },
    buf
  )
  return buf.toBinary()
}

// Regression tests for the avatar-range write guard: scene-sourced CRDT must not
// be able to create, mutate, or delete entities in the range owned by the avatar
// communication system. A scene write landing there fights the avatar system with
// an independent LWW timestamp domain, and a scene DELETE_ENTITY would tear down
// a live player (see the flag-tag cross-wire investigation handover).
testWithEngine(
  'avatar-range write guard',
  {
    baseUrl: '/',
    entity: { content: [], metadata: {} as Scene, type: 'scene' },
    urn: '123'
  },
  ($) => {
    beforeEach(() => $.startEngine())

    test('the guard range matches the range the avatar system actually allocates from', () => {
      expect(AVATAR_ENTITY_RANGE).toEqual(OTHER_PLAYER_ENTITIES_RANGE)
      expect(AVATAR_ENTITY_RANGE).toEqual([32, 256])
    })

    test('a scene PUT_COMPONENT on an avatar-range entity is dropped', async () => {
      const avatarEntity = 33 as Entity
      expect($.ctx.entities.has(avatarEntity)).toEqual(false)

      await $.ctx.crdtSendToRenderer({ data: serializeTransformPut(avatarEntity) })

      // the guard must drop the op BEFORE entity materialization
      expect($.ctx.entities.has(avatarEntity)).toEqual(false)
    })

    test('a scene PUT_COMPONENT below the avatar range still applies (pre-guard behavior preserved)', async () => {
      const reservedNonAvatarEntity = 21 as Entity
      await $.ctx.crdtSendToRenderer({ data: serializeTransformPut(reservedNonAvatarEntity) })
      expect($.ctx.entities.has(reservedNonAvatarEntity)).toEqual(true)
    })

    test('a scene PUT_COMPONENT on a scene-range entity still applies', async () => {
      const sceneEntity = 600 as Entity
      await $.ctx.crdtSendToRenderer({ data: serializeTransformPut(sceneEntity) })
      expect($.ctx.entities.has(sceneEntity)).toEqual(true)
    })

    test('a scene DELETE_ENTITY on an avatar-range entity is dropped', async () => {
      const avatarEntity = 34 as Entity
      // materialize the entity the way the avatar system's subscription would
      // (host-side), not through the guarded scene channel
      $.ctx.tryGetOrCreateEntity(avatarEntity)
      expect($.ctx.entities.has(avatarEntity)).toEqual(true)

      const buf = new ReadWriteByteBuffer()
      DeleteEntity.write({ entityId: avatarEntity }, buf)
      await $.ctx.crdtSendToRenderer({ data: buf.toBinary() })

      expect($.ctx.entities.has(avatarEntity)).toEqual(true)
    })

    test('a scene DELETE_ENTITY on a host static entity (PlayerEntity) is dropped', async () => {
      const playerEntity = StaticEntities.PlayerEntity
      $.ctx.tryGetOrCreateEntity(playerEntity)
      expect($.ctx.entities.has(playerEntity)).toEqual(true)

      const buf = new ReadWriteByteBuffer()
      DeleteEntity.write({ entityId: playerEntity }, buf)
      await $.ctx.crdtSendToRenderer({ data: buf.toBinary() })

      // a scene must never delete a host-owned entity, even outside the avatar range
      expect($.ctx.entities.has(playerEntity)).toEqual(true)
    })

    test('a scene DELETE_ENTITY on a reserved non-avatar entity is dropped', async () => {
      const reservedEntity = 400 as Entity // in [256, 512): reserved but not avatar range
      $.ctx.tryGetOrCreateEntity(reservedEntity)
      expect($.ctx.entities.has(reservedEntity)).toEqual(true)

      const buf = new ReadWriteByteBuffer()
      DeleteEntity.write({ entityId: reservedEntity }, buf)
      await $.ctx.crdtSendToRenderer({ data: buf.toBinary() })

      expect($.ctx.entities.has(reservedEntity)).toEqual(true)
    })

    test('a scene DELETE_ENTITY on a scene-range entity still applies', async () => {
      const sceneEntity = 601 as Entity
      await $.ctx.crdtSendToRenderer({ data: serializeTransformPut(sceneEntity) })
      expect($.ctx.entities.has(sceneEntity)).toEqual(true)

      const buf = new ReadWriteByteBuffer()
      DeleteEntity.write({ entityId: sceneEntity }, buf)
      await $.ctx.crdtSendToRenderer({ data: buf.toBinary() })

      expect($.ctx.entities.has(sceneEntity)).toEqual(false)
    })
  }
)
