import { Quaternion, Vector3 } from '@babylonjs/core'
import { Scene } from '@dcl/schemas'
import { EasingFunction, PBTween } from '@dcl/protocol/out-js/decentraland/sdk/components/tween.gen'
import { TweenStateStatus } from '@dcl/protocol/out-js/decentraland/sdk/components/tween_state.gen'
import { processTweens } from '../../../../src/lib/babylon/scene/logic/tweens'
import { tweenComponent } from '../../../../src/lib/decentraland/sdk-components/tween'
import { tweenStateComponent } from '../../../../src/lib/decentraland/sdk-components/tween-state'
import { transformComponent, Transform } from '../../../../src/lib/decentraland/sdk-components/transform-component'
import { Entity } from '../../../../src/lib/decentraland/types'
import { CrdtBuilder, testWithEngine } from '../babylon-test-helper'

// PBTween used to be accepted into the CRDT and then dropped -- the whole
// interpolation branch in BabylonEntity was commented out behind `if (false)`,
// and TweenState was never registered at all. These tests drive real CRDT PUTs
// through SceneContext and then step the tween system by an explicit delta, so
// they assert both halves: the entity moves, AND the scene is told it moved.

const IDENTITY_TRANSFORM: Transform = {
  position: Vector3.Zero(),
  rotation: Quaternion.Identity(),
  scale: Vector3.One(),
  parent: 0 as Entity
}

testWithEngine(
  'tween component',
  {
    baseUrl: '/',
    entity: { content: [], metadata: {} as Scene, type: 'scene' },
    urn: 'tween-spec'
  },
  ($) => {
    // Monotonic across the WHOLE suite, deliberately not reset per test: the
    // SceneContext (and its CRDT stores) is shared by every test here, so a
    // timestamp that restarted would make later puts lose LWW conflict
    // resolution against the values an earlier test already wrote, and they
    // would be silently dropped.
    let timestamp = 0

    beforeEach(() => {
      $.startEngine()
      // SceneContext.update() steps tweens with the engine's real delta, so a
      // frame driven by crdtSendToRenderer would advance them by an unpredictable
      // amount of wall-clock time on top of the explicit step() calls below.
      // Pinning the engine delta to 0 makes step() the ONLY source of tween time,
      // without bypassing the real update() wiring.
      jest.spyOn($.ctx.babylonScene.getEngine(), 'getDeltaTime').mockReturnValue(0)
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    async function putTween(entity: Entity, tween: PBTween, transform: Transform = IDENTITY_TRANSFORM) {
      await $.ctx.crdtSendToRenderer({
        data: new CrdtBuilder()
          .put(transformComponent, entity, ++timestamp, transform)
          .put(tweenComponent, entity, ++timestamp, tween)
          .finish()
      })
    }

    // Steps the tween system directly rather than waiting on the render loop, so
    // the elapsed time in each test is exact instead of wall-clock dependent.
    function step(deltaMs: number) {
      processTweens($.ctx, deltaMs)
    }

    function positionOf(entity: Entity): Vector3 {
      return $.ctx.components[transformComponent.componentId].getOrNull(entity)!.position
    }

    function stateOf(entity: Entity): TweenStateStatus | undefined {
      return $.ctx.components[tweenStateComponent.componentId].getOrNull(entity)?.state
    }

    describe('when a scene puts a linear move tween', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 800 as Entity
        await putTween(entity, {
          duration: 1000,
          easingFunction: EasingFunction.EF_LINEAR,
          mode: { $case: 'move', move: { start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 } } }
        })
      })

      it('should report the tween as active as soon as it is set up', () => {
        expect(stateOf(entity)).toBe(TweenStateStatus.TS_ACTIVE)
      })

      it('should place the entity at the interpolated position halfway through', () => {
        step(500)
        expect(positionOf(entity).x).toBeCloseTo(5, 5)
      })

      // The scene being TOLD the entity moved is only half of it: the babylon
      // node has to move as well, or the collider stays where it was and
      // raycasts disagree with the transform the scene just received.
      // `position` is materialized from the transform commands during
      // computeWorldMatrix, which is what the render loop calls each frame.
      it('should move the babylon entity too, not just the reported transform', () => {
        step(500)
        const babylonEntity = $.ctx.entities.get(entity)!
        babylonEntity.computeWorldMatrix(true)
        expect(babylonEntity.position.x).toBeCloseTo(5, 5)
      })

      it('should land exactly on the end value when the duration elapses', () => {
        step(1000)
        expect(positionOf(entity).x).toBeCloseTo(10, 5)
      })

      it('should not overshoot the end value when stepped past the duration', () => {
        step(5000)
        expect(positionOf(entity).x).toBeCloseTo(10, 5)
      })
    })

    describe('when a move tween reaches the end of its duration', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 801 as Entity
        await putTween(entity, {
          duration: 1000,
          easingFunction: EasingFunction.EF_LINEAR,
          mode: { $case: 'move', move: { start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 } } }
        })
        step(1000)
      })

      // This is what `tweenSystem.tweenCompleted()` reads. Without it a scene
      // waiting on a tween to finish waits forever.
      it('should report the tween as completed', () => {
        expect(stateOf(entity)).toBe(TweenStateStatus.TS_COMPLETED)
      })
    })

    describe('when a tween is put with playing set to false', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 802 as Entity
        await putTween(entity, {
          duration: 1000,
          easingFunction: EasingFunction.EF_LINEAR,
          playing: false,
          mode: { $case: 'move', move: { start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 } } }
        })
      })

      it('should report the tween as paused', () => {
        expect(stateOf(entity)).toBe(TweenStateStatus.TS_PAUSED)
      })

      it('should not advance the entity while paused', () => {
        step(900)
        expect(positionOf(entity).x).toBeCloseTo(0, 5)
      })
    })

    describe('when a tween is put with a currentTime seek position', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 803 as Entity
        await putTween(entity, {
          duration: 1000,
          easingFunction: EasingFunction.EF_LINEAR,
          currentTime: 0.25,
          mode: { $case: 'move', move: { start: { x: 0, y: 0, z: 0 }, end: { x: 100, y: 0, z: 0 } } }
        })
      })

      it('should start the tween from that fraction of the duration', () => {
        step(0)
        expect(positionOf(entity).x).toBeCloseTo(25, 5)
      })
    })

    describe('when a scene re-puts an identical tween after it completed', () => {
      let entity: Entity
      let tween: PBTween

      beforeEach(async () => {
        entity = 804 as Entity
        tween = {
          duration: 1000,
          easingFunction: EasingFunction.EF_LINEAR,
          mode: { $case: 'move', move: { start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 } } }
        }
        await putTween(entity, tween)
        step(1000)
        await putTween(entity, tween)
      })

      // A PUT restarts the tween even when the value is unchanged -- the
      // reference client's IsDirty behaviour, which scenes rely on to replay.
      it('should restart the tween rather than leaving it completed', () => {
        expect(stateOf(entity)).toBe(TweenStateStatus.TS_ACTIVE)
      })

      it('should rewind the entity to the start of the tween', () => {
        expect(positionOf(entity).x).toBeCloseTo(0, 5)
      })
    })

    describe('when a scene puts a scale tween', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 805 as Entity
        await putTween(entity, {
          duration: 1000,
          easingFunction: EasingFunction.EF_LINEAR,
          mode: { $case: 'scale', scale: { start: { x: 1, y: 1, z: 1 }, end: { x: 3, y: 3, z: 3 } } }
        })
        step(500)
      })

      it('should interpolate the scale', () => {
        expect($.ctx.components[transformComponent.componentId].getOrNull(entity)!.scale.x).toBeCloseTo(2, 5)
      })
    })

    describe('when a scene puts a rotate tween', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 806 as Entity
        await putTween(entity, {
          duration: 1000,
          easingFunction: EasingFunction.EF_LINEAR,
          mode: {
            $case: 'rotate',
            rotate: {
              start: { x: 0, y: 0, z: 0, w: 1 },
              // 180 degrees about Y
              end: { x: 0, y: 1, z: 0, w: 0 }
            }
          }
        })
        step(500)
      })

      it('should slerp to the halfway orientation', () => {
        const rotation = $.ctx.components[transformComponent.componentId].getOrNull(entity)!.rotation
        // Halfway between identity and 180deg-about-Y is 90deg about Y.
        expect(rotation.y).toBeCloseTo(Math.SQRT1_2, 4)
      })
    })

    describe('when a scene puts a moveContinuous tween', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 807 as Entity
        await putTween(entity, {
          duration: 1000,
          easingFunction: EasingFunction.EF_LINEAR,
          mode: {
            $case: 'moveContinuous',
            moveContinuous: { direction: { x: 0, y: 0, z: 2 }, speed: 3 }
          }
        })
      })

      // direction is normalized, so a length-2 vector at speed 3 still travels
      // 3 units per second.
      it('should travel at the requested speed along the normalized direction', () => {
        step(1000)
        expect(positionOf(entity).z).toBeCloseTo(3, 5)
      })

      it('should keep going past the nominal duration instead of completing', () => {
        step(5000)
        expect(positionOf(entity).z).toBeCloseTo(15, 5)
      })

      it('should stay active forever rather than reporting completion', () => {
        step(5000)
        expect(stateOf(entity)).toBe(TweenStateStatus.TS_ACTIVE)
      })
    })

    describe('when a scene puts a texture move tween', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 808 as Entity
        await putTween(entity, {
          duration: 1000,
          easingFunction: EasingFunction.EF_LINEAR,
          mode: {
            $case: 'textureMove',
            textureMove: { start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }
          }
        })
        step(1000)
      })

      // Nothing to animate headless, but the tween still has to RUN: a scene
      // waiting on a texture tween must still observe completion.
      it('should still report completion so the scene is not left waiting', () => {
        expect(stateOf(entity)).toBe(TweenStateStatus.TS_COMPLETED)
      })

      it('should leave the transform untouched', () => {
        expect(positionOf(entity).equalsToFloats(0, 0, 0)).toBe(true)
      })
    })

    describe('when a tween has a zero duration', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 809 as Entity
        await putTween(entity, {
          duration: 0,
          easingFunction: EasingFunction.EF_LINEAR,
          mode: { $case: 'move', move: { start: { x: 0, y: 0, z: 0 }, end: { x: 7, y: 0, z: 0 } } }
        })
        step(16)
      })

      it('should jump straight to the end value instead of dividing by zero', () => {
        expect(positionOf(entity).x).toBeCloseTo(7, 5)
      })

      it('should report completion immediately', () => {
        expect(stateOf(entity)).toBe(TweenStateStatus.TS_COMPLETED)
      })
    })

    describe('when a scene puts a tween on an entity with no transform', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 810 as Entity
        await $.ctx.crdtSendToRenderer({
          data: new CrdtBuilder()
            .put(tweenComponent, entity, ++timestamp, {
              duration: 1000,
              easingFunction: EasingFunction.EF_LINEAR,
              mode: { $case: 'move', move: { start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 } } }
            })
            .finish()
        })
      })

      // The reference client's query requires an SDKTransform; without one there
      // is nothing to tween against.
      it('should skip it without throwing', () => {
        expect(() => step(500)).not.toThrow()
      })

      it('should not report any tween state for it', () => {
        step(500)
        expect(stateOf(entity)).toBeUndefined()
      })
    })

    describe('when an eased tween is halfway through its duration', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 811 as Entity
        await putTween(entity, {
          duration: 1000,
          // An in-out variant: these were missing from the easings table
          // entirely and silently behaved as linear.
          easingFunction: EasingFunction.EF_EASEQUAD,
          mode: { $case: 'move', move: { start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 } } }
        })
        step(250)
      })

      it('should follow the eased curve rather than the linear one', () => {
        // easeInOutQuad(0.25) = 2 * 0.25^2 = 0.125, so 1.25 rather than 2.5.
        expect(positionOf(entity).x).toBeCloseTo(1.25, 5)
      })
    })
  }
)
