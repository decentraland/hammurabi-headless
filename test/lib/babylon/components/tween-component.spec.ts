import { Quaternion, Vector3 } from '@babylonjs/core'
import { Scene } from '@dcl/schemas'
import { EasingFunction, PBTween } from '@dcl/protocol/out-js/decentraland/sdk/components/tween.gen'
import { TweenStateStatus } from '@dcl/protocol/out-js/decentraland/sdk/components/tween_state.gen'
import { processTweens } from '../../../../src/lib/babylon/scene/logic/tweens'
import { resolveCyclicParenting } from '../../../../src/lib/babylon/scene/logic/cyclic-transform'
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

// A 90-degree rotation about an axis, as a PBTween `direction` quaternion: the
// reference derives the continuous rotation axis from the imaginary part, so the
// magnitude of the angle is irrelevant and only the axis (and its sign) matter.
const SIN_45 = Math.SQRT1_2

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
    //
    // Each PUT jumps by a wide margin rather than by one: the store ALSO bumps an
    // entity's timestamp on every frame the component is dirty, and an ACTIVE
    // tween republishes its Transform every frame while the render loop runs
    // between tests. A +1 step would eventually lose to that count.
    let timestamp = 0

    function nextTimestamp(): number {
      timestamp += 1000
      return timestamp
    }

    beforeEach(() => {
      $.startEngine()
      // SceneContext.update() steps tweens with accumulated WALL-CLOCK time, so a
      // frame driven by crdtSendToRenderer would advance them by an unpredictable
      // amount of time on top of the explicit step() calls below. Pinning the
      // context's tween clock to 0 makes step() the ONLY source of tween time,
      // without bypassing the real update() wiring.
      jest.spyOn($.ctx, 'consumeTweenDeltaMs').mockReturnValue(0)
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    async function putTween(entity: Entity, tween: PBTween, transform: Transform = IDENTITY_TRANSFORM) {
      await $.ctx.crdtSendToRenderer({
        data: new CrdtBuilder()
          .put(transformComponent, entity, nextTimestamp(), transform)
          .put(tweenComponent, entity, nextTimestamp(), tween)
          .finish()
      })
    }

    // Steps the tween system directly rather than waiting on the render loop, so
    // the elapsed time in each test is exact instead of wall-clock dependent.
    function step(deltaMs: number) {
      processTweens($.ctx, deltaMs)
    }

    function transformOf(entity: Entity): Transform {
      return $.ctx.components[transformComponent.componentId].getOrNull(entity)!
    }

    function positionOf(entity: Entity): Vector3 {
      return transformOf(entity).position
    }

    function rotationOf(entity: Entity): Quaternion {
      return transformOf(entity).rotation
    }

    function stateOf(entity: Entity): TweenStateStatus | undefined {
      return $.ctx.components[tweenStateComponent.componentId].getOrNull(entity)?.state
    }

    // A tween that keeps writing the same Transform every frame after it settled
    // is the exact regression this system is supposed to avoid, and the dirty set
    // is what turns into a CRDT message. Clearing it first isolates the step().
    function transformWritesDuring(entity: Entity, deltaMs: number): boolean {
      const store = $.ctx.components[transformComponent.componentId]
      store.commitDirtyState()
      step(deltaMs)
      return Array.from(store.dirtyIterator()).includes(entity)
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

      it('should stop republishing the transform once completed', () => {
        expect(transformWritesDuring(entity, 16)).toBe(false)
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

      it('should not republish the transform while paused', () => {
        expect(transformWritesDuring(entity, 900)).toBe(false)
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
        expect(transformOf(entity).scale.x).toBeCloseTo(2, 5)
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
        // Halfway between identity and 180deg-about-Y is 90deg about Y.
        expect(rotationOf(entity).y).toBeCloseTo(Math.SQRT1_2, 4)
      })
    })

    describe('when a scene puts a rotate tween between two degenerate quaternions', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 812 as Entity
        await putTween(entity, {
          duration: 1000,
          easingFunction: EasingFunction.EF_LINEAR,
          mode: {
            $case: 'rotate',
            rotate: { start: { x: 0, y: 0, z: 0, w: 0 }, end: { x: 0, y: 0, z: 0, w: 0 } }
          }
        })
        step(500)
      })

      // Slerping two zero-length quaternions yields {0,0,0,0}, which is not a
      // rotation: no real client ever emits a non-unit quaternion, and it would
      // be written verbatim to the CRDT and onto rotationQuaternion.
      it('should report a unit quaternion rather than a zero-length one', () => {
        expect(rotationOf(entity).length()).toBeCloseTo(1, 5)
      })
    })

    describe('when a scene puts a moveContinuous tween with a finite duration', () => {
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

      // The reference's UpdatePBTween kills a continuous tween once
      // TweenSurpassedDuration (Duration > 0 && elapsed >= Duration/1000), so a
      // continuous tween with a finite duration DOES complete -- it just freezes
      // wherever it had travelled to. Pinned upstream by
      // MoveContinuousMovesAndCompletesAfterDuration.
      it('should report completion once the duration elapses', () => {
        step(1000)
        expect(stateOf(entity)).toBe(TweenStateStatus.TS_COMPLETED)
      })

      it('should freeze at the position it reached rather than travelling further', () => {
        step(5000)
        expect(positionOf(entity).z).toBeCloseTo(3, 5)
      })

      it('should stop republishing the transform once completed', () => {
        step(1000)
        expect(transformWritesDuring(entity, 500)).toBe(false)
      })
    })

    describe('when a scene puts a moveContinuous tween with a zero duration', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 813 as Entity
        await putTween(entity, {
          duration: 0,
          easingFunction: EasingFunction.EF_LINEAR,
          mode: {
            $case: 'moveContinuous',
            moveContinuous: { direction: { x: 0, y: 1, z: 0 }, speed: 3 }
          }
        })
        step(5000)
      })

      // Zero duration is the documented way to run forever
      // (ContinuousTweensRunIndefinitelyWhenDurationIsZero upstream).
      it('should keep travelling indefinitely', () => {
        expect(positionOf(entity).y).toBeCloseTo(15, 5)
      })

      it('should stay active rather than reporting completion', () => {
        expect(stateOf(entity)).toBe(TweenStateStatus.TS_ACTIVE)
      })
    })

    describe('when a scene puts a rotateContinuous tween around the X axis', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 814 as Entity
        await putTween(entity, {
          duration: 0,
          easingFunction: EasingFunction.EF_LINEAR,
          mode: {
            $case: 'rotateContinuous',
            // 90 degrees about +X: the imaginary part points along X.
            rotateContinuous: { direction: { x: SIN_45, y: 0, z: 0, w: SIN_45 }, speed: 90 }
          }
        })
        step(1000)
      })

      // Port of the reference's RotateContinuousAroundXAxisRotatesAroundXNotZ:
      // deriving the axis by rotating Vector3.up would have produced a Z-axis
      // rotation here.
      it('should rotate around the X axis', () => {
        expect(rotationOf(entity).x).toBeCloseTo(SIN_45, 4)
      })

      it('should leave the Z component of the rotation at zero', () => {
        expect(rotationOf(entity).z).toBeCloseTo(0, 5)
      })
    })

    describe('when a scene puts rotateContinuous tweens with opposite Y directions', () => {
      let positiveEntity: Entity
      let negativeEntity: Entity

      beforeEach(async () => {
        positiveEntity = 815 as Entity
        negativeEntity = 816 as Entity
        await putTween(positiveEntity, {
          duration: 0,
          easingFunction: EasingFunction.EF_LINEAR,
          mode: {
            $case: 'rotateContinuous',
            rotateContinuous: { direction: { x: 0, y: SIN_45, z: 0, w: SIN_45 }, speed: 90 }
          }
        })
        await putTween(negativeEntity, {
          duration: 0,
          easingFunction: EasingFunction.EF_LINEAR,
          mode: {
            $case: 'rotateContinuous',
            rotateContinuous: { direction: { x: 0, y: -SIN_45, z: 0, w: SIN_45 }, speed: 90 }
          }
        })
        step(1000)
      })

      // Port of RotateContinuousPositiveAndNegativeYDirectionsAreOpposite: the
      // sign of the axis has to survive, which is why the axis comes from the
      // quaternion's imaginary part instead of a rotated reference vector.
      it('should rotate the positive direction towards a positive Y component', () => {
        expect(rotationOf(positiveEntity).y).toBeCloseTo(SIN_45, 4)
      })

      it('should rotate the negative direction towards a negative Y component', () => {
        expect(rotationOf(negativeEntity).y).toBeCloseTo(-SIN_45, 4)
      })
    })

    describe('when a rotateContinuous tween with a finite duration elapses', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 817 as Entity
        await putTween(entity, {
          duration: 1000,
          easingFunction: EasingFunction.EF_LINEAR,
          mode: {
            $case: 'rotateContinuous',
            rotateContinuous: { direction: { x: 0, y: 0, z: SIN_45, w: SIN_45 }, speed: 90 }
          }
        })
        step(1000)
      })

      // Port of RotateContinuousCompletesAfterDuration.
      it('should report completion', () => {
        expect(stateOf(entity)).toBe(TweenStateStatus.TS_COMPLETED)
      })

      it('should not rotate any further after completing', () => {
        const settled = rotationOf(entity).clone()
        step(500)
        expect(rotationOf(entity).equalsWithEpsilon(settled, 1e-6)).toBe(true)
      })
    })

    describe('when a scene puts a moveRotateScale tween with omitted fields', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 818 as Entity
        await putTween(
          entity,
          {
            duration: 1000,
            easingFunction: EasingFunction.EF_LINEAR,
            mode: {
              $case: 'moveRotateScale',
              moveRotateScale: {
                positionStart: undefined,
                positionEnd: { x: 10, y: 0, z: 0 },
                rotationStart: undefined,
                rotationEnd: undefined,
                scaleStart: undefined,
                scaleEnd: undefined
              }
            }
          },
          {
            position: new Vector3(2, 0, 0),
            rotation: Quaternion.Identity(),
            scale: new Vector3(4, 4, 4),
            parent: 0 as Entity
          }
        )
        step(500)
      })

      // ResolveMoveRotateScale fills every omitted field from the transform the
      // entity had when the tween started.
      it('should interpolate from the entity position when the start is omitted', () => {
        expect(positionOf(entity).x).toBeCloseTo(6, 5)
      })

      it('should keep the entity scale when both scale ends are omitted', () => {
        expect(transformOf(entity).scale.x).toBeCloseTo(4, 5)
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

    describe('when a scene puts a texture move tween on an entity with no transform', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 819 as Entity
        await $.ctx.crdtSendToRenderer({
          data: new CrdtBuilder()
            .put(tweenComponent, entity, nextTimestamp(), {
              duration: 1000,
              easingFunction: EasingFunction.EF_LINEAR,
              mode: {
                $case: 'textureMove',
                textureMove: { start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }
              }
            })
            .finish()
        })
        step(1000)
      })

      // The reference's texture path queries MaterialComponent, not SDKTransform,
      // so requiring a Transform here would defeat the whole point of tracking
      // texture tweens: the scene would never observe completion.
      it('should report completion even without a transform to tween', () => {
        expect(stateOf(entity)).toBe(TweenStateStatus.TS_COMPLETED)
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
            .put(tweenComponent, entity, nextTimestamp(), {
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

    describe('when a scene puts a tween with no mode', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 820 as Entity
        await putTween(entity, {
          duration: 1000,
          easingFunction: EasingFunction.EF_LINEAR,
          mode: undefined
        })
        step(500)
      })

      // TweenLoaderSystem.LoadTween and UpdatePBTween both return on
      // ModeCase == None: no component is created and no state is ever reported.
      it('should not report any tween state for it', () => {
        expect(stateOf(entity)).toBeUndefined()
      })

      it('should leave the transform untouched', () => {
        expect(positionOf(entity).equalsToFloats(0, 0, 0)).toBe(true)
      })
    })

    describe('when a scene deletes the tween component of a running tween', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 821 as Entity
        await putTween(entity, {
          duration: 1000,
          easingFunction: EasingFunction.EF_LINEAR,
          mode: { $case: 'move', move: { start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 } } }
        })
        step(1000)
        await $.ctx.crdtSendToRenderer({
          data: new CrdtBuilder().delete(tweenComponent, entity, nextTimestamp()).finish()
        })
        step(16)
      })

      // TweenCleanUpSystem.CleanUpTweenBeforeRemoval issues a
      // DeleteMessage<PBTweenState> alongside releasing the tweener. Without it
      // `tweenSystem.tweenCompleted(entity)` keeps answering true for an entity
      // that no longer has a tween at all.
      it('should delete the tween state along with the tween', () => {
        expect(stateOf(entity)).toBeUndefined()
      })
    })

    describe('when a scene puts a tween with a non-finite duration', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 822 as Entity
        await putTween(entity, {
          duration: NaN,
          easingFunction: EasingFunction.EF_LINEAR,
          mode: { $case: 'move', move: { start: { x: 0, y: 0, z: 0 }, end: { x: 4, y: 0, z: 0 } } }
        })
        step(16)
      })

      // A NaN duration made `elapsedMs >= durationMs` false forever, so the tween
      // never left TS_ACTIVE and published a Transform every frame for the rest of
      // the process's life.
      it('should complete rather than staying active forever', () => {
        expect(stateOf(entity)).toBe(TweenStateStatus.TS_COMPLETED)
      })

      it('should stop republishing the transform', () => {
        expect(transformWritesDuring(entity, 16)).toBe(false)
      })

      it('should report a finite position', () => {
        expect(Number.isFinite(positionOf(entity).x)).toBe(true)
      })
    })

    describe('when a scene puts a tween with a non-finite currentTime', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 823 as Entity
        await putTween(entity, {
          duration: 1000,
          easingFunction: EasingFunction.EF_LINEAR,
          currentTime: NaN,
          mode: { $case: 'move', move: { start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 } } }
        })
        step(0)
      })

      // Math.min(Math.max(NaN, 0), 1) is NaN, so the clamp alone never sanitized
      // this: the entity ended up at (NaN, NaN, NaN) in the CRDT and on the node.
      it('should seek to the start of the tween instead of a NaN position', () => {
        expect(positionOf(entity).x).toBeCloseTo(0, 5)
      })

      it('should keep the babylon node position finite', () => {
        const babylonEntity = $.ctx.entities.get(entity)!
        babylonEntity.computeWorldMatrix(true)
        expect(Number.isFinite(babylonEntity.getWorldMatrix().m[12])).toBe(true)
      })
    })

    describe('when a scene puts a moveContinuous tween with a non-finite direction', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 824 as Entity
        await putTween(entity, {
          duration: 1000,
          easingFunction: EasingFunction.EF_LINEAR,
          mode: {
            $case: 'moveContinuous',
            moveContinuous: { direction: { x: NaN, y: 0, z: 0 }, speed: 3 }
          }
        })
        step(500)
      })

      // Unity's Vector3.normalized returns the zero vector when the magnitude is
      // not greater than 1e-5, so the reference simply does not move. `length > 0`
      // was false for NaN and used the direction UNNORMALIZED.
      it('should not move the entity at all', () => {
        expect(positionOf(entity).equalsToFloats(0, 0, 0)).toBe(true)
      })
    })

    describe('when a scene puts a tween with a non-finite start position', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 825 as Entity
        await putTween(entity, {
          duration: 1000,
          easingFunction: EasingFunction.EF_LINEAR,
          mode: { $case: 'move', move: { start: { x: NaN, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 } } }
        })
        step(500)
      })

      // An unsanitized endpoint poisons the lerp for the whole life of the tween.
      it('should report a finite position', () => {
        expect(Number.isFinite(positionOf(entity).x)).toBe(true)
      })
    })

    describe('when a scene puts a tween on the reserved root entity', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = 0 as Entity
        await putTween(
          entity,
          {
            duration: 1000,
            easingFunction: EasingFunction.EF_LINEAR,
            mode: { $case: 'move', move: { start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 } } }
          },
          { ...IDENTITY_TRANSFORM, parent: 900 as Entity }
        )
        step(16)
      })

      // The scene write guard allows component PUTs on entity 0, and
      // transformComponent.applyChanges deliberately early-returns for the root --
      // but processTweens called applyNewTransform directly, which scheduled the
      // ROOT for reparenting. resolveCyclicParenting then "resolved" the cycle by
      // setting rootNode.parent = rootNode, and computeWorldMatrix recursed until
      // the stack blew, from Babylon's world-matrix pass OUTSIDE update()'s
      // try/catch, every frame.
      it('should not schedule the root entity for reparenting', () => {
        expect($.ctx.unparentedEntities.has(entity)).toBe(false)
      })

      // Compared as a boolean on purpose: a failing `expect(node).not.toBe(node)`
      // makes jest serialize a self-referencing BabylonEntity and the whole
      // worker dies on "Converting circular structure to JSON" instead of
      // reporting the assertion.
      it('should not parent the scene root to itself', () => {
        resolveCyclicParenting($.ctx)
        expect($.ctx.rootNode.parent === $.ctx.rootNode).toBe(false)
      })

      it('should not compute a recursive world matrix for the scene root', () => {
        resolveCyclicParenting($.ctx)
        expect(() => $.ctx.rootNode.computeWorldMatrix(true)).not.toThrow()
      })

      it('should not move the root entity', () => {
        expect(positionOf(entity).equalsToFloats(0, 0, 0)).toBe(true)
      })

      it('should not report any tween state for the root entity', () => {
        expect(stateOf(entity)).toBeUndefined()
      })
    })
  }
)
