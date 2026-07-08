import { ArcRotateCamera, TransformNode, Vector3 } from "@babylonjs/core";
import { PLAYER_HEIGHT, StaticEntities } from "./static-entities";
import { CharacterController } from "../../avatars/CharacterController";
import { BabylonEntity } from "../BabylonEntity";
import { Transform, applyNewTransform, transformComponent } from "../../../decentraland/sdk-components/transform-component";

// Reused per-frame temporaries (single-threaded). CAMERA_TARGET_OFFSET is
// read-only: it only feeds addToRef.
const tmpCapsulePosition = new Vector3()
const CAMERA_TARGET_OFFSET = new Vector3(0, PLAYER_HEIGHT, 0)

export function createCameraFollowsPlayerSystem(camera: ArcRotateCamera, playerEntity: BabylonEntity, characterController: CharacterController) {

  // this function updates the PlayerEntity position using the CharacterController.capsule's position
  function updatePlayerEntityPositionFromCapsule(playerEntity: BabylonEntity, capsule: TransformNode) {
    tmpCapsulePosition.copyFrom(capsule.absolutePosition)
    tmpCapsulePosition.y -= 1 // don't know why

    const localAvatarScene = playerEntity.context.deref()!
    const store = localAvatarScene.components[transformComponent.componentId]

    // Only write (dirty + re-serialize + re-send) when the player actually
    // moved. The stored transform owns copies of the capsule state, never
    // references to the live Babylon objects. (Same "compare before dirty" pattern
    // as the static-entities transform updates — keep them in sync.)
    const current = store.get(StaticEntities.PlayerEntity)
    if (
      current &&
      current.position.equals(tmpCapsulePosition) &&
      current.rotation.equals(capsule.absoluteRotationQuaternion)
    ) {
      return
    }

    const t: Transform = {
      parent: StaticEntities.RootEntity,
      position: tmpCapsulePosition.clone(),
      rotation: capsule.absoluteRotationQuaternion.clone(),
      scale: Vector3.One(),
    }

    store.createOrReplace(StaticEntities.PlayerEntity, t)
    applyNewTransform(playerEntity, t)
  }

  return {
    update() {
      updatePlayerEntityPositionFromCapsule(playerEntity, characterController.capsule)

      // IMPORTANT: This logic is truncated, there are many protocol defined factors
      // playing with the visibility of the player. Those will be implemented in a future
      // PR along with the avatar attachment components of the SDK
      const playerVisible = !characterController.inFirstPerson

      playerEntity.setEnabled(playerVisible)
      playerEntity.absolutePosition.addToRef(CAMERA_TARGET_OFFSET, camera.target);
    }
  }
}