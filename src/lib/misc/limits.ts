import { createLogger } from './logger'

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
 * `_MB` = megabytes, otherwise a plain count. Spec-compliance validators (WebSocket
 * close codes, redirect method rewrites) are deliberately NOT configurable — only
 * resource/DoS caps and timeouts are.
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
  profileFetchCooldownMs: number
  livekitConnectTimeoutMs: number

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

  // --- Render loop / scheduling / shutdown ---
  minFrameTimeMs: number
  maxSceneDtMs: number
  msPerFrameProcessingSceneMessages: number
  shutdownHookTimeoutMs: number
  shutdownDrainMs: number

  // --- Raycasting ---
  maxRaycastIntersectionsPerFrame: number
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
  { key: 'profileFetchCooldownMs', env: 'HAMMURABI_PROFILE_FETCH_COOLDOWN_MS', def: 10_000, min: 0 },
  { key: 'livekitConnectTimeoutMs', env: 'HAMMURABI_LIVEKIT_CONNECT_TIMEOUT_MS', def: 30_000, min: 1_000 },

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

  // Render loop / scheduling / shutdown
  { key: 'minFrameTimeMs', env: 'HAMMURABI_MIN_FRAME_TIME_MS', def: 24, min: 1 },
  { key: 'maxSceneDtMs', env: 'HAMMURABI_MAX_SCENE_DT_MS', def: 1_000, min: 100 },
  { key: 'msPerFrameProcessingSceneMessages', env: 'HAMMURABI_MS_PER_FRAME_PROCESSING_SCENE_MESSAGES', def: 10, min: 1 },
  { key: 'shutdownHookTimeoutMs', env: 'HAMMURABI_SHUTDOWN_HOOK_TIMEOUT_MS', def: 2_000, min: 0 },
  { key: 'shutdownDrainMs', env: 'HAMMURABI_SHUTDOWN_DRAIN_MS', def: 1_500, min: 0 },

  // Raycasting
  { key: 'maxRaycastIntersectionsPerFrame', env: 'HAMMURABI_MAX_RAYCAST_INTERSECTIONS_PER_FRAME', def: 50_000, min: 1 }
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
