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
import { createRateLimitedErrorLogger } from "../../misc/logger"

/**
 * Single avatar communication system that handles avatar entities for a specific scene transport.
 * This system manages player entities, profiles, and avatar data for multiplayer scenarios.
 *
 * `worldToScene` converts world/global positions received from comms into the owning scene's
 * coordinate system, so the Transforms written here are only valid for that scene.
 */
/**
 * Peer-lifecycle state that belongs to the TRANSPORT, not to any one avatar system.
 *
 * The avatar systems are per-scene and are replaced freely (a local hot reload
 * disposes one and creates another with a ~100ms gap in between), while the entity
 * allocator they share is process-global and deliberately NOT reset on system
 * teardown. Anything that guards that allocator therefore cannot live on a system:
 *  - departed markers held by a disposed system are lost, so a straggler packet could
 *    re-adopt a departed peer through the still-present global mapping and resurrect
 *    a frozen ghost avatar;
 *  - a peer that disconnects during the gap has NO system listening at all, so the
 *    departure would be missed entirely and its pool slot leaked for good.
 *
 * So the registry owns the departed markers, the live sessions, and the transport
 * subscriptions that maintain them — registered once per transport and never removed
 * — and systems attach their own per-scene cleanup as callbacks. One registry per
 * transport, so every scene on that transport agrees on who has left.
 */
type AvatarTransportRegistry = {
  readonly departedPeers: Set<string>
  /**
   * Record that this address exists, without claiming any identified live session.
   *
   * Called when a system adopts a peer from a data packet: LiveKit emits no
   * ParticipantConnected for peers already in the room when we joined, so those are
   * only ever seen this way. Seeding a record makes "no record at all" mean strictly
   * "never observed" rather than "observed but evicted", which is what lets a
   * disconnect with no record be treated conservatively instead of destructively.
   */
  noteObserved(address: string): void
  onPeerAdopted(callback: (address: string) => void): () => void
  onPeerRetired(callback: (address: string) => void): () => void
}

// Keyed weakly so a discarded transport takes its registry with it.
const avatarTransportRegistries = new WeakMap<CommsTransportWrapper, RegistryInternals>()

/**
 * Which engine/comms session the avatar state belongs to.
 *
 * A registry keeps its transport subscriptions for the life of that transport and
 * deliberately never removes them, so they can outlive the session that created them:
 * `resetEngine` starts `transport.disconnect()` WITHOUT awaiting it, clears the
 * allocator and unblocks a restart, so a late PEER_DISCONNECTED from the OLD transport
 * can land after a NEW session has already allocated the same address — and the old
 * registry would then free a mapping that now belongs to the new session. Stamping each
 * registry with the generation it was built in, and no-oping its handlers once that
 * generation is over, closes that without having to chase down listeners.
 */
let avatarSessionGeneration = 0

/**
 * Ends the current avatar session: retires every registry built in it and releases the
 * process-global remote-player allocator. Called by the session owner (`resetEngine`)
 * once every scene is disposed and the transport is disconnecting — never from a scene
 * or subscription teardown, which share this state with live siblings.
 */
export function resetAvatarSessionState() {
  avatarSessionGeneration++
  playerEntityManager.clear()
}

type RegistryInternals = AvatarTransportRegistry & {
  readonly generation: number
  /**
   * Remove this registry's transport subscriptions. Called when a registry from a past
   * generation is replaced on a transport that is being reused: the generation guard
   * already makes the old handlers inert, but leaving them attached retains their
   * closures — and therefore the departed/session maps they capture — for the life of
   * the transport, once per session that reuses it.
   */
  detach(): void
}

function getAvatarTransportRegistry(transport: CommsTransportWrapper): AvatarTransportRegistry {
  const existing = avatarTransportRegistries.get(transport)
  if (existing) {
    if (existing.generation === avatarSessionGeneration) return existing
    // A registry from a previous session is inert (its handlers no-op on the generation
    // check), but leaving it subscribed retains its closures and their maps for the life
    // of the transport — once per session that reuses it. Detach before replacing.
    existing.detach()
    avatarTransportRegistries.delete(transport)
  }

  const generation = avatarSessionGeneration

  const departedPeers = new Set<string>()
  // Per address: the ids of live sessions, plus a count of live sessions whose id the
  // transport did not give us. `sid` is optional on the transport contract, so a
  // reconnect can arrive without one; recording nothing for it let a stale disconnect
  // for an OLD sid drain the set and retire the currently-live sid-less session.
  // Counted rather than flagged so connect(no sid) twice is not indistinguishable from
  // once — and an address-level (sid-less) disconnect clears both, so it cannot inflate
  // without bound.
  const liveSessions = new Map<string, { sids: Set<string>; unknown: number }>()
  const adoptedCallbacks = new Set<(address: string) => void>()
  const retiredCallbacks = new Set<(address: string) => void>()
  const MAX_DEPARTED_PEERS = limits.maxDepartedPeers // HAMMURABI_MAX_DEPARTED_PEERS
  const MAX_TRACKED_PEER_SESSIONS = limits.maxTrackedPeerSessions // HAMMURABI_MAX_TRACKED_PEER_SESSIONS
  const MAX_SESSIONS_PER_PEER = limits.maxSessionsPerPeer // HAMMURABI_MAX_SESSIONS_PER_PEER
  // One scene's callback must never be able to skip another scene's cleanup, so each
  // dispatch is contained. Throttled because a callback that fails once tends to keep
  // failing on every subsequent departure.
  const logRegistryError = createRateLimitedErrorLogger()

  /**
   * The session record for `address`, created if absent, evicting another address's
   * record first when the cap is reached.
   *
   * Eviction NEVER takes the record of an address that currently holds an avatar
   * entity. That is the invariant the retire decision depends on: with a record
   * present we can tell a stale session's disconnect from a real departure, and
   * without one we cannot — so losing the record of a LIVE peer would let a stale
   * sid-specific disconnect retire it and blacklist the address, making an active
   * player invisible. The allocator holds at most OTHER_PLAYER_ENTITIES (224)
   * addresses against a cap of 1024, so a protected record can never starve the
   * eviction scan; the fallback below exists only so a misconfigured cap degrades
   * instead of looping.
   */
  function recordFor(address: string): { sids: Set<string>; unknown: number } {
    const existing = liveSessions.get(address)
    if (existing !== undefined) return existing

    if (liveSessions.size >= MAX_TRACKED_PEER_SESSIONS) {
      let evicted: string | undefined
      for (const candidate of liveSessions.keys()) {
        if (playerEntityManager.getEntityForAddress(candidate) === null) {
          evicted = candidate
          break
        }
      }
      // Every tracked address holds an entity (only reachable if the cap is set below
      // the avatar pool size): drop the oldest regardless rather than grow unbounded.
      if (evicted === undefined) evicted = liveSessions.keys().next().value
      if (evicted !== undefined) liveSessions.delete(evicted)
      limitLogger.hit('maxTrackedPeerSessions', address)
    }

    const created = { sids: new Set<string>(), unknown: 0 }
    liveSessions.set(address, created)
    return created
  }

  function dispatch(callbacks: Set<(address: string) => void>, address: string, what: string) {
    for (const callback of callbacks) {
      try {
        callback(address)
      } catch (error: any) {
        logRegistryError(`avatar registry: a scene's ${what} handler failed for ${address}`, error)
      }
    }
  }

  const onPeerConnected = (event: { address: string; sid?: string }) => {
    // Inert once this session is over: see avatarSessionGeneration.
    if (generation !== avatarSessionGeneration) return
    const address = event.address.toLowerCase()
    // A reconnect makes the peer allocatable again. Done here, not in a system, so a
    // reconnect that lands while no system exists still clears the marker.
    departedPeers.delete(address)
    // Register THIS session so a late disconnect belonging to a PREVIOUS session
    // cannot retire it. A transport without per-session ids, or a repeated connect for
    // the same session, is idempotent — it is a Set.
    // BOUNDED (load-bearing, CLAUDE.md): every connect records an address and a
    // session, whether or not that peer ever obtains one of the 224 avatar slots, so a
    // hostile or faulty comms source churning identities/sids — or simply losing
    // disconnects — would otherwise grow this for the life of the transport.
    const sessions = recordFor(address)

    const trackedForPeer = sessions.sids.size + sessions.unknown
    if (event.sid !== undefined) {
      // Re-announcing a sid we already hold is free; only a NEW one consumes budget.
      if (!sessions.sids.has(event.sid) && trackedForPeer >= MAX_SESSIONS_PER_PEER) {
        const oldestSid = sessions.sids.values().next().value
        if (oldestSid !== undefined) sessions.sids.delete(oldestSid)
        else if (sessions.unknown > 0) sessions.unknown--
        limitLogger.hit('maxSessionsPerPeer', address)
      }
      sessions.sids.add(event.sid)
    } else if (trackedForPeer < MAX_SESSIONS_PER_PEER) {
      sessions.unknown++
    } else {
      // Clamp rather than grow. TRADEOFF: with more than MAX_SESSIONS_PER_PEER
      // concurrent UNIDENTIFIED sessions on one address, retiring the tracked ones can
      // retire the peer while an untracked one is still live. That needs a transport
      // that omits `sid` on many simultaneous sessions for a single address; the bound
      // matters more, and an address-level disconnect clears the record either way.
      limitLogger.hit('maxSessionsPerPeer', address)
    }
    dispatch(adoptedCallbacks, address, 'peer-adopted')
  }

  const onPeerDisconnected = (event: { address: string; sid?: string }) => {
    // Inert once this session is over. Without this, a late disconnect from the old
    // transport frees an allocator mapping that now belongs to the NEW session.
    if (generation !== avatarSessionGeneration) return
    const address = event.address.toLowerCase()

    // Retire THIS session. If any OTHER session for the same address is still live —
    // the reconnect's PEER_CONNECTED already arrived, out of order, ahead of this
    // disconnect — keep the peer: retiring it would make the live, reconnected client
    // invisible until it happens to send a movement packet, i.e. never if it is
    // standing still.
    // A disconnect WITHOUT a session id is an address-level departure — the transport
    // is telling us the peer is gone but cannot say which session, so every recorded
    // session for it is over. Without this, a sid-less disconnect for a peer that DOES
    // have recorded sessions left the set untouched and returned on `size > 0`, so the
    // peer was never retired and its entity and pool slot leaked.
    const sessions = liveSessions.get(address)
    if (event.sid !== undefined) {
      if (sessions === undefined) {
        // No record, and a sid-specific disconnect cannot tell us whether any OTHER
        // session for this address is still live. Because a record is seeded the first
        // time an address is observed and is never evicted while that address holds an
        // entity, reaching here means the address has no avatar entity to purge and no
        // straggler to blacklist — so the conservative choice costs nothing. Retiring
        // instead would let churn past the cap retire a live reconnect.
        //
        // DEFENCE IN DEPTH, deliberately not independently observable: the eviction
        // protection in recordFor is what actually guarantees a live peer keeps its
        // record, so no test can distinguish this branch while that holds. It exists so
        // that if the protection is ever weakened, the failure mode is a leaked pool
        // slot rather than an active player going invisible.
        return
      }
      if (!sessions.sids.delete(event.sid) && sessions.unknown > 0) {
        // The sid matches nothing we tracked, so it belongs to a session we could not
        // identify (a connect that arrived without one). Consume that instead of
        // ignoring the disconnect, which used to leave the peer live until an
        // address-level disconnect happened to arrive.
        sessions.unknown--
      }
      // Still live if another id remains, or if a session we could not identify does.
      if (sessions.sids.size > 0 || sessions.unknown > 0) return
    }
    liveSessions.delete(address)

    // Mark departed BEFORE notifying, so a straggler packet racing the callbacks is
    // already refused. Oldest markers are evicted once the set is full.
    // TRADEOFF: eviction can un-remember a very old departure, which at worst lets a
    // straggler resurrect one corpse — but stragglers land within seconds of the
    // departure, so re-admitting a peer that departed MAX_DEPARTED_PEERS distinct
    // departures ago is strictly better than an unbounded set (CLAUDE.md).
    departedPeers.add(address)
    if (departedPeers.size > MAX_DEPARTED_PEERS) limitLogger.hit('maxDepartedPeers')
    while (departedPeers.size > MAX_DEPARTED_PEERS) {
      const oldest = departedPeers.values().next().value
      if (oldest === undefined) break
      departedPeers.delete(oldest)
    }

    try {
      // Let every live system purge its own components and emit its own tombstone
      // first; they read their local mirrors, not the allocator. Contained per scene:
      // one scene throwing must not skip its siblings' cleanup.
      dispatch(retiredCallbacks, address, 'peer-retired')
    } finally {
      // Release the pool slot unconditionally and exactly once per departure. In a
      // `finally` so that nothing a scene does — however it fails — can leak the slot.
      playerEntityManager.freeEntityForPlayer(address)
    }
  }

  transport.events.on('PEER_CONNECTED', onPeerConnected)
  transport.events.on('PEER_DISCONNECTED', onPeerDisconnected)

  const registry: RegistryInternals = {
    generation,
    departedPeers,
    noteObserved(address: string) {
      if (generation !== avatarSessionGeneration) return
      recordFor(address)
    },
    detach() {
      transport.events.off('PEER_CONNECTED', onPeerConnected)
      transport.events.off('PEER_DISCONNECTED', onPeerDisconnected)
      // Drop what the (now unreachable) handlers captured, so a transport reused across
      // many sessions does not accumulate a retired registry's maps per session.
      adoptedCallbacks.clear()
      retiredCallbacks.clear()
      departedPeers.clear()
      liveSessions.clear()
    },
    onPeerAdopted(callback) {
      adoptedCallbacks.add(callback)
      return () => adoptedCallbacks.delete(callback)
    },
    onPeerRetired(callback) {
      retiredCallbacks.add(callback)
      return () => retiredCallbacks.delete(callback)
    }
  }
  avatarTransportRegistries.set(transport, registry)
  return registry
}

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

  // Throttle the "pool exhausted" warning. findPlayerEntityByAddress runs per
  // inbound packet, so once the 224-slot remote-player pool is full an unallocated
  // peer would otherwise log once per dropped packet — up to the per-peer inbound
  // rate, aggregated across peers. On blocking stderr that is an event-loop-stall
  // vector; log at most once per second regardless of how many packets are dropped.
  let lastPoolExhaustedLogAt = 0

  // Transport-scoped peer lifecycle: departed markers, live sessions, and the
  // subscriptions that maintain them. Shared with every other avatar system on this
  // transport and OUTLIVES this system, which is what makes the departed-peer guard
  // survive a hot reload (see getAvatarTransportRegistry).
  //
  // The guard refuses only KNOWN-DEPARTED addresses, never unknown ones: LiveKit does
  // NOT emit ParticipantConnected for peers already in the room when we joined, so
  // those are discovered ONLY from their first data packet and must still be allowed
  // to allocate. Inverting this into an allowlist would make every peer who joined
  // before us permanently invisible.
  const registry = getAvatarTransportRegistry(transport)
  const departedPeers = registry.departedPeers

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

    // Refuse a peer we already saw depart BEFORE consulting the allocator. The global
    // mapping may still exist — a sibling system that has not processed the departure
    // yet, or one this system never adopted — and honouring it here would let a
    // straggler packet resurrect a departed peer through the back door, which is the
    // whole thing departedPeers exists to prevent. Checked for reads as well as
    // allocations, since adopting an existing mapping also starts writing components.
    if (departedPeers.has(normalizedAddress)) return null

    // Then check if we already have an entity allocated for this address
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
      registry.noteObserved(normalizedAddress)
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
    ownedEntities.set(normalizedAddress, entity)
    // Peers already in the room when we joined get no PEER_CONNECTED, so this is the
    // only place their existence is recorded (see noteObserved).
    registry.noteObserved(normalizedAddress)

    return entity
  }

  // Event handlers (stored for cleanup on dispose)
  //
  // Peer connect/disconnect are NOT subscribed on the transport directly: the registry
  // owns those subscriptions so its bookkeeping survives this system, and hands us the
  // per-scene half of the work as callbacks (see getAvatarTransportRegistry).
  const handlePeerAdopted = (address: string) => {

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

  // The registry has already retired the session, marked the address departed and
  // will free the pool slot; this is only THIS scene's half of the teardown.
  const handlePeerRetired = (address: string) => {
    console.log('[PEER_DISCONNECTED]', { address })

    // Resolve from THIS system's mirror, not the allocator: sibling systems purge
    // independently and in any order, and the mapping may already be gone.
    const entity = ownedEntities.get(address) ?? null
    if (entity !== null) {
      removePlayerEntity(entity, address)
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
  const unsubscribePeerAdopted = registry.onPeerAdopted(handlePeerAdopted)
  const unsubscribePeerRetired = registry.onPeerRetired(handlePeerRetired)
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
      // Starts at the CURRENT deletion sequence, not 0: a subscription created now
      // begins from a state dump that never contained the already-purged entities, so
      // every tombstone retained from before this moment is one it must not emit.
      // Starting at 0 made a fresh subscription's first getUpdates emit a
      // DELETE_ENTITY for every retained tombstone — deletes for entities that
      // subscription had never been told about.
      const tracker = { emittedSeq: deletionSequence }
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
      unsubscribePeerAdopted()
      unsubscribePeerRetired()
      transport.events.off('position', handlePosition)
      transport.events.off('movement', handleMovement)
      transport.events.off('profileMessage', handleProfileMessage)
      transport.events.off('chatMessage', handleChatMessage)

      // Clear only what THIS system owns. Neither playerEntityManager nor the
      // transport registry is touched: they are shared with sibling scenes and must
      // outlive this system, which is exactly what lets the departed-peer guard and
      // the pool slots survive a hot reload. Pool slots are released by the registry
      // on PEER_DISCONNECTED, not by system teardown, and a replacement system
      // re-adopts live peers on their next packet (findPlayerEntityByAddress backfills
      // PlayerIdentityData and re-mirrors).
      profileCache.clear()
      profileFetchState.clear()
      deletedEntities.clear()
      ownedEntities.clear()
    }
  }
}

export type AvatarCommunicationSystem = ReturnType<typeof createAvatarCommunicationSystem>