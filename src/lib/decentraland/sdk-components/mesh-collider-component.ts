import { declareComponentUsingProtobufJs } from "./pb-based-component-helper";
import { ColliderLayer, PBMeshCollider } from "@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen";
import { ComponentType } from "../crdt-internal/components";
import { MeshBuilder, Scene } from '@babylonjs/core';
import { setColliderMask } from "../../babylon/scene/logic/colliders";
import { memoize } from "../../misc/memoize";

// template collider box, cloned per entity so all collider boxes share one
// geometry instead of building fresh vertex buffers per put (same pattern as
// mesh-renderer-component's baseBox)
const baseColliderBox = memoize((scene: Scene) => {
  const ret = MeshBuilder.CreateBox('base-box_collider', { updatable: false }, scene)
  ret.setEnabled(false)
  return ret
})

// TODO: this component is a stub that will be replaced by the real implementation later in a dedicated PR
export const meshColliderComponent = declareComponentUsingProtobufJs(PBMeshCollider, 1019, (entity, componentStorage) => {
  // this function is called when we receive the component and a change needs to be applied to the entity
  if (componentStorage.componentType !== ComponentType.LastWriteWinElementSet) return

  const newValue = componentStorage.getOrNull(entity.entityId)
  const currentValue = entity.appliedComponents.meshCollider

  const isAddingNewValue = Boolean(!currentValue && newValue)
  const isReplacingValue = Boolean(currentValue && newValue)
  const isRemovingValue = Boolean(currentValue && !newValue)

  if (isReplacingValue || isRemovingValue) {
    if (currentValue?.collider) {
      currentValue.collider.dispose()
    }
    // Clear eagerly so a removal doesn't leave a stale reference to the
    // disposed collider (the replace path below reassigns it).
    entity.appliedComponents.meshCollider = undefined
  }

  if (isAddingNewValue || isReplacingValue) {
    // clone the shared template box (clones share geometry) and attach it to the entity
    const colliderBox = baseColliderBox(entity.getScene()).clone('box_collider', entity)
    colliderBox.setEnabled(true)

    const DEFAULT_COLLIDER_LAYERS = ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER
    setColliderMask(colliderBox, newValue?.collisionMask ?? DEFAULT_COLLIDER_LAYERS)
    colliderBox.parent = entity

    entity.appliedComponents.meshCollider = {
      collider: colliderBox,
      info: newValue!
    }
  }
})
