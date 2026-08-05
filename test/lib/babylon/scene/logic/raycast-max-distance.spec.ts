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
import { pickMeshesForMask } from '../../../../../src/lib/babylon/scene/logic/colliders'
import { limits } from '../../../../../src/lib/misc/limits'
import { Entity } from '../../../../../src/lib/decentraland/types'
import { CrdtBuilder, testWithEngine } from '../../babylon-test-helper'

// PBRaycast.maxDistance was read NOWHERE in the codebase: `grep -rn maxDistance src/`
// returned nothing, and raycast-component.ts built every Ray with a hard-coded length
// of 999. A scene asking for a 1-metre raycast got a 999-metre one — measured, 304
// hits spanning ~34 metres against a requested maxDistance of 1.
//
// The Ray is also REUSED across re-PUTs (`prevValue?.ray ?? new Ray(...)`), so the
// length has to be assigned on every pass rather than at construction. The
// "re-armed with a different maxDistance" case below is what pins that.
//
// maxDistance is a raw scene-controlled float, so the hostile values are covered
// too: an unguarded NaN length makes Babylon's `distance > this.length` comparison
// false for every triangle, which a scene cannot distinguish from an empty scene.

const MASK = ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS
/** What raycast-component.ts has always constructed the Ray with. */
const HISTORICAL_DEFAULT_LENGTH = 999

testWithEngine(
  'raycast maxDistance',
  {
    baseUrl: '/',
    entity: { content: [], metadata: {} as Scene, type: 'scene' },
    urn: 'raycast-max-distance'
  },
  ($) => {
    let timestamp = 0
    let nextEntityId = 900
    let raycastEntity: Entity
    let colliderEntity: Entity

    const transform = (x: number, y: number, z: number) => ({
      position: new Vector3(x, y, z),
      rotation: Quaternion.Identity(),
      scale: new Vector3(1, 1, 1),
      parent: 0 as Entity
    })

    const hits = () =>
      ($.ctx.components[raycastResultComponent.componentId].getOrNull(raycastEntity) as any).hits as any[]

    /** Fires from the origin along +Z at a unit box centred 10 metres away. */
    async function fireAtTheDistantBox(maxDistance: unknown): Promise<void> {
      raycastEntity = nextEntityId++ as Entity
      await $.ctx.crdtSendToRenderer({
        data: new CrdtBuilder()
          .put(transformComponent, raycastEntity, ++timestamp, transform(0, 0, 0))
          .put(raycastComponent, raycastEntity, ++timestamp, {
            timestamp: 1,
            maxDistance,
            queryType: RaycastQueryType.RQT_HIT_FIRST,
            continuous: false,
            collisionMask: MASK,
            direction: { $case: 'globalDirection', globalDirection: new Vector3(0, 0, 1) }
          } as any)
          .finish()
      })
      processRaycasts($.ctx)
    }

    beforeEach(async () => {
      $.startEngine()
      // One unit box whose near face sits 9.5 metres along the ray.
      colliderEntity = nextEntityId++ as Entity
      await $.ctx.crdtSendToRenderer({
        data: new CrdtBuilder()
          .put(transformComponent, colliderEntity, ++timestamp, transform(0, 0, 10))
          .put(meshColliderComponent, colliderEntity, ++timestamp, {
            collisionMask: MASK,
            mesh: { $case: 'box', box: {} }
          } as any)
          .finish()
      })
    })

    describe('when a scene asks for a range shorter than the collider is away', () => {
      beforeEach(async () => {
        await fireAtTheDistantBox(5)
      })

      it('should report no hit, rather than one 9.5 metres past the requested range', () => {
        expect(hits()).toHaveLength(0)
      })
    })

    describe('when a scene asks for a range that reaches the collider', () => {
      beforeEach(async () => {
        await fireAtTheDistantBox(20)
      })

      it('should report the hit', () => {
        expect(hits()).toHaveLength(1)
      })
    })

    describe('when a scene leaves maxDistance unset', () => {
      beforeEach(async () => {
        // 0 is the protobuf default for an unset scalar float, which is what an SDK
        // scene that never touches the field actually sends.
        await fireAtTheDistantBox(0)
      })

      // Matches the client, which passes MaxDistance straight to
      // `Physics.RaycastNonAlloc` with no default anywhere in unity-explorer — a
      // zero-length ray finds nothing. This server used to substitute 999, which
      // was strictly more generous than every player's machine: a scene that never
      // sets the field already finds nothing in production, so nothing shipped can
      // be relying on the old fallback.
      it('should find nothing, because an unset range is a zero-length ray', () => {
        expect(hits()).toHaveLength(0)
      })

    })

    // A zero-range raycast skips the prefilter and the intersection but is still
    // CHARGED the mesh cost — and that is load-bearing, not tidy. An unset maxDistance
    // IS a zero-length ray, so this is the default path for any scene that never sets
    // the field. Left un-charged it was an amplifier exempt from both ceilings:
    // measured, 50_000 continuous raycasts emitted 50_000 results in 30.1ms, ~90% of a
    // 33ms frame, while charging nothing — and each result is an outgoing
    // PutComponentOperation, so the CRDT stream amplified with it. main throttles the
    // identical scene because it always charged the candidate count.
    //
    // An earlier version of this describe asserted the OPPOSITE, pinning the exemption
    // as a feature.
    describe('when a zero-range raycast shares a frame with a real one', () => {
      let processed: number[]
      let restore: number

      beforeEach(async () => {
        restore = limits.maxRaycastIntersectionsPerFrame
        // Exactly ONE raycast's worth of budget, measured rather than guessed:
        // colliders accumulate across this file's tests.
        limits.maxRaycastIntersectionsPerFrame = Array.from(pickMeshesForMask($.ctx.rootNode, MASK)).length
        $.ctx.raycastRotationCursor = 0
        processed = []

        const zeroRange = nextEntityId++ as Entity
        const realRaycast = nextEntityId++ as Entity
        const aimedAtTheBox = {
          queryType: RaycastQueryType.RQT_HIT_FIRST,
          continuous: false,
          collisionMask: MASK,
          direction: { $case: 'globalDirection', globalDirection: new Vector3(0, 0, 1) }
        }
        await $.ctx.crdtSendToRenderer({
          data: new CrdtBuilder()
            .put(transformComponent, zeroRange, ++timestamp, transform(0, 0, 0))
            .put(raycastComponent, zeroRange, ++timestamp, { timestamp: 1, maxDistance: 0, ...aimedAtTheBox } as any)
            .put(transformComponent, realRaycast, ++timestamp, transform(0, 0, 0))
            .put(raycastComponent, realRaycast, ++timestamp, { timestamp: 1, maxDistance: 20, ...aimedAtTheBox } as any)
            .finish()
        })

        const Results = $.ctx.components[raycastResultComponent.componentId]
        for (const entity of [zeroRange, realRaycast]) {
          if (Results.getOrNull(entity)) processed.push(entity)
        }
      })

      afterEach(() => {
        limits.maxRaycastIntersectionsPerFrame = restore
      })

      // The zero-range one consumes the frame's whole budget, exactly as a real
      // raycast against the same collider set would, so the second is deferred. That
      // is the point: a zero-range answer is not free.
      it('should spend the frame budget, deferring the second raycast', () => {
        expect(processed).toHaveLength(1)
      })
    })

    describe('when a scene re-arms the same raycast with a shorter range', () => {
      beforeEach(async () => {
        await fireAtTheDistantBox(20)
        // Same ENTITY, so raycast-component.ts hands back the Ray it already built
        // rather than a fresh one. A length assigned at construction would still be
        // 20 here and the hit would survive.
        await $.ctx.crdtSendToRenderer({
          data: new CrdtBuilder()
            .put(raycastComponent, raycastEntity, ++timestamp, {
              timestamp: 2,
              maxDistance: 5,
              queryType: RaycastQueryType.RQT_HIT_FIRST,
              continuous: false,
              collisionMask: MASK,
              direction: { $case: 'globalDirection', globalDirection: new Vector3(0, 0, 1) }
            } as any)
            .finish()
        })
        processRaycasts($.ctx)
      })

      it('should apply the new shorter range to the reused Ray', () => {
        expect(hits()).toHaveLength(0)
      })
    })

    describe('and the requested range is not a usable number', () => {
      // A raw scene-controlled float. NaN is the dangerous one and the reason this
      // is guarded rather than passed through like the client does: a NaN length
      // makes `tmin > tmax` false in the slab prefilter AND `distance > this.length`
      // false in `intersectsTriangle`, so an unguarded NaN admits EVERY collider at
      // ANY distance — the exact inverse of a range limit. Infinity would remove
      // the bound outright. Both are rejected to zero, which is also what the
      // client's `Physics.RaycastNonAlloc` does with a negative distance.
      const hostileRanges: Array<{ name: string; value: number }> = [
        { name: 'NaN', value: Number.NaN },
        { name: 'Infinity', value: Number.POSITIVE_INFINITY },
        { name: 'negative', value: -50 }
      ]

      for (const range of hostileRanges) {
        describe(`and it is ${range.name}`, () => {
          beforeEach(async () => {
            await fireAtTheDistantBox(range.value)
          })

          it('should find nothing rather than admitting every collider at any range', () => {
            expect(hits()).toHaveLength(0)
          })
        })
      }
    })
  }
)
