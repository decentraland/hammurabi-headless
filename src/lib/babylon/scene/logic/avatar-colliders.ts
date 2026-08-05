import * as BABYLON from '@babylonjs/core'
import { ColliderLayer } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen'
import type { SceneContext } from '../scene-context'
import type { BabylonEntity } from '../BabylonEntity'
import { Entity } from '../../../decentraland/types'
import { setColliderMask } from './colliders'
import { AVATAR_ENTITY_RANGE, PLAYER_CAPSULE_HALF_HEIGHT, PLAYER_HEIGHT, StaticEntities } from './static-entities'

/**
 * Radius of a player's collision capsule, matching the one `CharacterController`
 * already builds for the LOCAL player. Kept in step with it deliberately: a scene
 * raycasting for players and the character controller walking into them should
 * disagree about a player's width for no reason.
 */
const AVATAR_CAPSULE_RADIUS = 0.4

/**
 * Deliberately NOT suffixed `_collider`. `setColliderMask` keys off that suffix to
 * register a mesh in `floorMeshes`, the ground-detection candidate list — and an
 * avatar is not a floor. The suffix also attaches the collider material, which
 * nothing renders here anyway.
 */
const AVATAR_CAPSULE_NAME = 'avatar_capsule'

/** Marks a mesh as an avatar capsule this module owns. */
const avatarCapsuleSymbol = Symbol('isAvatarCapsule')

/**
 * True when `mesh` is one of the avatar capsules maintained here, as opposed to
 * scene-authored geometry. Used by the raycast hit builder to apply the client's
 * remote-avatar reporting rule.
 */
export function isAvatarCapsule(mesh: BABYLON.AbstractMesh): boolean {
  return (mesh as any)[avatarCapsuleSymbol] === true
}

/**
 * True for the entity ids the avatar-comms system allocates to OTHER players.
 * The local player is `StaticEntities.PlayerEntity` and is not in this range.
 */
export function isRemotePlayerEntity(entityId: number): boolean {
  return entityId >= AVATAR_ENTITY_RANGE[0] && entityId < AVATAR_ENTITY_RANGE[1]
}

function ensureCapsule(entity: BabylonEntity, layers: number): void {
  for (const child of entity.getChildMeshes(true)) {
    if (isAvatarCapsule(child)) return
  }

  const capsule = BABYLON.MeshBuilder.CreateCapsule(
    AVATAR_CAPSULE_NAME,
    { height: PLAYER_HEIGHT, radius: AVATAR_CAPSULE_RADIUS },
    entity.getScene()
  )
  ;(capsule as any)[avatarCapsuleSymbol] = true

  // Player entity transforms are FEET-anchored (see PLAYER_CAPSULE_HALF_HEIGHT in
  // static-entities.ts) while `CreateCapsule` centres its mesh on the origin, so
  // the capsule has to be lifted by half its height to stand ON the entity rather
  // than straddling it half-buried in the ground.
  capsule.position.y = PLAYER_CAPSULE_HALF_HEIGHT
  capsule.parent = entity
  capsule.setEnabled(true)

  setColliderMask(capsule, layers)
}

/**
 * Gives every player entity present in this scene a collision capsule, so a scene
 * raycasting with `CL_PLAYER` resolves against avatars.
 *
 * Without these, a `CL_PLAYER` raycast returned an empty result on this server
 * while the reference client reported hits — the client resolves player colliders
 * in `ExecuteRaycastSystem.DoesHitColliderQualify`, and no avatar collider existed
 * here at all. The local player's `CharacterController` capsule is not usable for
 * this: it lives outside every scene's node tree, so `pickMeshesForMask` (which
 * walks down from the scene root) can never reach it.
 *
 * The LOCAL player also gets `CL_MAIN_PLAYER`, matching the client's
 * `PLAYER_QUALIFYING_BITS = ClPlayer | ClMainPlayer` — a mask naming only
 * `CL_MAIN_PLAYER` must find the local player and no one else.
 *
 * Called once per frame per scene. It probes a FIXED id range rather than scanning
 * `context.entities`, which a scene can grow to the 100k entity cap: 1 + 224 map
 * lookups per frame is a constant this cannot be made to scale with.
 *
 * The capsules are children of the player `BabylonEntity`, so they inherit its
 * transform for free and are disposed with it when the player leaves — there is no
 * teardown path here on purpose.
 */
export function updateAvatarColliders(context: SceneContext): void {
  const localPlayer = context.getEntityOrNull(StaticEntities.PlayerEntity)
  if (localPlayer) {
    ensureCapsule(localPlayer, ColliderLayer.CL_PLAYER | ColliderLayer.CL_MAIN_PLAYER)
  }

  for (let entityId = AVATAR_ENTITY_RANGE[0]; entityId < AVATAR_ENTITY_RANGE[1]; entityId++) {
    const remotePlayer = context.getEntityOrNull(entityId as Entity)
    if (remotePlayer) {
      ensureCapsule(remotePlayer, ColliderLayer.CL_PLAYER)
    }
  }
}
