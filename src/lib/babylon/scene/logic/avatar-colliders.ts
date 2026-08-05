import * as BABYLON from '@babylonjs/core'
import { ColliderLayer } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen'
import type { SceneContext } from '../scene-context'
import type { BabylonEntity } from '../BabylonEntity'
import { Entity } from '../../../decentraland/types'
import { setColliderMask } from './colliders'
import {
  AVATAR_ENTITY_RANGE,
  entityIsInRange,
  PLAYER_CAPSULE_HALF_HEIGHT,
  PLAYER_HEIGHT,
  StaticEntities
} from './static-entities'

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
 * Disposes the capsules attached to `entity`, if any.
 *
 * Necessary because `BabylonEntity.dispose()` calls `super.dispose(true, false)` and
 * `TransformNode.dispose(doNotRecurse = true)` DETACHES child transform nodes instead
 * of disposing them — an orphaned capsule survives in `scene.meshes`, re-evaluated
 * every frame, one per join/leave cycle forever.
 */
export function disposeAvatarCapsules(entity: BabylonEntity): void {
  for (const child of entity.getChildMeshes(true)) {
    if (isAvatarCapsule(child)) child.dispose()
  }
}

/**
 * True for the entity ids the avatar-comms system allocates to OTHER players.
 * The local player is `StaticEntities.PlayerEntity` and is not in this range.
 */
export function isRemotePlayerEntity(entityId: Entity): boolean {
  // Through `entityIsInRange`, which UNPACKS the version. A raw `id >= 32 && id < 256`
  // comparison silently failed for every reused slot: PlayerEntityManager returns
  // `toEntityId(number, version + 1)`, so a slot's second occupant is `32 | (1 << 16)`
  // = 65568. That also meant `reportableEntityId` handed a scene the entity id for a
  // remote avatar, contradicting the client's deliberate `foundEntity = null`.
  return entityIsInRange(entityId, AVATAR_ENTITY_RANGE)
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
 * transform for free. They are NOT disposed with it: `TransformNode.dispose(true)`
 * DETACHES children (`parent = null`) rather than disposing them, so an orphaned
 * capsule would stay in `scene.meshes` and be re-evaluated every frame forever — one
 * leak per join/leave cycle. `disposeAvatarCapsules` is called from the entity
 * teardown path for that reason.
 */
export function updateAvatarColliders(context: SceneContext): void {
  // getOrCreate, NOT getEntityOrNull. A host `BabylonEntity` is only ever
  // materialized by INCOMING CRDT (`tryGetOrCreateEntity`), and entity 1's Transform
  // is written host->scene straight into the component store — so nothing ingests a
  // message naming it and `getEntityOrNull(1)` was null in every real scene.
  // Measured on a live SceneContext: `live entities: [0]`. The local player therefore
  // never got a capsule and CL_MAIN_PLAYER found nobody, while every spec passed
  // because its fixture called getOrCreateStaticEntity itself.
  //
  // This accessor exists for exactly this case: host-initiated, inside the reserved
  // static range.
  ensureCapsule(
    context.getOrCreateStaticEntity(StaticEntities.PlayerEntity),
    ColliderLayer.CL_PLAYER | ColliderLayer.CL_MAIN_PLAYER
  )

  // Driven off the tracked set rather than a raw id probe, because remote ids are
  // version-packed — see SceneContext.playerEntities.
  for (const entityId of context.playerEntities) {
    const remotePlayer = context.getEntityOrNull(entityId)
    if (remotePlayer) ensureCapsule(remotePlayer, ColliderLayer.CL_PLAYER)
  }
}
