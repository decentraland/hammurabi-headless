import {
  createCommsTopicRegistry,
  CommsTopicRegistry,
  TopicMessage
} from '../../../../src/lib/decentraland/communications/comms-api-topics'
import { limits } from '../../../../src/lib/misc/limits'

// The frame layout ([topicLen 2 bytes LE][topic UTF-8][data UTF-8]) is fixed by
// the reference client's CommsApiWrap, so these tests pin the bytes rather than
// just the round trip: a scene publishing here has to be readable by a real
// client and vice versa.
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function rawFrameOf(topicBytes: Uint8Array, dataBytes: Uint8Array, declaredTopicLength?: number): Uint8Array {
  const declared = declaredTopicLength ?? topicBytes.byteLength
  const frame = new Uint8Array(2 + topicBytes.byteLength + dataBytes.byteLength)
  frame[0] = declared & 0xff
  frame[1] = (declared >> 8) & 0xff
  frame.set(topicBytes, 2)
  frame.set(dataBytes, 2 + topicBytes.byteLength)
  return frame
}

function frameOf(topic: string, data: string): Uint8Array {
  return rawFrameOf(textEncoder.encode(topic), textEncoder.encode(data))
}

describe('comms api topic registry', () => {
  let registry: CommsTopicRegistry
  // Injectable clock: every rate budget here is a fixed window, and a test that
  // only ever runs inside ONE window cannot tell a working window from a counter
  // that never rolls over (i.e. a topic throttled for the life of the scene).
  let clock: number

  beforeEach(() => {
    clock = 1_700_000_000_000
    registry = createCommsTopicRegistry({ now: () => clock })
  })

  describe('when a scene subscribes to a topic and a peer publishes on it', () => {
    let received: TopicMessage[]

    beforeEach(() => {
      registry.subscribe('chat')
      registry.ingest('0xpeer', frameOf('chat', 'hello'))
      received = registry.consume('chat')
    })

    it('should hand the payload to the scene with its sender attached', () => {
      expect(received).toEqual([{ sender: '0xpeer', data: 'hello' }])
    })

    it('should drain the buffer so the same message is not delivered twice', () => {
      expect(registry.consume('chat')).toEqual([])
    })

    it('should release the bytes it was holding for the drained messages', () => {
      expect(registry.bufferedByteCount).toBe(0)
    })
  })

  describe('when a peer publishes on a topic the scene never subscribed to', () => {
    beforeEach(() => {
      registry.ingest('0xpeer', frameOf('unwatched', 'hello'))
    })

    // This is what bounds inbound memory: a peer must not be able to make the
    // host allocate a buffer for an arbitrary topic.
    it('should not buffer the message under that topic', () => {
      expect(registry.consume('unwatched')).toEqual([])
    })

    it('should not create a subscription as a side effect', () => {
      expect(registry.subscriptionCount).toBe(0)
    })
  })

  describe('when a scene unsubscribes from a topic that has buffered messages', () => {
    beforeEach(() => {
      registry.subscribe('chat')
      registry.ingest('0xpeer', frameOf('chat', 'hello'))
      registry.unsubscribe('chat')
    })

    it('should discard everything buffered for it', () => {
      expect(registry.consume('chat')).toEqual([])
    })

    it('should release the subscription slot', () => {
      expect(registry.subscriptionCount).toBe(0)
    })

    // Without this the aggregate byte budget would leak on every unsubscribe and
    // eventually refuse messages for topics that hold nothing.
    it('should give the buffered bytes back to the aggregate budget', () => {
      expect(registry.bufferedByteCount).toBe(0)
    })
  })

  describe('when a scene publishes to a topic', () => {
    let frame: Uint8Array | null

    beforeEach(() => {
      frame = registry.encodePublish('chat', 'hello')
    })

    it('should frame the topic length as a little-endian u16', () => {
      expect(Array.from(frame!.subarray(0, 2))).toEqual([4, 0])
    })

    it('should lay the topic and data out in the order the reference client reads them', () => {
      expect(textDecoder.decode(frame!.subarray(2))).toBe('chathello')
    })

    it('should produce a frame its own ingest can read back', () => {
      registry.subscribe('chat')
      registry.ingest('0xself', frame!)
      expect(registry.consume('chat')).toEqual([{ sender: '0xself', data: 'hello' }])
    })
  })

  describe('when a scene publishes to a topic containing multi-byte characters', () => {
    let frame: Uint8Array | null

    beforeEach(() => {
      // 'ñ' is 2 bytes in UTF-8, so a length taken from String.length would be
      // short by one and the receiver would read the topic past its end.
      frame = registry.encodePublish('añ', 'x')
    })

    it('should frame the topic length in bytes rather than code units', () => {
      expect(frame![0]).toBe(3)
    })

    it('should write the whole payload after the multi-byte topic', () => {
      expect(textDecoder.decode(frame!.subarray(2))).toBe('añx')
    })
  })

  describe('when a scene publishes an empty payload', () => {
    it('should drop it rather than framing an empty message', () => {
      expect(registry.encodePublish('chat', '')).toBeNull()
    })
  })

  describe('when a scene publishes with an empty topic', () => {
    it('should drop it rather than framing a topic no subscription can match', () => {
      expect(registry.encodePublish('', 'hello')).toBeNull()
    })
  })

  describe('when a scene subscribes to an empty topic', () => {
    beforeEach(() => {
      registry.subscribe('')
    })

    it('should refuse the subscription', () => {
      expect(registry.subscriptionCount).toBe(0)
    })
  })

  describe('when a scene publishes to an oversized topic', () => {
    let oversizedTopic: string

    beforeEach(() => {
      oversizedTopic = 'a'.repeat(limits.maxCommsTopicBytes + 1)
      registry.encodePublish(oversizedTopic, 'hello')
    })

    it('should drop the publish', () => {
      expect(registry.encodePublish(oversizedTopic, 'hello')).toBeNull()
    })

    // Order matters, not just the outcome: the publish budget does
    // publishRate.set(topic, ...), so validating size after it left a topic the cap
    // was about to reject sitting in the map as a live key. Eight rejected publishes
    // with 4MB topics retained 33.6MB that way.
    it('should not retain the rejected topic as a rate-limit entry', () => {
      expect(registry.publishRateEntryCount).toBe(0)
    })
  })

  describe('when a scene publishes a message larger than the per-message ceiling', () => {
    let frame: Uint8Array | null

    beforeEach(() => {
      frame = registry.encodePublish('chat', 'x'.repeat(limits.maxCommsMessageBytes))
    })

    // The ceiling counts the framing and the MsgType byte the caller prepends, so
    // it can reject BEFORE allocating the frame instead of after the caller has
    // built it and copied it again.
    it('should drop the publish before framing it', () => {
      expect(frame).toBeNull()
    })

    it('should not retain the topic as a rate-limit entry', () => {
      expect(registry.publishRateEntryCount).toBe(0)
    })
  })

  describe('when a scene subscribes to an oversized topic', () => {
    let oversizedTopic: string

    beforeEach(() => {
      oversizedTopic = 'a'.repeat(limits.maxCommsTopicBytes + 1)
      registry.subscribe(oversizedTopic)
    })

    it('should refuse the subscription', () => {
      expect(registry.subscriptionCount).toBe(0)
    })
  })

  describe('when a scene publishes to the same topic faster than the per-topic budget', () => {
    let results: Array<Uint8Array | null>

    beforeEach(() => {
      results = []
      for (let i = 0; i < limits.maxCommsTopicPublishesPerWindow + 3; i++) {
        results.push(registry.encodePublish('chat', `m${i}`))
      }
    })

    it('should allow exactly the budgeted number of publishes', () => {
      expect(results.filter(Boolean)).toHaveLength(limits.maxCommsTopicPublishesPerWindow)
    })

    it('should drop every publish past the budget', () => {
      expect(results[limits.maxCommsTopicPublishesPerWindow]).toBeNull()
    })

    describe('and the rate window elapses', () => {
      beforeEach(() => {
        clock += limits.commsTopicRateWindowMs
      })

      // A fixed window that never rolls over is not a rate limit, it is a
      // permanent ban on the first topic a scene happens to be busy on.
      it('should let the topic publish again', () => {
        expect(registry.encodePublish('chat', 'after the window')).not.toBeNull()
      })
    })

    describe('and the clock steps backwards before the window elapses', () => {
      beforeEach(() => {
        // NTP correction: the window start is now in the future.
        clock -= 60_000
      })

      it('should start a new window instead of wedging the topic', () => {
        expect(registry.encodePublish('chat', 'after the step')).not.toBeNull()
      })
    })
  })

  describe('when a scene publishes to many distinct topics', () => {
    beforeEach(() => {
      for (let i = 0; i < limits.maxCommsTopicPublishesPerWindow + 3; i++) {
        registry.encodePublish(`topic-${i}`, 'hello')
      }
    })

    // The per-topic budget is per topic, so unrelated topics must not starve each
    // other while the aggregate budget still has room.
    it('should not let one topic consume another topic budget', () => {
      expect(registry.encodePublish('a-fresh-topic', 'hello')).not.toBeNull()
    })
  })

  describe('when a scene publishes to distinct topics faster than the aggregate budget', () => {
    let results: Array<Uint8Array | null>

    beforeEach(() => {
      results = []
      // Every publish is to its own topic, so the per-topic budget never binds:
      // without an aggregate budget all of these would go out over LiveKit.
      for (let i = 0; i < limits.maxCommsTopicPublishesTotalPerWindow + 5; i++) {
        results.push(registry.encodePublish(`topic-${i}`, 'hello'))
      }
    })

    it('should allow exactly the aggregate budget for the window', () => {
      expect(results.filter(Boolean)).toHaveLength(limits.maxCommsTopicPublishesTotalPerWindow)
    })

    // The aggregate counter is the one no scene-controlled key can evict, so it has
    // to survive the per-topic map filling up and rolling over.
    it('should keep rejecting until the window elapses', () => {
      expect(registry.encodePublish('yet-another-topic', 'hello')).toBeNull()
    })

    describe('and the rate window elapses', () => {
      beforeEach(() => {
        clock += limits.commsTopicRateWindowMs
      })

      it('should let publishing resume', () => {
        expect(registry.encodePublish('yet-another-topic', 'hello')).not.toBeNull()
      })
    })
  })

  describe('when a scene publishes to more distinct topics than the rate map can hold', () => {
    beforeEach(() => {
      // One window per publish so the aggregate budget never binds: what is under
      // test is the growth of the per-topic map, which is keyed by a
      // scene-controlled string and would otherwise be unbounded.
      for (let i = 0; i < limits.maxCommsTopicSubscriptions + 5; i++) {
        clock += limits.commsTopicRateWindowMs
        registry.encodePublish(`topic-${i}`, 'hello')
      }
    })

    it('should cap the rate map at the subscription ceiling', () => {
      expect(registry.publishRateEntryCount).toBe(limits.maxCommsTopicSubscriptions)
    })

    it('should evict the oldest entry rather than refusing new topics', () => {
      expect(registry.encodePublish('one-more-topic', 'hello')).not.toBeNull()
    })
  })

  describe('when a scene subscribes to more topics than the cap allows', () => {
    beforeEach(() => {
      for (let i = 0; i < limits.maxCommsTopicSubscriptions + 5; i++) {
        registry.subscribe(`topic-${i}`)
      }
    })

    it('should stop creating buffers at the cap', () => {
      expect(registry.subscriptionCount).toBe(limits.maxCommsTopicSubscriptions)
    })
  })

  describe('when a scene churns subscriptions faster than the per-window budget', () => {
    beforeEach(() => {
      // Subscribe + unsubscribe never trips the subscription COUNT, so the churn
      // rate needs a bound of its own.
      for (let i = 0; i < limits.maxCommsTopicSubscribesPerWindow; i++) {
        registry.subscribe(`topic-${i}`)
        registry.unsubscribe(`topic-${i}`)
      }
      registry.subscribe('one-more')
    })

    it('should refuse the subscription that exceeds the budget', () => {
      expect(registry.subscriptionCount).toBe(0)
    })

    describe('and the rate window elapses', () => {
      beforeEach(() => {
        clock += limits.commsTopicRateWindowMs
      })

      it('should let the scene subscribe again', () => {
        registry.subscribe('one-more')
        expect(registry.subscriptionCount).toBe(1)
      })
    })
  })

  describe('when a peer floods a subscribed topic past its buffer size', () => {
    let drained: TopicMessage[]

    beforeEach(() => {
      registry.subscribe('chat')
      for (let i = 0; i < limits.maxCommsTopicBufferMessages + 2; i++) {
        registry.ingest('0xpeer', frameOf('chat', `m${i}`))
      }
      drained = registry.consume('chat')
    })

    it('should keep the buffer at its cap', () => {
      expect(drained).toHaveLength(limits.maxCommsTopicBufferMessages)
    })

    // Assert the HEAD, not the tail: the newest message is the last one either way,
    // so a tail assertion passes just as happily against drop-NEWEST. Two messages
    // over the cap went in, so the two oldest are the ones that must be gone.
    it('should drop the oldest messages rather than the newest', () => {
      expect(drained[0].data).toBe('m2')
    })

    it('should keep the newest message', () => {
      expect(drained[drained.length - 1].data).toBe(`m${limits.maxCommsTopicBufferMessages + 1}`)
    })
  })

  describe('when a peer floods a subscribed topic past its byte budget', () => {
    let sent: number
    let drained: TopicMessage[]

    beforeEach(() => {
      registry.subscribe('chat')
      // Message-count-bounded only, this is 128KB x 1024 = 134MB retained for one
      // topic; a single peer can send these at its full inbound rate.
      const payload = 'x'.repeat(128 * 1024)
      sent = Math.ceil((limits.maxCommsTopicBufferBytes / payload.length) * 2)
      for (let i = 0; i < sent; i++) {
        registry.ingest('0xpeer', frameOf('chat', `${i}:${payload}`))
      }
      drained = registry.consume('chat')
    })

    it('should hold fewer messages than were sent', () => {
      expect(drained.length).toBeLessThan(sent)
    })

    it('should keep the buffered bytes within the per-topic budget', () => {
      const buffered = drained.reduce((total, message) => total + message.data.length + message.sender.length, 0)
      expect(buffered).toBeLessThanOrEqual(limits.maxCommsTopicBufferBytes)
    })

    // Head again: whatever survived has to be the TAIL of what was sent, so the
    // first retained payload carries index (sent - kept). Dropping the newest would
    // leave index 0 here while the tail assertion below still passed.
    it('should drop the oldest messages rather than the newest', () => {
      expect(drained[0].data.startsWith(`${sent - drained.length}:`)).toBe(true)
    })

    it('should keep the newest message', () => {
      expect(drained[drained.length - 1].data.startsWith(`${sent - 1}:`)).toBe(true)
    })

    it('should release the whole byte budget once the scene consumes', () => {
      expect(registry.bufferedByteCount).toBe(0)
    })
  })

  describe('when peers flood many subscribed topics past the aggregate byte budget', () => {
    let topicCount: number

    beforeEach(() => {
      // Per-topic budgets multiply: at 256 subscriptions the per-topic cap alone
      // would still allow 256x its own ceiling.
      topicCount = 4 * Math.ceil(limits.maxCommsTopicBufferTotalBytes / limits.maxCommsTopicBufferBytes)
      const payload = 'x'.repeat(128 * 1024)
      const perTopic = Math.ceil((limits.maxCommsTopicBufferBytes / payload.length) * 2)

      for (let t = 0; t < topicCount; t++) registry.subscribe(`topic-${t}`)
      for (let i = 0; i < perTopic; i++) {
        for (let t = 0; t < topicCount; t++) {
          registry.ingest('0xpeer', frameOf(`topic-${t}`, payload))
        }
      }
    })

    it('should hold no more than the aggregate budget across every topic', () => {
      expect(registry.bufferedByteCount).toBeLessThanOrEqual(limits.maxCommsTopicBufferTotalBytes)
    })

    it('should still be buffering something rather than dropping everything', () => {
      expect(registry.bufferedByteCount).toBeGreaterThan(0)
    })
  })

  describe('when a peer sends a single message larger than the per-topic byte budget', () => {
    beforeEach(() => {
      registry.subscribe('chat')
      registry.ingest('0xpeer', frameOf('chat', 'x'.repeat(limits.maxCommsTopicBufferBytes + 1)))
    })

    it('should drop it instead of emptying the buffer to make room', () => {
      expect(registry.consume('chat')).toEqual([])
    })
  })

  describe('when a peer with an oversized address publishes on a subscribed topic', () => {
    beforeEach(() => {
      registry.subscribe('chat')
      // The MessageBus branch beside this one drops peer addresses over 255 bytes
      // because it frames the length in a single byte; the sender is retained per
      // buffered message here, so it gets the same ceiling.
      registry.ingest(`0x${'a'.repeat(300)}`, frameOf('chat', 'hello'))
    })

    it('should drop the message rather than buffer the address', () => {
      expect(registry.consume('chat')).toEqual([])
    })
  })

  describe('when a peer sends bytes that are not valid UTF-8 as the payload', () => {
    let received: TopicMessage[]

    beforeEach(() => {
      registry.subscribe('chat')
      // A decoder built with `fatal: true` would THROW here, inside the transport
      // dispatch, on a packet a remote peer fully controls.
      registry.ingest('0xpeer', rawFrameOf(textEncoder.encode('chat'), new Uint8Array([0xff, 0xfe, 0x80])))
      received = registry.consume('chat')
    })

    it('should substitute replacement characters instead of throwing', () => {
      expect(received).toEqual([{ sender: '0xpeer', data: '\ufffd\ufffd\ufffd' }])
    })
  })

  describe('when a peer sends bytes that are not valid UTF-8 as the topic', () => {
    beforeEach(() => {
      registry.subscribe('chat')
    })

    it('should drop the frame without throwing', () => {
      expect(() =>
        registry.ingest('0xpeer', rawFrameOf(new Uint8Array([0xff, 0xfe]), textEncoder.encode('hello')))
      ).not.toThrow()
    })

    it('should not deliver it to an unrelated subscribed topic', () => {
      registry.ingest('0xpeer', rawFrameOf(new Uint8Array([0xff, 0xfe]), textEncoder.encode('hello')))
      expect(registry.consume('chat')).toEqual([])
    })
  })

  describe('when a peer sends a frame declaring a zero-length topic', () => {
    beforeEach(() => {
      registry.subscribe('chat')
      registry.ingest('0xpeer', rawFrameOf(new Uint8Array(0), textEncoder.encode('hello')))
    })

    it('should not buffer it for any topic', () => {
      expect(registry.bufferedByteCount).toBe(0)
    })

    it('should leave the subscribed topic empty', () => {
      expect(registry.consume('chat')).toEqual([])
    })
  })

  describe('when a peer sends a frame shorter than its declared topic length', () => {
    beforeEach(() => {
      registry.subscribe('chat')
      // Declares a 200-byte topic but carries 4 bytes of it.
      registry.ingest('0xpeer', rawFrameOf(textEncoder.encode('chat'), new Uint8Array(0), 200))
    })

    it('should drop the frame instead of reading past its end', () => {
      expect(registry.consume('chat')).toEqual([])
    })
  })

  describe('when a peer sends a frame too short to hold a length prefix', () => {
    it('should drop it without throwing', () => {
      expect(() => registry.ingest('0xpeer', new Uint8Array([1]))).not.toThrow()
    })
  })
})

describe('comms api topic registry, when the operator raises the topic cap past the u16 length prefix', () => {
  let registry: CommsTopicRegistry
  let oversizedTopic: string

  beforeEach(() => {
    // limits is a singleton read from process.env at import, so the knob has to be
    // set before a fresh copy of the module graph is loaded.
    jest.resetModules()
    process.env.HAMMURABI_MAX_COMMS_TOPIC_BYTES = '70000'
    registry = require('../../../../src/lib/decentraland/communications/comms-api-topics').createCommsTopicRegistry()
    oversizedTopic = 'a'.repeat(66_000)
  })

  afterEach(() => {
    delete process.env.HAMMURABI_MAX_COMMS_TOPIC_BYTES
    jest.resetModules()
  })

  // The knob has no maximum, but the frame describes the topic with a u16: at
  // 66000 bytes the prefix declared 464 and the receiver read a 464-byte topic
  // with 65536 bytes of topic as its DATA. A drop beats silent corruption.
  it('should still refuse a topic the frame cannot describe', () => {
    expect(registry.encodePublish(oversizedTopic, 'hello')).toBeNull()
  })

  it('should still refuse to subscribe to it', () => {
    registry.subscribe(oversizedTopic)
    expect(registry.subscriptionCount).toBe(0)
  })
})
