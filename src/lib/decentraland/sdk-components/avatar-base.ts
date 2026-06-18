import { ComponentType } from "../crdt-internal/components";
import { PBAvatarBase } from "@dcl/protocol/out-js/decentraland/sdk/components/avatar_base.gen";
import { declareComponentUsingProtobufJs } from "./pb-based-component-helper";
import { BabylonEntity } from "../../babylon/scene/BabylonEntity";

export const avatarBaseComponent = declareComponentUsingProtobufJs(PBAvatarBase, 1087, (entity, component) => {
  if (component.componentType !== ComponentType.LastWriteWinElementSet) return

  if (entity.entityId === 0) return

  const newValue = component.getOrNull(entity.entityId) as PBAvatarBase | null

  setAvatarBase(entity, newValue)
})

// Headless: only store the avatar base data for queries — there is no renderer.
export function setAvatarBase(entity: BabylonEntity, data: PBAvatarBase | null) {
  if (data) {
    entity.appliedComponents.avatarBase = data
  } else if (entity.appliedComponents.avatarBase) {
    delete entity.appliedComponents.avatarBase
  }
}
