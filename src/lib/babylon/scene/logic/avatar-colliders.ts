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
  StaticEntities
} from './static-entities'
import { globalCoordinatesToSceneCoordinatesToRef } from '../coordinates'
import { playerEntityAtom } from '../../../decentraland/state'

/**
 * Radius of a player's collision capsule, from the reference client: both
 * `CharacterObject.prefab` (`m_Radius: 0.3`, the local `CharacterController`) and
 * `RemoteAvatarCollider.prefab` (`m_Radius: 0.3`) agree.
 *
 * NOT kept in step with this server's own `CharacterController` capsule, which is 0.4
 * — that one is what the local avatar WALKS with, and its width is a movement-feel
 * choice. This is what SCENES raycast against, so it has to be the width every player's
 * client reports or a `CL_PLAYER` ray 0.35m off-axis hits here and misses everywhere
 * else.
 */
export const AVATAR_CAPSULE_RADIUS = 0.3

/**
 * Total capsule height per player kind, from the client's two prefabs. They differ, and
 * the difference is observable: `CharacterObject.prefab` is `m_Height: 1.6` with
 * `m_Center.y: 0.8`, `RemoteAvatarCollider.prefab` is `m_Height: 1.9` with
 * `m_Center.y: 0.95`. In both the centre is exactly half the height, i.e. the collider
 * stands ON the transform origin, which is what a feet-anchored player entity wants.
 *
 * Babylon's `CreateCapsule({ height })` is the TOTAL height including the hemispherical
 * caps (`capsuleBuilder.js`: `heightMinusCaps = height - (radiusTop + radiusBottom)`),
 * the same convention as Unity's `CapsuleCollider.height`, so these transfer directly.
 */
export const LOCAL_PLAYER_CAPSULE_HEIGHT = 1.6
export const REMOTE_PLAYER_CAPSULE_HEIGHT = 1.9

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
 * The capsule this module attached to a player entity, held on the entity itself.
 *
 * A stored reference rather than a per-frame `getChildMeshes(true)` scan. That scan is
 * NOT recursive — `Node._getDescendants` only recurses when `directDescendantsOnly` is
 * false, and a 20_000-deep chain under the player entity does not overflow (measured) —
 * but it is still O(direct children), and a scene chooses that number: `Transform.parent`
 * lets it park entities under `StaticEntities.PlayerEntity`, and this runs every frame.
 * Measured at 50_000 such children: 0.113ms per lookup. A reference is O(1) and removes
 * the question entirely.
 */
const ownedCapsuleSymbol = Symbol('avatarCapsule')

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
  const capsule: BABYLON.AbstractMesh | undefined = (entity as any)[ownedCapsuleSymbol]
  if (!capsule) return
  ;(entity as any)[ownedCapsuleSymbol] = undefined
  capsule.dispose()
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

function ensureCapsule(entity: BabylonEntity, layers: number, height: number): BABYLON.AbstractMesh {
  // `isDisposed()` rather than a bare presence check: specs dispose capsules directly to
  // force a rebuild, and production disposes them with their entity. A stale reference to
  // a disposed mesh would otherwise be handed back and re-parented forever.
  const existing: BABYLON.AbstractMesh | undefined = (entity as any)[ownedCapsuleSymbol]
  if (existing && !existing.isDisposed()) return existing

  const capsule = BABYLON.MeshBuilder.CreateCapsule(
    AVATAR_CAPSULE_NAME,
    { height, radius: AVATAR_CAPSULE_RADIUS },
    entity.getScene()
  )
  ;(capsule as any)[avatarCapsuleSymbol] = true
  ;(entity as any)[ownedCapsuleSymbol] = capsule

  // Player entity transforms are FEET-anchored (see PLAYER_CAPSULE_HALF_HEIGHT in
  // static-entities.ts) while `CreateCapsule` centres its mesh on the origin, so
  // the capsule has to be lifted by half its height to stand ON the entity rather
  // than straddling it half-buried in the ground. That lift is exactly the client's
  // `m_Center.y` for both prefabs.
  capsule.position.y = height / 2
  capsule.parent = entity
  capsule.setEnabled(true)

  setColliderMask(capsule, layers)

  return capsule
}

const tmpLocalPlayerPosition = new BABYLON.Vector3()

/**
 * Places the LOCAL player's capsule, which — unlike every remote one — cannot simply
 * inherit its entity's transform.
 *
 * `StaticEntities.PlayerEntity` is a host->scene entity: `updateStaticEntities` writes
 * its Transform straight into the component store to be dumped OUT to the scene, and
 * nothing ever ingests a CRDT message naming it. A `BabylonEntity` only learns a
 * transform from incoming CRDT, so entity 1's `appliedComponents.transform` is
 * permanently undefined and `_setTransformParametersBeforeMatrixCalculation`
 * (`BabylonEntity.ts:116-122`) zeroes its position on every `computeWorldMatrix`.
 *
 * So parenting the capsule to it and stopping there pinned the local player's collider
 * to the SCENE ROOT ORIGIN: measured, player at (5, 0.85, 7) and capsule at
 * (0, 0.85, 0). `CL_MAIN_PLAYER` then reported a confident hit on a phantom at the
 * parcel corner while still missing the real player — strictly worse than the empty
 * result it replaced, because a wrong answer is not a missing one.
 *
 * The position therefore comes from `playerEntityAtom` (the CharacterController capsule
 * that actually moves) converted into scene space, which is also the local space of
 * entity 1 since it sits at the root with an identity transform. The atom's capsule is
 * PLAYER_HEIGHT tall and positioned by its CENTRE, so subtracting
 * PLAYER_CAPSULE_HALF_HEIGHT gives the feet, and half of OUR capsule's height puts its
 * centre where the client's `m_Center` sits. The two halves are different numbers
 * (0.85 and 0.8) and that is not a slip — they belong to two capsules of different
 * heights.
 */
function positionLocalPlayerCapsule(context: SceneContext, capsule: BABYLON.AbstractMesh, player: BABYLON.TransformNode) {
  globalCoordinatesToSceneCoordinatesToRef(context, player.absolutePosition, tmpLocalPlayerPosition)
  capsule.position.set(
    tmpLocalPlayerPosition.x,
    tmpLocalPlayerPosition.y - PLAYER_CAPSULE_HALF_HEIGHT + LOCAL_PLAYER_CAPSULE_HEIGHT / 2,
    tmpLocalPlayerPosition.z
  )
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
  // Only once the local player actually has a position. Creating it unconditionally
  // put a collider at the scene root origin for every scene that had not placed the
  // player yet — a hit no client reports. Nothing is lost by waiting: the capsule
  // appears on the first frame the position is known.
  const player = playerEntityAtom.getOrNull()
  if (player) {
    const capsule = ensureCapsule(
      context.getOrCreateStaticEntity(StaticEntities.PlayerEntity),
      ColliderLayer.CL_PLAYER | ColliderLayer.CL_MAIN_PLAYER,
      LOCAL_PLAYER_CAPSULE_HEIGHT
    )
    // EVERY frame, not just on creation — entity 1 never receives a transform of its
    // own, so this is the only thing that makes the local capsule follow the player.
    positionLocalPlayerCapsule(context, capsule, player)
  }

  // Driven off the tracked set rather than a raw id probe, because remote ids are
  // version-packed — see SceneContext.playerEntities.
  //
  // No repositioning here: a remote player's entity DOES receive its Transform through
  // incoming CRDT, so its capsule inherits the entity's position for free.
  for (const entityId of context.playerEntities) {
    const remotePlayer = context.getEntityOrNull(entityId)
    if (remotePlayer) ensureCapsule(remotePlayer, ColliderLayer.CL_PLAYER, REMOTE_PLAYER_CAPSULE_HEIGHT)
  }
}
