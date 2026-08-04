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

      it('should keep the historical 999-metre range so existing scenes are unaffected', () => {
        expect(hits()).toHaveLength(1)
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
      // Each of these must fall back to the default rather than produce a NaN or
      // negative length, which would silently answer "nothing is there" forever.
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

          it(`should fall back to the ${HISTORICAL_DEFAULT_LENGTH}-metre default and still find the collider`, () => {
            expect(hits()).toHaveLength(1)
          })
        })
      }
    })
  }
)
