import { Scene } from '@dcl/schemas'
import mitt from 'mitt'
import { testWithEngine } from './babylon-test-helper'

// The production transport's `.events` IS a mitt emitter (CommsTransportWrapper),
// so the stub uses the same library; attachLivekitTransport only needs `.events`.
const makeEmitter = () => mitt<Record<string, any>>()

testWithEngine(
  'inbound scene-bus queue is bounded',
  {
    baseUrl: '/',
    entity: { content: [], metadata: {} as Scene, type: 'scene' },
    urn: '123'
  },
  ($) => {
    // A scene that never uses the MessageBus never calls getNetworkMessages via
    // sendBinary, so the inbound queue must not grow without bound when a remote
    // peer keeps sending scene-cased packets.
    test('drops oldest messages beyond the cap when the scene never drains them', () => {
      const transport = { events: makeEmitter() }
      $.ctx.attachLivekitTransport(transport as any)

      const sceneId = $.ctx.entityId
      const CAP = 1024

      for (let i = 0; i < CAP + 200; i++) {
        transport.events.emit('sceneMessageBus', {
          address: '0xpeer',
          data: { sceneId, data: new Uint8Array([i & 0xff, 1, 2]) }
        })
      }

      const messages = $.ctx.getNetworkMessages()
      expect(messages.length).toBe(CAP)
    })
  }
)
