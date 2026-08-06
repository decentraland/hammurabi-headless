import * as BABYLON from '@babylonjs/core'
import { declareComponentUsingProtobufJs } from "./pb-based-component-helper";
import { PBPointerEvents } from "@dcl/protocol/out-js/decentraland/sdk/components/pointer_events.gen";
import { ComponentType } from "../crdt-internal/components";
import { updateProximityIndex } from "../../babylon/scene/logic/proximity-interaction";

// TODO: this component is a stub that will be replaced by the real implementation later in a dedicated PR
export const pointerEventsComponent = declareComponentUsingProtobufJs(PBPointerEvents, 1062, (entity, component) => {
  // this function is called when we receive the component and a change needs to be applied to the entity
  if (component.componentType !== ComponentType.LastWriteWinElementSet) return

  const newValue = component.get(entity.entityId)

  // update value
  entity.appliedComponents.pointerEvents = newValue || undefined

  // Keep the proximity index in step here rather than scanning every PointerEvents
  // entity once per frame — see updateProximityIndex for the measurements.
  const context = entity.context.deref()
  if (context) updateProximityIndex(context, entity.entityId, entity.appliedComponents.pointerEvents)
})
