import { Quaternion, Vector3 } from "@babylonjs/core"
import { ReadWriteByteBuffer } from "../ByteBuffer"
import { ComponentDefinition } from "../crdt-internal/components"
import { createLwwStore } from "../crdt-internal/last-write-win-element-set"
import { DeleteEntity } from "../crdt-wire-protocol"
import { playerIdentityDataComponent } from "../sdk-components/player-identity-data"
import { avatarBaseComponent } from "../sdk-components/avatar-base"
import { avatarEquippedDataComponent } from "../sdk-components/avatar-customizations"
import { transformComponent } from "../sdk-components/transform-component"
import { Entity } from "../types"
import { CommsTransportWrapper } from "./CommsTransportWrapper"
import { StaticEntities } from "../../babylon/scene/logic/static-entities"
import { playerEntityManager } from "./player-entity-manager"
import { getAssetBundleRegistryUrl } from "../environment"
import { robustFetch, drainResponse } from "../../misc/network"

/**
 * Single avatar communication system that handles avatar entities for a specific scene transport.
 * This system manages player entities, profiles, and avatar data for multiplayer scenarios.
 *
 * `worldToScene` converts world/global positions received from comms into the owning scene's
 * coordinate system, so the Transforms written here are only valid for that scene.
 */
export function createAvatarCommunicationSystem(transport: CommsTransportWrapper, worldToScene: (position: Vector3) => Vector3) {
  const PlayerIdentityData = createLwwStore(playerIdentityDataComponent)
  const AvatarBase = createLwwStore(avatarBaseComponent)
  const AvatarEquippedData = createLwwStore(avatarEquippedDataComponent)
  const Transform = createLwwStore(transformComponent)
  const listOfComponentsToSynchronize: ComponentDefinition<any>[] = [PlayerIdentityData, AvatarBase, AvatarEquippedData, Transform]

  // Track deleted entities for DELETE_ENTITY CRDT messages
  const deletedEntities = new Map<Entity, number>()  // entity -> tick when deleted
  // Bound the tombstone map: peers churn through versioned entity ids over a long
  // session, and this grows once per departed peer. Oldest entries are evicted.
  const MAX_DELETED_ENTITIES = 4096
  let currentTick = 0

  // Cache for profiles fetched from Catalyst
  const profileCache = new Map<string, {profile: any, version: number}>()

  // Per-peer guard against profile-fetch amplification. A remote peer announces
  // its profile version over comms; without this, a peer that announces an
  // ever-increasing (or simply un-cacheable) version forces an outbound Catalyst
  // fetch on every packet. We record the highest version we've ATTEMPTED (so a
  // lying peer whose real profile version is lower than announced can't make us
  // refetch), and rate-limit fetches per peer regardless of announced version.
  const profileFetchState = new Map<string, { attemptedVersion: number; lastFetchAt: number }>()
  const PROFILE_FETCH_COOLDOWN_MS = 10_000

  function normalizeAddress(address: string) {
    return address.toLowerCase()
  }

  async function fetchProfileFromCatalyst(address: string, _lambdasEndpoint?: string): Promise<any> {
    try {
      const response = await robustFetch(`${getAssetBundleRegistryUrl()}/profiles`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ids: [address] })
      }, { label: 'profiles' })
      if (!response.ok) {
        await drainResponse(response) // release the socket before discarding the response
        throw new Error(`Failed to fetch profile: ${response.status}`)
      }

      const data: any = await response.json()
      return data[0]?.avatars?.[0]
    } catch (error) {
      console.error('Failed to fetch profile:', error)
      throw error
    }
  }

  async function handleProfileVersionAnnouncement(
    entity: Entity,
    address: string,
    announcedVersion: number,
    lambdasEndpoint?: string
  ) {
    // Ignore non-numeric / non-finite announced versions from untrusted peers.
    if (!Number.isFinite(announcedVersion)) return

    const cached = profileCache.get(address)
    // Already have this version (or newer) cached — nothing to do.
    if (cached && cached.version >= announcedVersion) return

    const state = profileFetchState.get(address)
    // Already got a definitive answer for this announced version (or a higher
    // one) — don't refetch, even if the peer's real profile came back with a
    // lower version than it announced (otherwise every packet would trigger a
    // fetch). `attemptedVersion` is only advanced once a fetch COMPLETES (below),
    // so a transient failure is still retried after the cooldown.
    if (state && announcedVersion <= state.attemptedVersion) return
    // Rate-limit per peer so a peer announcing ever-higher versions can't drive
    // unbounded outbound fetches.
    const now = Date.now()
    if (state && now - state.lastFetchAt < PROFILE_FETCH_COOLDOWN_MS) return

    // Reserve the fetch slot (for the cooldown) but keep any prior attemptedVersion
    // so an in-flight failure doesn't wrongly suppress a retry.
    profileFetchState.set(address, { attemptedVersion: state?.attemptedVersion ?? -1, lastFetchAt: now })

    try {
      const profile = await fetchProfileFromCatalyst(address, lambdasEndpoint)

      // The fetch resolved: this announced version has a definitive answer, so
      // don't fetch it again even if the profile's real version was lower.
      const current = profileFetchState.get(address)
      if (current) current.attemptedVersion = Math.max(current.attemptedVersion, announcedVersion)

      if (profile && profile.version >= announcedVersion) {
        profileCache.set(address, {profile, version: profile.version})
        updatePlayerComponents(entity, address, profile)
      }
    } catch (error) {
      // Leave attemptedVersion unadvanced so a transient failure is retried once
      // the per-peer cooldown elapses.
      console.error('Failed to handle profile version announcement:', error)
    }
  }

  function updatePlayerComponents(entity: Entity, address: string, profile: any) {
    // Update PlayerIdentityData component (protobuf)
    PlayerIdentityData.createOrReplace(entity, {
      address: address,
      isGuest: !profile.hasConnectedWeb3
    })

    // Update AvatarBase component (protobuf)
    AvatarBase.createOrReplace(entity, {
      name: profile.name || 'Unknown',
      bodyShapeUrn: profile.avatar?.bodyShape || '',
      skinColor: profile.avatar?.skin?.color ? {
        r: profile.avatar.skin.color.r,
        g: profile.avatar.skin.color.g,
        b: profile.avatar.skin.color.b
      } : { r: 0.8, g: 0.6, b: 0.4 }, // Default skin color
      eyesColor: profile.avatar?.eyes?.color ? {
        r: profile.avatar.eyes.color.r,
        g: profile.avatar.eyes.color.g,
        b: profile.avatar.eyes.color.b
      } : { r: 0.2, g: 0.5, b: 0.8 }, // Default eye color
      hairColor: profile.avatar?.hair?.color ? {
        r: profile.avatar.hair.color.r,
        g: profile.avatar.hair.color.g,
        b: profile.avatar.hair.color.b
      } : { r: 0.3, g: 0.2, b: 0.1 } // Default hair color
    })

    // Update AvatarEquippedData component (protobuf)
    AvatarEquippedData.createOrReplace(entity, {
      wearableUrns: profile.avatar?.wearables || [],
      emoteUrns: (profile.avatar?.emotes || []).map((e: any) => e.urn).filter(Boolean)
    })
  }

  function removePlayerEntity(entity: Entity, address: string) {
    for (const component of listOfComponentsToSynchronize) {
      // purge (not just delete): peer entity ids are generationally versioned so
      // this id never comes back, these stores receive no remote CRDT updates
      // (they are only written from transport events), and the removal is
      // signaled to consumers via DELETE_ENTITY below. Keeping timestamps/tick
      // entries would grow every map by one entry per departed peer forever —
      // and dumpCrdtDeltas scans those maps every scene tick. (The
      // DELETE_COMPONENT deltas this used to emit were dropped by consumers
      // anyway: the scene context tombstones the entity on DELETE_ENTITY.)
      component.purgeEntity(entity)
    }

    // Track this entity for DELETE_ENTITY message, evicting the oldest tombstone
    // once the map is full so it can't grow without bound over a long session.
    deletedEntities.set(entity, currentTick)
    while (deletedEntities.size > MAX_DELETED_ENTITIES) {
      const oldest = deletedEntities.keys().next().value
      if (oldest === undefined) break
      deletedEntities.delete(oldest)
    }

    // Free the entity in the player entity manager
    playerEntityManager.freeEntityForPlayer(address)

    // Clear from profile cache and per-peer fetch state
    const normalizedAddress = normalizeAddress(address)
    profileCache.delete(normalizedAddress)
    profileFetchState.delete(normalizedAddress)
  }

  function findPlayerEntityByAddress(address: string, createIfMissing: boolean): Entity | null {
    const normalizedAddress = normalizeAddress(address)

    // First check if we already have an entity allocated for this address
    let entity = playerEntityManager.getEntityForAddress(normalizedAddress)
    if (entity !== null) {
      return entity
    }

    if (!createIfMissing) return null

    // Allocate a new entity for this remote player
    entity = playerEntityManager.allocateEntityForPlayer(normalizedAddress, false)
    if (entity === null) {
      console.warn(`Failed to allocate entity for player ${normalizedAddress}`)
      return null
    }

    // Initialize with minimal identity data
    PlayerIdentityData.createOrReplace(entity, { address: normalizedAddress, isGuest: true })

    return entity
  }

  // Event handlers (stored for cleanup on dispose)
  const handlePeerConnected = (event: { address: string }) => {
    console.log('peer connected', event)
    const address = normalizeAddress(event.address)

    // Allocate entity for the new participant
    const entity = findPlayerEntityByAddress(address, true)
    if (entity) {
      // Trigger initial profile fetch
      transport.events.emit('profileMessage', {
        address: address,
        data: {
          profileVersion: 1 // Initial version
        }
      })
    }
  }

  const handlePeerDisconnected = (event: { address: string }) => {
    console.log('[PEER_DISCONNECTED]', event)
    const entity = findPlayerEntityByAddress(event.address, false)
    if (entity) {
      removePlayerEntity(entity, event.address)
    }
  }

  // reused input temp: worldToScene produces the (fresh) vector the store
  // retains; this only avoids the second, intermediate allocation per packet
  const tmpWorldPosition = new Vector3()

  const putPlayerTransform = (entity: Entity, data: any, rotation: Quaternion) => {
    tmpWorldPosition.set(data.positionX, data.positionY, data.positionZ)
    Transform.createOrReplace(entity, {
      position: worldToScene(tmpWorldPosition),
      scale: Vector3.One(),
      rotation,
      parent: StaticEntities.RootEntity
    })
  }

  const handlePosition = (event: { address: string, data: any }) => {
    const d = event.data
    // Reject non-finite coordinates from untrusted peers before they poison the
    // scene's transform state (NaN/Infinity propagate through Babylon math).
    // Inlined checks: a rest-args helper allocated an array per packet.
    if (
      !Number.isFinite(d.positionX) || !Number.isFinite(d.positionY) || !Number.isFinite(d.positionZ) ||
      !Number.isFinite(d.rotationX) || !Number.isFinite(d.rotationY) || !Number.isFinite(d.rotationZ) ||
      !Number.isFinite(d.rotationW)
    ) return
    const entity = findPlayerEntityByAddress(event.address, true)
    if (entity) {
      putPlayerTransform(entity, event.data, new Quaternion(event.data.rotationX, event.data.rotationY, event.data.rotationZ, event.data.rotationW))
    }
  }

  const handleMovement = (event: { address: string, data: any }) => {
    const d = event.data
    if (
      !Number.isFinite(d.positionX) || !Number.isFinite(d.positionY) || !Number.isFinite(d.positionZ) ||
      !Number.isFinite(d.rotationY)
    ) return
    const entity = findPlayerEntityByAddress(event.address, true)

    if (entity) {
      putPlayerTransform(entity, event.data, Quaternion.RotationAxis(Vector3.Up(), event.data.rotationY))
    }
  }

  // ADR-204: Use profileMessage for profile version announcements
  const handleProfileMessage = async (event: { address: string, data: any }) => {
    const address = normalizeAddress(event.address)
    const announcedVersion = event.data.profileVersion

    const entity = findPlayerEntityByAddress(event.address, true)
    if (entity) {
      await handleProfileVersionAnnouncement(entity, address, announcedVersion)
    }
  }

  const handleChatMessage = (event: { address: string, data: any }) => {
    findPlayerEntityByAddress(event.address, true)
  }

  // Wire up transport events
  transport.events.on('PEER_CONNECTED', handlePeerConnected)
  transport.events.on('PEER_DISCONNECTED', handlePeerDisconnected)
  transport.events.on('position', handlePosition)
  transport.events.on('movement', handleMovement)
  transport.events.on('profileMessage', handleProfileMessage)
  transport.events.on('chatMessage', handleChatMessage)

  // Public API for managing the avatar system
  return {
    // Entity range this system manages
    range: [32, 256] as [number, number],

    // Update function to be called each frame
    update() {
      currentTick++
      for (const component of listOfComponentsToSynchronize) {
        // Advance ticks/timestamps and clear the dirty state; serialization
        // happens per-subscription in getUpdates (dumpCrdtDeltas). This
        // previously serialized every dirty component into a throwaway buffer
        // allocated every frame.
        component.commitDirtyState()
      }
    },

    // Create subscription for CRDT synchronization
    createSubscription() {
      const state = new Map<ComponentDefinition<any>, number>(
        listOfComponentsToSynchronize.map(component => [component, -1])
      )
      let lastDeleteTick = -1  // Track last processed delete tick

      return {
        range: [32, 256] as [number, number],
        dispose() {
          state.clear()
          // Clear player entity manager and profile cache
          playerEntityManager.clear()
          profileCache.clear()
          profileFetchState.clear()
          deletedEntities.clear()
        },
        getUpdates(writer: ReadWriteByteBuffer) {
          // Write DELETE_ENTITY messages for removed players
          for (const [entityId, tick] of deletedEntities) {
            if (tick > lastDeleteTick) {
              DeleteEntity.write({ entityId }, writer)
            }
          }
          lastDeleteTick = currentTick

          // Serialize all component updates from the last tick until now
          for (const [component, tick] of state) {
            const newTick = component.dumpCrdtDeltas(writer, tick)
            state.set(component, newTick)
          }
        },
      }
    },

    // Cleanup function
    dispose() {
      // Remove event listeners to prevent duplicates on hot-reload
      transport.events.off('PEER_CONNECTED', handlePeerConnected)
      transport.events.off('PEER_DISCONNECTED', handlePeerDisconnected)
      transport.events.off('position', handlePosition)
      transport.events.off('movement', handleMovement)
      transport.events.off('profileMessage', handleProfileMessage)
      transport.events.off('chatMessage', handleChatMessage)

      playerEntityManager.clear()
      profileCache.clear()
      deletedEntities.clear()
    }
  }
}

export type AvatarCommunicationSystem = ReturnType<typeof createAvatarCommunicationSystem>