import { Quaternion, Vector3 } from '@babylonjs/core'
import { EasingFunction, PBTween } from '@dcl/protocol/out-js/decentraland/sdk/components/tween.gen'
import { TweenStateStatus } from '@dcl/protocol/out-js/decentraland/sdk/components/tween_state.gen'
import { Vector3 as PBVector3 } from '@dcl/protocol/out-js/decentraland/common/vectors.gen'
import { Quaternion as PBQuaternion } from '@dcl/protocol/out-js/decentraland/common/vectors.gen'
import { easingsFunctions } from './easings'
import { tweenComponent } from '../../../decentraland/sdk-components/tween'
import { tweenStateComponent } from '../../../decentraland/sdk-components/tween-state'
import { applyNewTransform, Transform, transformComponent } from '../../../decentraland/sdk-components/transform-component'
import { Entity } from '../../../decentraland/types'
import type { SceneContext } from '../scene-context'

/**
 * PBTween runtime.
 *
 * Before this existed, `PBTween` was accepted into the CRDT and then dropped on
 * the floor (`BabylonEntity._setTransformParametersBeforeMatrixCalculation` had
 * the whole branch commented out behind `if (false)`), so a tweened entity never
 * moved on this server while it did move on every real client — and `TweenState`
 * was never written, so `tweenSystem.tweenCompleted()` never fired.
 *
 * Semantics follow the reference client (`TweenSDKComponentHelper`):
 *
 * - A PUT of PBTween RESTARTS the tween, even if the value is identical. That is
 *   the reference's `IsDirty` behaviour, and scenes rely on it to replay a tween.
 *   Detected here by object identity: the deserializer allocates a fresh object
 *   per PUT, so `runtime.source !== value` is exactly "a PUT arrived".
 * - `playing` defaults to true. False pauses without advancing time.
 * - `currentTime` (0..1) seeds the elapsed time on setup.
 * - TweenState is written on SETUP and on every state CHANGE. While ACTIVE the
 *   Transform is re-published every frame but TweenState is not — matching the
 *   reference, which only writes state on transition.
 * - Continuous modes never complete; they stay ACTIVE forever.
 */

type TweenRuntime = {
  // Identity of the PBTween this runtime was built from. See the note above.
  source: PBTween
  elapsedMs: number
  durationMs: number
  state: TweenStateStatus
  // Captured at setup. Continuous modes are relative to wherever the entity was
  // when the tween started, and MoveRotateScale fills omitted fields from it.
  startPosition: Vector3
  startRotation: Quaternion
  startScale: Vector3
}

const tmpVector = new Vector3()
const tmpQuaternion = new Quaternion()

function toVector3(value: PBVector3 | undefined, fallback: Vector3): Vector3 {
  if (!value) return fallback.clone()
  return new Vector3(value.x, value.y, value.z)
}

function toQuaternion(value: PBQuaternion | undefined, fallback: Quaternion): Quaternion {
  if (!value) return fallback.clone()
  return new Quaternion(value.x, value.y, value.z, value.w)
}

function isContinuous(tween: PBTween): boolean {
  const mode = tween.mode?.$case
  return mode === 'moveContinuous' || mode === 'rotateContinuous' || mode === 'textureMoveContinuous'
}

/**
 * Texture tweens animate a material's UV offset/tiling. There is nothing to
 * animate headless, but the tween still has to RUN — a scene waiting on
 * `tweenCompleted` for a texture tween must still observe TS_COMPLETED.
 */
function isTextureMode(tween: PBTween): boolean {
  const mode = tween.mode?.$case
  return mode === 'textureMove' || mode === 'textureMoveContinuous'
}

function easingFor(tween: PBTween): (progress: number) => number {
  // Continuous modes are linear by definition; the reference forces Ease.Linear
  // for them regardless of what the scene set.
  if (isContinuous(tween)) return easingsFunctions[EasingFunction.EF_LINEAR]
  return easingsFunctions[tween.easingFunction] ?? easingsFunctions[EasingFunction.EF_LINEAR]
}

function setupRuntime(tween: PBTween, current: Transform): TweenRuntime {
  const durationMs = tween.duration ?? 0
  const playing = tween.playing ?? true
  // `currentTime` is a normalized 0..1 seek position, clamped by the reference.
  const seek = Math.min(Math.max(tween.currentTime ?? 0, 0), 1)

  return {
    source: tween,
    durationMs,
    elapsedMs: seek * durationMs,
    state: playing ? TweenStateStatus.TS_ACTIVE : TweenStateStatus.TS_PAUSED,
    startPosition: current.position.clone(),
    startRotation: current.rotation.clone(),
    startScale: current.scale.clone()
  }
}

/**
 * Applies the tween at its current elapsed time to `target`, mutating it in
 * place. Returns false when the mode has no transform effect (texture modes).
 */
function applyTweenValue(tween: PBTween, runtime: TweenRuntime, target: Transform): boolean {
  const mode = tween.mode
  if (!mode) return false

  const elapsedSeconds = runtime.elapsedMs / 1000
  // A zero (or negative) duration cannot produce a ratio; the reference lets
  // DOTween complete such a tween immediately, so treat progress as finished.
  const rawProgress = runtime.durationMs > 0 ? Math.min(runtime.elapsedMs / runtime.durationMs, 1) : 1
  const progress = easingFor(tween)(rawProgress)

  switch (mode.$case) {
    case 'move': {
      const start = toVector3(mode.move.start, runtime.startPosition)
      const end = toVector3(mode.move.end, runtime.startPosition)
      Vector3.LerpToRef(start, end, progress, target.position)
      // `faceDirection` is deliberately ignored: the reference client never
      // reads it either (it exists only in the generated protobuf), so honouring
      // it here would make this server rotate entities no client rotates.
      return true
    }
    case 'rotate': {
      const start = toQuaternion(mode.rotate.start, runtime.startRotation)
      const end = toQuaternion(mode.rotate.end, runtime.startRotation)
      Quaternion.SlerpToRef(start, end, progress, target.rotation)
      return true
    }
    case 'scale': {
      const start = toVector3(mode.scale.start, runtime.startScale)
      const end = toVector3(mode.scale.end, runtime.startScale)
      Vector3.LerpToRef(start, end, progress, target.scale)
      return true
    }
    case 'moveRotateScale': {
      // Every field is optional; an omitted one keeps the value the entity had
      // when the tween started (the reference's ResolveMoveRotateScale).
      const mrs = mode.moveRotateScale
      Vector3.LerpToRef(
        toVector3(mrs.positionStart, runtime.startPosition),
        toVector3(mrs.positionEnd, runtime.startPosition),
        progress,
        target.position
      )
      Quaternion.SlerpToRef(
        toQuaternion(mrs.rotationStart, runtime.startRotation),
        toQuaternion(mrs.rotationEnd, runtime.startRotation),
        progress,
        target.rotation
      )
      Vector3.LerpToRef(
        toVector3(mrs.scaleStart, runtime.startScale),
        toVector3(mrs.scaleEnd, runtime.startScale),
        progress,
        target.scale
      )
      return true
    }
    case 'moveContinuous': {
      // position = start + normalize(direction) * speed * elapsedSeconds.
      // The reference drives a 0..1 virtual float over ONE second on an
      // incremental loop, which is the same thing as multiplying by the elapsed
      // seconds — the sign travels with `speed`, not with the normalization.
      const direction = toVector3(mode.moveContinuous.direction, Vector3.Zero())
      const length = direction.length()
      if (length > 0) {
        direction.scaleInPlace(1 / length)
      }
      const speed = mode.moveContinuous.speed ?? 0
      direction.scaleToRef(speed * elapsedSeconds, tmpVector)
      runtime.startPosition.addToRef(tmpVector, target.position)
      return true
    }
    case 'rotateContinuous': {
      // The axis comes from the quaternion's imaginary part (x,y,z =
      // sin(angle/2) * axis), NOT from rotating a reference vector: that
      // preserves the sign of the axis, which the reference calls out
      // explicitly. A ~zero imaginary part means the identity quaternion, which
      // carries no axis — it falls back to +Y there and so do we.
      const direction = mode.rotateContinuous.direction
      const axis = new Vector3(direction?.x ?? 0, direction?.y ?? 0, direction?.z ?? 0)
      if (axis.lengthSquared() < 1e-6) {
        axis.set(0, 1, 0)
      } else {
        axis.normalize()
      }

      const speed = mode.rotateContinuous.speed ?? 0
      // `speed` is degrees per second (the reference derives
      // secondsPerRevolution = 360 / |speed|).
      const degrees = speed * elapsedSeconds
      Quaternion.RotationAxisToRef(axis, (degrees * Math.PI) / 180, tmpQuaternion)
      // Hamilton product, same operand order as the reference's
      // `AngleAxis(v, axis) * start` — the continuous rotation is applied on top
      // of the starting orientation, not before it.
      tmpQuaternion.multiplyToRef(runtime.startRotation, target.rotation)
      return true
    }
    case 'textureMove':
    case 'textureMoveContinuous':
      // Tracked for TweenState only; there is no material to move headless.
      return false
    default:
      return false
  }
}

/**
 * Advances every live tween in the scene by `deltaMs`, publishing the resulting
 * Transform and any TweenState transition back to the scene.
 *
 * Runs at the END of SceneContext.update() — after the scene's CRDT for this
 * tick is ingested (so a PUT this frame is honoured immediately) and before
 * Babylon computes world matrices, so colliders and raycasts in the same frame
 * see the tweened positions rather than last frame's.
 */
export function processTweens(context: SceneContext, deltaMs: number) {
  const Tween = context.components[tweenComponent.componentId]
  const TweenState = context.components[tweenStateComponent.componentId]
  const TransformStore = context.components[transformComponent.componentId]

  for (const [entityId, tween] of Tween.iterator()) {
    const babylonEntity = context.getEntityOrNull(entityId)
    if (!babylonEntity) continue

    const currentTransform = TransformStore.getOrNull(entityId)
    // The reference's query requires an SDKTransform; without one there is
    // nothing to tween against, so skip rather than inventing an identity
    // transform the scene never asked for.
    if (!currentTransform) continue

    let runtime = tweenRuntimes(context).get(entityId)
    const isNewValue = !runtime || runtime.source !== tween

    if (isNewValue) {
      runtime = setupRuntime(tween as PBTween, currentTransform)
      tweenRuntimes(context).set(entityId, runtime)
    }

    const active = runtime!.state === TweenStateStatus.TS_ACTIVE
    if (active) {
      runtime!.elapsedMs += deltaMs
    }

    const previousState = runtime!.state
    if (active && !isContinuous(tween as PBTween) && runtime!.elapsedMs >= runtime!.durationMs) {
      runtime!.elapsedMs = runtime!.durationMs
      runtime!.state = TweenStateStatus.TS_COMPLETED
    }

    const stateChanged = isNewValue || runtime!.state !== previousState

    // While ACTIVE the transform moves every frame. Once COMPLETED/PAUSED it is
    // written once (on the transition) and then left alone, so a finished tween
    // stops republishing the same Transform every frame forever.
    if (stateChanged || runtime!.state === TweenStateStatus.TS_ACTIVE) {
      const next: Transform = {
        position: currentTransform.position.clone(),
        rotation: currentTransform.rotation.clone(),
        scale: currentTransform.scale.clone(),
        parent: currentTransform.parent
      }

      if (applyTweenValue(tween as PBTween, runtime!, next)) {
        TransformStore.createOrReplace(entityId, next)
        // Mirror the CRDT write onto the Babylon node. A host-side
        // createOrReplace does not run the component's applyChanges (that is the
        // inbound-CRDT path), so without this the scene would be told the entity
        // moved while its collider stayed put.
        applyNewTransform(babylonEntity, next)
      }
    }

    if (stateChanged) {
      // Only `state` is populated. The reference client never sets
      // `currentTime` on TweenState either, and an authoritative server
      // reporting a field real clients leave at 0 is a divergence scenes could
      // legitimately trip over.
      TweenState.createOrReplace(entityId, { state: runtime!.state, currentTime: 0 })
    }
  }

  pruneRuntimes(context, Tween)
}

// Per-scene runtime map. Keyed by entity and bounded by the scene's live-entity
// cap; entries are dropped as soon as their Tween component goes away.
const runtimesByContext = new WeakMap<SceneContext, Map<Entity, TweenRuntime>>()

function tweenRuntimes(context: SceneContext): Map<Entity, TweenRuntime> {
  let map = runtimesByContext.get(context)
  if (!map) {
    map = new Map()
    runtimesByContext.set(context, map)
  }
  return map
}

function pruneRuntimes(context: SceneContext, Tween: { has(entity: Entity): boolean }) {
  const map = runtimesByContext.get(context)
  if (!map || map.size === 0) return
  for (const entityId of map.keys()) {
    if (!Tween.has(entityId)) {
      map.delete(entityId)
    }
  }
}
