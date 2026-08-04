import { createLogger } from './logger'
import { REMOTE_PLAYER_ENTITY_CAPACITY } from '../decentraland/communications/player-entity-manager'

/**
 * Central, env-configurable resource/DoS limits for a Hammurabi worker.
 *
 * Every numeric cap and timeout that bounds an untrusted scene, a remote comms
 * peer, or a content-server response lives here. Each field defaults to the value
 * that used to be hard-coded, so behavior is UNCHANGED unless an operator sets the
 * corresponding `HAMMURABI_*` environment variable. Values are read once at process
 * start (these processes are spawned one-scene-per-process by a supervisor that
 * sets the env per worker), parsed as integers, and clamped to a safe minimum; an
 * out-of-range or non-numeric override is ignored (default kept) and logged once.
 *
 * Units are named in the env var: `_MS` = milliseconds, `_BYTES` = bytes,
 * `_MB` = megabytes, `_METERS` = metres of scene space, otherwise a plain count.
 * Spec-compliance validators (WebSocket close codes, redirect method rewrites) are
 * deliberately NOT configurable — only resource/DoS caps and timeouts are.
 */
export interface Limits {
  // --- Isolate sandbox (per-scene V8 isolate) ---
  isolateMemoryLimitBytes: number
  maxSyncExecutionMs: number
  maxAsyncTurnMs: number
  maxHostCallArgBytes: number
  maxInflightHostCalls: number
  maxCoercedBytes: number
  maxOpenSockets: number
  maxWsPendingDispatch: number

  // --- Scene / CRDT ingest ---
  maxLiveEntities: number
  maxDeletedTombstones: number
  maxCrdtPayloadBytes: number
  maxIncomingQueue: number
  maxNetworkMessageQueue: number
  maxEchoDedupeEntries: number

  // --- Inbound communications (remote peers) ---
  maxInboundPacketBytes: number
  inboundRateWindowMs: number
  maxMessagesPerWindow: number
  maxRateEntries: number
  maxAvatarTombstones: number
  maxDepartedPeers: number
  maxTrackedPeerSessions: number
  maxSessionsPerPeer: number
  profileFetchCooldownMs: number
  livekitConnectTimeoutMs: number
  maxEmoteUrnBytes: number
  maxEmoteAppendLog: number
  maxEmoteMetadataCacheEntries: number
  maxEmoteMetadataInflight: number
  maxEmoteMetadataWaiters: number
  emoteMetadataFetchCooldownMs: number
  emoteMetadataLookupTimeoutMs: number

  // --- Scene RPC capabilities ---
  maxSendPeers: number
  maxSendMessages: number
  maxCommsMessageBytes: number
  maxSignedFetchRedirects: number

  // --- Fetch / network / assets / WebSocket ---
  fetchTimeoutMs: number
  fetchRetries: number
  maxBodyBytes: number
  maxAssetBytes: number
  maxXhrResponseBytes: number
  maxFetchRedirects: number
  maxConcurrentFetches: number
  maxWsMessageBytes: number
  maxWsBufferedBytes: number
  wsHandshakeTimeoutMs: number

  // --- Scene primitives (MeshRenderer / MeshCollider geometry) ---
  maxPrimitiveRadiusMeters: number

  // --- Render loop / scheduling / shutdown ---
  minFrameTimeMs: number
  msPerFrameProcessingSceneMessages: number
  shutdownHookTimeoutMs: number
  shutdownDrainMs: number

  // --- Raycasting ---
  maxRaycastIntersectionsPerFrame: number
  maxRaycastTrianglesPerFrame: number
  maxRaycastHitsPerQuery: number
  maxColliderTreeDepth: number
}

const KB = 1024
const MB = 1024 * 1024

// One row per tunable: the Limits key, its env var, the default (already in the
// field's native unit), a hard minimum (also native unit), and whether the env
// value is expressed in MB (only the isolate memory ceiling, to match isolated-vm's
// MB API and Node's --max-old-space-size convention). Everything else reads as an
// integer in the field's native unit.
interface Knob {
  key: keyof Limits
  env: string
  def: number
  min: number
  mb?: boolean
}

const KNOBS: readonly Knob[] = [
  // Isolate sandbox
  { key: 'isolateMemoryLimitBytes', env: 'HAMMURABI_ISOLATE_MEMORY_LIMIT_MB', def: 256 * MB, min: 8 * MB, mb: true },
  { key: 'maxSyncExecutionMs', env: 'HAMMURABI_MAX_SYNC_EXECUTION_MS', def: 10_000, min: 100 },
  { key: 'maxAsyncTurnMs', env: 'HAMMURABI_MAX_ASYNC_TURN_MS', def: 60_000, min: 1_000 },
  { key: 'maxHostCallArgBytes', env: 'HAMMURABI_MAX_HOST_CALL_ARG_BYTES', def: 16 * MB, min: 1 * KB },
  { key: 'maxInflightHostCalls', env: 'HAMMURABI_MAX_INFLIGHT_HOST_CALLS', def: 40, min: 1 },
  { key: 'maxCoercedBytes', env: 'HAMMURABI_MAX_COERCED_BYTES', def: 16 * MB, min: 1 * KB },
  { key: 'maxOpenSockets', env: 'HAMMURABI_MAX_OPEN_SOCKETS', def: 32, min: 1 },
  { key: 'maxWsPendingDispatch', env: 'HAMMURABI_MAX_WS_PENDING_DISPATCH', def: 256, min: 1 },

  // Scene / CRDT
  // maxLiveEntities must stay above the reserved entity id range (MAX_RESERVED_ENTITY = 512).
  { key: 'maxLiveEntities', env: 'HAMMURABI_MAX_LIVE_ENTITIES', def: 100_000, min: 512 },
  { key: 'maxDeletedTombstones', env: 'HAMMURABI_MAX_DELETED_TOMBSTONES', def: 100_000, min: 1 },
  { key: 'maxCrdtPayloadBytes', env: 'HAMMURABI_MAX_CRDT_PAYLOAD_BYTES', def: 8 * MB, min: 1 * KB },
  { key: 'maxIncomingQueue', env: 'HAMMURABI_MAX_INCOMING_QUEUE', def: 1_024, min: 1 },
  { key: 'maxNetworkMessageQueue', env: 'HAMMURABI_MAX_NETWORK_MESSAGE_QUEUE', def: 1_024, min: 1 },
  { key: 'maxEchoDedupeEntries', env: 'HAMMURABI_MAX_ECHO_DEDUPE_ENTRIES', def: 8_192, min: 1 },

  // Inbound comms
  { key: 'maxInboundPacketBytes', env: 'HAMMURABI_MAX_INBOUND_PACKET_BYTES', def: 128 * KB, min: 1 },
  { key: 'inboundRateWindowMs', env: 'HAMMURABI_INBOUND_RATE_WINDOW_MS', def: 1_000, min: 1 },
  { key: 'maxMessagesPerWindow', env: 'HAMMURABI_MAX_MESSAGES_PER_WINDOW', def: 300, min: 1 },
  { key: 'maxRateEntries', env: 'HAMMURABI_MAX_RATE_ENTRIES', def: 4_096, min: 1 },
  { key: 'maxAvatarTombstones', env: 'HAMMURABI_MAX_AVATAR_TOMBSTONES', def: 4_096, min: 1 },
  { key: 'maxDepartedPeers', env: 'HAMMURABI_MAX_DEPARTED_PEERS', def: 1_024, min: 1 },
  // Connect bookkeeping runs before avatar allocation, so one extra record is
  // required when all remote-player slots are occupied.
  {
    key: 'maxTrackedPeerSessions',
    env: 'HAMMURABI_MAX_TRACKED_PEER_SESSIONS',
    def: 1_024,
    min: REMOTE_PLAYER_ENTITY_CAPACITY + 1
  },
  { key: 'maxSessionsPerPeer', env: 'HAMMURABI_MAX_SESSIONS_PER_PEER', def: 8, min: 1 },
  { key: 'profileFetchCooldownMs', env: 'HAMMURABI_PROFILE_FETCH_COOLDOWN_MS', def: 10_000, min: 0 },
  { key: 'livekitConnectTimeoutMs', env: 'HAMMURABI_LIVEKIT_CONNECT_TIMEOUT_MS', def: 30_000, min: 1_000 },
  // Emote (playerEmote -> AvatarEmoteCommand). The urn is a peer-controlled string that
  // ends up in every scene's CRDT, the append log is drained per subscription, and the
  // metadata lookup is an outbound fetch keyed by that same peer-controlled urn.
  { key: 'maxEmoteUrnBytes', env: 'HAMMURABI_MAX_EMOTE_URN_BYTES', def: 256, min: 1 },
  { key: 'maxEmoteAppendLog', env: 'HAMMURABI_MAX_EMOTE_APPEND_LOG', def: 256, min: 1 },
  // Bounds the resolved-urn cache AND, deliberately, the per-peer cooldown map beside it:
  // both are keyed by peer-supplied data and neither needs a ceiling of its own (1024 is
  // already far above the 224 avatar slots a peer needs to reach either).
  {
    key: 'maxEmoteMetadataCacheEntries',
    env: 'HAMMURABI_MAX_EMOTE_METADATA_CACHE_ENTRIES',
    def: 1_024,
    min: 1
  },
  // The two metadata-lookup brakes bound DIFFERENT things and neither substitutes for the
  // other. Sustained rate is min(peers_with_avatar_slots ÷ cooldown, ceiling ÷ latency);
  // under defaults the first term binds at ~224/s, because a lookup requires an allocated
  // avatar slot. The ceiling's job is CONCURRENCY (in-flight entries and sockets, so a slow
  // registry cannot accumulate thousands); it bounds rate only weakly and latency-
  // dependently, and raising it multiplies that term directly — 16 -> 32 measured 3.1k ->
  // 6.3k req/s against a 5ms registry with the cooldown disabled. Setting the cooldown to 0
  // therefore leaves only that weak bound, and unlike profileFetchCooldownMs nothing sits
  // behind it (no attemptedVersion-style dedupe), so 0 removes the only rate control.
  { key: 'maxEmoteMetadataInflight', env: 'HAMMURABI_MAX_EMOTE_METADATA_INFLIGHT', def: 32, min: 1 },
  // Callers allowed to wait on ONE in-flight lookup. The ceiling above counts lookups, so
  // without this a peer repeating an emote at its full packet rate stacks continuations for
  // as long as that lookup takes, which is rate x deadline rather than any cap.
  { key: 'maxEmoteMetadataWaiters', env: 'HAMMURABI_MAX_EMOTE_METADATA_WAITERS', def: 64, min: 1 },
  {
    key: 'emoteMetadataFetchCooldownMs',
    env: 'HAMMURABI_EMOTE_METADATA_FETCH_COOLDOWN_MS',
    def: 1_000,
    min: 0
  },
  // Deadline for a whole lookup, body read included — robustFetch's timeout only covers
  // getting the response, so without this a stalled body holds an in-flight slot for good.
  {
    key: 'emoteMetadataLookupTimeoutMs',
    env: 'HAMMURABI_EMOTE_METADATA_LOOKUP_TIMEOUT_MS',
    def: 30_000,
    min: 1_000
  },

  // Scene RPC
  { key: 'maxSendPeers', env: 'HAMMURABI_MAX_SEND_PEERS', def: 256, min: 1 },
  { key: 'maxSendMessages', env: 'HAMMURABI_MAX_SEND_MESSAGES', def: 512, min: 1 },
  { key: 'maxCommsMessageBytes', env: 'HAMMURABI_MAX_COMMS_MESSAGE_BYTES', def: 30_000, min: 1 },
  { key: 'maxSignedFetchRedirects', env: 'HAMMURABI_MAX_SIGNED_FETCH_REDIRECTS', def: 5, min: 0 },

  // Fetch / network / assets / WS
  { key: 'fetchTimeoutMs', env: 'HAMMURABI_FETCH_TIMEOUT_MS', def: 15_000, min: 100 },
  { key: 'fetchRetries', env: 'HAMMURABI_FETCH_RETRIES', def: 2, min: 1 },
  { key: 'maxBodyBytes', env: 'HAMMURABI_MAX_BODY_BYTES', def: 10 * MB, min: 1 * KB },
  { key: 'maxAssetBytes', env: 'HAMMURABI_MAX_ASSET_BYTES', def: 64 * MB, min: 1 * KB },
  { key: 'maxXhrResponseBytes', env: 'HAMMURABI_MAX_XHR_RESPONSE_BYTES', def: 64 * MB, min: 1 * KB },
  { key: 'maxFetchRedirects', env: 'HAMMURABI_MAX_FETCH_REDIRECTS', def: 5, min: 0 },
  { key: 'maxConcurrentFetches', env: 'HAMMURABI_MAX_CONCURRENT_FETCHES', def: 32, min: 1 },
  { key: 'maxWsMessageBytes', env: 'HAMMURABI_MAX_WS_MESSAGE_BYTES', def: 1 * MB, min: 1 },
  { key: 'maxWsBufferedBytes', env: 'HAMMURABI_MAX_WS_BUFFERED_BYTES', def: 8 * MB, min: 1 },
  { key: 'wsHandshakeTimeoutMs', env: 'HAMMURABI_WS_HANDSHAKE_TIMEOUT_MS', def: 15_000, min: 100 },

  // Scene primitives. A CylinderMesh's radiusTop/radiusBottom are untrusted protobuf
  // floats that reach MeshBuilder directly, and the protocol states no maximum — so this
  // is a sanity ceiling, not a protocol rule. 4096m is orders of magnitude past any
  // legitimate primitive (they are unit-sized and scaled by the entity Transform, and a
  // parcel is 16m), while still keeping vertex coordinates far inside float range; without
  // it a scene builds a collider hittable from a million metres away, which no other
  // client agrees with.
  { key: 'maxPrimitiveRadiusMeters', env: 'HAMMURABI_MAX_PRIMITIVE_RADIUS_METERS', def: 4_096, min: 1 },

  // Render loop / scheduling / shutdown
  { key: 'minFrameTimeMs', env: 'HAMMURABI_MIN_FRAME_TIME_MS', def: 24, min: 1 },
  { key: 'msPerFrameProcessingSceneMessages', env: 'HAMMURABI_MS_PER_FRAME_PROCESSING_SCENE_MESSAGES', def: 10, min: 1 },
  { key: 'shutdownHookTimeoutMs', env: 'HAMMURABI_SHUTDOWN_HOOK_TIMEOUT_MS', def: 2_000, min: 0 },
  { key: 'shutdownDrainMs', env: 'HAMMURABI_SHUTDOWN_DRAIN_MS', def: 1_500, min: 0 },

  // Raycasting
  { key: 'maxRaycastIntersectionsPerFrame', env: 'HAMMURABI_MAX_RAYCAST_INTERSECTIONS_PER_FRAME', def: 50_000, min: 1 },
  // Triangle-denominated companion to the mesh ceiling above; both are charged and
  // the first to run out ends the frame. 600_000 is the mesh budget's own measured
  // cost against the shape it was tuned for (50_000 box colliders x 12 triangles
  // ~ 100ms/frame), so a box-only scene behaves exactly as before and only the
  // shapes that are orders of magnitude heavier per mesh are newly bounded.
  { key: 'maxRaycastTrianglesPerFrame', env: 'HAMMURABI_MAX_RAYCAST_TRIANGLES_PER_FRAME', def: 600_000, min: 1 },
  // RQT_QUERY_ALL returns EVERY mesh the ray crosses, one full RaycastHit each
  // (normal, origin, direction, position, length, meshName, entityId). The mesh
  // ceiling bounds how many are TESTED, not how many come back: measured, 300
  // colliders on one ray produced 304 hits in a single result, and that whole
  // list is serialized into the scene's CRDT stream every frame a continuous
  // raycast runs. Truncated NEAREST-first, so what a scene actually reaches for
  // survives the cut.
  { key: 'maxRaycastHitsPerQuery', env: 'HAMMURABI_MAX_RAYCAST_HITS_PER_QUERY', def: 256, min: 1 },
  // Depth ceiling for the collider-subtree walk. Babylon's own `_getDescendants`
  // is recursive and overflows the JS stack between depth 5000 and 6000, while a
  // scene may hold 100_000 entities and chains them to any depth it likes via
  // Transform.parent. The walk here is iterative so the stack cannot overflow at
  // all; this bounds the WORK instead, and sits far above any plausible scene
  // hierarchy.
  { key: 'maxColliderTreeDepth', env: 'HAMMURABI_MAX_COLLIDER_TREE_DEPTH', def: 1_024, min: 1 }
]

const logger = createLogger('⚙️ Limits')

/**
 * Read the {@link Limits} from an environment map (defaults to `process.env`).
 * Exported for testing; production code should import the {@link limits} singleton.
 */
export function readLimits(env: NodeJS.ProcessEnv = process.env): Limits {
  const warnings: string[] = []
  const result = {} as Limits

  for (const knob of KNOBS) {
    let value = knob.def
    const raw = env[knob.env]
    if (raw !== undefined && raw.trim() !== '') {
      const parsed = Number(raw)
      const scaled = knob.mb ? parsed * MB : parsed
      if (!Number.isInteger(parsed) || scaled < knob.min) {
        const minLabel = knob.mb ? `${knob.min / MB}MB` : String(knob.min)
        warnings.push(`${knob.env}="${raw}" is not a valid integer >= ${minLabel}; keeping default`)
      } else {
        value = scaled
      }
    }
    result[knob.key] = value
  }

  if (warnings.length > 0) {
    logger.error(`Ignoring invalid limit override(s):\n  ${warnings.join('\n  ')}`)
  }

  return result
}

/** Process-wide limits, read once from `process.env` at first import. */
export const limits: Limits = readLimits()
