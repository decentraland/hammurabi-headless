import { limits } from '../../misc/limits'
import { limitLogger } from '../../misc/limit-logger'

/**
 * Topic-based pub/sub for `~system/CommsApi` (subscribeToTopic / publishData /
 * consumeMessages).
 *
 * Payloads ride the same rfc4 `Scene` packet as the SDK MessageBus, tagged with
 * `MsgType.CommsData` and framed as:
 *
 *     [topicLen 2 bytes LE][topic UTF-8][data UTF-8]
 *
 * This framing is fixed by the reference client (`CommsApiWrap.PublishData` /
 * `OnDataReceived`) — a scene publishing here must be readable by a real client
 * and vice versa, so the layout and the little-endian length prefix are NOT
 * ours to change.
 *
 * Both directions are untrusted: the topic and data on a publish come from
 * scene code, and an inbound frame comes from a remote peer. Every bound below
 * is load-bearing rather than defensive tidiness.
 */

const TOPIC_LENGTH_PREFIX_BYTES = 2

const textEncoder = new TextEncoder()
// `fatal: false` (the default): a peer can send bytes that are not valid UTF-8,
// and replacement characters are a better outcome than a throw inside the
// transport dispatch.
const textDecoder = new TextDecoder()

export type TopicMessage = {
  sender: string
  data: string
}

export type CommsTopicRegistry = {
  subscribe(topic: string): void
  unsubscribe(topic: string): void
  /** Drains and returns everything buffered for `topic`. */
  consume(topic: string): TopicMessage[]
  /**
   * Frames a scene publish, or returns null when it must be dropped (empty
   * data, oversized topic, oversized frame, or the per-topic rate limit).
   * Dropping silently matches the reference client, which documents publish as
   * best-effort.
   */
  encodePublish(topic: string, data: string): Uint8Array | null
  /** Routes one decoded inbound CommsData frame into its topic buffer. */
  ingest(sender: string, payload: Uint8Array): void
  /** Number of live subscriptions — exposed for assertions and diagnostics. */
  readonly subscriptionCount: number
}

export function createCommsTopicRegistry(): CommsTopicRegistry {
  const MAX_TOPIC_BYTES = limits.maxCommsTopicBytes
  const MAX_SUBSCRIPTIONS = limits.maxCommsTopicSubscriptions
  const MAX_BUFFERED = limits.maxCommsTopicBufferMessages
  const PUBLISH_WINDOW_MS = limits.commsTopicPublishWindowMs
  const MAX_PUBLISHES_PER_WINDOW = limits.maxCommsTopicPublishesPerWindow

  const topicBuffers = new Map<string, TopicMessage[]>()
  const publishRate = new Map<string, { windowStart: number; count: number }>()

  function topicByteLength(topic: string): number {
    // Byte length, not `topic.length`: the cap the reference client enforces is
    // in UTF-8 bytes, and a multi-byte topic would otherwise frame a length the
    // receiver reads past.
    return textEncoder.encode(topic).byteLength
  }

  // Fixed-window per-topic publish limit, mirroring the reference client's
  // 10/second. The map is keyed by a scene-controlled string, so it is capped
  // and evicts oldest-first (same shape as CommsTransportWrapper.inboundRate) —
  // otherwise publishing to unique topics in a loop grows it without bound.
  function tryConsumePublishBudget(topic: string): boolean {
    const now = Date.now()
    const entry = publishRate.get(topic)

    if (!entry || now - entry.windowStart >= PUBLISH_WINDOW_MS) {
      if (!entry && publishRate.size >= MAX_SUBSCRIPTIONS) {
        const oldest = publishRate.keys().next().value
        if (oldest !== undefined) publishRate.delete(oldest)
      }
      publishRate.set(topic, { windowStart: now, count: 1 })
      return true
    }

    if (entry.count >= MAX_PUBLISHES_PER_WINDOW) return false

    entry.count++
    return true
  }

  return {
    get subscriptionCount() {
      return topicBuffers.size
    },

    subscribe(topic: string) {
      if (topicBuffers.has(topic)) return

      if (topicByteLength(topic) > MAX_TOPIC_BYTES) {
        limitLogger.hit('maxCommsTopicBytes', `subscribe topic of ${topicByteLength(topic)} bytes`)
        return
      }

      if (topicBuffers.size >= MAX_SUBSCRIPTIONS) {
        limitLogger.hit('maxCommsTopicSubscriptions', `${topicBuffers.size} topics already subscribed`)
        return
      }

      topicBuffers.set(topic, [])
    },

    unsubscribe(topic: string) {
      topicBuffers.delete(topic)
    },

    consume(topic: string): TopicMessage[] {
      const buffer = topicBuffers.get(topic)
      if (!buffer || buffer.length === 0) return []
      // Hand the array over and start a fresh one rather than copying+clearing
      // (same pattern as SceneContext.getNetworkMessages).
      topicBuffers.set(topic, [])
      return buffer
    },

    encodePublish(topic: string, data: string): Uint8Array | null {
      if (!data) return null

      if (!tryConsumePublishBudget(topic)) {
        limitLogger.hit('maxCommsTopicPublishesPerWindow', `topic ${topic.slice(0, 64)}`)
        return null
      }

      const topicBytes = textEncoder.encode(topic)
      if (topicBytes.byteLength > MAX_TOPIC_BYTES) {
        limitLogger.hit('maxCommsTopicBytes', `publish topic of ${topicBytes.byteLength} bytes`)
        return null
      }

      const dataBytes = textEncoder.encode(data)
      const frame = new Uint8Array(TOPIC_LENGTH_PREFIX_BYTES + topicBytes.byteLength + dataBytes.byteLength)

      // Little-endian u16, matching BinaryPrimitives.WriteUInt16LittleEndian.
      frame[0] = topicBytes.byteLength & 0xff
      frame[1] = (topicBytes.byteLength >> 8) & 0xff
      frame.set(topicBytes, TOPIC_LENGTH_PREFIX_BYTES)
      frame.set(dataBytes, TOPIC_LENGTH_PREFIX_BYTES + topicBytes.byteLength)

      // The per-message size cap is applied by the caller against the framed
      // payload, since it also has to account for the MsgType byte the scene
      // packet adds.
      return frame
    },

    ingest(sender: string, payload: Uint8Array) {
      if (payload.byteLength < TOPIC_LENGTH_PREFIX_BYTES) return

      const topicLength = payload[0] | (payload[1] << 8)
      if (payload.byteLength < TOPIC_LENGTH_PREFIX_BYTES + topicLength) return

      const topic = textDecoder.decode(payload.subarray(TOPIC_LENGTH_PREFIX_BYTES, TOPIC_LENGTH_PREFIX_BYTES + topicLength))

      // Only subscribed topics are buffered. This is what bounds inbound memory:
      // a peer cannot make the host allocate a buffer for a topic the scene
      // never asked for.
      const buffer = topicBuffers.get(topic)
      if (!buffer) return

      // Drop-oldest, matching the reference client's documented policy: a scene
      // that stops polling must not let peers grow the buffer without limit.
      if (buffer.length >= MAX_BUFFERED) {
        buffer.shift()
        limitLogger.hit('maxCommsTopicBufferMessages', `topic ${topic.slice(0, 64)}`)
      }

      buffer.push({
        sender,
        data: textDecoder.decode(payload.subarray(TOPIC_LENGTH_PREFIX_BYTES + topicLength))
      })
    }
  }
}
