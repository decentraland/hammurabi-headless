import * as BABYLON from '@babylonjs/core'
import { Scene } from '@dcl/schemas'
import { Entity } from '../../../src/lib/decentraland/types'
import { testWithEngine, CrdtBuilder } from './babylon-test-helper'
import { processRaycasts } from '../../../src/lib/babylon/scene/logic/raycasts'
import { raycastComponent, raycastResultComponent } from '../../../src/lib/decentraland/sdk-components/raycast-component'
import { setColliderMask } from '../../../src/lib/babylon/scene/logic/colliders'
import { ColliderLayer } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen'
import { RaycastQueryType } from '@dcl/protocol/out-js/decentraland/sdk/components/raycast.gen'

const MASK = ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER
const RAY_ENTITY = 512 as Entity

function raycast(maxDistance: number, timestamp: number) {
  return {
    timestamp,
    maxDistance,
    queryType: RaycastQueryType.RQT_HIT_FIRST,
    continuous: true,
    collisionMask: MASK
  } as any
}

// Regression: PBRaycast.maxDistance was ignored (the ray used a hard-coded reach
// of 999), and the per-entity Ray is reused across frames — so maxDistance must
// be applied on EVERY pass, not lingered from a previous one.
testWithEngine('raycast honors maxDistance on a reused ray', {
  baseUrl: '/',
  entity: { content: [], metadata: {} as Scene, type: 'scene' },
  urn: '123'
}, ($) => {
  beforeEach(() => $.startEngine())

  test('a collider beyond maxDistance is missed, and re-arming with a larger maxDistance then hits it', async () => {
    // A collider box centered at z=10 (world), parented to the scene root.
    const box = BABYLON.MeshBuilder.CreateBox('target', { size: 2 }, $.scene)
    box.parent = $.ctx.rootNode
    box.position.set(0, 0, 10)
    box.computeWorldMatrix(true)
    setColliderMask(box, MASK)

    const RaycastResult = $.ctx.components[raycastResultComponent.componentId]

    // 1) maxDistance 5 — the box (~z=9 near face) is out of range → no hit.
    await $.ctx.crdtSendToRenderer({
      data: new CrdtBuilder().put(raycastComponent, RAY_ENTITY, 1, raycast(5, 1)).finish()
    })
    processRaycasts($.ctx)
    expect(RaycastResult.getOrNull(RAY_ENTITY)?.hits ?? []).toHaveLength(0)

    // 2) re-arm the SAME continuous raycast with maxDistance 50 — now in range →
    // hit. This only passes if maxDistance updates the reused Ray's length.
    await $.ctx.crdtSendToRenderer({
      data: new CrdtBuilder().put(raycastComponent, RAY_ENTITY, 2, raycast(50, 2)).finish()
    })
    processRaycasts($.ctx)
    expect((RaycastResult.getOrNull(RAY_ENTITY)?.hits ?? []).length).toBeGreaterThan(0)

    // 3) re-arm again with maxDistance 5 — the reused Ray must revert to the short
    // reach (a stale length of 50 would keep hitting) → no hit.
    await $.ctx.crdtSendToRenderer({
      data: new CrdtBuilder().put(raycastComponent, RAY_ENTITY, 3, raycast(5, 3)).finish()
    })
    processRaycasts($.ctx)
    expect(RaycastResult.getOrNull(RAY_ENTITY)?.hits ?? []).toHaveLength(0)

    // 4) re-arm with maxDistance 0 (unset) — must revert to the DEFAULT reach and
    // hit the box again. Setting ray.length only when maxDistance > 0 would leave
    // the stale short length (5) from step 3 and keep missing.
    await $.ctx.crdtSendToRenderer({
      data: new CrdtBuilder().put(raycastComponent, RAY_ENTITY, 4, raycast(0, 4)).finish()
    })
    processRaycasts($.ctx)
    expect((RaycastResult.getOrNull(RAY_ENTITY)?.hits ?? []).length).toBeGreaterThan(0)
  })
})
