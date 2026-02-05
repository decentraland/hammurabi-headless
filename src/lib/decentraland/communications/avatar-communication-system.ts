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

/**
 * Single avatar communication system that handles avatar entities for a specific scene transport.
 * This system manages player entities, profiles, and avatar data for multiplayer scenarios.
 */
export function createAvatarCommunicationSystem(transport: CommsTransportWrapper) {
  const PlayerIdentityData = createLwwStore(playerIdentityDataComponent)
  const AvatarBase = createLwwStore(avatarBaseComponent)
  const AvatarEquippedData = createLwwStore(avatarEquippedDataComponent)
  const Transform = createLwwStore(transformComponent)
  const listOfComponentsToSynchronize: ComponentDefinition<any>[] = [PlayerIdentityData, AvatarBase, AvatarEquippedData, Transform]

  // Track deleted entities for DELETE_ENTITY CRDT messages
  const deletedEntities = new Map<Entity, number>()  // entity -> tick when deleted
  let currentTick = 0

  // Cache for profiles fetched from Catalyst
  const profileCache = new Map<string, {profile: any, version: number}>()

  function normalizeAddress(address: string) {
    return address.toLowerCase()
  }

  async function fetchProfileFromCatalyst(address: string, _lambdasEndpoint?: string): Promise<any> {
    try {
      const response = await fetch(`${getAssetBundleRegistryUrl()}/profiles`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ids: [address] })
      })
      if (!response.ok) {
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
    const cached = profileCache.get(address)

    // Only fetch if we don't have this version cached
    if (!cached || cached.version < announcedVersion) {
      try {
        const profile = await fetchProfileFromCatalyst(address, lambdasEndpoint)

        if (profile && profile.version >= announcedVersion) {
          profileCache.set(address, {profile, version: profile.version})
          updatePlayerComponents(entity, address, profile)
                  }
      } catch (error) {
        console.error('Failed to handle profile version announcement:', error)
      }
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
      component.entityDeleted(entity, true)
    }

    // Track this entity for DELETE_ENTITY message
    deletedEntities.set(entity, currentTick)

    // Free the entity in the player entity manager
    playerEntityManager.freeEntityForPlayer(address)

    // Clear from profile cache
    const normalizedAddress = normalizeAddress(address)
    profileCache.delete(normalizedAddress)
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

  const handlePosition = (event: { address: string, data: any }) => {
    const entity = findPlayerEntityByAddress(event.address, true)
    if (entity) {
      Transform.createOrReplace(entity, {
        position: new Vector3(event.data.positionX, event.data.positionY, event.data.positionZ),
        scale: Vector3.One(),
        rotation: new Quaternion(event.data.rotationX, event.data.rotationY, event.data.rotationZ, event.data.rotationW),
        parent: StaticEntities.GlobalCenterOfCoordinates
      })
    }
  }

  const handleMovement = (event: { address: string, data: any }) => {
    const entity = findPlayerEntityByAddress(event.address, true)

    if (entity) {
      Transform.createOrReplace(entity, {
        position: new Vector3(event.data.positionX, event.data.positionY, event.data.positionZ),
        scale: Vector3.One(),
        rotation: Quaternion.RotationAxis(Vector3.Up(), event.data.rotationY),
        parent: StaticEntities.GlobalCenterOfCoordinates
      })
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
    const address = normalizeAddress(event.address)
    const _cached = profileCache.get(address)
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
      const updates = new ReadWriteByteBuffer()
      for (const component of listOfComponentsToSynchronize) {
        // Commit updates and clean dirty iterators
        component.dumpCrdtUpdates(updates)
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