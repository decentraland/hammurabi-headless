import { Quaternion, Vector3 } from '@babylonjs/core'
import { EasingFunction, PBTween } from '@dcl/protocol/out-js/decentraland/sdk/components/tween.gen'
import { TweenStateStatus } from '@dcl/protocol/out-js/decentraland/sdk/components/tween_state.gen'
import {
  Quaternion as PBQuaternion,
  Vector3 as PBVector3
} from '@dcl/protocol/out-js/decentraland/common/vectors.gen'
import { easingsFunctions } from './easings'
import { tweenComponent } from '../../../decentraland/sdk-components/tween'
import { tweenStateComponent } from '../../../decentraland/sdk-components/tween-state'
import { applyNewTransform, Transform, transformComponent } from '../../../decentraland/sdk-components/transform-component'
import { Entity } from '../../../decentraland/types'
import { RESERVED_ENTITY_RANGE, entityIsInRange } from './static-entities'
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
 * - Continuous modes DO complete when `duration > 0` (the reference's
 *   `UpdatePBTween` kills them once `TweenSurpassedDuration`); only
 *   `duration == 0` runs forever. They freeze at the value reached at the
 *   deadline, and ignore easing (the reference forces `Ease.Linear`).
 * - A PBTween with no `mode` is ignored entirely — no runtime, no TweenState.
 *   The reference's `TweenLoaderSystem.LoadTween` / `UpdatePBTween` both return
 *   on `ModeCase == None`.
 * - `PBTweenState` is DELETED when `PBTween` goes away (the reference's
 *   `TweenCleanUpSystem.CleanUpTweenBeforeRemoval`); otherwise
 *   `tweenSystem.tweenCompleted()` keeps answering `true` for an entity that no
 *   longer has a tween.
 *
 * UNTRUSTED INPUT: a PBTween is scene-authored, so every number it carries can be
 * NaN/Infinity and every vector can be degenerate. All of it is sanitized ONCE at
 * setup (see `setupRuntime`/`buildPlan`) rather than per frame, because a
 * non-finite value that reaches the per-frame path never leaves TS_ACTIVE
 * (`NaN >= NaN` is false) and therefore publishes a NaN Transform to the scene —
 * and onto the Babylon node — on every frame, forever.
 */

// Unity's `Vector3.normalized` returns the ZERO vector when the magnitude is not
// greater than 1e-5, so a degenerate (or NaN) direction simply does not move in
// the reference client. `length > MIN_NORMALIZABLE_LENGTH` is false for NaN,
// which is the whole point: `if (length > 0)` was not.
const MIN_NORMALIZABLE_LENGTH = 1e-5
// The reference's rotateContinuous axis guard is `sqrMagnitude < 1e-6`, i.e. a
// magnitude below 1e-3.
const MIN_AXIS_LENGTH = 1e-3
// Below this a quaternion carries no orientation at all; slerping two of them
// yields {0,0,0,0}, which is not a rotation any real client would ever emit.
const MIN_QUATERNION_LENGTH = 1e-6

// Reused temporaries for the per-frame math (single-threaded, non-reentrant).
const tmpVector = new Vector3()
const tmpQuaternion = new Quaternion()

// Never mutated — only cloned from / read as fallbacks.
const READONLY_ZERO = Vector3.Zero()
const READONLY_ONE = Vector3.One()
const READONLY_IDENTITY = Quaternion.Identity()

/**
 * What a tween actually does, resolved once at setup: sanitized endpoints for the
 * interpolated modes, a sanitized velocity/axis for the continuous ones, and
 * nothing at all for the modes that only report state. Resolving here (rather
 * than re-reading `tween.mode` every frame) is both the sanitization seam and the
 * allocation fix — the per-frame path allocates nothing.
 */
type LerpPlan = {
  $case: 'lerp'
  positionStart: Vector3 | null
  positionEnd: Vector3 | null
  rotationStart: Quaternion | null
  rotationEnd: Quaternion | null
  scaleStart: Vector3 | null
  scaleEnd: Vector3 | null
}

type TweenPlan =
  | LerpPlan
  | { $case: 'moveContinuous'; origin: Vector3; velocity: Vector3 }
  | { $case: 'rotateContinuous'; origin: Quaternion; axis: Vector3; degreesPerSecond: number }
  // Texture modes (nothing to animate headless) and any mode this server does
  // not know about: they still RUN, so a scene waiting on `tweenCompleted` is
  // not left waiting, but they never touch the Transform.
  | { $case: 'stateOnly' }

const STATE_ONLY_PLAN: TweenPlan = { $case: 'stateOnly' }

type TweenRuntime = {
  // Identity of the PBTween this runtime was built from. See the note above.
  source: PBTween
  elapsedMs: number
  durationMs: number
  continuous: boolean
  easing: (progress: number) => number
  state: TweenStateStatus
  plan: TweenPlan
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function vector3Of(x: number, y: number, z: number, fallback: Vector3): Vector3 {
  if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) return new Vector3(x, y, z)
  return fallback.clone()
}

function toVector3(value: PBVector3 | undefined, fallback: Vector3): Vector3 {
  if (!value) return fallback.clone()
  return vector3Of(value.x, value.y, value.z, fallback)
}

/**
 * Always returns a UNIT quaternion (or the fallback, which callers keep unit).
 * `Quaternion.SlerpToRef` of two zero-length quaternions returns {0,0,0,0}, and
 * that value would be written verbatim to the CRDT and onto `rotationQuaternion`
 * — no real client emits a non-unit rotation.
 */
function quaternionOf(x: number, y: number, z: number, w: number, fallback: Quaternion): Quaternion {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(w)) {
    return fallback.clone()
  }
  const value = new Quaternion(x, y, z, w)
  const length = value.length()
  if (!Number.isFinite(length) || length < MIN_QUATERNION_LENGTH) return READONLY_IDENTITY.clone()
  value.scaleInPlace(1 / length)
  return value
}

function toQuaternion(value: PBQuaternion | undefined, fallback: Quaternion): Quaternion {
  if (!value) return fallback.clone()
  return quaternionOf(value.x, value.y, value.z, value.w, fallback)
}

function isContinuous(tween: PBTween): boolean {
  const mode = tween.mode?.$case
  return mode === 'moveContinuous' || mode === 'rotateContinuous' || mode === 'textureMoveContinuous'
}

/**
 * Whether the mode drives the entity's Transform. Texture tweens animate a
 * material's UV offset/tiling — there is nothing to animate headless, but the
 * tween still has to RUN, so they are tracked for STATE only. An unknown mode
 * (protocol drift) is treated the same way rather than assumed to be a transform.
 *
 * This is also why the Transform requirement below is conditional: the
 * reference's texture path queries MaterialComponent, not SDKTransform, so
 * demanding a Transform would silently drop the completion a scene is waiting on.
 */
function modeDrivesTransform(tween: PBTween): boolean {
  switch (tween.mode?.$case) {
    case 'move':
    case 'rotate':
    case 'scale':
    case 'moveRotateScale':
    case 'moveContinuous':
    case 'rotateContinuous':
      return true
    default:
      return false
  }
}

function easingFor(tween: PBTween): (progress: number) => number {
  // Continuous modes are linear by definition; the reference forces Ease.Linear
  // for them regardless of what the scene set.
  if (isContinuous(tween)) return easingsFunctions[EasingFunction.EF_LINEAR]
  return easingsFunctions[tween.easingFunction] ?? easingsFunctions[EasingFunction.EF_LINEAR]
}

function buildPlan(
  tween: PBTween,
  startPosition: Vector3,
  startRotation: Quaternion,
  startScale: Vector3
): TweenPlan {
  const mode = tween.mode

  switch (mode?.$case) {
    case 'move':
      // `faceDirection` is deliberately ignored: the reference client never
      // reads it either (it exists only in the generated protobuf), so honouring
      // it here would make this server rotate entities no client rotates.
      return {
        $case: 'lerp',
        positionStart: toVector3(mode.move.start, startPosition),
        positionEnd: toVector3(mode.move.end, startPosition),
        rotationStart: null,
        rotationEnd: null,
        scaleStart: null,
        scaleEnd: null
      }
    case 'rotate':
      return {
        $case: 'lerp',
        positionStart: null,
        positionEnd: null,
        rotationStart: toQuaternion(mode.rotate.start, startRotation),
        rotationEnd: toQuaternion(mode.rotate.end, startRotation),
        scaleStart: null,
        scaleEnd: null
      }
    case 'scale':
      return {
        $case: 'lerp',
        positionStart: null,
        positionEnd: null,
        rotationStart: null,
        rotationEnd: null,
        scaleStart: toVector3(mode.scale.start, startScale),
        scaleEnd: toVector3(mode.scale.end, startScale)
      }
    case 'moveRotateScale': {
      // Every field is optional; an omitted one keeps the value the entity had
      // when the tween started (the reference's ResolveMoveRotateScale).
      const mrs = mode.moveRotateScale
      return {
        $case: 'lerp',
        positionStart: toVector3(mrs.positionStart, startPosition),
        positionEnd: toVector3(mrs.positionEnd, startPosition),
        rotationStart: toQuaternion(mrs.rotationStart, startRotation),
        rotationEnd: toQuaternion(mrs.rotationEnd, startRotation),
        scaleStart: toVector3(mrs.scaleStart, startScale),
        scaleEnd: toVector3(mrs.scaleEnd, startScale)
      }
    }
    case 'moveContinuous': {
      // position = start + normalize(direction) * speed * elapsedSeconds.
      // The reference drives a 0..1 virtual float over ONE second on an
      // incremental loop, which is the same thing as multiplying by the elapsed
      // seconds — the sign travels with `speed`, not with the normalization.
      const direction = toVector3(mode.moveContinuous.direction, READONLY_ZERO)
      const length = direction.length()
      const speed = finiteOr(mode.moveContinuous.speed, 0)
      const factor = speed / length
      const velocity =
        Number.isFinite(length) && length > MIN_NORMALIZABLE_LENGTH
          ? vector3Of(direction.x * factor, direction.y * factor, direction.z * factor, READONLY_ZERO)
          : READONLY_ZERO.clone()
      return { $case: 'moveContinuous', origin: startPosition, velocity }
    }
    case 'rotateContinuous': {
      // The axis comes from the quaternion's imaginary part (x,y,z =
      // sin(angle/2) * axis), NOT from rotating a reference vector: that
      // preserves the sign of the axis, which the reference calls out
      // explicitly. A ~zero (or non-finite) imaginary part carries no axis — it
      // falls back to +Y there and so do we.
      const direction = mode.rotateContinuous.direction
      const axis = vector3Of(direction?.x ?? 0, direction?.y ?? 0, direction?.z ?? 0, READONLY_ZERO)
      const length = axis.length()
      if (Number.isFinite(length) && length >= MIN_AXIS_LENGTH) {
        axis.scaleInPlace(1 / length)
      } else {
        axis.set(0, 1, 0)
      }
      return {
        $case: 'rotateContinuous',
        origin: startRotation,
        axis,
        // `speed` is degrees per second (the reference derives
        // secondsPerRevolution = 360 / |speed|).
        degreesPerSecond: finiteOr(mode.rotateContinuous.speed, 0)
      }
    }
    default:
      return STATE_ONLY_PLAN
  }
}

function setupRuntime(tween: PBTween, current: Transform | null): TweenRuntime {
  // A negative duration is not a thing the reference can express either (DOTween
  // clamps at 0); clamping here also keeps `elapsedMs >= durationMs` meaningful.
  const durationMs = Math.max(finiteOr(tween.duration, 0), 0)
  const playing = tween.playing ?? true
  // `currentTime` is a normalized 0..1 seek position, clamped by the reference.
  // `Math.min(Math.max(NaN, 0), 1)` is NaN, so the clamp alone does NOT sanitize.
  const seek = Math.min(Math.max(finiteOr(tween.currentTime, 0), 0), 1)

  // Captured at setup. Continuous modes are relative to wherever the entity was
  // when the tween started, and MoveRotateScale fills omitted fields from it.
  // Sanitized too: the Transform itself came from scene-authored CRDT floats.
  const startPosition = current
    ? vector3Of(current.position.x, current.position.y, current.position.z, READONLY_ZERO)
    : READONLY_ZERO.clone()
  const startRotation = current
    ? quaternionOf(current.rotation.x, current.rotation.y, current.rotation.z, current.rotation.w, READONLY_IDENTITY)
    : READONLY_IDENTITY.clone()
  const startScale = current
    ? vector3Of(current.scale.x, current.scale.y, current.scale.z, READONLY_ONE)
    : READONLY_ONE.clone()

  return {
    source: tween,
    durationMs,
    elapsedMs: seek * durationMs,
    continuous: isContinuous(tween),
    easing: easingFor(tween),
    state: playing ? TweenStateStatus.TS_ACTIVE : TweenStateStatus.TS_PAUSED,
    plan: buildPlan(tween, startPosition, startRotation, startScale)
  }
}

/**
 * The reference's `TweenSurpassedDuration`: `Duration > 0 && elapsed >=
 * Duration/1000`. The `Duration > 0` half only matters for the CONTINUOUS modes
 * — a zero-duration interpolated tween completes on the spot (DOTween finishes
 * it immediately), while a zero-duration continuous tween is the documented way
 * to run forever.
 */
function hasSurpassedDuration(runtime: TweenRuntime): boolean {
  if (runtime.elapsedMs < runtime.durationMs) return false
  return runtime.continuous ? runtime.durationMs > 0 : true
}

/**
 * Applies the tween at its current elapsed time to `target`, mutating it in
 * place. Only ever called for plans that drive the Transform.
 */
function applyTween(runtime: TweenRuntime, target: Transform) {
  const plan = runtime.plan

  switch (plan.$case) {
    case 'lerp': {
      // A zero (or negative) duration cannot produce a ratio; the reference lets
      // DOTween complete such a tween immediately, so treat progress as finished.
      const rawProgress = runtime.durationMs > 0 ? Math.min(runtime.elapsedMs / runtime.durationMs, 1) : 1
      const progress = runtime.easing(rawProgress)
      if (plan.positionStart && plan.positionEnd) {
        Vector3.LerpToRef(plan.positionStart, plan.positionEnd, progress, target.position)
      }
      if (plan.rotationStart && plan.rotationEnd) {
        Quaternion.SlerpToRef(plan.rotationStart, plan.rotationEnd, progress, target.rotation)
      }
      if (plan.scaleStart && plan.scaleEnd) {
        Vector3.LerpToRef(plan.scaleStart, plan.scaleEnd, progress, target.scale)
      }
      return
    }
    case 'moveContinuous': {
      plan.velocity.scaleToRef(runtime.elapsedMs / 1000, tmpVector)
      plan.origin.addToRef(tmpVector, target.position)
      return
    }
    case 'rotateContinuous': {
      // Wrapped to a single revolution, as the reference does via
      // `LoopType.Restart` over `secondsPerRevolution = 360 / |speed|`: the
      // rotation is identical and `elapsedMs` (unbounded for a duration-0 tween)
      // stops eating the angle's floating-point precision after hours of uptime.
      const degrees = finiteOr(plan.degreesPerSecond * (runtime.elapsedMs / 1000), 0) % 360
      Quaternion.RotationAxisToRef(plan.axis, (degrees * Math.PI) / 180, tmpQuaternion)
      // Hamilton product, same operand order as the reference's
      // `AngleAxis(v, axis) * start` — the continuous rotation is applied on top
      // of the starting orientation, not before it.
      tmpQuaternion.multiplyToRef(plan.origin, target.rotation)
      return
    }
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
 *
 * `deltaMs` is ELAPSED WALL-CLOCK time since the previous call, not the engine's
 * frame delta — see `SceneContext.consumeTweenDeltaMs`.
 */
export function processTweens(context: SceneContext, deltaMs: number) {
  const Tween = context.components[tweenComponent.componentId]
  const TweenState = context.components[tweenStateComponent.componentId]
  const TransformStore = context.components[transformComponent.componentId]
  const runtimes = tweenRuntimes(context)

  // The clock is the host's, but a NaN/negative delta must not be able to poison
  // every live tween's elapsed time.
  const delta = deltaMs > 0 && Number.isFinite(deltaMs) ? deltaMs : 0

  // Number of Tween entities that own a runtime after this pass. Used to skip the
  // prune scan entirely in the steady state (nothing was removed).
  let liveRuntimes = 0

  for (const [entityId, value] of Tween.iterator()) {
    // The reserved range [0, MAX_RESERVED_ENTITY) is HOST-owned. Component PUTs
    // there are not denied by the scene write guard (scenes legitimately write
    // e.g. InputModifier on PlayerEntity), and `transformComponent.applyChanges`
    // deliberately early-returns for the root — but `applyNewTransform` below is
    // the raw call that guard protects. A scene PUTting Transform{parent: N} +
    // PBTween on entity 0 would otherwise schedule the ROOT for reparenting,
    // `resolveCyclicParenting` would resolve the cycle by setting
    // `rootNode.parent = rootNode`, and `computeWorldMatrix` would then recurse
    // until the stack blew — outside update()/lateUpdate()'s try/catch, every
    // frame. Host entities are not scene-tweenable, full stop.
    if (entityIsInRange(entityId, RESERVED_ENTITY_RANGE)) continue

    const babylonEntity = context.getEntityOrNull(entityId)
    if (!babylonEntity) continue

    const tween = value as PBTween
    // No mode means there is nothing to run: the reference's
    // TweenLoaderSystem.LoadTween and UpdatePBTween both return on
    // `ModeCase == None`, so no component and no TweenState are ever produced.
    if (!tween.mode) continue

    const drivesTransform = modeDrivesTransform(tween)
    const currentTransform = TransformStore.getOrNull(entityId)
    // The reference's transform query requires an SDKTransform; without one there
    // is nothing to tween against, so skip rather than inventing an identity
    // transform the scene never asked for. Texture/state-only modes do NOT need
    // one (see modeDrivesTransform).
    if (drivesTransform && !currentTransform) continue

    let runtime = runtimes.get(entityId)
    const isNewValue = !runtime || runtime.source !== tween

    if (isNewValue) {
      runtime = setupRuntime(tween, currentTransform)
      runtimes.set(entityId, runtime)
    }
    liveRuntimes++

    const active = runtime!.state === TweenStateStatus.TS_ACTIVE
    // A tween set up THIS pass has not lived through `delta` yet. It matters
    // because `delta` is accumulated wall-clock time: a tween PUT on a frame that
    // followed a quota-starved one would otherwise jump forward by time that
    // elapsed before it existed.
    if (active && !isNewValue) {
      runtime!.elapsedMs += delta
    }

    const previousState = runtime!.state
    if (active && hasSurpassedDuration(runtime!)) {
      runtime!.elapsedMs = runtime!.durationMs
      runtime!.state = TweenStateStatus.TS_COMPLETED
    }

    const stateChanged = isNewValue || runtime!.state !== previousState

    // While ACTIVE the transform moves every frame. Once COMPLETED/PAUSED it is
    // written once (on the transition) and then left alone, so a finished tween
    // stops republishing the same Transform every frame forever.
    if (drivesTransform && (stateChanged || runtime!.state === TweenStateStatus.TS_ACTIVE)) {
      // Mutated IN PLACE: the stored Transform is the very object the entity's
      // command log already points at, so there is nothing to clone and nothing
      // to re-parent. Cloning it (plus the endpoint vectors, now resolved at
      // setup) cost ~10 short-lived objects per tweened entity per frame.
      const target = TransformStore.getMutableOrNull(entityId)
      if (target) {
        applyTween(runtime!, target)
        // Mirror the CRDT write onto the Babylon node. A host-side mutation does
        // not run the component's applyChanges (that is the inbound-CRDT path),
        // so without this the scene would be told the entity moved while its
        // collider stayed put.
        applyNewTransform(babylonEntity, target)
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

  // Every runtime we did not touch belongs to an entity whose PBTween is gone (or
  // is being skipped); only then is the scan worth doing.
  if (runtimes.size !== liveRuntimes) {
    pruneRuntimes(runtimes, Tween, TweenState)
  }
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

function pruneRuntimes(
  runtimes: Map<Entity, TweenRuntime>,
  Tween: { has(entity: Entity): boolean },
  TweenState: { deleteFrom(entity: Entity, markAsDirty?: boolean): unknown }
) {
  for (const entityId of runtimes.keys()) {
    if (!Tween.has(entityId)) {
      runtimes.delete(entityId)
      // PBTweenState must not outlive PBTween: the reference's
      // TweenCleanUpSystem.CleanUpTweenBeforeRemoval issues DeleteMessage<
      // PBTweenState> too. Without it `tweenSystem.tweenCompleted(entity)` keeps
      // returning true for an entity that no longer has a tween. A no-op (and
      // no CRDT message) when the entity was deleted outright — removeEntity
      // already purged the component.
      TweenState.deleteFrom(entityId)
    }
  }
}
