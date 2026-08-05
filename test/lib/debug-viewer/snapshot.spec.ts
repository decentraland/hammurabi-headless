import { Quaternion, Vector3 } from '@babylonjs/core'
import { Scene } from '@dcl/schemas'
import { ReadWriteByteBuffer } from '../../../src/lib/decentraland/ByteBuffer'
import { PutComponentOperation } from '../../../src/lib/decentraland/crdt-wire-protocol'
import { transformComponent } from '../../../src/lib/decentraland/sdk-components/transform-component'
import { meshRendererComponent } from '../../../src/lib/decentraland/sdk-components/mesh-renderer-component'
import { Entity } from '../../../src/lib/decentraland/types'
import { StaticEntities } from '../../../src/lib/babylon/scene/logic/static-entities'
import { buildSnapshot } from '../../../src/lib/debug-viewer/snapshot'
import { testWithEngine } from '../babylon/babylon-test-helper'

// The debug viewer is READ-ONLY observability over the authoritative scene graph.
// What is pinned here is what makes it trustworthy:
// - transforms are emitted in WORLD space (through the parcel offset on rootNode
//   and through parent chains), because a viewer that silently drops the scene
//   offset would draw every off-origin scene in the wrong place
// - the untrusted-input cap is enforced and REPORTED, never silently truncating
// - a shape the host declines to build (cylinder) is marked, not hidden

function putTransform(entityId: Entity, parent: Entity, position: Vector3): Uint8Array {
  const componentBuffer = new ReadWriteByteBuffer()
  transformComponent.serialize(
    { parent, position, scale: Vector3.One(), rotation: Quaternion.Identity() },
    componentBuffer
  )
  const buf = new ReadWriteByteBuffer()
  PutComponentOperation.write(
    { entityId, componentId: transformComponent.componentId, timestamp: 1, data: componentBuffer.toBinary() },
    buf
  )
  return buf.toBinary()
}

function putMeshRenderer(entityId: Entity, value: any): Uint8Array {
  const componentBuffer = new ReadWriteByteBuffer()
  meshRendererComponent.serialize(value, componentBuffer)
  const buf = new ReadWriteByteBuffer()
  PutComponentOperation.write(
    { entityId, componentId: meshRendererComponent.componentId, timestamp: 1, data: componentBuffer.toBinary() },
    buf
  )
  return buf.toBinary()
}

testWithEngine(
  'debug-viewer snapshot',
  {
    baseUrl: 'https://content.example.com/contents/',
    entity: {
      content: [],
      // base 2,3 -> the scene rootNode sits at world (32, 0, 48)
      metadata: { scene: { base: '2,3', parcels: ['2,3'] } } as Scene,
      type: 'scene'
    },
    urn: 'urn:test'
  },
  ($) => {
    beforeEach(() => $.startEngine())

    it('emits world-space transforms, composing the scene offset and the parent chain', async () => {
      const parent = 512 as Entity
      const child = 513 as Entity

      await $.ctx.crdtSendToRenderer({ data: putTransform(parent, StaticEntities.RootEntity, new Vector3(1, 0, 0)) })
      await $.ctx.crdtSendToRenderer({ data: putTransform(child, parent, new Vector3(0, 2, 0)) })
      $.ctx.update(() => true)
      $.ctx.lateUpdate()

      const snapshot = buildSnapshot([$.ctx], 1000)
      expect(snapshot.scenes).toHaveLength(1)
      expect(snapshot.scenes[0].base).toEqual('2,3')

      const byId = new Map(snapshot.scenes[0].entities.map((e) => [e.id, e]))
      // parcel offset (32,0,48) + local (1,0,0)
      expect(byId.get(512)!.p).toEqual([33, 0, 48])
      // ...and the child adds its own local offset on top of the parent's world
      expect(byId.get(513)!.p).toEqual([33, 2, 48])
    })

    it('flags a declared shape the host does not build, and reports the entity cap', async () => {
      const cylinder = 600 as Entity
      const box = 601 as Entity

      await $.ctx.crdtSendToRenderer({ data: putTransform(cylinder, StaticEntities.RootEntity, Vector3.Zero()) })
      await $.ctx.crdtSendToRenderer({
        data: putMeshRenderer(cylinder, { mesh: { $case: 'cylinder', cylinder: { radiusTop: 1, radiusBottom: 1 } } })
      })
      await $.ctx.crdtSendToRenderer({ data: putTransform(box, StaticEntities.RootEntity, Vector3.Zero()) })
      await $.ctx.crdtSendToRenderer({ data: putMeshRenderer(box, { mesh: { $case: 'box', box: { uvs: [] } } }) })
      $.ctx.update(() => true)
      $.ctx.lateUpdate()

      const snapshot = buildSnapshot([$.ctx], 1000)
      const byId = new Map(snapshot.scenes[0].entities.map((e) => [e.id, e]))

      // A cylinder MeshRenderer is accepted by the CRDT but never built headlessly:
      // the viewer must show it as a ghost rather than pretend it does not exist.
      expect(byId.get(600)).toMatchObject({ k: 'cylinder', ghost: true })
      // A box IS built, so it is not a ghost.
      expect(byId.get(601)!.k).toEqual('box')
      expect(byId.get(601)!.ghost).toBeUndefined()

      // The cap is a hard bound on serialization work (scene CRDT is untrusted),
      // and overflow must be visible instead of silently missing.
      const capped = buildSnapshot([$.ctx], 2)
      expect(capped.scenes[0].entities).toHaveLength(2)
      expect(capped.scenes[0].truncated).toBeGreaterThan(0)
    })

    it('distinguishes the host-owned player and avatar entities from scene entities', () => {
      // These are HOST-owned: the player comes from the character controller and
      // the avatar range is written by the comms path (scene CRDT is denied on
      // both, which is why they cannot be set up through crdtSendToRenderer).
      // The viewer draws them as capsules, so misclassifying one would silently
      // turn a peer into a unit box.
      $.ctx.getOrCreateStaticEntity(StaticEntities.PlayerEntity)
      $.ctx.getOrCreateStaticEntity(40 as Entity)

      const byId = new Map(buildSnapshot([$.ctx], 1000).scenes[0].entities.map((e) => [e.id, e]))
      expect(byId.get(StaticEntities.PlayerEntity)!.k).toEqual('player')
      expect(byId.get(40)!.k).toEqual('avatar')
    })

    it('never mutates the scene graph it observes', async () => {
      const entity = 700 as Entity
      await $.ctx.crdtSendToRenderer({ data: putTransform(entity, StaticEntities.RootEntity, new Vector3(3, 4, 5)) })
      $.ctx.update(() => true)
      $.ctx.lateUpdate()

      const before = $.ctx.entities.size
      const babylonEntity = $.ctx.getEntityOrNull(entity)!
      const worldBefore = babylonEntity.getWorldMatrix().clone()

      buildSnapshot([$.ctx], 1000)
      buildSnapshot([$.ctx], 1000)

      expect($.ctx.entities.size).toEqual(before)
      expect(babylonEntity.getWorldMatrix().equals(worldBefore)).toEqual(true)
    })
  }
)
