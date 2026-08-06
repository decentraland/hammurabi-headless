import { Quaternion, Ray, Vector3 } from '@babylonjs/core'
import { Scene } from '@dcl/schemas'
import { ColliderLayer } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen'
import { RaycastQueryType } from '@dcl/protocol/out-js/decentraland/sdk/components/raycast.gen'
import { meshColliderComponent } from '../../../../../src/lib/decentraland/sdk-components/mesh-collider-component'
import { transformComponent } from '../../../../../src/lib/decentraland/sdk-components/transform-component'
import {
  raycastComponent,
  raycastResultComponent
} from '../../../../../src/lib/decentraland/sdk-components/raycast-component'
import { processRaycasts } from '../../../../../src/lib/babylon/scene/logic/raycasts'
import { pickMeshesForMask } from '../../../../../src/lib/babylon/scene/logic/colliders'
import { Entity } from '../../../../../src/lib/decentraland/types'
import { CrdtBuilder, testWithEngine } from '../../babylon-test-helper'

// The raycast prefilter reads minimumWorld/maximumWorld, which `getBoundingInfo()`
// re-derives from the CACHED world matrix — it does not recompute one. Babylon's
// `_evaluateActiveMeshes` skips any mesh that is `!isEnabled()`, `scene-culling.ts`
// disables the whole scene root once it leaves the camera frustum, and
// `pickMeshesForMask` keeps offering those meshes as raycast candidates anyway.
// Meanwhile `computeRayDirection` reads a FRESH matrix for the ray's own entity.
// So without an explicit refresh the ray moves and the colliders do not, and a
// collider moved into the ray's path answers a false miss.
//
// The path the prefilter replaced never hit this: `Ray.intersectsMesh` calls
// `getWorldMatrix()` per mesh and tests in local space.
//
// There is deliberately no assertion here that reads the stale bounds directly:
// the scene's continuous raycast is pending, so any crdtSendToRenderer in setup
// drives a frame through processRaycasts, which refreshes them. Such a test would
// pass only WITHOUT the fix — the opposite of a regression test. Removing the
// refresh instead makes the three hit assertions below fail, which is the property
// worth pinning.
//
// The setup is shaped by two mutants that an earlier version of this file let
// through, both now pinned:
//   - a sweep of only `meshes[0]` — hence the decoy collider, PUT ahead of the one
//     that moves, so "swept every candidate" differs from "swept the first";
//   - a sweep that runs AFTER `getBoundingInfo()` — hence no explicit
//     processRaycasts() call in any test. `crdtSendToRenderer` resolves out of
//     lateUpdate, so the setup's last await already drove the pass that first sees
//     the move; a second pass reads bounds an after-the-fact sweep has already
//     healed, and passes either way.
// Only the disabled-root case needs the sweep at all. Measured with the root left
// ENABLED, the same move resolves correctly with the sweep deleted outright — so
// there is no enabled-root test here, because there would be nothing for it to pin.

const MASK = ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS
const RAYCAST_ENTITY = 512 as Entity
// Scene based at parcel 1,1, so rootNode sits at world (16,0,16). Deliberately NOT
// 0,0: SceneContext only builds `boundingBox` when `if (minX)` is truthy, so a
// scene at 0,0 is never culled and could not exhibit this at all.
const RAY_ORIGIN_WORLD = new Vector3(16 + 8, 1, 16 + 2)
const PARKED_X = 100

testWithEngine(
  'raycast prefilter against stale world bounds',
  {
    baseUrl: '/',
    entity: {
      content: [],
      metadata: { scene: { base: '1,1', parcels: ['1,1'] } } as unknown as Scene,
      type: 'scene'
    },
    urn: 'raycast-stale-bounds'
  },
  ($) => {
    let timestamp = 0
    let nextColliderEntity = 600
    let colliderEntity: Entity
    let decoyEntity: Entity

    const transform = (x: number, y: number, z: number) => ({
      position: new Vector3(x, y, z),
      rotation: Quaternion.Identity(),
      scale: new Vector3(1, 1, 1),
      parent: 0 as Entity
    })

    const meshOf = (entity: Entity) => $.ctx.entities.get(entity)!.appliedComponents.meshCollider!.collider!
    const colliderMesh = () => meshOf(colliderEntity)
    const decoyMesh = () => meshOf(decoyEntity)
    const lastResult = () =>
      $.ctx.components[raycastResultComponent.componentId].getOrNull(RAYCAST_ENTITY) as any
    const candidates = () => Array.from(pickMeshesForMask($.ctx.rootNode, MASK))

    beforeAll(async () => {
      $.startEngine()
      // A continuous raycast at scene-local (8,1,2) firing along +Z.
      await $.ctx.crdtSendToRenderer({
        data: new CrdtBuilder()
          .put(transformComponent, RAYCAST_ENTITY, ++timestamp, transform(8, 1, 2))
          .put(raycastComponent, RAYCAST_ENTITY, ++timestamp, {
            timestamp: 1,
            maxDistance: 100,
            queryType: RaycastQueryType.RQT_HIT_FIRST,
            continuous: true,
            collisionMask: MASK,
            direction: { $case: 'globalDirection', globalDirection: new Vector3(0, 0, 1) }
          } as any)
          .finish()
      })
    })

    describe('when the scene root is disabled and a collider moves into the ray path', () => {
      beforeEach(async () => {
        // Fresh colliders per test, both parked off the ray while the root is ENABLED
        // so _evaluateActiveMeshes computes their matrices once, then ONE of them is
        // moved into the path while the root is DISABLED so nothing recomputes it.
        //
        // The decoy exists so the sweep has to iterate. It is PUT first, and the guard
        // below pins that it really is candidate 0: with a single collider a sweep of
        // just `meshes[0]` covers everything, and the mutant that refreshes only the
        // first mesh passes. Parked far off the ray and never moved, so it changes no
        // hit — it only makes "swept every mesh" distinguishable from "swept one".
        const previousDecoy = decoyEntity
        const previousCollider = colliderEntity
        decoyEntity = nextColliderEntity++ as Entity
        colliderEntity = nextColliderEntity++ as Entity

        const collider = { collisionMask: MASK, mesh: { $case: 'box', box: {} } } as any
        const setup = new CrdtBuilder()
        if (previousDecoy !== undefined) setup.deleteEntity(previousDecoy).deleteEntity(previousCollider)
        await $.ctx.crdtSendToRenderer({
          data: setup
            .put(transformComponent, decoyEntity, ++timestamp, transform(PARKED_X + 20, 1, 8))
            .put(meshColliderComponent, decoyEntity, ++timestamp, collider)
            .put(transformComponent, colliderEntity, ++timestamp, transform(PARKED_X, 1, 8))
            .put(meshColliderComponent, colliderEntity, ++timestamp, collider)
            .finish()
        })

        // Exactly what scene-culling.ts does when the scene leaves the frustum.
        $.ctx.rootNode.setEnabled(false)

        // The frame that moves the collider into the ray path. `crdtSendToRenderer`
        // resolves out of lateUpdate, which drives processRaycasts, so THIS await is
        // the pass under test — the first one that sees the moved collider. The tests
        // below deliberately do not call processRaycasts again: a second pass is
        // already healed by whatever the first one refreshed, so an after-the-fact
        // sweep would pass. Asserting on the first pass is what pins that the refresh
        // happens BEFORE the bounds are read.
        await $.ctx.crdtSendToRenderer({
          data: new CrdtBuilder()
            .put(transformComponent, colliderEntity, ++timestamp, transform(8, 1, 8))
            .finish()
        })
      })

      afterEach(() => {
        $.ctx.rootNode.setEnabled(true)
      })

      // Not a test of processRaycasts — it pins `pickMeshesForMask`, and it is also the
      // fixture's own guard: the mutation that sweeps only `meshes[0]` is
      // indistinguishable from a correct sweep unless the mover is NOT first.
      //
      // Compared as booleans/counts, never by handing Babylon meshes to a matcher.
      // pretty-format walks a mesh's whole object graph on mismatch: measured at
      // 2.57M characters for ONE mesh in a 2-mesh scene and 36M in a 22-mesh one,
      // which is enough to kill the jest worker with a heap OOM and report nothing
      // at all. A failure you cannot read is not a test.
      it('should offer both colliders as raycast candidates, disabled subtree and all', () => {
        const found = candidates()
        expect(found.length).toBe(2)
        expect(found[0] === decoyMesh()).toBe(true)
        expect(found[1] === colliderMesh()).toBe(true)
      })

      it('should find the hit on the very pass that applies the move', () => {
        expect(lastResult().hits).toHaveLength(1)
      })

      it('should report the hit against the collider that moved rather than the parked decoy', () => {
        expect(lastResult().hits[0].entityId).toBe(colliderEntity)
      })

      // Differential against the path the prefilter replaced: `Ray.intersectsMesh`
      // calls `getWorldMatrix()` per mesh and tests in LOCAL space, so it is immune to
      // the staleness by construction and stands in for the right answer. Asserting
      // that processRaycasts AGREES with it is what makes this a test of this
      // codebase; asserting the baseline alone would only test Babylon.
      it('should agree with the pre-prefilter path, which refreshed via getWorldMatrix', () => {
        const ray = new Ray(RAY_ORIGIN_WORLD.clone(), new Vector3(0, 0, 1), 999)
        const entityOfMesh = (uniqueId: number) =>
          uniqueId === colliderMesh().uniqueId ? colliderEntity : uniqueId === decoyMesh().uniqueId ? decoyEntity : -1
        const baseline = ray.intersectsMeshes(candidates() as any, false)

        expect(lastResult().hits.map((hit: any) => hit.entityId)).toEqual(
          baseline.map((result) => entityOfMesh(result.pickedMesh!.uniqueId))
        )
      })
    })
  }
)
