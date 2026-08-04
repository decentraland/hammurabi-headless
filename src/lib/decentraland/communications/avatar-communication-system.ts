import { Quaternion, Vector3 } from "@babylonjs/core"
import { ReadWriteByteBuffer } from "../ByteBuffer"
import { ComponentDefinition } from "../crdt-internal/components"
import { createLwwStore } from "../crdt-internal/last-write-win-element-set"
import { AppendValueOperation, DeleteEntity } from "../crdt-wire-protocol"
import { playerIdentityDataComponent } from "../sdk-components/player-identity-data"
import { avatarBaseComponent } from "../sdk-components/avatar-base"
import { avatarEmoteCommandComponent, avatarEquippedDataComponent } from "../sdk-components/avatar-customizations"
import { transformComponent } from "../sdk-components/transform-component"
import { Entity } from "../types"
import { CommsTransportWrapper } from "./CommsTransportWrapper"
import { StaticEntities } from "../../babylon/scene/logic/static-entities"
import { playerEntityManager, OTHER_PLAYER_ENTITIES_RANGE } from "./player-entity-manager"
import { getAssetBundleRegistryUrl } from "../environment"
import { robustFetch, drainResponse, readBodyCapped, DEFAULT_MAX_BODY_BYTES } from "../../misc/network"
import { limits } from "../../misc/limits"
import { limitLogger } from "../../misc/limit-logger"
import { createRateLimitedErrorLogger } from "../../misc/logger"
import { createEmoteAppendLog } from "./emote-append-log"
import { EmoteMetadataResolver, emoteMetadataResolver } from "./emote-metadata"

/**
 * The canonical spelling of a peer address.
 *
 * Comms identities arrive in whatever case the peer's client used (LiveKit hands back
 * checksummed addresses), while every map in this system — and the entity allocator it
 * shares — is keyed lowercase. Exported so callers that report an address back to a
 * scene (`~system/Players`) hand out the SAME string this system does, instead of
 * echoing the caller's spelling.
 */
export function normalizeAddress(address: string): string {
  return address.toLowerCase()
}

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
  /**
   * Visit every address the registry currently considers observed and not departed.
   * Used by a newly attached system to rebuild its per-scene component stores without
   * waiting for each stationary peer to send another packet.
   */
  forEachObservedPeer(callback: (address: string) => void): void
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
  // Per address: a bounded set of exact live session ids, plus a scalar count for
  // sessions whose identity is unavailable. That includes genuinely sid-less connects
  // and exact ids collapsed out of the bounded set. Keeping collapsed liveness prevents
  // the remaining exact disconnects from retiring a peer whose forgotten session is
  // still live, without retaining attacker-controlled strings beyond the configured cap.
  type PeerSessions = {
    sids: Set<string>
    untracked: number
    untrackedSaturated: boolean
  }
  const liveSessions = new Map<string, PeerSessions>()
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
   * player invisible. Configuration requires one more tracked record than the remote
   * avatar capacity, so a protected record cannot starve the eviction scan.
   *
   * The no-candidate path remains load-bearing defence in depth for tests, embedding,
   * or future configuration changes that bypass readLimits: it permits a bounded
   * overage instead of evicting a live record. At most the avatar capacity plus one
   * records can then survive—the extra record belongs to the peer whose allocation
   * fails, and the next insertion can evict it.
   */
  function recordFor(address: string): PeerSessions {
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
      // Never evict a live peer. If the configured invariant was bypassed and every
      // record is protected, allow this insertion to exceed that invalid cap. The
      // remote-player pool is the hard bound: once full, this new address cannot
      // allocate an entity and becomes the evictable candidate for the next insertion.
      if (evicted !== undefined) liveSessions.delete(evicted)
      limitLogger.hit('maxTrackedPeerSessions', address)
    }

    const created: PeerSessions = { sids: new Set<string>(), untracked: 0, untrackedSaturated: false }
    liveSessions.set(address, created)
    return created
  }

  function addUntrackedSession(sessions: PeerSessions) {
    if (sessions.untracked < Number.MAX_SAFE_INTEGER) {
      sessions.untracked++
    } else {
      // Once the scalar count cannot represent another session exactly, fail
      // conservatively: sid-specific disconnects can no longer prove that every
      // collapsed session ended. An address-level disconnect still clears the record.
      sessions.untrackedSaturated = true
    }
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

    if (event.sid !== undefined) {
      // Re-announcing a sid we already hold is free; only a NEW exact id consumes
      // string-storage budget.
      if (!sessions.sids.has(event.sid) && sessions.sids.size >= MAX_SESSIONS_PER_PEER) {
        const oldestSid = sessions.sids.values().next().value
        if (oldestSid !== undefined) {
          sessions.sids.delete(oldestSid)
          // The evicted sid may still be live. Collapse it into scalar liveness so
          // disconnecting the retained ids cannot retire the address prematurely.
          addUntrackedSession(sessions)
        }
        limitLogger.hit('maxSessionsPerPeer', address)
      }
      sessions.sids.add(event.sid)
    } else {
      // A number is fixed-size state, so count every sid-less session rather than
      // dropping liveness merely to enforce the cap on attacker-controlled SID strings.
      if (sessions.untracked >= MAX_SESSIONS_PER_PEER || sessions.untrackedSaturated) {
        limitLogger.hit('maxSessionsPerPeer', address)
      }
      addUntrackedSession(sessions)
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
      if (!sessions.sids.delete(event.sid) && !sessions.untrackedSaturated && sessions.untracked > 0) {
        // The sid matches nothing we tracked, so it belongs to a session we could not
        // identify or whose exact id was collapsed. Consume that scalar liveness
        // instead of ignoring the disconnect, which would retain the peer forever.
        sessions.untracked--
      }
      // Still live if another exact id remains, if a collapsed session remains, or if
      // the collapsed count saturated and can no longer be retired safely by id.
      if (sessions.sids.size > 0 || sessions.untracked > 0 || sessions.untrackedSaturated) return
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
    forEachObservedPeer(callback) {
      if (generation !== avatarSessionGeneration) return
      // The callback may mirror an existing allocation and call noteObserved again,
      // but it does not add a new address. Iterating the map directly is therefore safe
      // and avoids allocating a snapshot proportional to the registry cap.
      for (const address of liveSessions.keys()) {
        try {
          callback(address)
        } catch (error: any) {
          logRegistryError(`avatar registry: a scene's peer-replay handler failed for ${address}`, error)
        }
      }
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

export function createAvatarCommunicationSystem(
  transport: CommsTransportWrapper,
  worldToScene: (position: Vector3) => Vector3,
  // Injectable so a test can drive a resolver whose cache/debounce/in-flight state it
  // owns. The default is process-wide on purpose (emote urns repeat across peers and
  // scenes), which is exactly what makes it unusable as shared test state.
  metadataResolver: EmoteMetadataResolver = emoteMetadataResolver
) {
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

  // Whitespace (incl. CR/LF) or an ASCII control char anywhere in an emote identifier.
  const MALFORMED_EMOTE_URN = /[\s\u0000-\u001f\u007f]/

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

  // Pending AvatarEmoteCommand appends. NOT a component store: 1088 is a GrowOnly
  // value set whose only drain empties one shared queue, which the several
  // subscriptions this system hands out would fight over (see emote-append-log).
  const emoteAppendLog = createEmoteAppendLog()
  // Scratch for serializing one emote payload. The bytes are COPIED into the log, so
  // one buffer is reused instead of allocating per emote.
  const emoteSerializationScratch = new ReadWriteByteBuffer()
  // Monotonic counter for PBAvatarEmoteCommand.timestamp, which the proto documents as
  // exactly that. Deliberately host-side: the reference client fills the field with its
  // own scene tick, `PlayerEmote.incrementalId` is never set by that client (it would
  // always be 0), and `PlayerEmote.timestamp` is peer-controlled client uptime — none of
  // which belong in the key the scene's value set sorts and trims by. The field is a
  // proto uint32, so protobufjs wraps it (`value >>> 0`); reaching that needs ~4 billion
  // appends in one process, and the only consequence is one ordering glitch at the wrap.
  //
  // Stamped when the append is QUEUED, which is also when the reference client stamps it
  // (it writes its current scene tick, and only once the emote has finished loading).
  //
  // The alternative — stamping on packet arrival — reads better for two emotes played back
  // to back whose lookups resolve out of order, but a value set is the wrong place for a
  // non-monotonic key. `gotUpdated` (crdt-internal/grow-only-set.ts, which mirrors the
  // SDK's implementation) re-sorts a row as soon as its newest key is <= its predecessor
  // and then trims with `shift()` from the FRONT, so an out-of-order lower key arriving at
  // a full row is precisely what gets discarded — the emote would be dropped outright.
  // Short of that it still sorts behind values the scene has already consumed, so a scene
  // tracking the highest key it processed never observes it. Queue-time stamping keeps the
  // key monotonic in delivery order, at the cost of an emote delayed by a metadata lookup
  // sorting after one played just behind it.
  //
  // Derived from the log's own sequence rather than a second counter of its own: the two
  // would be equal by construction today, and a second push site added later would
  // silently desynchronise the sort key from delivery order — which is the bug this
  // paragraph exists to prevent.
  const nextEmoteTimestamp = () => emoteAppendLog.sequence + 1
  // Appends are only drained up to here. Raised in update() once the LWW stores have
  // committed their dirty state, because that is what makes their deltas dumpable — an
  // append is dumpable the instant it is pushed, so without this gate a packet landing
  // after update() would deliver its APPEND_VALUE a frame BEFORE the PlayerIdentityData
  // PUT of the very entity it names.
  let committedEmoteSeq = 0
  const MAX_EMOTE_URN_BYTES = limits.maxEmoteUrnBytes // HAMMURABI_MAX_EMOTE_URN_BYTES
  const logEmoteError = createRateLimitedErrorLogger()

  // One tracker per live subscription: its highest emitted deletion sequence and its
  // highest emitted emote-append sequence.
  const subscriptionTrackers = new Set<{ emittedSeq: number; emittedEmoteSeq: number }>()
  let lastPrunedMinSeq = 0
  let lastPrunedEmoteSeq = 0

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

  // Drop emote appends every live subscription has already emitted. Same low-water-mark
  // reasoning (and the same stalled-subscription short-circuit) as the tombstone prune
  // above; a subscription created later starts at the current sequence, so it never
  // needs older entries.
  function pruneEmittedEmotes() {
    if (emoteAppendLog.size === 0) return
    let minEmitted = emoteAppendLog.sequence
    for (const tracker of subscriptionTrackers) {
      if (tracker.emittedEmoteSeq < minEmitted) minEmitted = tracker.emittedEmoteSeq
    }
    if (minEmitted <= lastPrunedEmoteSeq) return
    lastPrunedEmoteSeq = minEmitted
    emoteAppendLog.pruneUpTo(minEmitted)
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
    // An append still queued behind this entity's DELETE_ENTITY describes an entity the
    // scene is about to be told is gone. First, because it cannot throw.
    emoteAppendLog.purgeEntity(entity)

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
    lastCommsPosLogMs.delete(normalizedAddress)
    lastWorldPosition.delete(normalizedAddress)
  }

  /**
   * Resolve (and optionally allocate) the entity for an ALREADY-normalized address.
   *
   * Split from `findPlayerEntityByAddress` so a caller that needs the normalized key
   * for its own bookkeeping normalizes ONCE. Position and movement packets both do —
   * they key `lastWorldPosition` by it — and at the 224-slot pool times 30Hz the second
   * `toLowerCase()` was ~6.7k throwaway strings a second for nothing.
   */
  function findPlayerEntityByNormalizedAddress(normalizedAddress: string, createIfMissing: boolean): Entity | null {
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

  function findPlayerEntityByAddress(address: string, createIfMissing: boolean): Entity | null {
    return findPlayerEntityByNormalizedAddress(normalizeAddress(address), createIfMissing)
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

  // Last WORLD position seen per peer, for `~system/Players.getPlayersInScene`.
  // The Transform store holds SCENE-space positions (worldToScene is applied on
  // the way in), which cannot answer "is this peer inside scene X" for any scene
  // but this one — so the pre-conversion value is kept here.
  //
  // Bounded like lastCommsPosLogMs: an entry is only created for an address that
  // resolved to an entity (so at most one per pool slot) and removePlayerEntity
  // clears it on disconnect.
  const lastWorldPosition = new Map<string, Vector3>()

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

  const putPlayerTransform = (entity: Entity, address: string, data: any, rotation: Quaternion) => {
    tmpWorldPosition.set(data.positionX, data.positionY, data.positionZ)

    // Record BEFORE the conversion: worldToScene returns the vector the store
    // retains, and it is scene-local.
    const known = lastWorldPosition.get(address)
    if (known) {
      known.copyFrom(tmpWorldPosition)
    } else {
      lastWorldPosition.set(address, tmpWorldPosition.clone())
    }

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
    // Normalized ONCE per packet and threaded through: this is the hottest path in the
    // system (every peer, ~30Hz).
    const address = normalizeAddress(event.address)
    const entity = findPlayerEntityByNormalizedAddress(address, true)
    if (entity) {
      // Log only after allocation succeeds, so the throttle map gets an entry
      // only for an address that has an entity (cleaned up in removePlayerEntity).
      if (DEBUG_COMMS_POSITIONS) debugLogCommsPosition('position', address, d)
      putPlayerTransform(entity, address, event.data, new Quaternion(event.data.rotationX, event.data.rotationY, event.data.rotationZ, event.data.rotationW))
    }
  }

  const handleMovement = (event: { address: string, data: any }) => {
    const d = event.data
    if (
      !Number.isFinite(d.positionX) || !Number.isFinite(d.positionY) || !Number.isFinite(d.positionZ) ||
      !Number.isFinite(d.rotationY)
    ) return
    const address = normalizeAddress(event.address)
    const entity = findPlayerEntityByNormalizedAddress(address, true)

    if (entity) {
      // Log only after allocation succeeds (see handlePosition).
      if (DEBUG_COMMS_POSITIONS) debugLogCommsPosition('movement', address, d)
      putPlayerTransform(entity, address, event.data, Quaternion.RotationAxis(Vector3.Up(), event.data.rotationY))
    }
  }

  // Serialize + queue one AvatarEmoteCommand append for this entity. Serialization
  // happens ONCE here (not per subscription) and the bytes are shared by every
  // subscription that has yet to drain them.
  const appendEmote = (entity: Entity, emoteUrn: string, loop: boolean) => {
    emoteSerializationScratch.resetBuffer()
    avatarEmoteCommandComponent.serialize(
      { emoteUrn, loop, timestamp: nextEmoteTimestamp() },
      emoteSerializationScratch
    )
    emoteAppendLog.push(entity, emoteSerializationScratch.toCopiedBinary())
  }

  const handlePlayerEmote = (event: { address: string, data: any }) => {
    const d = event.data
    // A stop is not a playback event: the reference client tears the animation down and
    // writes no component for it, and the SDK component cannot express "stopped".
    if (d?.isStopping === true) return

    const emoteUrn = d?.urn
    if (typeof emoteUrn !== 'string' || emoteUrn.length === 0) return
    // Peer-controlled string headed for every scene's CRDT — bound it before it gets
    // there. Throttled log: a peer could otherwise spam this at its full packet rate.
    if (Buffer.byteLength(emoteUrn) > MAX_EMOTE_URN_BYTES) {
      limitLogger.hit('maxEmoteUrnBytes', event.address)
      return
    }
    // No real emote identifier contains whitespace or control characters — urns, legacy
    // names and the client's embedded ids are all single tokens. Rejecting those here keeps
    // a crafted string from becoming a registry pointer and a cache key, and keeps it out of
    // log lines. Deliberately NOT a charset allowlist: a false reject would silently drop a
    // legitimate emote, and cache/debounce/ceiling already bound the load an odd-but-valid
    // urn can cause.
    if (MALFORMED_EMOTE_URN.test(emoteUrn)) {
      limitLogger.hit('maxEmoteUrnBytes', `malformed urn from ${event.address}`)
      return
    }

    const normalizedAddress = normalizeAddress(event.address)
    const entity = findPlayerEntityByNormalizedAddress(normalizedAddress, true)
    if (!entity) return

    const loop = metadataResolver.resolveLoop(emoteUrn, normalizedAddress)
    if (typeof loop === 'boolean') {
      appendEmote(entity, emoteUrn, loop)
      return
    }
    // Anything that is neither a boolean nor a thenable would throw below, and a throw
    // here aborts the whole transport emit (skipping every later listener) and logs
    // unthrottled once per packet — a peer-triggerable stderr flood. resolveLoop is
    // typed to return only these two shapes; this is the belt to that braces.
    if (typeof loop?.then !== 'function') {
      logEmoteError('emote loop resolver returned an unexpected value', new Error(typeof loop))
      return
    }

    // A metadata lookup is in flight. resolveLoop never rejects (it resolves `false` on
    // failure), but keep the chain guarded so a surprise can never surface as an
    // unhandled rejection out of a transport event handler.
    loop
      .then((resolved) => {
        // The peer may have departed — or reconnected onto a fresh entity — while the
        // lookup was in flight. Consult THIS system's mirror rather than the global
        // allocator: `ownedEntities` is what the rest of this system trusts for the
        // mapping (see its declaration), and it cannot be confused by an id reissued
        // after a session reset.
        if (ownedEntities.get(normalizedAddress) !== entity) return
        appendEmote(entity, emoteUrn, resolved)
      })
      .catch((error) => logEmoteError('Failed to append avatar emote command', error))
  }

  // ADR-204: Use profileMessage for profile version announcements
  const handleProfileMessage = async (event: { address: string, data: any }) => {
    const address = normalizeAddress(event.address)
    const announcedVersion = event.data.profileVersion

    const entity = findPlayerEntityByNormalizedAddress(address, true)
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
  transport.events.on('playerEmote', handlePlayerEmote)
  transport.events.on('profileMessage', handleProfileMessage)
  transport.events.on('chatMessage', handleChatMessage)
  // The registry outlives systems across hot reloads and late scene attachment.
  // Rebuild this system's local stores now; stationary peers may send no future packet
  // that would otherwise trigger adoption. Run after every transport handler is wired
  // because adoption emits the initial profileMessage synchronously.
  registry.forEachObservedPeer(handlePeerAdopted)

  // Public API for managing the avatar system
  return {
    // Entity range this system manages (single source of truth: player-entity-manager)
    range: OTHER_PLAYER_ENTITIES_RANGE,

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
      // Only NOW may the appends queued so far be drained: the commits above are what
      // make the LWW deltas of the same entities dumpable (see committedEmoteSeq).
      committedEmoteSeq = emoteAppendLog.sequence
      pruneEmittedTombstones()
      pruneEmittedEmotes()
    },

    // Diagnostics: emote appends still awaiting delivery. Should return to 0 once every
    // live subscription has drained and a tick has pruned — i.e. the log does not
    // accumulate over a session.
    pendingEmoteAppends() {
      return emoteAppendLog.size
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
      // Emote appends start at the CURRENT sequence for the same reason: this
      // subscription begins from a state dump that never contained those emotes, and
      // emotes are events — there is no backlog to re-synchronize.
      const tracker = { emittedSeq: deletionSequence, emittedEmoteSeq: emoteAppendLog.sequence }
      subscriptionTrackers.add(tracker)

      return {
        range: OTHER_PLAYER_ENTITIES_RANGE,
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

          // Emote appends go LAST, after the component deltas above: a peer adopted by
          // its own emote packet has its PlayerIdentityData PUT in this same buffer, and
          // that must reach the scene before an APPEND_VALUE for the entity. Bounded by
          // committedEmoteSeq so an append can never outrun the commit that made those
          // deltas dumpable.
          emoteAppendLog.forEachAfter(tracker.emittedEmoteSeq, committedEmoteSeq, (entry) => {
            AppendValueOperation.write(
              {
                entityId: entry.entityId,
                componentId: avatarEmoteCommandComponent.componentId,
                // Lamport timestamp is unused for GrowOnly sets (the value carries its
                // own ordering key), so the wire header stays 0 — same as the GOS store.
                timestamp: 0,
                data: entry.data
              },
              writer
            )
            // Per entry, not after the loop: a partial buffer is still forwarded to the
            // scene, so progress must be recorded as it happens.
            tracker.emittedEmoteSeq = entry.seq
          })
          // NEVER backwards. This tracker may have been created with a cursor ABOVE the
          // watermark — `createSubscription` initializes it to the log's newest sequence
          // so a latecomer gets no backlog, and pushes since the last tick are not yet
          // committed. Assigning the watermark unconditionally would rewind that cursor
          // and hand the latecomer exactly the backlog it must not see.
          tracker.emittedEmoteSeq = Math.max(tracker.emittedEmoteSeq, committedEmoteSeq)
        },
      }
    },

    /**
     * Read-only view of the peers this system currently owns an entity for, for
     * `~system/Players`. Positions are WORLD-space (pre-`worldToScene`) so a caller can
     * test them against any scene's parcels.
     *
     * MEMBERSHIP: one entry per address in `ownedEntities` — every peer this system has
     * adopted, from ANY packet (position, movement, profile, chat, emote) or from the
     * registry replay of peers already in the room when this system attached. An entry
     * appears when the peer is adopted and disappears only when the transport reports it
     * gone (PEER_DISCONNECTED -> `removePlayerEntity`).
     *
     * `worldPosition` IS NULL until the peer's first position/movement packet, and only
     * those two packets ever write it. So:
     *  - a peer adopted by a profile/chat/emote packet, and every peer replayed from the
     *    registry, reports `null` until it moves. A stationary peer that never sends a
     *    position packet reports `null` forever. That is deliberate: this system does not
     *    know where it stands, and no caller should be able to mistake a guess for an
     *    answer.
     *  - the converse: a peer that STOPS sending keeps its last reported position for as
     *    long as it stays connected. There is no staleness timeout — standing still is
     *    the normal reason a client sends nothing.
     *
     * `entity` is the allocated avatar entity. Peer entity ids are generationally
     * versioned, so a RECONNECT gets a different id for the same address — which is the
     * only thing that distinguishes "still here" from "left and came back" for a caller
     * that only ever sees whole snapshots (the address alone does not: a disconnect and
     * a reconnect between two frames leave it present in both).
     *
     * Returns a snapshot: the caller must not retain the vectors, which are
     * reused in place as packets arrive.
     */
    listKnownPeers(): Array<{ address: string; entity: Entity; worldPosition: Vector3 | null; profile: any | null }> {
      const result: Array<{ address: string; entity: Entity; worldPosition: Vector3 | null; profile: any | null }> = []
      for (const [address, entity] of ownedEntities) {
        result.push({
          address,
          entity,
          worldPosition: lastWorldPosition.get(address) ?? null,
          profile: profileCache.get(address)?.profile ?? null
        })
      }
      return result
    },

    /** The cached profile for a peer, or null when none has been resolved yet. */
    getKnownProfile(address: string): any | null {
      return profileCache.get(normalizeAddress(address))?.profile ?? null
    },

    // Cleanup function
    dispose() {
      // Remove event listeners to prevent duplicates on hot-reload
      unsubscribePeerAdopted()
      unsubscribePeerRetired()
      transport.events.off('position', handlePosition)
      transport.events.off('movement', handleMovement)
      transport.events.off('playerEmote', handlePlayerEmote)
      transport.events.off('profileMessage', handleProfileMessage)
      transport.events.off('chatMessage', handleChatMessage)

      // Clear only what THIS system owns. Neither playerEntityManager nor the
      // transport registry is touched: they are shared with sibling scenes and must
      // outlive this system, which is exactly what lets the departed-peer guard and
      // the pool slots survive a hot reload. Pool slots are released by the registry
      // on PEER_DISCONNECTED, not by system teardown, and a replacement system replays
      // the registry's observed peers when it attaches.
      profileCache.clear()
      profileFetchState.clear()
      deletedEntities.clear()
      ownedEntities.clear()
      lastWorldPosition.clear()
    }
  }
}

export type AvatarCommunicationSystem = ReturnType<typeof createAvatarCommunicationSystem>
