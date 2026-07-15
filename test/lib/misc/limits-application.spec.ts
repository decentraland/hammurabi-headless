import mitt from 'mitt'
import * as proto from '@dcl/protocol/out-js/decentraland/kernel/comms/rfc4/comms.gen'

// End-to-end coverage of the config SEAM: a HAMMURABI_* env override must flow
// through the `limits` singleton into the value a consumer actually enforces — not
// merely parse correctly (limits.spec) nor merely change behavior when injected as a
// param (deadline.spec). Because `limits` is read once at import, each test sets the
// env var, resets the module registry, then requires the consumer fresh so it picks
// up the override.

const TOUCHED = [
  'HAMMURABI_MAX_MESSAGES_PER_WINDOW',
  'HAMMURABI_MAX_INBOUND_PACKET_BYTES',
  'HAMMURABI_MAX_SYNC_EXECUTION_MS'
]

afterEach(() => {
  for (const key of TOUCHED) delete process.env[key]
  jest.resetModules()
})

function makeTransport() {
  return { events: mitt(), async connect() {}, async disconnect() {}, send() {}, setVoicePosition() {} }
}

function positionPacket(): Uint8Array {
  return proto.Packet.encode({
    message: {
      $case: 'position',
      position: { index: 0, positionX: 1, positionY: 2, positionZ: 3, rotationX: 0, rotationY: 0, rotationZ: 0, rotationW: 1 }
    },
    protocolVersion: 0
  } as any).finish()
}

describe('HAMMURABI_* overrides take effect in the code that enforces them', () => {
  describe('a count knob: HAMMURABI_MAX_MESSAGES_PER_WINDOW', () => {
    it('rate-limits inbound comms at the overridden count, not the 300 default', () => {
      process.env.HAMMURABI_MAX_MESSAGES_PER_WINDOW = '50'
      jest.resetModules()
      const { CommsTransportWrapper } = require('../../../src/lib/decentraland/communications/CommsTransportWrapper')

      const transport = makeTransport()
      const wrapper = new CommsTransportWrapper(transport as any, 'scene')
      let dispatched = 0
      wrapper.events.on('position', () => dispatched++)

      const pkt = positionPacket()
      for (let i = 0; i < 400; i++) transport.events.emit('message', { data: pkt, address: '0xflood' })

      expect(dispatched).toBe(50)
    })
  })

  describe('a byte knob: HAMMURABI_MAX_INBOUND_PACKET_BYTES', () => {
    it('drops a VALID packet that exceeds the overridden size cap', () => {
      // 10 bytes is far below a real position packet, so a well-formed packet that
      // would decode+dispatch at the default is now rejected purely on size.
      process.env.HAMMURABI_MAX_INBOUND_PACKET_BYTES = '10'
      jest.resetModules()
      const { CommsTransportWrapper } = require('../../../src/lib/decentraland/communications/CommsTransportWrapper')

      const transport = makeTransport()
      const wrapper = new CommsTransportWrapper(transport as any, 'scene')
      let dispatched = 0
      wrapper.events.on('position', () => dispatched++)

      const pkt = positionPacket()
      expect(pkt.length).toBeGreaterThan(10) // guard: the packet really is over the override
      transport.events.emit('message', { data: pkt, address: '0xpeer' })

      expect(dispatched).toBe(0)
    })
  })

  describe('a timeout knob: HAMMURABI_MAX_SYNC_EXECUTION_MS', () => {
    it('bounds a runaway synchronous turn at the overridden deadline (well under the 10s default)', async () => {
      process.env.HAMMURABI_MAX_SYNC_EXECUTION_MS = '150'
      jest.resetModules()
      const { withIsolatedVm } = require('../../../src/lib/isolated-vm/index')

      const start = Date.now()
      await expect(
        withIsolatedVm(async (opts: any) => {
          opts.provide({ log() {}, error() {}, require() { throw new Error('n/a') } })
          opts.eval('module.exports.onStart = function () { while (true) {} }')
          await opts.onStart()
        })
      ).rejects.toBeDefined()

      // Would run for the 10_000ms default if the env override were ignored.
      expect(Date.now() - start).toBeLessThan(4000)
    }, 15000)
  })
})
