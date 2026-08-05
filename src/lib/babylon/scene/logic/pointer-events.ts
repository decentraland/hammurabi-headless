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
import { resolvePointerInfo, selectFiringEntries } from './pointer-event-filter'

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
 * The pick was previously unbounded — `scene.pick` tests the whole scene — so an
 * entity a kilometre away could be hovered and clicked here while no client would
 * reach it. The per-entry `maxDistance` filter below would reject most of those
 * anyway, but bounding the pick means the work is not done in the first place.
 */
export const MAX_POINTER_PICK_DISTANCE = 100

export function pickActivePointerEventsEntity(scene: Scene): BabylonEntity | null {
  const camera = scene.activeCamera

  if (!camera) return null

  const pickInfo = scene.pick(
    scene.getEngine().getRenderWidth() / 2,
    scene.getEngine().getRenderHeight() / 2,
    (mesh) => {
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
 * unknown case: 0 would make every proximity-style entry qualify before the player
 * even exists.
 */
function distanceFromPlayer(point: Vector3): number {
  const player = playerEntityAtom.getOrNull()
  if (!player) return Number.POSITIVE_INFINITY
  return Vector3.Distance(player.absolutePosition, point)
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
      // The ENTRY's button, not the raw input. For a real press that is the same
      // value unless the entry said IA_ANY; for a HOVER it is the only sensible
      // answer, and it replaces the `InputAction.UNRECOGNIZED` (-1) this used to
      // send — a ts-proto "unknown enum" sentinel that no scene can match on.
      button: resolvePointerInfo(entry.eventInfo).button,
      hit,
      timestamp: globalLamportTimestamp++
    })
  }
}