// ASSERTION STYLE — do not hand a Babylon mesh or material to a matcher.
// `toBe`/`toEqual`/`toBeUndefined` pretty-print their operands on failure, and
// pretty-format walks a Babylon node's whole object graph: measured at 2,572,921
// characters for ONE mesh in a 2-mesh scene and 36,249,465 in a 22-mesh one, so the
// cost scales with the SCENE rather than the value under test. In the sibling
// collider spec that was enough to kill the jest worker with a heap OOM and emit no
// report at all — a mutation was misrecorded as SURVIVING because jest never wrote
// its JSON. Compare references with `===` and assert the boolean, or assert a
// scalar (name, length, count). A failure you cannot read is not a test.

import { AbstractMesh, VertexBuffer } from '@babylonjs/core'
import { Scene } from '@dcl/schemas'
import { PBMeshCollider } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen'
import { PBMeshRenderer } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_renderer.gen'
import { baseMaterial } from '../../../../src/lib/babylon/scene/BabylonEntity'
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
//
// The box/sphere/plane branches are covered too even though they predate this change:
// every one of them clones or builds through the same primitive-meshes functions the
// collider uses now, so an untested renderer branch is a place the two can drift apart
// unnoticed.

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

/** Distance from the mesh origin of the vertex nearest to / farthest from it. */
function vertexDistanceRange(mesh: AbstractMesh): [number, number] {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!
  let min = Number.POSITIVE_INFINITY
  let max = 0
  for (let i = 0; i < positions.length; i += 3) {
    const distance = Math.hypot(positions[i], positions[i + 1], positions[i + 2])
    min = Math.min(min, distance)
    max = Math.max(max, distance)
  }
  return [min, max]
}

/** Half the diagonal of a unit cube: where every one of its 24 vertices sits. */
const UNIT_CUBE_VERTEX_DISTANCE = Math.sqrt(0.75)

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

    async function deleteRenderer(entity: Entity): Promise<void> {
      await $.ctx.crdtSendToRenderer({
        data: new CrdtBuilder().delete(meshRendererComponent, entity, ++timestamp).finish()
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
          expect(meshOf(entity)!.parent === $.ctx.entities.get(entity)).toBe(true)
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

        // Weak on its own — MeshBuilder hands back an enabled mesh, so the branch's
        // own setEnabled(true) is redundant here. It is the CLONED branches (box,
        // sphere, plane) whose templates are disabled, and their copies of this
        // assertion are the ones that can actually fail.
        it('should enable the mesh so it is part of the rendered scene', () => {
          expect(meshOf(entity)!.isEnabled()).toBe(true)
        })

        // Asserted by identity, not truthiness: the cylinder branch does not assign
        // a material of its own (unlike the cloned templates, which inherit one), so
        // this is entirely setMeshRendererMaterial's doing and a truthiness check
        // could not tell the two sources apart.
        it('should be given the shared base material by setMeshRendererMaterial', () => {
          expect(meshOf(entity)!.material === baseMaterial($.scene)).toBe(true)
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

    describe('when a scene puts a MeshRenderer with a box shape', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = nextEntityId++ as Entity
        // uvs is a non-optional repeated field on a BoxMesh: the encoder iterates it,
        // so an absent list throws before the CRDT is even built.
        await putRenderer(entity, { mesh: { $case: 'box', box: { uvs: [] } } })
      })

      it('should build a unit cube spanning half a metre from the entity origin on every axis', () => {
        expect(meshOf(entity)!.getBoundingInfo().boundingBox.extendSize.asArray()).toEqual([0.5, 0.5, 0.5])
      })

      // extendSize cannot tell a cube from a diameter-1 sphere; vertex positions can.
      it('should place every vertex on a cube corner rather than on a sphere surface', () => {
        const [nearest, farthest] = vertexDistanceRange(meshOf(entity)!)
        expect([nearest, farthest]).toEqual([
          expect.closeTo(UNIT_CUBE_VERTEX_DISTANCE, 5),
          expect.closeTo(UNIT_CUBE_VERTEX_DISTANCE, 5)
        ])
      })

      // The template is built disabled and clone() inherits that, so the branch has
      // to re-enable: without it the entity carries geometry nothing ever draws or
      // traverses, and no other assertion here notices.
      it('should enable the clone so it is part of the rendered scene', () => {
        expect(meshOf(entity)!.isEnabled()).toBe(true)
      })

      // Unparented, the mesh is outside the scene rootNode subtree that culling,
      // picking and raycasts walk — present in the scene and reachable by nothing.
      it('should attach the mesh to the entity', () => {
        expect(meshOf(entity)!.parent === $.ctx.entities.get(entity)).toBe(true)
      })
    })

    describe('when a scene puts a MeshRenderer with a sphere shape', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = nextEntityId++ as Entity
        await putRenderer(entity, { mesh: { $case: 'sphere', sphere: {} } })
      })

      // Left to Babylon's default the diameter is 1 anyway, so a dropped `diameter`
      // is invisible here — but the constant is what keeps renderer and collider in
      // step, and this pins the size the protocol specifies rather than the default.
      it('should build a diameter-1 sphere that fits the unit box the Transform scales', () => {
        expect(meshOf(entity)!.getBoundingInfo().boundingBox.extendSize.asArray()).toEqual([0.5, 0.5, 0.5])
      })

      it('should place every vertex on the sphere surface rather than at cube corners', () => {
        const [nearest, farthest] = vertexDistanceRange(meshOf(entity)!)
        expect([nearest, farthest]).toEqual([expect.closeTo(0.5, 5), expect.closeTo(0.5, 5)])
      })

      it('should enable the clone so it is part of the rendered scene', () => {
        expect(meshOf(entity)!.isEnabled()).toBe(true)
      })

      it('should attach the mesh to the entity', () => {
        expect(meshOf(entity)!.parent === $.ctx.entities.get(entity)).toBe(true)
      })

      describe('and the same entity also carries a MeshCollider with a sphere', () => {
        beforeEach(async () => {
          await putCollider(entity, { mesh: { $case: 'sphere', sphere: {} } })
        })

        // Both come from createSphereMesh, so the pinned segment count cannot drift
        // between what is drawn and what raycasts resolve against. Nothing but this
        // stops one of the two picking up Babylon's implicit default again.
        it('should build vertex data identical to the collider it stands in for', () => {
          expect(Array.from(meshOf(entity)!.getVerticesData(VertexBuffer.PositionKind)!)).toEqual(
            Array.from(colliderOf(entity)!.getVerticesData(VertexBuffer.PositionKind)!)
          )
        })
      })
    })

    describe('when a scene puts a MeshRenderer with a plane shape', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = nextEntityId++ as Entity
        // uvs is a non-optional repeated field on a PlaneMesh, like BoxMesh's.
        await putRenderer(entity, { mesh: { $case: 'plane', plane: { uvs: [] } } })
      })

      it('should build a 1x1 quad with no depth instead of a cube', () => {
        expect(meshOf(entity)!.getBoundingInfo().boundingBox.extendSize.asArray()).toEqual([0.5, 0.5, 0])
      })

      // DOUBLESIDE, unlike the collider's quad: this one is DRAWN and a PlaneMesh is
      // visible from both sides. It shows up as doubled geometry — 8 vertices / 4
      // triangles against 4 / 2 — which is the only observable difference and so the
      // only way a dropped sideOrientation can be caught.
      it('should double the geometry so the plane is visible from behind as well', () => {
        expect(meshOf(entity)!.getTotalVertices()).toBe(8)
      })

      // Pins what a deleted `else` branch used to write by hand. Babylon already
      // generates exactly these 16 values for a DOUBLESIDE plane, so the branch was a
      // no-op copy of a Babylon internal; this asserts the internal still produces
      // the layout the protocol describes ("2D * 1 face * 2 sides * 4 vertices")
      // instead of keeping a second copy of it in the source.
      it('should carry the default 16-value UV map a double-sided quad needs', () => {
        expect(Array.from(meshOf(entity)!.getVerticesData(VertexBuffer.UVKind)!)).toEqual([
          0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1
        ])
      })

      it('should enable the mesh so it is part of the rendered scene', () => {
        expect(meshOf(entity)!.isEnabled()).toBe(true)
      })

      it('should attach the mesh to the entity', () => {
        expect(meshOf(entity)!.parent === $.ctx.entities.get(entity)).toBe(true)
      })

      describe('and the scene supplies its own UV map', () => {
        let uvs: number[]

        beforeEach(async () => {
          uvs = [0, 0, 0.5, 0, 0.5, 0.5, 0, 0.5, 0, 0, 0.5, 0, 0.5, 0.5, 0, 0.5]
          entity = nextEntityId++ as Entity
          await putRenderer(entity, { mesh: { $case: 'plane', plane: { uvs } } })
        })

        // The whole reason the plane is built `updatable` rather than cloned from a
        // template: the UVs are per entity.
        it('should write the scene UV map over the generated one', () => {
          expect(Array.from(meshOf(entity)!.getVerticesData(VertexBuffer.UVKind)!)).toEqual(uvs)
        })
      })
    })

    describe('when a scene deletes the MeshRenderer component', () => {
      let entity: Entity
      let originalMesh: AbstractMesh

      beforeEach(async () => {
        entity = nextEntityId++ as Entity
        await putRenderer(entity, { mesh: { $case: 'box', box: { uvs: [] } } })
        originalMesh = meshOf(entity)!
        await deleteRenderer(entity)
      })

      // A mesh surviving its component keeps rendering and stays in the entity's
      // child list forever.
      it('should dispose the mesh it was rendering', () => {
        expect(originalMesh.isDisposed()).toBe(true)
      })

      // Nothing below the clear reassigns the entry on a DELETE, so leaving it in
      // place hands the DISPOSED mesh to setMeshRendererMaterial on the next
      // Material PUT — and blocks the next MeshRenderer PUT's own clear from
      // finding a live mesh to dispose.
      it('should clear the applied component so no stale reference to the disposed mesh remains', () => {
        // `=== undefined`, not `'meshRenderer' in …`: the applier ASSIGNS undefined
        // rather than deleting the key, so the `in` check is true and asserts the
        // opposite of what this test is named for.
        expect($.ctx.entities.get(entity)!.appliedComponents.meshRenderer === undefined).toBe(true)
      })
    })
  }
)
