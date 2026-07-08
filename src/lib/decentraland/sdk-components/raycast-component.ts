import * as BABYLON from '@babylonjs/core'
import { declareComponentUsingProtobufJs } from "./pb-based-component-helper";
import { PBRaycast } from "@dcl/protocol/out-js/decentraland/sdk/components/raycast.gen";
import { PBRaycastResult } from "@dcl/protocol/out-js/decentraland/sdk/components/raycast_result.gen";
import { ComponentType } from "../crdt-internal/components";
import { Vector3 } from '@babylonjs/core';

export const raycastComponent = declareComponentUsingProtobufJs(PBRaycast, 1067, (entity, component) => {
  // this function is called when we receive the component and a change needs to be applied to the entity
  if (component.componentType !== ComponentType.LastWriteWinElementSet) return

  const prevValue = entity.appliedComponents.raycast
  const shouldCreateNewRay = Boolean(component.has(entity.entityId) && !prevValue)
  const shouldDeleteRay = !component.has(entity.entityId)

  const context = entity.context.deref()

  if (shouldCreateNewRay) {
    const raycast = component.get(entity.entityId)!
    const ray = new BABYLON.Ray(Vector3.Zero(), Vector3.Forward(), 999)
    entity.appliedComponents.raycast = {
      value: raycast!,
      ray
    }

    // NOTE: no debug RayHelper for continuous rays — RayHelper.show() creates a
    // LinesMesh and registers a per-frame vertex-buffer rewrite; on a headless
    // server it is a pure per-frame cost with no observable effect.

    if (context)
      context.pendingRaycastOperations.add(entity.entityId)
  } else if (shouldDeleteRay && prevValue) {
    if (context)
      context.pendingRaycastOperations.delete(entity.entityId)

    delete entity.appliedComponents.raycast
  }
})

export const raycastResultComponent = declareComponentUsingProtobufJs(PBRaycastResult, 1068, () => {
  // this function is called when we receive the component and a change needs to be applied to the entity
})
