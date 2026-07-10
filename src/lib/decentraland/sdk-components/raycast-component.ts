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
  const hasValue = component.has(entity.entityId)

  const context = entity.context.deref()

  if (hasValue) {
    // EVERY accepted PUT re-arms the query, not just the first one: scenes
    // re-trigger a one-shot raycast by re-PUTting the component with a bumped
    // timestamp, and processRaycasts removes non-continuous entries after one
    // pass — without the re-add here, only DELETE_COMPONENT + re-PUT would ever
    // produce a fresh RaycastResult.
    const raycast = component.get(entity.entityId)!
    entity.appliedComponents.raycast = {
      value: raycast,
      ray: prevValue?.ray ?? new BABYLON.Ray(Vector3.Zero(), Vector3.Forward(), 999)
    }

    // NOTE: no debug RayHelper for continuous rays — RayHelper.show() creates a
    // LinesMesh and registers a per-frame vertex-buffer rewrite; on a headless
    // server it is a pure per-frame cost with no observable effect.

    if (context)
      context.pendingRaycastOperations.add(entity.entityId)
  } else if (prevValue) {
    if (context)
      context.pendingRaycastOperations.delete(entity.entityId)

    delete entity.appliedComponents.raycast
  }
})

export const raycastResultComponent = declareComponentUsingProtobufJs(PBRaycastResult, 1068, () => {
  // this function is called when we receive the component and a change needs to be applied to the entity
})
