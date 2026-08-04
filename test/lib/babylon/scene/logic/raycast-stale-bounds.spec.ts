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
// refresh instead makes the two hit assertions below fail, which is the property
// worth pinning.

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

    const transform = (x: number, y: number, z: number) => ({
      position: new Vector3(x, y, z),
      rotation: Quaternion.Identity(),
      scale: new Vector3(1, 1, 1),
      parent: 0 as Entity
    })

    const colliderMesh = () => $.ctx.entities.get(colliderEntity)!.appliedComponents.meshCollider!.collider!
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
        // Fresh collider per test, parked off the ray while the root is ENABLED so
        // _evaluateActiveMeshes computes its matrix once, then moved into the path
        // while the root is DISABLED so nothing recomputes it.
        const previous = colliderEntity
        colliderEntity = nextColliderEntity++ as Entity

        const setup = new CrdtBuilder()
        if (previous !== undefined) setup.deleteEntity(previous)
        await $.ctx.crdtSendToRenderer({
          data: setup
            .put(transformComponent, colliderEntity, ++timestamp, transform(PARKED_X, 1, 8))
            .put(meshColliderComponent, colliderEntity, ++timestamp, {
              collisionMask: MASK,
              mesh: { $case: 'box', box: {} }
            } as any)
            .finish()
        })

        // Exactly what scene-culling.ts does when the scene leaves the frustum.
        $.ctx.rootNode.setEnabled(false)

        await $.ctx.crdtSendToRenderer({
          data: new CrdtBuilder()
            .put(transformComponent, colliderEntity, ++timestamp, transform(8, 1, 8))
            .finish()
        })
      })

      afterEach(() => {
        $.ctx.rootNode.setEnabled(true)
      })

      it('should still offer the collider as a raycast candidate, disabled subtree and all', () => {
        // Compared as booleans/counts, never by handing Babylon meshes to a matcher.
        // pretty-format walks a mesh's whole object graph on mismatch: measured at
        // 2.57M characters for ONE mesh in a 2-mesh scene and 36M in a 22-mesh one,
        // which is enough to kill the jest worker with a heap OOM and report nothing
        // at all. A failure you cannot read is not a test.
        const found = candidates()
        expect(found.length).toBe(1)
        expect(found[0] === colliderMesh()).toBe(true)
      })

      it('should still find the hit, because processRaycasts refreshes the matrices first', () => {
        processRaycasts($.ctx)
        expect(lastResult().hits).toHaveLength(1)
      })

      it('should report the hit against the collider that moved', () => {
        processRaycasts($.ctx)
        expect(lastResult().hits[0].entityId).toBe(colliderEntity)
      })

      it('should agree with the pre-prefilter path, which refreshed via getWorldMatrix', () => {
        const ray = new Ray(RAY_ORIGIN_WORLD.clone(), new Vector3(0, 0, 1), 999)
        const results = ray.intersectsMeshes(candidates() as any, false)
        expect(results.map((result) => result.pickedMesh!.name)).toEqual(['box_collider'])
      })
    })
  }
)
