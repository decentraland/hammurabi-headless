import { Quaternion, Vector3 } from '@babylonjs/core'
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
import { Entity } from '../../../../../src/lib/decentraland/types'
import { CrdtBuilder, testWithEngine } from '../../babylon-test-helper'

// Parity with the reference client (unity-explorer), checked against
// `DCL/Interaction/Utility/RaycastUtils.cs`, `Raycast/Systems/ExecuteRaycastSystem.cs`
// and `Raycast/Components/PBRaycastDefaults.cs`.
//
// Every case here is one where this server previously answered differently from
// the client every player is running. On a headless AUTHORITATIVE server that is
// the whole ballgame: the server decides what was clicked and where a player may
// stand, so a disagreement is not a rendering nicety.
//
// Two of these deliberately follow the CLIENT where it contradicts raycast.proto.
// That is a decision, not an oversight, and each is called out below.

const PHYSICS_ONLY = ColliderLayer.CL_PHYSICS
const POINTER_ONLY = ColliderLayer.CL_POINTER

testWithEngine(
  'raycast parity with the reference client',
  {
    baseUrl: '/',
    // Parcel 1,1: root at world (16,0,16), so any scene-space conversion that is
    // applied one time too many shows up instead of cancelling to zero.
    entity: {
      content: [],
      metadata: { scene: { base: '1,1', parcels: ['1,1'] } } as unknown as Scene,
      type: 'scene'
    },
    urn: 'raycast-parity'
  },
  ($) => {
    let t = 0
    let nextEntity = 700
    let raycastEntity: Entity

    const transform = (position: Vector3, rotation = Quaternion.Identity(), scale = new Vector3(1, 1, 1)) => ({
      position,
      rotation,
      scale,
      parent: 0 as Entity
    })

    const resultOf = (entity: Entity) =>
      $.ctx.components[raycastResultComponent.componentId].getOrNull(entity) as any

    // The SceneContext is shared by the whole file, so colliders MUST be torn down
    // between tests. Without this the scaled-entity case below silently hit a
    // leftover collider from the preceding describe and "passed" a range check it
    // was not performing — the assertion measured the wrong collider entirely.
    let created: Entity[] = []

    beforeEach(() => {
      $.startEngine()
      created = []
    })

    afterEach(async () => {
      if (!created.length) return
      const teardown = new CrdtBuilder()
      for (const entity of created) teardown.deleteEntity(entity)
      await $.ctx.crdtSendToRenderer({ data: teardown.finish() })
    })

    /** A unit box collider on the given layer, at a scene-local position. */
    async function putCollider(position: Vector3, layer: number): Promise<Entity> {
      const entity = nextEntity++ as Entity
      created.push(entity)
      await $.ctx.crdtSendToRenderer({
        data: new CrdtBuilder()
          .put(transformComponent, entity, ++t, transform(position))
          .put(meshColliderComponent, entity, ++t, { collisionMask: layer, mesh: { $case: 'box', box: {} } } as any)
          .finish()
      })
      return entity
    }

    async function fire(raycast: Record<string, unknown>, entityTransform = transform(Vector3.Zero())): Promise<void> {
      raycastEntity = nextEntity++ as Entity
      created.push(raycastEntity)
      await $.ctx.crdtSendToRenderer({
        data: new CrdtBuilder()
          .put(transformComponent, raycastEntity, ++t, entityTransform)
          .put(raycastComponent, raycastEntity, ++t, { timestamp: 1, continuous: false, ...raycast } as any)
          .finish()
      })
      processRaycasts($.ctx)
    }

    // RaycastUtils.TryCreateRay: `rayOrigin = entityPosition + sdkRaycast.OriginOffset`.
    // A world-space add — the offset is NOT rotated by the entity. Running it
    // through the entity world matrix (as this did) agreed only for an unrotated
    // entity and silently swung the ray's start point for every other one.
    describe('when a rotated entity offsets its ray origin', () => {
      beforeEach(async () => {
        // Collider 10m along +Z from the scene origin. The offset moves the ray
        // start to (0,0,5); rotating that offset instead would put it at (5,0,0),
        // firing parallel to the collider and missing entirely.
        await putCollider(new Vector3(0, 0, 10), PHYSICS_ONLY)
        await fire(
          {
            maxDistance: 6,
            queryType: RaycastQueryType.RQT_HIT_FIRST,
            collisionMask: PHYSICS_ONLY,
            originOffset: new Vector3(0, 0, 5),
            direction: { $case: 'globalDirection', globalDirection: new Vector3(0, 0, 1) }
          },
          transform(Vector3.Zero(), Quaternion.RotationYawPitchRoll(Math.PI / 2, 0, 0))
        )
      })

      it('should add the offset in world space rather than rotating it with the entity', () => {
        expect(resultOf(raycastEntity).hits).toHaveLength(1)
      })
    })

    // The client computes `rayOrigin = entityPosition + OriginOffset` but every
    // direction as `target - entityPosition`. Subtracting the OFFSET origin instead
    // skewed the aim by that offset — and the offset case above only covered
    // globalDirection, where direction is offset-independent and the bug is invisible.
    describe('when a globalTarget raycast also carries an originOffset', () => {
      beforeEach(async () => {
        // Entity at the scene origin, offset 5m along +X, target 10m along +Z. Aiming
        // from the ENTITY gives (0,0,1); aiming from the offset origin gives a vector
        // skewed by -5 on X.
        await fire({
          maxDistance: 100,
          queryType: RaycastQueryType.RQT_HIT_FIRST,
          collisionMask: PHYSICS_ONLY,
          originOffset: new Vector3(5, 0, 0),
          direction: { $case: 'globalTarget', globalTarget: new Vector3(0, 0, 10) }
        })
      })

      it('should aim from the entity position, not from the offset ray origin', () => {
        const direction = resultOf(raycastEntity).direction
        expect([direction.x, direction.y, direction.z].map((n) => Math.round(n * 1000) / 1000)).toEqual([0, 0, 1])
      })
    })

    // RaycastUtils.TryCreateRay: `rayDirection = entityRotation * sdkRaycast.LocalDirection`,
    // then `.normalized`. Rotation only — no scale — and unit length.
    //
    // Not observable through the reported direction, which is normalized on the way
    // out either way. It shows up in RANGE: Babylon measures a ray in units of its
    // direction vector, so a direction of length 2 doubles what maxDistance means.
    describe('when a scaled entity fires along a local direction', () => {
      beforeEach(async () => {
        // Collider at 15m, range asked for 10m. Correct: miss. Folding the entity's
        // 2x scale into the direction makes the ray effectively 20m and it hits.
        await putCollider(new Vector3(0, 0, 15), PHYSICS_ONLY)
        await fire(
          {
            maxDistance: 10,
            queryType: RaycastQueryType.RQT_HIT_FIRST,
            collisionMask: PHYSICS_ONLY,
            direction: { $case: 'localDirection', localDirection: new Vector3(0, 0, 1) }
          },
          transform(Vector3.Zero(), Quaternion.Identity(), new Vector3(2, 2, 2))
        )
      })

      it('should keep maxDistance meaning metres, not entity-scaled units', () => {
        expect(resultOf(raycastEntity).hits).toHaveLength(0)
      })
    })

    // RaycastUtils.TryCreateRay ends its switch with `default: ray = default;
    // return false` — an unset direction oneof is malformed data, not a request for
    // a forward ray. The client logs "Raycast data is malformed" and writes nothing.
    //
    // We stay quiet rather than logging: a scene can hold a malformed CONTINUOUS
    // raycast and reach this every frame forever, and an unthrottled
    // scene-triggerable log is an amplification vector. The absent RaycastResult is
    // the signal.
    describe('when a scene sets no direction at all', () => {
      beforeEach(async () => {
        await putCollider(new Vector3(0, 0, 10), PHYSICS_ONLY)
        await fire({
          maxDistance: 100,
          queryType: RaycastQueryType.RQT_HIT_FIRST,
          collisionMask: PHYSICS_ONLY,
          direction: undefined
        })
      })

      it('should write no result rather than inventing a local forward ray', () => {
        expect(resultOf(raycastEntity) === null).toBe(true)
      })
    })

    // `if (rayDirection == Vector3.zero) { ray = default; return false; }`.
    // Load-bearing rather than tidy: `Vector3.normalize()` LEAVES a zero vector
    // unchanged (Babylon guards the divide), so without this the ray would keep
    // direction (0,0,0) and be answered as though it meant something.
    describe('when a scene asks for a zero-length direction', () => {
      beforeEach(async () => {
        await putCollider(new Vector3(0, 0, 10), PHYSICS_ONLY)
        await fire({
          maxDistance: 100,
          queryType: RaycastQueryType.RQT_HIT_FIRST,
          collisionMask: PHYSICS_ONLY,
          direction: { $case: 'globalDirection', globalDirection: new Vector3(0, 0, 0) }
        })
      })

      it('should treat it as malformed and write no result', () => {
        expect(resultOf(raycastEntity) === null).toBe(true)
      })
    })

    // RaycastUtils.TryCreateRay: `targetTransform.Transform.position - entityPosition`.
    // Both are already world-space; nothing converts through the scene root.
    describe('when a ray points at another entity in a scene away from the origin', () => {
      beforeEach(async () => {
        const target = await putCollider(new Vector3(0, 0, 10), PHYSICS_ONLY)
        await fire({
          maxDistance: 100,
          queryType: RaycastQueryType.RQT_HIT_FIRST,
          collisionMask: PHYSICS_ONLY,
          direction: { $case: 'targetEntity', targetEntity: target }
        })
      })

      // Measured against the bug: at parcel 1,1 a target 10m along +Z produced
      // (0.5241, 0, 0.8517) instead of (0, 0, 1), because the scene root was added
      // to a position that already included it.
      it('should point straight at the target rather than off by the scene root offset', () => {
        const direction = resultOf(raycastEntity).direction
        expect([direction.x, direction.y, direction.z].map((n) => Math.round(n * 1000) / 1000)).toEqual([0, 0, 1])
      })

      it('should actually hit the entity it was aimed at', () => {
        expect(resultOf(raycastEntity).hits).toHaveLength(1)
      })
    })

    // PBRaycastDefaults.GetCollisionMask: `HasCollisionMask ? mask : ClPhysics`.
    //
    // DELIBERATELY CONTRADICTS raycast.proto, which documents the default as
    // "CL_POINTER | CL_PHYSICS". Where the shipped client and the protocol text
    // disagree, this server follows the client — matching the renderer every
    // player runs matters more than matching a comment.
    describe('when a raycast leaves its collisionMask unset', () => {
      let physicsHits: number
      let pointerHits: number

      beforeEach(async () => {
        await putCollider(new Vector3(0, 0, 10), PHYSICS_ONLY)
        await fire({
          maxDistance: 100,
          queryType: RaycastQueryType.RQT_HIT_FIRST,
          direction: { $case: 'globalDirection', globalDirection: new Vector3(0, 0, 1) }
        })
        physicsHits = resultOf(raycastEntity).hits.length

        await putCollider(new Vector3(20, 0, 10), POINTER_ONLY)
        await fire(
          {
            maxDistance: 100,
            queryType: RaycastQueryType.RQT_HIT_FIRST,
            direction: { $case: 'globalDirection', globalDirection: new Vector3(0, 0, 1) }
          },
          transform(new Vector3(20, 0, 0))
        )
        pointerHits = resultOf(raycastEntity).hits.length
      })

      it('should hit a CL_PHYSICS collider', () => {
        expect(physicsHits).toBe(1)
      })

      it('should NOT hit a CL_POINTER-only collider, matching the client default', () => {
        expect(pointerHits).toBe(0)
      })
    })

    // ExecuteRaycastSystem.CreateRaycastData: `if (raycast.QueryType == RqtNone) return`.
    //
    // ALSO CONTRADICTS raycast.proto, whose RQT_NONE reads "Do not perform the
    // raycast, only set the raycast result with empty hits". The client writes no
    // result at all. Following the client, and it stops an RQT_NONE raycast paying
    // for a full mask walk, prefilter and intersection whose hits are discarded.
    describe('when a scene requests RQT_NONE', () => {
      beforeEach(async () => {
        await putCollider(new Vector3(0, 0, 10), PHYSICS_ONLY)
        await fire({
          maxDistance: 100,
          queryType: RaycastQueryType.RQT_NONE,
          collisionMask: PHYSICS_ONLY,
          direction: { $case: 'globalDirection', globalDirection: new Vector3(0, 0, 1) }
        })
      })

      it('should write no RaycastResult at all', () => {
        expect(resultOf(raycastEntity) === null).toBe(true)
      })

      it('should not leave the one-shot pending, so it is not rewalked every frame', () => {
        expect($.ctx.pendingRaycastOperations.has(raycastEntity)).toBe(false)
      })
    })
  }
)
