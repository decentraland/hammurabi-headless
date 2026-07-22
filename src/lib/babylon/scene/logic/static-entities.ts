import { Vector3, Quaternion } from '@babylonjs/core'
import { transformComponent } from '../../../decentraland/sdk-components/transform-component'
import type { SceneContext } from '../scene-context'
import { globalCoordinatesToSceneCoordinatesToRef } from '../coordinates'
import { Entity } from '../../../decentraland/types'
import { engineInfoComponent } from '../../../decentraland/sdk-components/engine-info'
import { realmInfoComponent } from '../../../decentraland/sdk-components/realm-info'
import { EntityUtils } from '../../../decentraland/crdt-internal/generational-index-pool'
import { playerEntityAtom, currentRealm } from '../../../decentraland/state'
import { isLocalhostRealm } from '../../../decentraland/realm/resolution'
import { OTHER_PLAYER_ENTITIES_RANGE } from '../../../decentraland/communications/player-entity-manager'

export const StaticEntities = {
  RootEntity: 0 as Entity,
  PlayerEntity: 1 as Entity,
  CameraEntity: 2 as Entity
} as const

export const PLAYER_HEIGHT = 1.7
/**
 * Babylon capsules are anchored at their CENTER, but scene-facing player
 * transforms are feet-anchored by protocol convention (comms movement packets
 * and the explorers report feet). Reporting the raw capsule position leaks a
 * +PLAYER_HEIGHT/2 offset into scenes — exactly the "~0.85m Y" fingerprint that
 * surfaced in the flag-tag cross-wire investigation (a position stream matching
 * another player's movement plus this constant). Every site that turns
 * capsule.position into a scene-facing player position must subtract this.
 */
export const PLAYER_CAPSULE_HALF_HEIGHT = PLAYER_HEIGHT / 2
export const MAX_RESERVED_ENTITY = 512
/**
 * The avatar-comms entity range, sourced from the player entity manager so the
 * avatar-range write guard (scene-context) and the avatar system's subscription
 * range can never disagree. (This was [128, 512] — the wrong half of the
 * reserved space — while the avatar system allocated [32, 256).)
 */
export const AVATAR_ENTITY_RANGE: [number, number] = OTHER_PLAYER_ENTITIES_RANGE

// Reused temporaries for the per-frame static-entity update (single-threaded).
// The read-only constants are never mutated — they only feed copyFrom/compares.
const tmpPosition = new Vector3()
const tmpRotation = new Quaternion()
const READONLY_ZERO = Vector3.Zero()
const READONLY_IDENTITY = Quaternion.Identity()

// this function defines if the engine should accept updates to the entity by its
// entity number
export function entityIsInRange(entity: Entity, range: [number, number]) {
  const [entityNumber, _version] = EntityUtils.fromEntityId(entity)
  return entityNumber < range[1] && entityNumber >= range[0]
}

/**
 * This function updates the static entities to be reported back to the scene once
 * per frame and when the scene asks for the initial state.
 */
export function updateStaticEntities(context: SceneContext) {
  const EngineInfo = context.components[engineInfoComponent.componentId]

  if (!EngineInfo.has(StaticEntities.RootEntity))
    EngineInfo.create(StaticEntities.RootEntity, { frameNumber: 0, tickNumber: 0, totalRuntime: 0 })

  const info = EngineInfo.getMutable(StaticEntities.RootEntity)

  info.tickNumber = context.currentTick
  info.totalRuntime = context.getElapsedTime()
  info.frameNumber = context.babylonScene.getEngine().frameId - context.startFrame

  // Update RealmInfo component
  const RealmInfo = context.components[realmInfoComponent.componentId]
  const realm = currentRealm.getOrNull()

  if (realm) {
    const { aboutResponse, baseUrl } = realm
    const isLocalhost = isLocalhostRealm(baseUrl)
    const roomInfo = context.transport?.getRoomInfo?.()

    if (!RealmInfo.has(StaticEntities.RootEntity)) {
      RealmInfo.create(StaticEntities.RootEntity, {
        baseUrl,
        realmName: aboutResponse.configurations?.realmName || 'Unknown',
        networkId: aboutResponse.configurations?.networkId || 0,
        commsAdapter: aboutResponse.comms?.fixedAdapter || 'offline',
        isPreview: (aboutResponse.configurations as any)?.isPreview ?? isLocalhost,
        room: roomInfo?.roomName,
        isConnectedSceneRoom: roomInfo?.isConnected
      })
    } else {
      // Only mark dirty when a dynamic field actually changed: getMutable
      // unconditionally re-serializes and re-sends the whole component
      // (including its URL strings) to the scene every tick otherwise.
      const current = RealmInfo.getOrNull(StaticEntities.RootEntity)!
      if (current.room !== roomInfo?.roomName || current.isConnectedSceneRoom !== roomInfo?.isConnected) {
        const realmInfoData = RealmInfo.getMutable(StaticEntities.RootEntity)
        realmInfoData.room = roomInfo?.roomName
        realmInfoData.isConnectedSceneRoom = roomInfo?.isConnected
      }
    }
  }

  const Transform = context.components[transformComponent.componentId]

  if (!Transform.has(StaticEntities.CameraEntity))
    Transform.create(StaticEntities.CameraEntity, {
      position: Vector3.Zero(),
      scale: Vector3.One(),
      rotation: Quaternion.Identity(),
      parent: StaticEntities.RootEntity
    })
  if (!Transform.has(StaticEntities.PlayerEntity))
    Transform.create(StaticEntities.PlayerEntity, {
      position: Vector3.Zero(),
      scale: Vector3.One(),
      rotation: Quaternion.Identity(),
      parent: StaticEntities.RootEntity
    })
  // StaticEntities.PlayerEntity
  {
    const player = playerEntityAtom.getOrNull()

    // convert the player position to scene-space coordinates (into a reused temp)
    globalCoordinatesToSceneCoordinatesToRef(context, player?.absolutePosition ?? READONLY_ZERO, tmpPosition)
    // The atom holds the CharacterController capsule, whose position is its
    // CENTER — report feet to the scene (see PLAYER_CAPSULE_HALF_HEIGHT).
    if (player) tmpPosition.y -= PLAYER_CAPSULE_HALF_HEIGHT
    const rotation = player?.absoluteRotationQuaternion ?? READONLY_IDENTITY

    // Only dirty (re-serialize + re-send) the transform when it actually moved.
    // The stored vectors are copies (copyFrom), never references to live Babylon
    // objects — aliasing a live object would make this comparison see no change.
    //
    // "Compare before getMutable/dirty" is a recurring pattern in the per-frame
    // static-entity updates (RealmInfo above, the CameraEntity transform below, and
    // camera-follows-player's PlayerEntity write) — getMutable() unconditionally
    // re-serializes + re-sends the whole component every tick, so each site guards
    // it with an equality check. Keep them consistent; the copies-not-references
    // caveat applies to all of them.
    const playerTransform = Transform.get(StaticEntities.PlayerEntity)!
    if (!playerTransform.position.equals(tmpPosition) || !playerTransform.rotation.equals(rotation)) {
      const mutable = Transform.getMutable(StaticEntities.PlayerEntity)
      mutable.position.copyFrom(tmpPosition)
      mutable.rotation.copyFrom(rotation)
    }
  }

  // StaticEntities.CameraEntity
  {
    const engineCamera = context.babylonScene.activeCamera
    if (engineCamera) {
      engineCamera.getWorldMatrix().decompose(undefined, tmpRotation, tmpPosition)

      // convert the camera position to scene-space coordinates
      globalCoordinatesToSceneCoordinatesToRef(context, tmpPosition, tmpPosition)

      // Compare before getMutable/dirty (same pattern as the PlayerEntity write
      // above): only re-serialize + re-send when the camera transform changed.
      const cameraTransform = Transform.get(StaticEntities.CameraEntity)!
      if (
        !cameraTransform.position.equals(tmpPosition) ||
        !cameraTransform.rotation.equals(tmpRotation) ||
        cameraTransform.scale.x !== 1 ||
        cameraTransform.scale.y !== 1 ||
        cameraTransform.scale.z !== 1
      ) {
        const mutable = Transform.getMutable(StaticEntities.CameraEntity)
        mutable.position.copyFrom(tmpPosition)
        mutable.rotation.copyFrom(tmpRotation)
        mutable.scale.setAll(1)
      }
    }
  }
}
