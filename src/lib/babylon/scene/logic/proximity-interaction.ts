import { Quaternion, Vector3 } from '@babylonjs/core'
import { InputAction, InteractionType, PointerEventType } from '@dcl/protocol/out-js/decentraland/sdk/components/common/input_action.gen'
import { PBPointerEvents } from '@dcl/protocol/out-js/decentraland/sdk/components/pointer_events.gen'
import type { SceneContext } from '../scene-context'
import { Entity } from '../../../decentraland/types'
import { pointerEventsComponent } from '../../../decentraland/sdk-components/pointer-events'
import { pointerEventsResultComponent } from '../../../decentraland/sdk-components/pointer-events-result'
import { playerEntityAtom } from '../../../decentraland/state'
import { limitLogger } from '../../../misc/limit-logger'
import { interactionTypeOf, resolvePointerInfo } from './pointer-event-filter'

/**
 * `InteractionType.PROXIMITY` pointer events: entries that fire on the player being
 * NEAR an entity rather than pointing at it, reporting PET_PROXIMITY_ENTER and
 * PET_PROXIMITY_LEAVE.
 *
 * These never fired at all on this server — the whole interaction type was
 * unimplemented, so a scene using proximity triggers (a door that greets you, a sign
 * that lights up as you approach) simply got nothing while working for every real
 * player. The reference client implements it in `PlayerOriginatedProximitySystem`.
 *
 * The client's geometry, matched here:
 *   - origin is the player capsule's CENTRE, not its feet. NOTE this differs from
 *     the POINTER path's `max_player_distance`, which the client measures from the
 *     feet (`cc.transform.position`) — the proximity system deliberately computes
 *     `TransformPoint(cc.center)` instead. Two origins, 0.85m apart, easy to conflate.
 *   - candidates within PROXIMITY_SEARCH_RADIUS metres
 *   - inside a 120-degree HORIZONTAL cone in front of the player, so something
 *     behind you does not trigger
 *   - within the entry's `maxPlayerDistance`
 *   - highest `priority` wins; among equal priority the CLOSEST wins
 *   - exactly ONE entity is the proximity target at a time
 *
 * NOT matched, and deliberately: the client also raycasts to the candidate and skips
 * it when another collider obstructs the line. That needs a per-candidate raycast
 * against the whole collider set, which is the cost this PR spent considerable effort
 * bounding, and the occlusion it prevents is cosmetic rather than authoritative. Left
 * as a known divergence rather than smuggled in.
 */

/** Radius searched around the player, from the client's PROXIMITY_DEFAULT_MAX_DISTANCE. */
const PROXIMITY_SEARCH_RADIUS = 3

/**
 * Ceiling on entities examined per frame, mirroring the client's fixed 32-collider
 * `OverlapSphereNonAlloc` buffer.
 *
 * Without it this scanned EVERY entity holding a PointerEvents component, every frame,
 * per scene, inside a quota-free `lateUpdate`: measured 3.86ms at 3000 entities, so
 * ~130ms/frame at the 100_000 entity cap. The client never examines more than 32
 * candidates because its buffer cannot hold more.
 *
 * Examined, not matched: entities are skipped cheaply before counting, so the ceiling
 * bounds real work rather than truncating at an arbitrary point in the map.
 */
const PROXIMITY_MAX_CANDIDATES = 32

/** Horizontal field of view in front of the player, from the client's constant. */
const PROXIMITY_FOV_ANGLE_DEGREES = 120

/** cos of the HALF angle: a candidate qualifies when its flattened direction is inside the cone. */
const FOV_HALF_ANGLE_COS = Math.cos(((PROXIMITY_FOV_ANGLE_DEGREES / 2) * Math.PI) / 180)

/** The entity currently in proximity, per scene, so ENTER/LEAVE fire on change only. */
const proximityTargets = new WeakMap<SceneContext, Entity>()

/**
 * Smallest `maxPlayerDistance` and highest `priority` across an entity's PROXIMITY
 * entries, matching the client's `GetMaxDistanceAndHighestPriority`.
 *
 * The MINIMUM distance, not the maximum: the entity becomes a candidate at the
 * tightest range any of its entries asks for. Each entry is still filtered
 * individually when the result is emitted, so a wider entry is not lost — this only
 * decides candidacy.
 */
function proximityCriteria(value: PBPointerEvents): { maxPlayerDistance: number; priority: number } | null {
  let maxPlayerDistance = Number.POSITIVE_INFINITY
  let priority = 0
  let found = false

  for (const entry of value.pointerEvents) {
    if (interactionTypeOf(entry) !== InteractionType.PROXIMITY) continue
    found = true
    const info = resolvePointerInfo(entry.eventInfo)
    if (info.maxPlayerDistance < maxPlayerDistance) maxPlayerDistance = info.maxPlayerDistance
    if (info.priority > priority) priority = info.priority
  }

  return found ? { maxPlayerDistance, priority } : null
}

/**
 * Picks this scene's proximity target and emits PET_PROXIMITY_ENTER / _LEAVE when it
 * changes. Called once per frame per scene.
 */
export function updateProximityInteractions(context: SceneContext): void {
  const player = playerEntityAtom.getOrNull()
  const PointerEvents = context.components[pointerEventsComponent.componentId]

  const winner = player
    ? findProximityTarget(context, player.absolutePosition, playerForward(player.absoluteRotationQuaternion))
    : null
  const previous = proximityTargets.get(context)

  if (previous === winner) return

  // LEAVE targets the entity being left, so it fires BEFORE the swap; ENTER targets
  // the new one and fires after. Same ordering trap as the hover path, which had the
  // comparison after the assignment and so could never fire ENTER.
  if (previous !== undefined) {
    const leaving = PointerEvents.getOrNull(previous)
    if (leaving) emitProximityResults(context, previous, leaving, PointerEventType.PET_PROXIMITY_LEAVE)
  }

  if (winner === null) {
    proximityTargets.delete(context)
  } else {
    proximityTargets.set(context, winner)
    emitProximityResults(context, winner, PointerEvents.getOrNull(winner)!, PointerEventType.PET_PROXIMITY_ENTER)
  }
}

/**
 * Flattened, normalized facing direction of the player, or null when it cannot be
 * determined — in which case the cone test is skipped and only distance applies.
 *
 * Derived from the rotation rather than read off `TransformNode.forward`, which is
 * the same vector but requires a fully-built node: `playerEntityAtom` is a plain atom
 * that tests (and early startup) can hold a partially-populated object in, and
 * reaching for `.forward` there threw and took the whole per-frame static-entity
 * update down with it.
 */
function playerForward(rotation: Quaternion | undefined | null): Vector3 | null {
  if (!rotation) return null
  const facing = Vector3.Forward().rotateByQuaternionToRef(rotation, new Vector3())
  const flat = new Vector3(facing.x, 0, facing.z)
  if (flat.lengthSquared() < 1e-6) return null
  return flat.normalize()
}

function findProximityTarget(context: SceneContext, playerPosition: Vector3, forward: Vector3 | null): Entity | null {
  const PointerEvents = context.components[pointerEventsComponent.componentId]

  let bestEntity: Entity | null = null
  let bestPriority = -1
  let bestDistance = Number.POSITIVE_INFINITY
  let examined = 0

  for (const [entityId, value] of PointerEvents.iterator()) {
    if (examined >= PROXIMITY_MAX_CANDIDATES) {
      limitLogger.hit('maxLiveEntities', `scene ${context.entityId}: proximity candidates truncated`)
      break
    }

    const criteria = proximityCriteria(value)
    if (!criteria) continue

    const entity = context.getEntityOrNull(entityId)
    if (!entity) continue

    const toTarget = entity.absolutePosition.subtract(playerPosition)
    const distance = toTarget.length()

    if (distance > PROXIMITY_SEARCH_RADIUS || distance > criteria.maxPlayerDistance) continue

    // Counted only once a candidate is genuinely in range, so the ceiling bounds the
    // expensive tail (cone test, priority compare) rather than cutting the scan at an
    // arbitrary point in the component map.
    examined++

    // Cone test on the FLATTENED direction, so looking up or down does not change
    // who is in front of you. A candidate exactly on the player is skipped rather
    // than treated as in-cone: its direction is undefined.
    if (forward) {
      const flat = new Vector3(toTarget.x, 0, toTarget.z)
      const flatLength = flat.length()
      if (flatLength < 1e-3) continue
      if (Vector3.Dot(forward, flat) / flatLength < FOV_HALF_ANGLE_COS) continue
    }

    // Highest priority wins outright; the closest breaks ties within a priority.
    if (criteria.priority < bestPriority) continue
    if (criteria.priority === bestPriority && distance >= bestDistance) continue

    bestEntity = entityId
    bestPriority = criteria.priority
    bestDistance = distance
  }

  return bestEntity
}

/**
 * Emits one result per PROXIMITY entry matching `eventType`.
 *
 * `hit` is deliberately left undefined: a proximity event has no ray and no
 * intersection, so there is no hit to report. PBPointerEventsResult.hit is optional
 * for exactly this case, and inventing a synthetic ray would hand scenes a
 * direction and origin that no pointer ever travelled.
 */
function emitProximityResults(
  context: SceneContext,
  entityId: Entity,
  value: PBPointerEvents,
  eventType: PointerEventType
): void {
  const PointerEventsResult = context.components[pointerEventsResultComponent.componentId]

  for (const entry of value.pointerEvents) {
    if (interactionTypeOf(entry) !== InteractionType.PROXIMITY) continue
    if (entry.eventType !== eventType) continue
    const { button } = resolvePointerInfo(entry.eventInfo)
    if (button !== InputAction.IA_POINTER && button !== InputAction.IA_ANY) continue

    PointerEventsResult.addValue(entityId, {
      // Button-gated like the cursor path: the client's AppendPointerInputIfQualified
      // requires IaPointer or IaAny for every enter/leave append.
      button: resolvePointerInfo(entry.eventInfo).button,
      state: eventType,
      hit: undefined,
      // THE TICK, not a private counter. An earlier revision used its own lamport
      // counter here, independent of the cursor path's — and the scene-side SDK gates
      // every lookup on `timestamp > previousFrameMaxTimestamp`, where the maximum is
      // taken over ALL entities' results in the scene. Once the cursor counter ran
      // ahead (it always does, hover fires every frame) every proximity result looked
      // stale and was silently discarded, and low timestamps are also the first
      // trimmed by the store's 100-element cap. The client uses TickNumber for both
      // fields; one source is the only thing that works.
      timestamp: context.currentTick,
      tickNumber: context.currentTick
    })
  }
}
