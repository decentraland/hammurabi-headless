import { Quaternion, Vector3 } from '@babylonjs/core'
import { ReadWriteByteBuffer } from '../../../src/lib/decentraland/ByteBuffer'
import { DeleteEntity, PutComponentOperation } from '../../../src/lib/decentraland/crdt-wire-protocol'
import { transformComponent } from '../../../src/lib/decentraland/sdk-components/transform-component'
import { Entity } from '../../../src/lib/decentraland/types'
import { testWithEngine } from './babylon-test-helper'
import { Scene } from '@dcl/schemas'

// Regression coverage for removeEntity (DELETE_ENTITY handling):
// - children of a deleted parent must be re-rooted to the SCENE root, not
//   detached to the Babylon world root (which drops the scene offset and takes
//   them out of the raycast/culling traversal)
// - the CRDT bookkeeping of the deleted entity must be purged from every
//   component store (it used to leak one timestamps entry per component per
//   deleted id, forever, outside every documented cap)

function putTransform(entityId: Entity, parent: Entity, timestamp: number): Uint8Array {
  const componentBuffer = new ReadWriteByteBuffer()
  transformComponent.serialize(
    {
      parent,
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
      timestamp,
      data: componentBuffer.toBinary()
    },
    buf
  )
  return buf.toBinary()
}

testWithEngine(
  'DELETE_ENTITY of a parent entity',
  {
    baseUrl: '/',
    entity: { content: [], metadata: {} as Scene, type: 'scene' },
    urn: '123'
  },
  ($) => {
    beforeEach(() => $.startEngine())

    it('should re-root the children to the scene root instead of the world root', async () => {
      const parentId = 21 as Entity
      const childId = 22 as Entity

      await $.ctx.crdtSendToRenderer({ data: putTransform(parentId, 0 as Entity, 1) })
      await $.ctx.crdtSendToRenderer({ data: putTransform(childId, parentId, 1) })

      const child = $.ctx.entities.get(childId)!
      expect(child.parent).toBe($.ctx.entities.get(parentId))

      const buf = new ReadWriteByteBuffer()
      DeleteEntity.write({ entityId: parentId }, buf)
      await $.ctx.crdtSendToRenderer({ data: buf.toBinary() })

      // the parent is gone, and the child hangs from the scene root — NOT from
      // the Babylon world root (parent=null), which would lose the scene offset
      expect($.ctx.entities.has(parentId)).toEqual(false)
      expect($.ctx.entities.has(childId)).toEqual(true)
      expect(child.parent).toBe($.ctx.rootNode)
    })

    it('should purge the CRDT bookkeeping of the deleted entity from every component store', async () => {
      const entityId = 23 as Entity

      await $.ctx.crdtSendToRenderer({ data: putTransform(entityId, 0 as Entity, 1) })

      const transformStore = ($.ctx.components as any)[transformComponent.componentId]
      const purgeSpy = jest.spyOn(transformStore, 'purgeEntity')

      const buf = new ReadWriteByteBuffer()
      DeleteEntity.write({ entityId }, buf)
      await $.ctx.crdtSendToRenderer({ data: buf.toBinary() })

      expect(purgeSpy).toHaveBeenCalledWith(entityId)
      purgeSpy.mockRestore()
    })
  }
)
