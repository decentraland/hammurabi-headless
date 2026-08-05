import { Quaternion, Vector3 } from '@babylonjs/core'
import { Scene } from '@dcl/schemas'
import { RaycastQueryType } from '@dcl/protocol/out-js/decentraland/sdk/components/raycast.gen'
import { transformComponent } from '../../../../../src/lib/decentraland/sdk-components/transform-component'
import {
  raycastComponent,
  raycastResultComponent
} from '../../../../../src/lib/decentraland/sdk-components/raycast-component'
import { processRaycasts } from '../../../../../src/lib/babylon/scene/logic/raycasts'
import { Entity } from '../../../../../src/lib/decentraland/types'
import { CrdtBuilder, testWithEngine } from '../../babylon-test-helper'

// computeRayDirection had NO coverage at all. Every fixture in the sibling raycast
// specs asks for globalDirection (0,0,1) or leaves direction unset, and (0,0,1) is
// exactly what `new Ray(Zero, Forward, ...)` already holds — so replacing the whole
// five-branch chain with a no-op passed the entire suite, as did gutting any branch
// individually. Verified by mutation before these tests were written.
//
// Asserted on the RaycastResult's own `direction` (raycastResultFromRay writes
// `Vector3.Normalize(ray.direction)`) rather than on which collider was hit: it
// observes the function's actual output, and needs no geometry, so a case cannot
// accidentally pass because some other mesh happened to be in the way.
//
// Every expected value below is deliberately NOT (0,0,1): a branch that computes
// nothing leaves the Ray's construction default in place, and an expectation of
// (0,0,1) would be indistinguishable from that.

// A quarter turn about Y, so local and global axes cannot be confused for each
// other. Babylon is left-handed: this maps local +Z to world +X and local +X to
// world -Z.
const QUARTER_TURN_ABOUT_Y = Quaternion.RotationYawPitchRoll(Math.PI / 2, 0, 0)

testWithEngine(
  'raycast direction resolution',
  {
    baseUrl: '/',
    // Parcel 1,1 — rootNode at world (16,0,16) — deliberately NOT 0,0. The
    // targetEntity branch used to convert an already-world `absolutePosition`
    // through `sceneCoordinatesToBabylonGlobalCoordinates`, adding the scene root
    // twice. At 0,0 that offset is zero and the bug is invisible: this spec passed
    // against it. Every scene-space conversion below is now exercised against a
    // non-zero root.
    entity: {
      content: [],
      metadata: { scene: { base: '1,1', parcels: ['1,1'] } } as unknown as Scene,
      type: 'scene'
    },
    urn: 'raycast-direction'
  },
  ($) => {
    let timestamp = 0
    let nextEntityId = 700
    let raycastEntity: Entity

    const transform = (position: Vector3, rotation = Quaternion.Identity()) => ({
      position,
      rotation,
      scale: new Vector3(1, 1, 1),
      parent: 0 as Entity
    })

    beforeEach(() => {
      $.startEngine()
    })

    /** The direction the scene was actually told its ray travelled in. */
    const reportedDirection = () => {
      const result = $.ctx.components[raycastResultComponent.componentId].getOrNull(raycastEntity) as any
      return [result.direction.x, result.direction.y, result.direction.z]
    }

    async function fireFrom(rotation: Quaternion, direction: unknown): Promise<void> {
      raycastEntity = nextEntityId++ as Entity
      await $.ctx.crdtSendToRenderer({
        data: new CrdtBuilder()
          .put(transformComponent, raycastEntity, ++timestamp, transform(Vector3.Zero(), rotation))
          .put(raycastComponent, raycastEntity, ++timestamp, {
            timestamp: 1,
            maxDistance: 100,
            queryType: RaycastQueryType.RQT_HIT_FIRST,
            continuous: false,
            collisionMask: undefined,
            direction
          } as any)
          .finish()
      })
      processRaycasts($.ctx)
    }

    describe('when a scene leaves the direction unset', () => {
      beforeEach(async () => {
        await fireFrom(QUARTER_TURN_ABOUT_Y, undefined)
      })

      // No ray at all, matching the client's `default: ray = default; return false`
      // in RaycastUtils.TryCreateRay. This used to fire a local-space forward
      // vector — a hammurabi invention. raycast.proto documents no default for the
      // oneof, and the client treats an unset direction as malformed data, so a
      // scene relying on the implicit forward ray was already getting nothing on
      // every player's machine.
      it('should write no result at all rather than inventing a forward ray', () => {
        expect(
          $.ctx.components[raycastResultComponent.componentId].getOrNull(raycastEntity) === null
        ).toBe(true)
      })
    })

    describe('when a scene asks for a localDirection', () => {
      beforeEach(async () => {
        await fireFrom(QUARTER_TURN_ABOUT_Y, { $case: 'localDirection', localDirection: new Vector3(1, 0, 0) })
      })

      // Local +X under a quarter turn about Y becomes world -Z, which is neither the
      // requested vector nor the Ray default — so this fails both if the rotation is
      // dropped and if the branch does nothing.
      it('should rotate the requested local axis into world space', () => {
        expect(reportedDirection().map((n) => Math.round(n * 1000) / 1000)).toEqual([0, 0, -1])
      })
    })

    describe('when a scene asks for a globalDirection', () => {
      beforeEach(async () => {
        await fireFrom(QUARTER_TURN_ABOUT_Y, { $case: 'globalDirection', globalDirection: new Vector3(0, 1, 0) })
      })

      // Straight up: unaffected by the entity's rotation, and distinct from every
      // other case here, so it cannot pass by borrowing another branch's answer.
      it('should use the requested vector as-is, ignoring the entity rotation', () => {
        expect(reportedDirection().map((n) => Math.round(n * 1000) / 1000)).toEqual([0, 1, 0])
      })
    })

    describe('when a scene asks for a globalTarget', () => {
      beforeEach(async () => {
        await fireFrom(QUARTER_TURN_ABOUT_Y, { $case: 'globalTarget', globalTarget: new Vector3(0, -10, 0) })
      })

      // A point, not a vector: the branch has to subtract the ray's own origin and
      // normalize. Straight down, so again unique among these cases.
      it('should point from the ray origin towards the requested scene position', () => {
        expect(reportedDirection().map((n) => Math.round(n * 1000) / 1000)).toEqual([0, -1, 0])
      })
    })

    describe('when a scene asks for a targetEntity', () => {
      let targetEntity: Entity

      beforeEach(async () => {
        targetEntity = nextEntityId++ as Entity
        await $.ctx.crdtSendToRenderer({
          data: new CrdtBuilder()
            .put(transformComponent, targetEntity, ++timestamp, transform(new Vector3(0, 0, -10)))
            .finish()
        })
        await fireFrom(QUARTER_TURN_ABOUT_Y, { $case: 'targetEntity', targetEntity })
      })

      // Resolves another entity's position at fire time rather than a literal.
      it("should point from the ray origin towards the target entity's position", () => {
        expect(reportedDirection().map((n) => Math.round(n * 1000) / 1000)).toEqual([0, 0, -1])
      })
    })
  }
)
