import { Scene } from '@dcl/schemas'
import { testWithEngine } from './babylon-test-helper'

// Minimal event emitter standing in for a CommsTransportWrapper; attachLivekitTransport
// only needs `.events` (on/off/emit).
function makeEmitter() {
  const handlers: Record<string, Function[]> = {}
  return {
    on(t: string, h: Function) {
      ;(handlers[t] ||= []).push(h)
    },
    off(t: string, h: Function) {
      handlers[t] = (handlers[t] || []).filter((x) => x !== h)
    },
    emit(t: string, e: any) {
      ;(handlers[t] || []).forEach((h) => h(e))
    }
  }
}

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
