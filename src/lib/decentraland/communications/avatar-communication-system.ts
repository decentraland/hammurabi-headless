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

  // Addresses of peers we have SEEN DEPART. Data packets and participant events are
  // delivered on different LiveKit paths, so a position/movement/profile packet
  // routinely lands AFTER that peer's PEER_DISCONNECTED. Without this, such a
  // straggler re-enters the allocation path below and resurrects the departed peer
  // as a permanent frozen "corpse" avatar: nothing ever moves it again, and because
  // a departed address never disconnects a second time nothing ever frees it — so it
  // holds one of the 224 remote-player pool slots for the rest of the session. Enough
  // churn exhausts the pool and then genuinely-connected players get no entity at all.
  //
  // CORRECTNESS: this refuses only KNOWN-DEPARTED addresses, never unknown ones.
  // LiveKit does NOT emit ParticipantConnected for peers that were already in the
  // room when we joined (they arrive in the room's participant snapshot instead), so
  // those peers are discovered ONLY from their first data packet and must still be
  // allowed to allocate. Inverting this into an allowlist ("refuse unless we saw a
  // connect") would make every peer who joined before us permanently invisible.
  const departedPeers = new Set<string>()
  const MAX_DEPARTED_PEERS = limits.maxDepartedPeers // HAMMURABI_MAX_DEPARTED_PEERS

  // Live sessions per peer identity. PEER_CONNECTED/PEER_DISCONNECTED carry only the
  // LiveKit identity (the wallet address), which is IDENTICAL across a reconnect, and
  // their relative order is NOT guaranteed: a client that drops and re-joins can
  // produce connect(session N+1) before disconnect(session N). Acting on that late
  // disconnect would purge the entity of the session that is currently live, and a
  // stationary client (one not sending movement packets that would re-allocate it)
  // then stays invisible for the rest of the session. Counting live sessions lets the
  // late disconnect retire its own session without touching the newer one.
  //
  // The durable fix is to forward `participant.sid` from `transports/livekit.ts` on
  // both events so sessions are DISTINGUISHABLE rather than merely counted; a count
  // cannot tell a genuine reconnect from a transport that double-fires for one
  // session.
  const sessionCount = new Map<string, number>()

  // THIS system's own address→entity mirror of the process-global allocator.
  //
  // `playerEntityManager` is shared by every avatar system in the process (one per
  // scene, all wired to the same transport), but the LWW stores and the
  // `deletedEntities` tombstones are per-system. Resolving a departing peer through
  // the global allocator therefore only works for whichever system's
  // PEER_DISCONNECTED listener happens to run FIRST: it calls removePlayerEntity,
  // which frees the global mapping, and every sibling system then resolves `null`,
  // purges nothing and emits no DELETE_ENTITY — leaving a ghost avatar frozen in
  // those scenes forever.
  //
  // Mirroring locally makes each system's cleanup independent of listener order.
  // Freeing the global slot stays safe: freeEntityForPlayer early-exits once the
  // address is gone, so several systems calling it is harmless.
  const ownedEntities = new Map<string, Entity>()

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

    // Free the entity in the player entity manager. Idempotent across systems: a
    // sibling may already have freed this address, in which case this is a no-op.
    playerEntityManager.freeEntityForPlayer(address)

    // Clear from profile cache and per-peer fetch state
    const normalizedAddress = normalizeAddress(address)
    profileCache.delete(normalizedAddress)
    profileFetchState.delete(normalizedAddress)
    ownedEntities.delete(normalizedAddress)
  }

  function findPlayerEntityByAddress(address: string, createIfMissing: boolean): Entity | null {
    const normalizedAddress = normalizeAddress(address)

    // First check if we already have an entity allocated for this address
    let entity = playerEntityManager.getEntityForAddress(normalizedAddress)
    if (entity !== null) {
      // The allocation may have been made by ANOTHER avatar system sharing the
      // process-global playerEntityManager (there is one system per scene, all wired
      // to the same comms transport), in which case only THAT system's store holds
      // the identity. Backfill ours, or this scene writes a 30Hz Transform for an
      // entity that has no PlayerIdentityData here — a moving avatar belonging to no
      // player. Guarded by `has` so we don't rewrite (and re-dirty) the component on
      // every inbound packet.
      if (!PlayerIdentityData.has(entity)) {
        PlayerIdentityData.createOrReplace(entity, { address: normalizedAddress, isGuest: true })
      }
      // Mirror it locally even though another system allocated it: this system now
      // writes components for that entity, so this system must be able to clean it
      // up on disconnect regardless of which listener runs first (see ownedEntities).
      ownedEntities.set(normalizedAddress, entity)
      return entity
    }

    if (!createIfMissing) return null

    // Never re-allocate a peer we already saw depart: a straggler packet arriving
    // after PEER_DISCONNECTED would otherwise resurrect it as a permanently leaked
    // corpse avatar (see departedPeers).
    if (departedPeers.has(normalizedAddress)) return null

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
    ownedEntities.set(normalizedAddress, entity)

    return entity
  }

  // Event handlers (stored for cleanup on dispose)
  const handlePeerConnected = (event: { address: string }) => {
    console.log('peer connected', event)
    const address = normalizeAddress(event.address)

    // A reconnecting peer must be allowed to allocate again, so drop the departed
    // marker BEFORE the allocation below (which refuses known-departed addresses).
    departedPeers.delete(address)

    // Register this session so a LATE disconnect belonging to a PREVIOUS session
    // cannot purge it (see sessionCount).
    sessionCount.set(address, (sessionCount.get(address) ?? 0) + 1)

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
    const normalizedAddress = normalizeAddress(event.address)

    // Retire one live session. If a NEWER session is still live — the reconnect's
    // PEER_CONNECTED already arrived, out of order, ahead of this disconnect — keep
    // the entity: purging it here would make the live, reconnected client invisible
    // until it happens to send a movement packet (never, if it is standing still).
    // A peer with no counted session (already in the room when we joined, so we never
    // saw its connect) yields a non-positive remainder and falls through to removal.
    const remainingSessions = (sessionCount.get(normalizedAddress) ?? 0) - 1
    if (remainingSessions > 0) {
      sessionCount.set(normalizedAddress, remainingSessions)
      return
    }
    sessionCount.delete(normalizedAddress)

    // Resolve from THIS system's mirror, not the global allocator: a sibling system's
    // listener may already have freed the global mapping, and we still have to purge
    // our own stores and emit our own DELETE_ENTITY (see ownedEntities).
    const entity = ownedEntities.get(normalizedAddress) ?? null
    if (entity !== null) {
      removePlayerEntity(entity, event.address)
    }

    // Remember the departure AFTER the removal above, so straggler packets can no
    // longer resurrect this peer (see departedPeers). Oldest markers are evicted once
    // the set is full.
    // TRADEOFF: eviction can un-remember a very old departure, which at worst lets a
    // straggler resurrect one corpse — but stragglers land within seconds of the
    // departure, so re-admitting a peer that departed 1024 distinct departures ago is
    // strictly better than an unbounded set (a load-bearing memory bound, CLAUDE.md).
    departedPeers.add(normalizedAddress)
    if (departedPeers.size > MAX_DEPARTED_PEERS) limitLogger.hit('maxDepartedPeers')
    while (departedPeers.size > MAX_DEPARTED_PEERS) {
      const oldest = departedPeers.values().next().value
      if (oldest === undefined) break
      departedPeers.delete(oldest)
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
        range: [32, 256] as [number, number],
        dispose() {
          // ONE subscription is going away: tear down only what belongs to it — its
          // tracker and its per-component tick cursors.
          //
          // Deliberately does NOT clear playerEntityManager / profileCache /
          // profileFetchState / deletedEntities. `playerEntityManager` is a
          // process-global singleton and the other three belong to the SYSTEM, shared
          // by every subscription it hands out, so clearing them from one
          // subscription's teardown drops other scenes' live peer mappings and
          // destroys sibling subscriptions' pending DELETE_ENTITY tombstones (which,
          // since removePlayerEntity purges the components, are the ONLY removal
          // signal — so their avatars linger as ghosts).
          //
          // Worse, playerEntityManager.clear() also resets `nextEntityNumber` and
          // `entityVersions`, so a later allocation can hand a DIFFERENT address an
          // entity id a surviving scene's VM still holds. That is not merely cosmetic:
          // `@dcl/ecs` treats entities < 512 as Reserved and KEEPS their LWW
          // timestamps across `entityDeleted`, while our purgeEntity resets ours to 0.
          // The reissued id's one-shot PlayerIdentityData PUT (timestamp 1) is then
          // rejected as outdated while its 30Hz Transform PUTs eventually win — so the
          // entity keeps the OLD player's address while tracking the NEW player's
          // movement.
          subscriptionTrackers.delete(tracker)
          state.clear()
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

      // Clear only what THIS system owns. playerEntityManager is a process-global
      // singleton: clearing it here would drop sibling systems' live peer mappings
      // and reset nextEntityNumber/entityVersions while they are still serving those
      // peers — the same ownership bug this file fixes for subscription teardown, and
      // the reset is what lets a later allocation hand a different address an entity
      // id a surviving scene's VM still holds.
      //
      // Not a leak: pool slots are released on PEER_DISCONNECTED, which is a
      // transport-level event every system sees, not on system teardown. A system
      // disposed while peers are still connected SHOULD leave their global mappings
      // intact, and a replacement system re-adopts them (findPlayerEntityByAddress
      // backfills PlayerIdentityData and re-mirrors). Freeing the allocator wholesale
      // needs an explicit transport/session owner, which does not exist yet.
      profileCache.clear()
      profileFetchState.clear()
      deletedEntities.clear()
      departedPeers.clear()
      sessionCount.clear()
      ownedEntities.clear()
    }
  }
}

export type AvatarCommunicationSystem = ReturnType<typeof createAvatarCommunicationSystem>