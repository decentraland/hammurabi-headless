import { AbstractMesh } from '@babylonjs/core'
import { Scene } from '@dcl/schemas'
import { ColliderLayer, PBMeshCollider } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen'
import { meshColliderComponent } from '../../../../src/lib/decentraland/sdk-components/mesh-collider-component'
import { Entity } from '../../../../src/lib/decentraland/types'
import { CrdtBuilder, testWithEngine } from '../babylon-test-helper'

// Every MeshCollider shape used to clone the same 1x1x1 box, so a sphere,
// cylinder or plane collider silently occupied a cube's volume — raycasts and
// pointer picks reported hits no client agrees with. These tests pin the shape
// actually built for each `mesh` oneof case.

testWithEngine(
  'mesh collider component',
  {
    baseUrl: '/',
    entity: { content: [], metadata: {} as Scene, type: 'scene' },
    urn: 'mesh-collider-spec'
  },
  ($) => {
    let timestamp: number

    beforeEach(() => {
      $.startEngine()
      timestamp = 0
    })

    async function putCollider(entity: Entity, value: PBMeshCollider): Promise<void> {
      await $.ctx.crdtSendToRenderer({
        data: new CrdtBuilder().put(meshColliderComponent, entity, ++timestamp, value).finish()
      })
    }

    function colliderOf(entity: Entity): AbstractMesh | null {
      return $.ctx.entities.get(entity)!.appliedComponents.meshCollider!.collider
    }

    describe('when a scene puts a MeshCollider with a box shape', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 700 as Entity
        await putCollider(entity, { mesh: { $case: 'box', box: {} } })
      })

      it('should build a collider named box_collider so setColliderMask treats it as a collider', () => {
        expect(colliderOf(entity)!.name).toBe('box_collider')
      })

      it('should build a unit cube spanning half a metre from the entity origin on every axis', () => {
        expect(colliderOf(entity)!.getBoundingInfo().boundingBox.extendSize.asArray()).toEqual([0.5, 0.5, 0.5])
      })
    })

    describe('when a scene puts a MeshCollider with a sphere shape', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 701 as Entity
        await putCollider(entity, { mesh: { $case: 'sphere', sphere: {} } })
      })

      it('should build a sphere collider rather than reusing the box template', () => {
        expect(colliderOf(entity)!.name).toBe('sphere_collider')
      })
    })

    describe('when a scene puts a MeshCollider with a plane shape', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 702 as Entity
        await putCollider(entity, { mesh: { $case: 'plane', plane: {} } })
      })

      it('should build a plane collider rather than reusing the box template', () => {
        expect(colliderOf(entity)!.name).toBe('plane_collider')
      })

      it('should build a flat quad with no depth instead of a cube', () => {
        expect(colliderOf(entity)!.getBoundingInfo().boundingBox.extendSize.z).toBe(0)
      })
    })

    describe('when a scene puts a MeshCollider with a cylinder shape', () => {
      describe('and the radii are omitted', () => {
        let entity: Entity

        beforeEach(async () => {
          entity = 703 as Entity
          await putCollider(entity, { mesh: { $case: 'cylinder', cylinder: {} } })
        })

        it('should build a cylinder collider rather than reusing the box template', () => {
          expect(colliderOf(entity)!.name).toBe('cylinder_collider')
        })

        it('should default both radii to 0.5 so the cylinder fits the unit box', () => {
          expect(colliderOf(entity)!.getBoundingInfo().boundingBox.extendSize.x).toBeCloseTo(0.5, 5)
        })
      })

      describe('and the radii differ from each other', () => {
        let entity: Entity

        beforeEach(async () => {
          entity = 704 as Entity
          await putCollider(entity, {
            mesh: { $case: 'cylinder', cylinder: { radiusTop: 2, radiusBottom: 0.5 } }
          })
        })

        it('should size the collider from the widest radius instead of the default', () => {
          expect(colliderOf(entity)!.getBoundingInfo().boundingBox.extendSize.x).toBeCloseTo(2, 5)
        })
      })

      describe('and only the bottom radius is given', () => {
        let entity: Entity

        beforeEach(async () => {
          entity = 705 as Entity
          await putCollider(entity, {
            mesh: { $case: 'cylinder', cylinder: { radiusBottom: 3 } }
          })
        })

        // A missing radius means 0.5, not 0 — `?? 0` here would collapse the top
        // into a cone tip and shrink the collider the scene asked for.
        it('should keep the omitted top radius at its 0.5 default', () => {
          expect(colliderOf(entity)!.getBoundingInfo().boundingBox.extendSize.x).toBeCloseTo(3, 5)
        })
      })
    })

    describe('when a scene puts a MeshCollider carrying no shape at all', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 706 as Entity
        await putCollider(entity, { collisionMask: ColliderLayer.CL_POINTER })
      })

      // Matches the reference client, which returns early on MeshOneofCase.None.
      // Falling through to a box fabricated an invisible collider no client had.
      it('should not build any collider mesh', () => {
        expect(colliderOf(entity)).toBeNull()
      })

      it('should still record the component so a later delete has an entry to clear', () => {
        expect($.ctx.entities.get(entity)!.appliedComponents.meshCollider).toBeTruthy()
      })
    })

    describe('when a scene replaces a box collider with a sphere collider', () => {
      let entity: Entity
      let originalCollider: AbstractMesh

      beforeEach(async () => {
        entity = 707 as Entity
        await putCollider(entity, { mesh: { $case: 'box', box: {} } })
        originalCollider = colliderOf(entity)!
        await putCollider(entity, { mesh: { $case: 'sphere', sphere: {} } })
      })

      it('should dispose the box that the sphere replaced', () => {
        expect(originalCollider.isDisposed()).toBe(true)
      })

      it('should attach the sphere in its place', () => {
        expect(colliderOf(entity)!.name).toBe('sphere_collider')
      })
    })

    describe('when a scene puts a shaped MeshCollider without a collision mask', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 708 as Entity
        await putCollider(entity, { mesh: { $case: 'sphere', sphere: {} } })
      })

      it('should make the collider pickable so pointer rays hit it', () => {
        expect(colliderOf(entity)!.isPickable).toBe(true)
      })

      it('should enable physics collisions on it', () => {
        expect(colliderOf(entity)!.checkCollisions).toBe(true)
      })
    })
  }
)
