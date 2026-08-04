import { AbstractMesh, VertexBuffer } from '@babylonjs/core'
import { Scene } from '@dcl/schemas'
import { PBMeshCollider } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen'
import { PBMeshRenderer } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_renderer.gen'
import { meshColliderComponent } from '../../../../src/lib/decentraland/sdk-components/mesh-collider-component'
import { meshRendererComponent } from '../../../../src/lib/decentraland/sdk-components/mesh-renderer-component'
import { Entity } from '../../../../src/lib/decentraland/types'
import { limits } from '../../../../src/lib/misc/limits'
import { CrdtBuilder, testWithEngine } from '../babylon-test-helper'

// MeshRenderer had NO cylinder branch: a CylinderMesh rendered nothing at all, so
// the entity had no geometry for anything that walks the render tree while its
// MeshCollider claimed a truncated cone. These tests pin the shape it now builds and,
// crucially, that it is the SAME geometry the collider gets for the same value — a
// collider that disagrees with the mesh it stands in for reports hits at coordinates
// no client agrees with.

/**
 * Largest distance from the Y axis among the vertices of one end cap. Bounding
 * boxes are driven by the WIDER end, so they cannot tell radiusTop from
 * radiusBottom (nor a swap of the two); this reads the ring the scene asked for.
 */
function endCapRadius(mesh: AbstractMesh, end: 'top' | 'bottom'): number {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!
  let radius = 0
  for (let i = 0; i < positions.length; i += 3) {
    const y = positions[i + 1]
    if (end === 'top' ? y > 0.4 : y < -0.4) {
      radius = Math.max(radius, Math.hypot(positions[i], positions[i + 2]))
    }
  }
  return radius
}

testWithEngine(
  'mesh renderer component',
  {
    baseUrl: '/',
    entity: { content: [], metadata: {} as Scene, type: 'scene' },
    urn: 'mesh-renderer-spec'
  },
  ($) => {
    // The SceneContext is shared by the whole file and its CRDT state outlives each
    // test: a repeated timestamp is rejected as outdated. Both counters only move
    // forward so every test gets a fresh entity and a strictly newer timestamp.
    let timestamp = 0
    let nextEntityId = 800

    beforeEach(() => {
      $.startEngine()
    })

    async function putRenderer(entity: Entity, value: PBMeshRenderer): Promise<void> {
      await $.ctx.crdtSendToRenderer({
        data: new CrdtBuilder().put(meshRendererComponent, entity, ++timestamp, value).finish()
      })
    }

    async function putCollider(entity: Entity, value: PBMeshCollider): Promise<void> {
      await $.ctx.crdtSendToRenderer({
        data: new CrdtBuilder().put(meshColliderComponent, entity, ++timestamp, value).finish()
      })
    }

    function meshOf(entity: Entity): AbstractMesh | null {
      return $.ctx.entities.get(entity)!.appliedComponents.meshRenderer!.mesh
    }

    function colliderOf(entity: Entity): AbstractMesh | null {
      return $.ctx.entities.get(entity)!.appliedComponents.meshCollider!.collider
    }

    describe('when a scene puts a MeshRenderer with a cylinder shape', () => {
      describe('and the radii are omitted', () => {
        let entity: Entity

        beforeEach(async () => {
          entity = nextEntityId++ as Entity
          await putRenderer(entity, { mesh: { $case: 'cylinder', cylinder: {} } })
        })

        // The branch did not exist: `mesh` stayed null and the entity rendered nothing.
        it('should build a cylinder mesh instead of leaving the entity empty', () => {
          expect(meshOf(entity)).not.toBeNull()
        })

        // Without a parent the mesh is not under the scene rootNode, so it is outside
        // the subtree culling, picking and raycasts traverse.
        it('should attach the mesh to the entity', () => {
          expect(meshOf(entity)!.parent).toBe($.ctx.entities.get(entity))
        })

        it('should default the top radius to 0.5', () => {
          expect(endCapRadius(meshOf(entity)!, 'top')).toBeCloseTo(0.5, 5)
        })

        it('should default the bottom radius to 0.5', () => {
          expect(endCapRadius(meshOf(entity)!, 'bottom')).toBeCloseTo(0.5, 5)
        })

        it('should build it one metre tall so it fits the unit box the Transform scales', () => {
          expect(meshOf(entity)!.getBoundingInfo().boundingBox.extendSize.y).toBeCloseTo(0.5, 5)
        })

        it('should enable the mesh so it is part of the rendered scene', () => {
          expect(meshOf(entity)!.isEnabled()).toBe(true)
        })

        it('should give it a material, as every other renderer shape gets', () => {
          expect(meshOf(entity)!.material).toBeTruthy()
        })
      })

      describe('and the radii differ from each other', () => {
        let entity: Entity

        beforeEach(async () => {
          entity = nextEntityId++ as Entity
          await putRenderer(entity, {
            mesh: { $case: 'cylinder', cylinder: { radiusTop: 2, radiusBottom: 0.5 } }
          })
        })

        it('should build the top ring at the requested top radius', () => {
          expect(endCapRadius(meshOf(entity)!, 'top')).toBeCloseTo(2, 5)
        })

        it('should build the bottom ring at the requested bottom radius rather than reusing the top one', () => {
          expect(endCapRadius(meshOf(entity)!, 'bottom')).toBeCloseTo(0.5, 5)
        })
      })

      describe('and the same entity also carries a MeshCollider with the same cylinder', () => {
        let entity: Entity

        beforeEach(async () => {
          entity = nextEntityId++ as Entity
          await putRenderer(entity, {
            mesh: { $case: 'cylinder', cylinder: { radiusTop: 1.5, radiusBottom: 0.25 } }
          })
          await putCollider(entity, {
            mesh: { $case: 'cylinder', cylinder: { radiusTop: 1.5, radiusBottom: 0.25 } }
          })
        })

        // Both go through createCylinderMesh precisely so they cannot drift: a
        // collider whose geometry disagrees with the mesh it stands in for resolves
        // raycasts and pointer picks against a shape the scene never asked for.
        it('should build vertex data identical to the collider it stands in for', () => {
          expect(Array.from(meshOf(entity)!.getVerticesData(VertexBuffer.PositionKind)!)).toEqual(
            Array.from(colliderOf(entity)!.getVerticesData(VertexBuffer.PositionKind)!)
          )
        })
      })

      describe('and a radius is hostile', () => {
        let entity: Entity

        beforeEach(async () => {
          entity = nextEntityId++ as Entity
          await putRenderer(entity, {
            mesh: {
              $case: 'cylinder',
              cylinder: { radiusTop: Number.POSITIVE_INFINITY, radiusBottom: 1e30 }
            }
          })
        })

        // The renderer shares the collider's clamp: an unguarded Infinity builds
        // vertex data full of NaN, and 1e30 builds geometry a million metres wide.
        it('should replace the non-finite radius with the 0.5 default', () => {
          expect(endCapRadius(meshOf(entity)!, 'top')).toBeCloseTo(0.5, 5)
        })

        it('should clamp the oversized radius to the configured primitive radius ceiling', () => {
          expect(endCapRadius(meshOf(entity)!, 'bottom')).toBeCloseTo(limits.maxPrimitiveRadiusMeters, 5)
        })
      })

      describe('and the scene replaces it with a box', () => {
        let entity: Entity
        let originalMesh: AbstractMesh

        beforeEach(async () => {
          entity = nextEntityId++ as Entity
          await putRenderer(entity, { mesh: { $case: 'cylinder', cylinder: { radiusTop: 2 } } })
          originalMesh = meshOf(entity)!
          // uvs is a non-optional repeated field on a renderer BoxMesh: the encoder
          // iterates it, so an absent list throws before the CRDT is even built.
          await putRenderer(entity, { mesh: { $case: 'box', box: { uvs: [] } } })
        })

        // A cylinder is built per entity rather than cloned, so nothing else owns it:
        // if the replace path leaks it, the geometry stays in the scene forever.
        it('should dispose the cylinder it replaced', () => {
          expect(originalMesh.isDisposed()).toBe(true)
        })

        it('should build the unit cube in its place', () => {
          expect(meshOf(entity)!.getBoundingInfo().boundingBox.extendSize.asArray()).toEqual([0.5, 0.5, 0.5])
        })
      })
    })
  }
)
