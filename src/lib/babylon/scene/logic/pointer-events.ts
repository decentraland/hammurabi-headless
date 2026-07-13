import { Matrix, Node, PickingInfo, PointerEventTypes, Ray, Scene, Vector3 } from '@babylonjs/core'
import { BabylonEntity } from '../BabylonEntity'
import { getColliderLayers } from './colliders'
import { ColliderLayer } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen'
import { InputAction, PointerEventType } from '@dcl/protocol/out-js/decentraland/sdk/components/common/input_action.gen'
import { pointerEventsComponent } from '../../../decentraland/sdk-components/pointer-events'
import { pointerEventsResultComponent } from '../../../decentraland/sdk-components/pointer-events-result'
import { PBPointerEventsResult } from '@dcl/protocol/out-js/decentraland/sdk/components/pointer_events_result.gen'
import { pickingToRaycastHit, raycastResultFromRay } from './raycasts'
import { loadedScenesByEntityId } from '../../../decentraland/state'

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
  // Drop a hovered entity that was disposed (hot reload / scene unload): the
  // module-level state would otherwise pin the disposed entity and its
  // PickingInfo (a live mesh reference) until the next hover change, and a stale
  // click could write into a disposed context's store.
  if (lastPickedEntity?.isDisposed()) {
    lastPickedEntity = null
    lastPickPoint = null
  }

  // The center-screen pick below is a full-scene CPU raycast (predicate over
  // every mesh, triangle-level tests) that runs every frame — skip it entirely
  // when no loaded scene has a PointerEvents component, since hover synthesis is
  // its only consumer on this headless server. When an entity is currently
  // hovered, still run one more pass so its hover state is reconciled (a
  // HOVER_LEAVE fires if the entity still has a PointerEvents component).
  if (!lastPickedEntity && !anySceneHasPointerEvents()) return

  const pick = pickActivePointerEventsEntity(scene)

  hoverNewEntity(pick)
}

export function pickActivePointerEventsEntity(scene: Scene): { entity: BabylonEntity; pickInfo: PickingInfo } | null {
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

  // Does NOT mutate the module state — the caller reconciles hover transitions so
  // a HOVER_LEAVE fires with the PREVIOUS entity's pick data, not this one's.
  if (pickInfo.pickedMesh && pickInfo.pickedPoint) {
    const parentEntity = getParentEntity(pickInfo.pickedMesh)
    if (parentEntity) return { entity: parentEntity, pickInfo }
  }

  return null
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

function hoverNewEntity(pick: { entity: BabylonEntity; pickInfo: PickingInfo } | null) {
  const entity = pick?.entity ?? null

  if (lastPickedEntity === entity) {
    // Same entity still hovered: refresh the pick point so a click this frame
    // reports the current hit position.
    if (pick) lastPickPoint = pick.pickInfo
    return
  }

  // HOVER_LEAVE targets the PREVIOUS entity and must fire with the PREVIOUS pick
  // point, so it runs BEFORE we overwrite the module state below. HOVER_ENTER
  // targets the new entity and fires after. (Hover has no specific input button,
  // so it reports IA_ANY — the reference explorer's value — not UNRECOGNIZED.)
  if (lastPickedEntity) {
    interactWithScene(PointerEventType.PET_HOVER_LEAVE, InputAction.IA_ANY)
  }

  lastPickedEntity = entity
  lastPickPoint = pick?.pickInfo ?? null

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
  if (!lastPickedEntity?.appliedComponents.pointerEvents || !lastPickPoint) return

  const context = lastPickedEntity.context.deref()
  if (!context) return

  // TODO: check for max distance and input filtering

  addPointerEventResult(lastPickedEntity, {
    state: eventType,
    button: action,
    hit: pickingToRaycastHit(context, lastPickPoint, lastPickPoint.ray!),
    timestamp: globalLamportTimestamp++,
  })
}