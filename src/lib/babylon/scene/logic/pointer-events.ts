import { Matrix, Node, PickingInfo, PointerEventTypes, Ray, Scene, Vector3 } from '@babylonjs/core'
import { BabylonEntity } from '../BabylonEntity'
import { getColliderLayers } from './colliders'
import { ColliderLayer } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen'
import { InputAction, InteractionType, PointerEventType } from '@dcl/protocol/out-js/decentraland/sdk/components/common/input_action.gen'
import { pointerEventsComponent } from '../../../decentraland/sdk-components/pointer-events'
import { pointerEventsResultComponent } from '../../../decentraland/sdk-components/pointer-events-result'
import { PBPointerEventsResult } from '@dcl/protocol/out-js/decentraland/sdk/components/pointer_events_result.gen'
import { pickingToRaycastHit, raycastResultFromRay } from './raycasts'
import { loadedScenesByEntityId, playerEntityAtom } from '../../../decentraland/state'
import { isAvatarCapsule } from './avatar-colliders'
import { isHover, resolvePointerInfo, selectFiringEntries } from './pointer-event-filter'
import { PLAYER_CAPSULE_HALF_HEIGHT } from './static-entities'

// returns true if the entity has PointerEvents
export function entityHasPointerEvents(entity: BabylonEntity) {
  return !!entity.appliedComponents.pointerEvents
}

let lastPickedEntity: BabylonEntity | null = null
let lastPickPoint: PickingInfo | null = null

// NOTE: there is deliberately no private lamport counter here any more. Both writers of
// PBPointerEventsResult (this file and proximity-interaction.ts) stamp `timestamp` with
// the scene's `currentTick` — see addPointerEventResult.

/**
 * This function walks the parents of the provided searchEntity
 * @returns the first BabylonEntity it encounters
 */
function getParentEntity(leafEntity: Node): BabylonEntity | null {
  // walk the parents until we find the searchEntity we are looking for
  let parent: Node | null = leafEntity
  if (leafEntity instanceof BabylonEntity) return leafEntity
  while (parent = parent?.parent as any) {
    if (parent instanceof BabylonEntity) return parent
  }
  return null
}

// returns true if any loaded scene has at least one PointerEvents component
function anySceneHasPointerEvents(): boolean {
  for (const context of loadedScenesByEntityId.values()) {
    const store = context.components[pointerEventsComponent.componentId]
    for (const _ of store.iterator()) return true
  }
  return false
}

export function pickPointerEventsMesh(scene: Scene) {
  // The center-screen pick below is a full-scene CPU raycast (predicate over
  // every mesh, triangle-level tests) that runs every frame — skip it entirely
  // when no loaded scene has a PointerEvents component, since hover synthesis is
  // its only consumer on this headless server. When an entity is currently
  // hovered, still run one more pass so HOVER_LEAVE fires after the last
  // PointerEvents component disappears.
  if (!lastPickedEntity && !anySceneHasPointerEvents()) return

  const pick = pickActivePointerEventsInfo(scene)

  hoverNewEntity(pick ? getParentEntity(pick.pickedMesh!) : null, pick)
}

/** The interactable entity under the pointer this frame, or null. */
export function pickActivePointerEventsEntity(scene: Scene): BabylonEntity | null {
  const pick = pickActivePointerEventsInfo(scene)
  return pick ? getParentEntity(pick.pickedMesh!) : null
}

/**
 * Reach of the centre-screen pointer pick, matching the client's
 * `PlayerOriginatedRaycastSystem.MAX_RAYCAST_DISTANCE`.
 *
 * An entity a kilometre away could otherwise be hovered and clicked here while no
 * client would reach it, since a scene is free to ask for `maxDistance: 500` and the
 * client still cannot fire past its ray cap.
 *
 * This bounds the ANSWER, not the work: `Scene.prototype.pick` takes no distance
 * argument, so the whole scene is still tested and the check below is post-hoc. An
 * earlier version of this comment claimed the opposite.
 */
export const MAX_POINTER_PICK_DISTANCE = 100

/**
 * Collider layers that can BLOCK the pointer, whether or not they can receive it.
 *
 * The client casts one closest hit over `OnPointerEvent | Default | OtherAvatars`
 * (`PhysicsLayers.PLAYER_ORIGIN_RAYCAST_MASK`) and, when that closest collider is not
 * an interactable scene entity, calls `Reset()` and hovers NOTHING
 * (`PlayerOriginatedRaycastSystem.cs:93,112-113`). So a plain wall, or another player,
 * blocks interaction there.
 *
 * `CL_PHYSICS` stands in for Unity's Default layer and `CL_PLAYER` for `OtherAvatars`.
 *
 * `CL_MAIN_PLAYER` is deliberately ABSENT, matching the client's mask, which names
 * OtherAvatars but not the local CharacterController — see the capsule check in the
 * predicate for why that distinction decides whether the pointer works at all.
 *
 * The `CL_CUSTOM*` bits are deliberately NOT included either: this server has no
 * evidence of which Unity layer the client assigns a custom-only collider to, and
 * treating them as occluders would be inventing an interaction block rather than
 * reproducing one.
 */
const POINTER_OCCLUDING_LAYERS =
  ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS | ColliderLayer.CL_PLAYER

/**
 * The centre-screen pick, or null when nothing interactable is hovered.
 *
 * Returns the `PickingInfo` rather than the entity, and does NOT touch `lastPickPoint`:
 * the caller has to emit `PET_HOVER_LEAVE` for the OUTGOING entity before this frame's
 * pick replaces it. Assigning here meant the leave was distance-gated against the new
 * entity's distance and carried the new entity's `hit` — look from a button 3m away to
 * one 30m away with the default `maxDistance` of 10 and the leave was filtered out
 * entirely, stranding the scene's hover state on the first button forever.
 */
export function pickActivePointerEventsInfo(scene: Scene): PickingInfo | null {
  const camera = scene.activeCamera

  if (!camera) return null

  const pickInfo = scene.pick(
    scene.getEngine().getRenderWidth() / 2,
    scene.getEngine().getRenderHeight() / 2,
    (mesh) => {
      // isEnabled FIRST. Passing a predicate to `scene.pick` REPLACES Babylon's
      // default `isEnabled/isVisible/isPickable` filter (ray.js:598-607) rather than
      // adding to it — so without this, a collider that `scene-bounds.ts` disabled for
      // leaving its parcels still absorbed pointer events, which is verbatim the
      // griefing vector that module exists to close. The raycast path already honours
      // it via `pickMeshesForMask`.
      if (!mesh.isEnabled()) return false

      // The LOCAL player's own capsule never blocks, and this is not a detail: the
      // camera is an ArcRotateCamera at radius 8, i.e. BEHIND the avatar, so the
      // centre-screen ray passes through your own body before it reaches anything you
      // are looking at. Treating it as an occluder killed every pointer interaction in
      // the game — measured, the hovered entity became null with the avatar on the ray.
      //
      // The client excludes it the same way: PLAYER_ORIGIN_RAYCAST_MASK is
      // `OnPointerEvent | Default | OtherAvatars`, so the local CharacterController
      // layer is deliberately absent while OTHER avatars are present. A remote player
      // blocks your pointer; you do not block your own.
      //
      // Keyed on the capsule TAG as well as the layer, so a scene cannot make one of
      // its own colliders unblockable — and therefore invisible to hover — merely by
      // naming CL_MAIN_PLAYER in its collision mask.
      if (isAvatarCapsule(mesh) && getColliderLayers(mesh) & ColliderLayer.CL_MAIN_PLAYER) return false

      // Every OCCLUDER, not just the interactables. Restricting the predicate to
      // CL_POINTER meshes that carry PointerEvents made them the only candidates, so
      // the closest hit was always interactable and nothing could ever block it: hover
      // and click passed straight through walls, floors and other players, none of
      // which is reachable on any client.
      return (getColliderLayers(mesh) & POINTER_OCCLUDING_LAYERS) !== 0
    },
    false,
    camera
  )

  if (!pickInfo.pickedMesh || !pickInfo.pickedPoint || pickInfo.distance > MAX_POINTER_PICK_DISTANCE) {
    return null
  }

  // The closest thing in front of the player is not something a scene can interact
  // with, so nothing is hovered — the client's `Reset()` branch.
  const parentEntity = getParentEntity(pickInfo.pickedMesh)
  if (!parentEntity || !entityHasPointerEvents(parentEntity)) return null

  return pickInfo
}

/**
 * Distance from the local player to a point, in world units, or Infinity when the
 * player's position is not known yet.
 *
 * Feeds the protocol's `max_player_distance` check. Infinity rather than 0 for the
 * unknown case: 0 would make every distance-gated entry qualify before the player
 * even exists.
 *
 * Measured from the player's FEET, not the capsule centre. The client uses two
 * different origins and it is easy to conflate them: `PlayerInteractionEntity.
 * PlayerPosition` — what feeds this check — is `cc.transform.position`, the
 * CharacterController's own transform, whereas its PROXIMITY system explicitly
 * computes `TransformPoint(cc.center)` because it wants the centre. `playerEntityAtom`
 * holds the capsule, whose position IS its centre, so using it raw put every
 * max_player_distance check PLAYER_CAPSULE_HALF_HEIGHT (0.85m) out.
 */
function distanceFromPlayer(point: Vector3): number {
  const player = playerEntityAtom.getOrNull()
  if (!player) return Number.POSITIVE_INFINITY
  const feet = player.absolutePosition.clone()
  feet.y -= PLAYER_CAPSULE_HALF_HEIGHT
  return Vector3.Distance(feet, point)
}

/**
 * Distance feeding the protocol's `max_distance` check.
 *
 * NOT `pickInfo.distance`. That is measured from the CAMERA, and this server's camera
 * is an `ArcRotateCamera` sitting `radius = 8` metres behind the player
 * (`CharacterController.ts:95`) — so every distance was ~8m larger than the client's
 * and the protocol's own default `max_distance` of 10 stopped qualifying about two
 * metres in front of the player. Entities that every client reports as interactable out
 * to 10m were silently unclickable here.
 *
 * The client measures from the PLAYER in both camera modes: first person is the camera
 * distance (they coincide), third person is
 * `Vector3.Distance(hitInfo.point, camera.PlayerFocus.position)`
 * (`PlayerOriginatedRaycastSystem.cs:100`). We only ever have a third-person camera.
 *
 * From the capsule CENTRE, where `distanceFromPlayer` above measures from the FEET.
 * That is not an inconsistency — it mirrors the client's two origins, `PlayerFocus`
 * against `cc.transform.position`, which are 0.85m apart and easy to conflate.
 *
 * Falls back to the raw camera distance only when the player is not known yet, which is
 * the same fallback the pick itself would have had.
 */
function distanceFromPlayerFocus(pickInfo: PickingInfo): number {
  const player = playerEntityAtom.getOrNull()
  if (!player || !pickInfo.pickedPoint) return pickInfo.distance
  return Vector3.Distance(player.absolutePosition, pickInfo.pickedPoint)
}

function addPointerEventResult(
  entity: BabylonEntity,
  result: Omit<PBPointerEventsResult, 'tickNumber' | 'timestamp'>
) {
  if (!lastPickedEntity?.appliedComponents.pointerEvents) return

  const context = lastPickedEntity.context.deref()
  if (!context) return

  const PointerEventsResult = context.components[pointerEventsResultComponent.componentId]

  PointerEventsResult.addValue(entity.entityId, {
    // THE TICK for both fields, matching the client
    // (`WritePointerEventResultsSystem.cs:127-128` sets `Timestamp` and `TickNumber`
    // from the same `sceneStateProvider.TickNumber`).
    //
    // This used to be a private lamport counter while proximity-interaction.ts used the
    // tick, and two clocks in one component is fatal rather than untidy. The scene-side
    // SDK gates every lookup on `timestamp > previousFrameMaxTimestamp`, where that
    // maximum is taken over ALL of the scene's results and never decreases
    // (@dcl/ecs `engine/input.js` `buttonStateUpdateSystem`). The tick advances 30x a
    // second from scene start; this counter advanced only when a hover CHANGED or a
    // button was pressed, so it was always far behind. Executed against the real SDK: a
    // single proximity event at tick ~300 made every subsequent hover and click on
    // every entity in the scene fail the gate permanently — `isClicked`,
    // `isTriggered` and `getInputCommand` all returned null for the life of the
    // process. One clock is the only arrangement that works.
    tickNumber: context.currentTick,
    timestamp: context.currentTick,
    ...result
  })
}

function hoverNewEntity(entity: BabylonEntity | null, pick: PickingInfo | null) {
  if (lastPickedEntity === entity) {
    // Still the same entity, but it (or the player) has moved: refresh the pick so a
    // press this frame reports where the pointer actually is.
    if (pick) lastPickPoint = pick
    return
  }

  // HOVER_LEAVE targets the previous entity, so it must fire BEFORE the reassignment;
  // HOVER_ENTER targets the new one, so it fires after. (An earlier version compared
  // lastPickedEntity !== entity AFTER assigning it, so HOVER_ENTER could never fire.)
  //
  // Load-bearing that `lastPickPoint` is still the OUTGOING entity's pick here — see
  // pickActivePointerEventsEntity.
  if (lastPickedEntity) {
    interactWithScene(PointerEventType.PET_HOVER_LEAVE, InputAction.IA_ANY)
  }

  lastPickedEntity = entity
  // Kept as-is when the pick found nothing: `interactWithScene` early-returns on a null
  // `lastPickedEntity`, so a stale point is never read, and there is nothing newer.
  if (pick) lastPickPoint = pick

  if (entity) {
    interactWithScene(PointerEventType.PET_HOVER_ENTER, InputAction.IA_ANY)
  }

  // headless: no hover-text label UI to update
}

/**
 * This function reacts to a pointer event triggered by any input. If an entity was picked,
 * it will trigger the corresponding PointerEvent
 */
export function interactWithScene(eventType: PointerEventType, action: InputAction) {
  const pointerEvents = lastPickedEntity?.appliedComponents.pointerEvents
  if (!lastPickedEntity || !pointerEvents || !lastPickPoint) return

  const context = lastPickedEntity.context.deref()
  if (!context) return

  // Every declared entry is consulted now. This used to emit ONE result for the
  // hovered entity with whatever button the caller passed, reading nothing off the
  // component — so an entity asking only for {PET_DOWN, IA_PRIMARY} still received
  // PET_UP with IA_POINTER, and any entity in view was clickable from any distance.
  const cameraDistance = distanceFromPlayerFocus(lastPickPoint)
  const playerDistance = distanceFromPlayer(lastPickPoint.pickedPoint!)

  const firing = selectFiringEntries(
    pointerEvents.pointerEvents,
    eventType,
    action,
    cameraDistance,
    playerDistance,
    InteractionType.CURSOR
  )
  // NOTE for anyone mutation-testing this: deleting this early return is an
  // EQUIVALENT mutant, not a gap. The loop below iterates `firing`, so an empty
  // `firing` emits nothing either way — the return only avoids building `hit`.
  if (!firing.length) return

  const hit = pickingToRaycastHit(context, lastPickPoint, lastPickPoint.ray!)

  // A PRESS emits exactly ONE result no matter how many entries qualified; only
  // hover emits per entry.
  //
  // The client reaches these two through different loops. Hover/proximity go through
  // `intent.ValidIndices`, one append per qualifying ENTRY
  // (`AppendPointerEventResultsIntent.AppendPointerInputIfQualified`), while a button
  // press goes through `intent.ValidInputActions`, filled by `TryAppendButtonAction`
  // called ONCE PER ENTITY outside the entry loop (`ProcessPointerEventsSystem.cs:337`)
  // — one append per input action actually pressed.
  //
  // It matters because presses now report the raw action rather than the entry's
  // button, so the canonical SDK pair `{PET_DOWN, IA_ANY}` plus an explicit
  // `{PET_DOWN, IA_PRIMARY}` produced two results identical in `state`, `button` and
  // `hit`, differing only in a timestamp that is now also the same tick. That is pure
  // duplication in the CRDT stream, and `pointerEventsResultComponent` keeps only
  // `maxElements: 10`, so it halved the usable history too.
  const emitted = isHover(eventType) ? firing : firing.slice(0, 1)

  for (const entry of emitted) {
    addPointerEventResult(lastPickedEntity, {
      state: eventType,
      // HOVER reports IA_POINTER; a press reports the RAW input action. Neither is a
      // free choice, and reporting the ENTRY's button — which an earlier revision did
      // for both — is wrong twice over.
      //
      // Hover: the client hard-codes it in `WritePointerEventResultsSystem` with the
      // comment "If the event is a Hover, the scenes are expecting an input action of
      // type IaPointer." The SDK confirms it — `getInputCommand` expands IA_ANY over
      // `[IA_POINTER, IA_PRIMARY, ...]`, a list that does NOT contain IA_ANY, and
      // matches `command.button === inputAction` exactly. An IA_ANY-buttoned hover is
      // invisible to every scene.
      //
      // Press: the client reports the concrete action pressed
      // (`TryAppendButtonAction` -> `AddInputAction(ecsInputAction, ...)`), never the
      // entry's. Reporting the entry's breaks the canonical SDK click, whose default
      // entry is `{PET_DOWN, IA_ANY}`: the result carried IA_ANY and
      // `getInputCommand(IA_ANY, PET_DOWN, entity)` resolved to null, so
      // `onPointerDown` never fired.
      button: isHover(eventType) ? InputAction.IA_POINTER : action,
      hit
    })
  }
}