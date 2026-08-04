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
 *
 * **Outbound.** Validation runs strictly BEFORE anything keyed by the
 * scene-controlled topic and before the frame is allocated — see `encodePublish`.
 * There are two publish budgets and they bound different things:
 *
 *  - the PER-TOPIC one mirrors the reference client's 10/second, and on its own
 *    bounds nothing global. Its map is keyed by a scene-chosen string, so 5000
 *    publishes to 5000 distinct topics in one window all pass it, and when that map
 *    is full the oldest counter is EVICTED, which hands a throttled topic a fresh
 *    budget inside the same window. It is parity + per-topic fairness, not a
 *    ceiling on publishing.
 *  - the AGGREGATE one is a single counter that no scene-controlled key can evict.
 *    It is what actually bounds scene -> LiveKit publish volume, and it is why the
 *    two eviction/uniqueness holes above are acceptable rather than fixed in place
 *    (a per-topic map without eviction is itself unbounded growth).
 *
 * **Inbound.** Only SUBSCRIBED topics allocate a buffer — a peer cannot make the
 * host allocate for a topic the scene never asked for — and each buffer is bounded
 * in MESSAGES and, because a message count is not a memory bound, in BYTES: per
 * topic and in aggregate across topics, released again as the scene consumes.
 */

const TOPIC_LENGTH_PREFIX_BYTES = 2

/**
 * Hard ceiling on a topic, independent of `maxCommsTopicBytes`. The frame
 * describes the topic with a u16, so a longer one cannot be expressed: the
 * length wraps (mod 65536) and the receiver reads a short topic and treats the
 * remainder of the topic AS DATA. Measured with the knob raised to 70000 and a
 * 66000-byte topic: the frame declared 464 and 65536 bytes of topic arrived as
 * payload. The knob is operator-supplied and has no maximum, so the check cannot
 * live in the knob — silent corruption is a far worse outcome than a drop.
 */
const MAX_FRAMED_TOPIC_BYTES = 0xffff

/**
 * The `MsgType` byte `encodeMessage` (scene-context) prepends to this frame before
 * it goes on the wire. Counted here so the per-message ceiling can be applied
 * BEFORE the frame is allocated rather than after the caller has built and copied
 * it. Duplicated rather than imported because scene-context imports this module.
 */
const SCENE_PACKET_TYPE_BYTES = 1

/**
 * Peer-address ceiling, matching the MessageBus branch in scene-context: there the
 * sender length is framed in a single byte, so a longer address is dropped. It is a
 * wire constant rather than a tunable, and the two paths take the same peer-supplied
 * `address` off the same event — letting an unbounded one through here (it is
 * retained per buffered message) while the branch beside it drops it is the kind of
 * inconsistency that turns into "which path was hardened again?".
 */
const MAX_SENDER_BYTES = 255

const textEncoder = new TextEncoder()
// `fatal: false` (the default): a peer can send bytes that are not valid UTF-8,
// and replacement characters are a better outcome than a throw inside the
// transport dispatch.
const textDecoder = new TextDecoder()

export type TopicMessage = {
  sender: string
  data: string
}

export type CommsTopicRegistryOptions = {
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number
}

export type CommsTopicRegistry = {
  subscribe(topic: string): void
  unsubscribe(topic: string): void
  /** Drains and returns everything buffered for `topic`. */
  consume(topic: string): TopicMessage[]
  /**
   * Frames a scene publish, or returns null when it must be dropped (empty topic
   * or data, oversized topic, oversized message, or either publish budget).
   * Dropping silently matches the reference client, which documents publish as
   * best-effort.
   */
  encodePublish(topic: string, data: string): Uint8Array | null
  /** Routes one decoded inbound CommsData frame into its topic buffer. */
  ingest(sender: string, payload: Uint8Array): void
  /** Number of live subscriptions — exposed for assertions and diagnostics. */
  readonly subscriptionCount: number
  /**
   * Entries held by the per-topic publish-rate map — exposed so a test can assert
   * that a rejected publish never created one (the map is keyed by a
   * scene-controlled string, so an entry IS retained memory).
   */
  readonly publishRateEntryCount: number
  /** Bytes buffered across every topic — exposed for assertions and diagnostics. */
  readonly bufferedByteCount: number
}

type TopicBuffer = {
  messages: TopicMessage[]
  /** Byte cost of `messages[i]`, kept in step so eviction and consume undo it exactly. */
  costs: number[]
  bytes: number
}

type RateWindow = { windowStart: number; count: number }

export function createCommsTopicRegistry(options: CommsTopicRegistryOptions = {}): CommsTopicRegistry {
  const now = options.now ?? Date.now

  const MAX_TOPIC_BYTES = limits.maxCommsTopicBytes
  const MAX_SUBSCRIPTIONS = limits.maxCommsTopicSubscriptions
  const MAX_BUFFERED = limits.maxCommsTopicBufferMessages
  const MAX_BUFFER_BYTES = limits.maxCommsTopicBufferBytes
  const MAX_TOTAL_BUFFER_BYTES = limits.maxCommsTopicBufferTotalBytes
  const RATE_WINDOW_MS = limits.commsTopicRateWindowMs
  const MAX_PUBLISHES_PER_WINDOW = limits.maxCommsTopicPublishesPerWindow
  const MAX_TOTAL_PUBLISHES_PER_WINDOW = limits.maxCommsTopicPublishesTotalPerWindow
  const MAX_SUBSCRIBES_PER_WINDOW = limits.maxCommsTopicSubscribesPerWindow
  const MAX_MESSAGE_BYTES = limits.maxCommsMessageBytes

  const topicBuffers = new Map<string, TopicBuffer>()
  const publishRate = new Map<string, RateWindow>()
  const totalPublishRate: RateWindow = { windowStart: 0, count: 0 }
  const subscribeRate: RateWindow = { windowStart: 0, count: 0 }
  let totalBufferedBytes = 0

  /** Fixed-window counter shared by the three topic budgets. */
  function tryConsumeWindow(window: RateWindow, max: number): boolean {
    const t = now()
    const elapsed = t - window.windowStart

    // `elapsed < 0` is a clock that stepped BACKWARDS (NTP). Without it the window
    // start sits in the future and the counter never rolls over, so a topic that
    // happened to be throttled at that moment stays throttled until real time
    // catches up — potentially for the life of the scene.
    if (elapsed < 0 || elapsed >= RATE_WINDOW_MS) {
      window.windowStart = t
      window.count = 1
      return true
    }

    if (window.count >= max) return false

    window.count++
    return true
  }

  // Per-topic budget. The map is keyed by a scene-controlled string, so it is
  // capped and evicts oldest-first (same shape as CommsTransportWrapper.inboundRate)
  // — otherwise publishing to unique topics in a loop grows it without bound. See
  // the module header for what this budget does and does not bound.
  function tryConsumePublishBudget(topic: string): boolean {
    const entry = publishRate.get(topic)

    if (entry) return tryConsumeWindow(entry, MAX_PUBLISHES_PER_WINDOW)

    if (publishRate.size >= MAX_SUBSCRIPTIONS) {
      const oldest = publishRate.keys().next().value
      if (oldest !== undefined) publishRate.delete(oldest)
      limitLogger.hit('maxCommsTopicSubscriptions', `${publishRate.size} rate-limited topics`)
    }

    publishRate.set(topic, { windowStart: now(), count: 1 })
    return true
  }

  /**
   * UTF-8 byte length of `topic`, or -1 when it may not be used at all.
   *
   * `Buffer.byteLength` rather than `textEncoder.encode(topic).byteLength`: the
   * latter ALLOCATES the encoded copy just to read its length, on a string the
   * scene controls the size of, on a path whose whole job is to reject oversized
   * ones. Callers keep the result — encoding the topic twice (once to measure,
   * once to log or frame) is the same waste one call later.
   */
  function validatedTopicBytes(topic: string, what: 'subscribe' | 'publish'): number {
    // An empty topic addresses nothing. Refusing it here is what lets `ingest`
    // reject a zero-length topic frame outright.
    if (!topic) return -1

    const topicBytes = Buffer.byteLength(topic, 'utf8')

    if (topicBytes > MAX_TOPIC_BYTES) {
      limitLogger.hit('maxCommsTopicBytes', `${what} topic of ${topicBytes} bytes`)
      return -1
    }

    // Only reachable when an operator raises the knob past 65535; see
    // MAX_FRAMED_TOPIC_BYTES.
    if (topicBytes > MAX_FRAMED_TOPIC_BYTES) {
      limitLogger.hit('maxCommsTopicBytes', `${what} topic of ${topicBytes} bytes exceeds the u16 length prefix`)
      return -1
    }

    return topicBytes
  }

  function evictOldest(buffer: TopicBuffer): void {
    buffer.messages.shift()
    const cost = buffer.costs.shift() ?? 0
    buffer.bytes -= cost
    totalBufferedBytes -= cost
  }

  return {
    get subscriptionCount() {
      return topicBuffers.size
    },

    get publishRateEntryCount() {
      return publishRate.size
    },

    get bufferedByteCount() {
      return totalBufferedBytes
    },

    subscribe(topic: string) {
      if (topicBuffers.has(topic)) return

      if (validatedTopicBytes(topic, 'subscribe') < 0) return

      if (topicBuffers.size >= MAX_SUBSCRIPTIONS) {
        limitLogger.hit('maxCommsTopicSubscriptions', `${topicBuffers.size} topics already subscribed`)
        return
      }

      // The subscription count bounds how many buffers live at once, not how fast a
      // scene can create and destroy them, so the churn gets a budget of its own.
      if (!tryConsumeWindow(subscribeRate, MAX_SUBSCRIBES_PER_WINDOW)) {
        limitLogger.hit('maxCommsTopicSubscribesPerWindow', `topic ${topic.slice(0, 64)}`)
        return
      }

      topicBuffers.set(topic, { messages: [], costs: [], bytes: 0 })
    },

    unsubscribe(topic: string) {
      const buffer = topicBuffers.get(topic)
      if (!buffer) return

      // Give the bytes back: dropping the buffer without this would leak the
      // aggregate budget until the process restarted.
      totalBufferedBytes -= buffer.bytes
      topicBuffers.delete(topic)
    },

    consume(topic: string): TopicMessage[] {
      const buffer = topicBuffers.get(topic)
      if (!buffer || buffer.messages.length === 0) return []

      // Hand the array over and start a fresh one rather than copying+clearing
      // (same pattern as SceneContext.getNetworkMessages).
      const messages = buffer.messages
      // Release the byte budget as the messages leave, or the caps would be
      // one-shot ceilings that a well-behaved, polling scene still trips.
      totalBufferedBytes -= buffer.bytes
      buffer.messages = []
      buffer.costs = []
      buffer.bytes = 0
      return messages
    },

    encodePublish(topic: string, data: string): Uint8Array | null {
      if (!data) return null

      // Size checks come FIRST, before anything keyed by the scene-controlled
      // topic: tryConsumePublishBudget does publishRate.set(topic, ...), so
      // validating afterwards meant a topic the cap was about to reject was already
      // a live map key. Measured: 8 rejected publishes with 4MB topics retained
      // 33.6MB, and the map's own ceiling made the worst case
      // maxCommsTopicSubscriptions x maxHostCallArgBytes (256 x 16MB ~ 4GB).
      const topicBytes = validatedTopicBytes(topic, 'publish')
      if (topicBytes < 0) return null

      // Reject on the FRAMED size before allocating anything. The caller applies
      // the same ceiling, but by then the frame exists and encodeMessage has copied
      // it: a 16MB publish measured a 16,777,219-byte frame plus a ~16.8MB copy,
      // both discarded. The reference client checks the total length first too.
      const dataBytes = Buffer.byteLength(data, 'utf8')
      const messageBytes = SCENE_PACKET_TYPE_BYTES + TOPIC_LENGTH_PREFIX_BYTES + topicBytes + dataBytes
      if (messageBytes > MAX_MESSAGE_BYTES) {
        limitLogger.hit('maxCommsMessageBytes', `${messageBytes} bytes on a comms topic`)
        return null
      }

      // Aggregate budget before the per-topic one: it is the cheaper check and it
      // keeps a scene-controlled map untouched while a flood is being rejected.
      if (!tryConsumeWindow(totalPublishRate, MAX_TOTAL_PUBLISHES_PER_WINDOW)) {
        limitLogger.hit('maxCommsTopicPublishesTotalPerWindow', `topic ${topic.slice(0, 64)}`)
        return null
      }

      if (!tryConsumePublishBudget(topic)) {
        limitLogger.hit('maxCommsTopicPublishesPerWindow', `topic ${topic.slice(0, 64)}`)
        return null
      }

      const frame = new Uint8Array(TOPIC_LENGTH_PREFIX_BYTES + topicBytes + dataBytes)

      // Little-endian u16, matching BinaryPrimitives.WriteUInt16LittleEndian.
      frame[0] = topicBytes & 0xff
      frame[1] = (topicBytes >> 8) & 0xff
      // encodeInto writes UTF-8 straight into the frame: one allocation for the
      // whole message instead of one per part plus the frame.
      textEncoder.encodeInto(topic, frame.subarray(TOPIC_LENGTH_PREFIX_BYTES))
      textEncoder.encodeInto(data, frame.subarray(TOPIC_LENGTH_PREFIX_BYTES + topicBytes))

      return frame
    },

    ingest(sender: string, payload: Uint8Array) {
      if (payload.byteLength < TOPIC_LENGTH_PREFIX_BYTES) return

      const topicLength = payload[0] | (payload[1] << 8)
      // A zero-length topic can never match a subscription (subscribe refuses the
      // empty string), so drop it before decoding anything.
      if (topicLength === 0) return
      if (payload.byteLength < TOPIC_LENGTH_PREFIX_BYTES + topicLength) return

      const topic = textDecoder.decode(payload.subarray(TOPIC_LENGTH_PREFIX_BYTES, TOPIC_LENGTH_PREFIX_BYTES + topicLength))

      // Only subscribed topics are buffered. This is what bounds inbound memory:
      // a peer cannot make the host allocate a buffer for a topic the scene
      // never asked for.
      const buffer = topicBuffers.get(topic)
      if (!buffer) return

      const senderBytes = Buffer.byteLength(sender, 'utf8')
      if (senderBytes > MAX_SENDER_BYTES) return

      // Wire cost of what this message retains. The decoded strings are UTF-16 in
      // the heap, so the real footprint is within a constant factor of this — the
      // point is that it is a factor and not "however many messages fit".
      const cost = senderBytes + (payload.byteLength - TOPIC_LENGTH_PREFIX_BYTES - topicLength)

      // A single message that cannot fit either budget is dropped rather than
      // emptying the buffer for nothing.
      if (cost > MAX_BUFFER_BYTES || cost > MAX_TOTAL_BUFFER_BYTES) {
        limitLogger.hit('maxCommsTopicBufferBytes', `${cost} bytes on topic ${topic.slice(0, 64)}`)
        return
      }

      const overTopicBytes = buffer.bytes + cost > MAX_BUFFER_BYTES
      const overTotalBytes = totalBufferedBytes + cost > MAX_TOTAL_BUFFER_BYTES
      if (overTopicBytes || overTotalBytes) {
        limitLogger.hit(
          overTopicBytes ? 'maxCommsTopicBufferBytes' : 'maxCommsTopicBufferTotalBytes',
          `topic ${topic.slice(0, 64)}`
        )
        // Drop-oldest until the newcomer fits, same policy as the message count.
        while (
          buffer.messages.length > 0 &&
          (buffer.bytes + cost > MAX_BUFFER_BYTES || totalBufferedBytes + cost > MAX_TOTAL_BUFFER_BYTES)
        ) {
          evictOldest(buffer)
        }

        // Its own buffer is empty and the aggregate is still full, i.e. OTHER topics
        // hold it. Deliberately not evicting from them: a peer publishing on topic A
        // would otherwise flush topic B's messages, and a scene that consumes at all
        // releases the budget. Memory stays bounded either way; this only picks who
        // loses messages.
        if (totalBufferedBytes + cost > MAX_TOTAL_BUFFER_BYTES) {
          limitLogger.hit('maxCommsTopicBufferTotalBytes', `topic ${topic.slice(0, 64)} starved by other topics`)
          return
        }
      }

      // Drop-oldest, matching the reference client's documented policy: a scene
      // that stops polling must not let peers grow the buffer without limit.
      if (buffer.messages.length >= MAX_BUFFERED) {
        evictOldest(buffer)
        limitLogger.hit('maxCommsTopicBufferMessages', `topic ${topic.slice(0, 64)}`)
      }

      buffer.messages.push({
        sender,
        data: textDecoder.decode(payload.subarray(TOPIC_LENGTH_PREFIX_BYTES + topicLength))
      })
      buffer.costs.push(cost)
      buffer.bytes += cost
      totalBufferedBytes += cost
    }
  }
}
