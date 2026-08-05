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
import { isHover, resolvePointerInfo, selectFiringEntries } from './pointer-event-filter'
import { PLAYER_CAPSULE_HALF_HEIGHT } from './static-entities'

// returns true if the entity has PointerEvents
export function entityHasPointerEvents(entity: BabylonEntity) {
  return !!entity.appliedComponents.pointerEvents
}

let lastPickedEntity: BabylonEntity | null = null
let lastPickPoint: PickingInfo | null = null

let globalLamportTimestamp = 0

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

  const pickedEntity = pickActivePointerEventsEntity(scene)

  hoverNewEntity(pickedEntity, scene)
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

export function pickActivePointerEventsEntity(scene: Scene): BabylonEntity | null {
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

      // select meshes with CL_POINTER
      if (getColliderLayers(mesh) & ColliderLayer.CL_POINTER) {

        // and then only filter by meshes having PointerEvents
        const parentEntity = getParentEntity(mesh)
        if (parentEntity) {
          return entityHasPointerEvents(parentEntity)
        }
      }
      return false
    },
    false,
    camera
  );

  if (pickInfo.pickedMesh && pickInfo.pickedPoint && pickInfo.distance <= MAX_POINTER_PICK_DISTANCE) {
    lastPickPoint = pickInfo
    const parentEntity = getParentEntity(pickInfo.pickedMesh)
    return parentEntity
  }

  return null
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

function addPointerEventResult(entity: BabylonEntity, result: Omit<PBPointerEventsResult, "tickNumber">) {
  if (!lastPickedEntity?.appliedComponents.pointerEvents) return

  const context = lastPickedEntity.context.deref()
  if (!context) return

  const PointerEventsResult = context.components[pointerEventsResultComponent.componentId]

  PointerEventsResult.addValue(entity.entityId, {
    tickNumber: context.currentTick,
    ...result
  })
}

function hoverNewEntity(entity: BabylonEntity | null, scene: Scene) {
  if (lastPickedEntity === entity) return

  // HOVER_LEAVE targets the previous entity, so it must fire BEFORE the
  // reassignment; HOVER_ENTER targets the new one, so it fires after. (The
  // previous version compared lastPickedEntity !== entity AFTER assigning it,
  // so HOVER_ENTER could never fire.)
  if (lastPickedEntity) {
    interactWithScene(PointerEventType.PET_HOVER_LEAVE, InputAction.IA_ANY)
  }

  lastPickedEntity = entity

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
  const cameraDistance = lastPickPoint.distance
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

  for (const entry of firing) {
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
      hit,
      timestamp: globalLamportTimestamp++
    })
  }
}