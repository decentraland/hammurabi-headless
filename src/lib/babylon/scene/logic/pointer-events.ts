import { Matrix, Node, PickingInfo, PointerEventTypes, Ray, Scene, Vector3 } from '@babylonjs/core'
import { BabylonEntity } from '../BabylonEntity'
import { getColliderLayers } from './colliders'
import { ColliderLayer } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen'
import { InputAction, PointerEventType } from '@dcl/protocol/out-js/decentraland/sdk/components/common/input_action.gen'
import { pointerEventsResultComponent } from '../../../decentraland/sdk-components/pointer-events-result'
import { PBPointerEventsResult } from '@dcl/protocol/out-js/decentraland/sdk/components/pointer_events_result.gen'
import { pickingToRaycastHit, raycastResultFromRay } from './raycasts'

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

export function pickPointerEventsMesh(scene: Scene) {
  const pickedEntity = pickActivePointerEventsEntity(scene)

  hoverNewEntity(pickedEntity, scene)
}

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

  if (pickInfo.pickedMesh && pickInfo.pickedPoint) {
    lastPickPoint = pickInfo
    const parentEntity = getParentEntity(pickInfo.pickedMesh)
    return parentEntity
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

function hoverNewEntity(entity: BabylonEntity | null, scene: Scene) {
  if (lastPickedEntity && lastPickedEntity !== entity) {
    interactWithScene(PointerEventType.PET_HOVER_LEAVE, InputAction.UNRECOGNIZED)
  }

  lastPickedEntity = entity

  if (entity && lastPickedEntity !== entity) {
    interactWithScene(PointerEventType.PET_HOVER_ENTER, InputAction.UNRECOGNIZED)
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