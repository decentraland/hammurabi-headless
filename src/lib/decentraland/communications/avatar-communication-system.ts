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
import { playerEntityManager, OTHER_PLAYER_ENTITIES_RANGE } from "./player-entity-manager"
import { getAssetBundleRegistryUrl } from "../environment"
import { robustFetch, drainResponse, readBodyCapped, DEFAULT_MAX_BODY_BYTES } from "../../misc/network"
import { limits } from "../../misc/limits"
import { limitLogger } from "../../misc/limit-logger"

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

  // Track deleted entities for DELETE_ENTITY CRDT messages: entity -> the
  // deletion sequence number when it was removed. The sequence is a dedicated
  // monotonic counter (NOT the per-frame tick): a subscription emits every
  // tombstone whose sequence exceeds the highest it has already emitted. Using
  // the frame tick here raced — a disconnect stamped between frames got the tick
  // the last getUpdates had already marked as emitted, so DELETE_ENTITY never
  // fired and departed avatars lingered forever.
  const deletedEntities = new Map<Entity, number>()
  let deletionSequence = 0
  // Bound the tombstone map: peers churn through versioned entity ids over a long
  // session, and this grows once per departed peer. Oldest entries are evicted.
  const MAX_DELETED_ENTITIES = limits.maxAvatarTombstones // HAMMURABI_MAX_AVATAR_TOMBSTONES
  let currentTick = 0

  // Throttle the "pool exhausted" warning. findPlayerEntityByAddress runs per
  // inbound packet, so once the 224-slot remote-player pool is full an unallocated
  // peer would otherwise log once per dropped packet — up to the per-peer inbound
  // rate, aggregated across peers. On blocking stderr that is an event-loop-stall
  // vector; log at most once per second regardless of how many packets are dropped.
  let lastPoolExhaustedLogAt = 0

  // One tracker per live subscription: its highest emitted deletion sequence.
  const subscriptionTrackers = new Set<{ emittedSeq: number }>()
  let lastPrunedMinSeq = 0

  // Drop tombstones every live subscription has already emitted. A tombstone
  // only exists to deliver DELETE_ENTITY to subscriptions that saw the entity;
  // a subscription created later starts from a state dump that no longer
  // contains the (purged) entity, so it never needs old tombstones. With no
  // live subscriptions, nothing can ever need them.
  function pruneEmittedTombstones() {
    if (deletedEntities.size === 0) return
    let minEmitted = deletionSequence
    for (const tracker of subscriptionTrackers) {
      if (tracker.emittedSeq < minEmitted) minEmitted = tracker.emittedSeq
    }
    // Skip the tombstone scan when the low-water mark hasn't advanced since
    // the last prune (e.g. a stalled subscription): every entry with
    // seq <= lastPrunedMinSeq was already deleted then, so the scan would
    // re-iterate up to MAX_DELETED_ENTITIES entries per frame deleting nothing.
    if (minEmitted <= lastPrunedMinSeq) return
    lastPrunedMinSeq = minEmitted
    for (const [entity, seq] of deletedEntities) {
      if (seq <= minEmitted) deletedEntities.delete(entity)
    }
  }

  // Cache for profiles fetched from Catalyst
  const profileCache = new Map<string, {profile: any, version: number}>()

  // Per-peer guard against profile-fetch amplification. A remote peer announces
  // its profile version over comms; without this, a peer that announces an
  // ever-increasing (or simply un-cacheable) version forces an outbound Catalyst
  // fetch on every packet. We record the highest version we've ATTEMPTED (so a
  // lying peer whose real profile version is lower than announced can't make us
  // refetch), and rate-limit fetches per peer regardless of announced version.
  const profileFetchState = new Map<string, { attemptedVersion: number; lastFetchAt: number }>()
  const PROFILE_FETCH_COOLDOWN_MS = limits.profileFetchCooldownMs // HAMMURABI_PROFILE_FETCH_COOLDOWN_MS

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

      // Cap the (peer-influenced) profile body before buffering/parsing, matching
      // the repo's other fetches; a compromised registry can't drive unbounded host
      // memory here.
      const data: any = JSON.parse(await readBodyCapped(response, DEFAULT_MAX_BODY_BYTES))
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

      // The peer may have disconnected — or disconnected and reconnected onto a
      // fresh entity — while the fetch was in flight. removePlayerEntity already
      // purged its components and emitted DELETE_ENTITY; writing now would
      // resurrect the freed entity as a ghost avatar and permanently leak the
      // cache/LWW entries (a departed address never disconnects a second time).
      const current = profileFetchState.get(address)
      if (!current || playerEntityManager.getEntityForAddress(address) !== entity) return

      // The fetch resolved: this announced version has a definitive answer, so
      // don't fetch it again even if the profile's real version was lower.
      current.attemptedVersion = Math.max(current.attemptedVersion, announcedVersion)

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
      // signaled to consumers via the DELETE_ENTITY tombstone below. Keeping
      // timestamps/tick entries would grow every map by one entry per departed
      // peer forever — and dumpCrdtDeltas scans those maps every scene tick.
      // Because purge drops those maps, DELETE_ENTITY is now the ONLY removal
      // signal, so it must be delivered reliably (see deletionSequence).
      component.purgeEntity(entity)
    }

    // Track this entity for DELETE_ENTITY message, evicting the oldest tombstone
    // once the map is full so it can't grow without bound over a long session.
    // TRADEOFF: this cap is a load-bearing memory bound (CLAUDE.md), and since
    // purgeEntity dropped the delta-channel removal fallback, DELETE_ENTITY is
    // the only removal signal. If a scene's VM stalls (its getUpdates stops
    // running) while > MAX_DELETED_ENTITIES distinct peers disconnect, the oldest
    // tombstones evict before that scene emits them, leaving a few ghost avatars
    // until it reloads. Deliberately accepted: the bound matters more than a
    // cosmetic glitch that needs 4096+ departures during a single hang.
    deletedEntities.set(entity, ++deletionSequence)
    if (deletedEntities.size > MAX_DELETED_ENTITIES) limitLogger.hit('maxAvatarTombstones')
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
    lastCommsPosLogMs.delete(normalizedAddress)
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
      const now = Date.now()
      if (now - lastPoolExhaustedLogAt > 1000) {
        lastPoolExhaustedLogAt = now
        console.warn('Remote player entity pool exhausted; dropping packets from unallocated peers')
      }
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

  // DEBUG-only comms attribution tracer (opt-in). Logs which ADDRESS each
  // position/movement packet was attributed to (by LiveKit participant identity)
  // and the raw coordinates it carried, throttled per address. This is the
  // dispositive evidence for the cross-wire class of bug where a player's entity
  // receives ANOTHER player's coordinates: address attribution is the only
  // routing key on this path, so a log showing address A with address B's
  // trajectory localizes the fault below this layer (FFI/SFU) or at the sender.
  // Matches the HAMMURABI_XHR_DEBUG convention: only 1/true/yes/on enable it.
  const DEBUG_COMMS_POSITIONS = ['1', 'true', 'yes', 'on'].includes(
    (process.env.HAMMURABI_DEBUG_COMMS_POSITIONS ?? '').toLowerCase()
  )
  const COMMS_POS_LOG_INTERVAL_MS = 1000
  // Bounded: an entry is created only for an address that resolved to an entity
  // (logging happens after findPlayerEntityByAddress succeeds), so there is at
  // most one per allocated peer (≤ pool size), and removePlayerEntity clears it
  // on disconnect. An address that never gets an entity (pool exhausted) never
  // creates an entry.
  const lastCommsPosLogMs = new Map<string, number>()

  // Collapse control chars and cap length so a crafted participant identity can't
  // forge or flood log lines (matches the limit-logger sanitization convention).
  function sanitizeForLog(value: string): string {
    // eslint-disable-next-line no-control-regex
    const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '?')
    return cleaned.length > 64 ? cleaned.slice(0, 64) + '…' : cleaned
  }

  function debugLogCommsPosition(kind: 'position' | 'movement', address: string, d: any) {
    const now = Date.now()
    const last = lastCommsPosLogMs.get(address) ?? 0
    if (now - last < COMMS_POS_LOG_INTERVAL_MS) return
    lastCommsPosLogMs.set(address, now)
    console.log(
      `[COMMS-POS] ${kind} from=${sanitizeForLog(address)} pos=(${d.positionX.toFixed(2)}, ${d.positionY.toFixed(2)}, ${d.positionZ.toFixed(2)})`
    )
  }

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
      // Log only after allocation succeeds, so the throttle map gets an entry
      // only for an address that has an entity (cleaned up in removePlayerEntity).
      if (DEBUG_COMMS_POSITIONS) debugLogCommsPosition('position', normalizeAddress(event.address), d)
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
      // Log only after allocation succeeds (see handlePosition).
      if (DEBUG_COMMS_POSITIONS) debugLogCommsPosition('movement', normalizeAddress(event.address), d)
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
    // Entity range this system manages (single source of truth: player-entity-manager)
    range: OTHER_PLAYER_ENTITIES_RANGE,

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
      // Once per tick (not per subscription in getUpdates): the prune scans
      // all trackers + all tombstones, and the emittedSeq values it needs only
      // advance once per frame anyway — pruning here just trails by one frame.
      pruneEmittedTombstones()
    },

    // Create subscription for CRDT synchronization
    createSubscription() {
      const state = new Map<ComponentDefinition<any>, number>(
        listOfComponentsToSynchronize.map(component => [component, -1])
      )
      // Registered so emitted tombstones can be pruned once EVERY live
      // subscription has delivered them (see pruneEmittedTombstones); without
      // pruning, getUpdates rescans up to MAX_DELETED_ENTITIES entries per
      // subscription per frame for the rest of the session.
      const tracker = { emittedSeq: 0 }
      subscriptionTrackers.add(tracker)

      return {
        range: OTHER_PLAYER_ENTITIES_RANGE,
        dispose() {
          subscriptionTrackers.delete(tracker)
          state.clear()
          // Clear player entity manager and profile cache
          playerEntityManager.clear()
          profileCache.clear()
          profileFetchState.clear()
          deletedEntities.clear()
        },
        getUpdates(writer: ReadWriteByteBuffer) {
          // Write DELETE_ENTITY messages for players removed since we last ran.
          // Keyed on the monotonic deletion sequence, not the frame tick, so a
          // disconnect that lands between frames is still delivered exactly once.
          for (const [entityId, seq] of deletedEntities) {
            if (seq > tracker.emittedSeq) {
              DeleteEntity.write({ entityId }, writer)
            }
          }
          tracker.emittedSeq = deletionSequence

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