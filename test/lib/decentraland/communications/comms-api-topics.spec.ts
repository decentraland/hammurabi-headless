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

function frameOf(topic: string, data: string): Uint8Array {
  const topicBytes = textEncoder.encode(topic)
  const dataBytes = textEncoder.encode(data)
  const frame = new Uint8Array(2 + topicBytes.byteLength + dataBytes.byteLength)
  frame[0] = topicBytes.byteLength & 0xff
  frame[1] = (topicBytes.byteLength >> 8) & 0xff
  frame.set(topicBytes, 2)
  frame.set(dataBytes, 2 + topicBytes.byteLength)
  return frame
}

describe('comms api topic registry', () => {
  let registry: CommsTopicRegistry

  beforeEach(() => {
    registry = createCommsTopicRegistry()
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
  })

  describe('when a scene publishes an empty payload', () => {
    it('should drop it rather than framing an empty message', () => {
      expect(registry.encodePublish('chat', '')).toBeNull()
    })
  })

  describe('when a scene publishes to an oversized topic', () => {
    let oversizedTopic: string

    beforeEach(() => {
      oversizedTopic = 'a'.repeat(limits.maxCommsTopicBytes + 1)
    })

    it('should drop the publish', () => {
      expect(registry.encodePublish(oversizedTopic, 'hello')).toBeNull()
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

  describe('when a scene publishes to the same topic faster than the per-window budget', () => {
    let results: Array<Uint8Array | null>

    beforeEach(() => {
      results = []
      // Synchronous loop: Date.now() cannot advance a full window mid-loop, so
      // every one of these lands in the same fixed window.
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
  })

  describe('when a scene publishes to many distinct topics', () => {
    beforeEach(() => {
      for (let i = 0; i < limits.maxCommsTopicPublishesPerWindow + 3; i++) {
        registry.encodePublish(`topic-${i}`, 'hello')
      }
    })

    // The budget is per topic, so unrelated topics must not starve each other.
    it('should not let one topic consume another topic budget', () => {
      expect(registry.encodePublish('a-fresh-topic', 'hello')).not.toBeNull()
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

    it('should drop the oldest messages rather than the newest', () => {
      expect(drained[drained.length - 1].data).toBe(`m${limits.maxCommsTopicBufferMessages + 1}`)
    })
  })

  describe('when a peer sends a frame shorter than its declared topic length', () => {
    beforeEach(() => {
      registry.subscribe('chat')
      // Declares a 200-byte topic but carries 4 bytes of it.
      const malformed = new Uint8Array([200, 0, 99, 104, 97, 116])
      registry.ingest('0xpeer', malformed)
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
