import { Quaternion, Vector3 } from "@babylonjs/core";
import { ComponentDeclaration, ComponentType } from "../crdt-internal/components";
import { Entity } from "../types";
import { BabylonEntity } from "../../babylon/scene/BabylonEntity";

export type Transform = {
  position: Vector3
  scale: Vector3
  rotation: Quaternion
  parent: Entity
}

export const transformComponent: ComponentDeclaration<Transform, 1> = {
  componentId: 1,
  deserialize(buffer) {
    // Sanitize non-finite floats from untrusted scene CRDT to 0: a NaN/Infinity
    // here would poison Babylon world matrices and the character-controller ground
    // detection (the peer-avatar path already drops non-finite transforms). Reads
    // stay in wire order (JS evaluates call args left-to-right).
    const f = () => {
      const n = buffer.readFloat32()
      return Number.isFinite(n) ? n : 0
    }
    return {
      position: new Vector3(f(), f(), f()),
      rotation: new Quaternion(f(), f(), f(), f()),
      scale: new Vector3(f(), f(), f()),
      parent: buffer.readUint32()
    }
  },
  serialize(value, buffer) {
    buffer.writeFloat32(value.position.x);
    buffer.writeFloat32(value.position.y);
    buffer.writeFloat32(value.position.z);
    buffer.writeFloat32(value.rotation.x);
    buffer.writeFloat32(value.rotation.y);
    buffer.writeFloat32(value.rotation.z);
    buffer.writeFloat32(value.rotation.w);
    buffer.writeFloat32(value.scale.x);
    buffer.writeFloat32(value.scale.y);
    buffer.writeFloat32(value.scale.z);
    buffer.writeUint32(value.parent || 0);
  },
  applyChanges(entity, componentStorage) {
    // this function is called when we receive a CRDT put/delete message and a change of state needs
    // to be applied to the BabylonEntity

    if (componentStorage.componentType !== ComponentType.LastWriteWinElementSet) return

    // the transform of the ROOT entity 0 cannot be changed by a CRDT message
    if (entity.entityId === 0) return

    const newValue = componentStorage.getOrNull(entity.entityId) as Transform | null
    applyNewTransform(entity, newValue)
  }
}

export function applyNewTransform(entity: BabylonEntity, transform: Transform | null) {
  const commands = entity.appliedComponents.transform?.commands || []
  const currentValue = commands.length ? commands[commands.length - 1] : null

  if (transform) {
    const isDifferentParent = currentValue?.value.parent !== transform.parent

    // no interpolation in reparenting scenarios
    if (isDifferentParent) {
      commands.length = 0
    }

    commands.push({ value: transform, time: performance.now() })
    entity.appliedComponents.transform = {
      commands,
      parent: transform.parent
    }

    // Keep only the latest command: the interpolation/tween consumers that read
    // the 10-deep history are currently disabled and only the last command is
    // used (BabylonEntity), so retaining 10 was pure per-tick allocation + memory.
    // Restore the larger bound if/when interpolation lands.
    while (commands.length > 1) {
      commands.shift()
    }
  } else {
    entity.appliedComponents.transform = undefined
  }

  let needsReparenting = false

  const isAddingNewValue = Boolean(!currentValue && transform)
  const isReplacingValue = Boolean(currentValue && transform)
  const isRemovingValue = Boolean(currentValue && !transform)

  if (isAddingNewValue || isReplacingValue) {
    needsReparenting ||= currentValue?.value.parent !== transform!.parent

    entity.markAsDirty()
  } else if (isRemovingValue) {
    entity.markAsDirty()
    needsReparenting = true

  }

  if (needsReparenting) {
    const context = entity.context.deref()

    if (context) {
      context.hierarchyChanged = true
      // schedule the parenting of the entity
      context.unparentedEntities.add(entity.entityId)
    }
  }
}
