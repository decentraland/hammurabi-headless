import mitt from 'mitt'
import * as proto from '@dcl/protocol/out-js/decentraland/kernel/comms/rfc4/comms.gen'
import { ReadWriteByteBuffer } from '../../../../src/lib/decentraland/ByteBuffer'
import { readAllMessages } from '../../../../src/lib/decentraland/crdt-wire-protocol'
import { createAvatarCommunicationSystem } from '../../../../src/lib/decentraland/communications/avatar-communication-system'
import {
  playerEntityManager,
  EntityUtils
} from '../../../../src/lib/decentraland/communications/player-entity-manager'
import { CommsTransportWrapper } from '../../../../src/lib/decentraland/communications/CommsTransportWrapper'

// The production transport's `.events` IS a mitt emitter (CommsTransportWrapper),
// so the stub uses the same library instead of a hand-rolled copy of it.
const makeEmitter = () => mitt<Record<string, any>>()

// End-to-end coverage of the UNTRUSTED-PEER comms path (host side, outside the VM):
// remote packets -> CommsTransportWrapper decode/bounds -> avatar system -> CRDT.
// Fully in-memory: no LiveKit, no network.

describe('comms: a remote peer position materializes a player entity + CRDT', () => {
  let transport: { events: ReturnType<typeof makeEmitter> }
  let system: ReturnType<typeof createAvatarCommunicationSystem>

  beforeEach(() => {
    // playerEntityManager is a shared singleton across the process.
    playerEntityManager.clear()
    transport = { events: makeEmitter() }
    // worldToScene converts comms world positions into the owning scene's
    // coordinates; identity (as a fresh clone, since the LWW store retains the
    // vector) is enough here.
    system = createAvatarCommunicationSystem(transport as any, (position) => position.clone())
  })

  afterEach(() => {
    system.dispose()
  })

  it('should allocate a player-range entity and emit its transform as CRDT', () => {
    const subscription = system.createSubscription()

    // A remote peer reports a position (finite coords).
    transport.events.emit('position', {
      address: '0xPeer',
      data: { positionX: 1, positionY: 2, positionZ: 3, rotationX: 0, rotationY: 0, rotationZ: 0, rotationW: 1 }
    })

    // The peer must now own an entity, allocated in the reserved remote-player range.
    const entity = playerEntityManager.getEntityForAddress('0xpeer')
    expect(entity).not.toBeNull()
    const [entityNumber] = EntityUtils.fromEntityId(entity!)
    expect(entityNumber).toBeGreaterThanOrEqual(32)
    expect(entityNumber).toBeLessThan(256)

    // Commit dirty components and pull the CRDT the scene subscription would send.
    system.update()
    const buf = new ReadWriteByteBuffer()
    subscription.getUpdates(buf)
    const messages = Array.from(readAllMessages(new ReadWriteByteBuffer(buf.toBinary())))

    // At least one message targets the newly-allocated player entity.
    const playerMessages = messages.filter((m) => {
      const [num] = EntityUtils.fromEntityId(m.entityId)
      return num >= 32 && num < 256
    })
    expect(playerMessages.length).toBeGreaterThan(0)
  })
})

describe('comms: CommsTransportWrapper bounds untrusted inbound traffic', () => {
  function makeTransport() {
    return {
      events: makeEmitter(),
      async connect() {},
      async disconnect() {},
      send() {},
      setVoicePosition() {}
    }
  }

  function positionPacket(): Uint8Array {
    return proto.Packet.encode({
      message: {
        $case: 'position',
        position: {
          index: 0,
          positionX: 1,
          positionY: 2,
          positionZ: 3,
          rotationX: 0,
          rotationY: 0,
          rotationZ: 0,
          rotationW: 1
        }
      },
      protocolVersion: 0
    } as any).finish()
  }

  it('decodes and dispatches a valid packet', () => {
    const transport = makeTransport()
    const wrapper = new CommsTransportWrapper(transport as any, 'scene')
    let positions = 0
    wrapper.events.on('position', () => positions++)

    transport.events.emit('message', { data: positionPacket(), address: '0xpeer' })

    expect(positions).toBe(1)
  })

  it('drops an oversized packet before decoding it', () => {
    const transport = makeTransport()
    const wrapper = new CommsTransportWrapper(transport as any, 'scene')
    let dispatched = 0
    wrapper.events.on('position', () => dispatched++)

    // 128 KiB + 1 — over MAX_INBOUND_PACKET_BYTES.
    const oversized = new Uint8Array(128 * 1024 + 1)
    transport.events.emit('message', { data: oversized, address: '0xpeer' })

    expect(dispatched).toBe(0)
  })

  it('rate-limits a single peer flooding within one window', () => {
    const transport = makeTransport()
    const wrapper = new CommsTransportWrapper(transport as any, 'scene')
    let dispatched = 0
    wrapper.events.on('position', () => dispatched++)

    const pkt = positionPacket()
    for (let i = 0; i < 400; i++) {
      transport.events.emit('message', { data: pkt, address: '0xflood' })
    }

    // MAX_MESSAGES_PER_WINDOW is 300; the rest are dropped.
    expect(dispatched).toBe(300)
  })

  it('keeps a separate budget per peer address', () => {
    const transport = makeTransport()
    const wrapper = new CommsTransportWrapper(transport as any, 'scene')
    let dispatched = 0
    wrapper.events.on('position', () => dispatched++)

    const pkt = positionPacket()
    // Two distinct peers, 10 packets each — well under the cap, all delivered.
    for (let i = 0; i < 10; i++) transport.events.emit('message', { data: pkt, address: '0xpeerA' })
    for (let i = 0; i < 10; i++) transport.events.emit('message', { data: pkt, address: '0xpeerB' })

    expect(dispatched).toBe(20)
  })
})

// Every member of the rfc4 `Packet` oneof, split by whether `dispatchMessage` implements
// it. Payloads are protobuf defaults (`fromPartial`) on purpose: what matters here is
// which `$case` gets dispatched vs. reported, not the payload contents.
const HANDLED_VARIANTS: ReadonlyArray<readonly [string, string]> = [
  ['position', 'position'],
  ['profileVersion', 'profileMessage'],
  ['profileRequest', 'profileRequest'],
  ['profileResponse', 'profileResponse'],
  ['chat', 'chatMessage'],
  ['scene', 'sceneMessageBus'],
  ['voice', 'voiceMessage'],
  ['movement', 'movement']
]

const UNHANDLED_VARIANTS: readonly string[] = [
  'playerEmote',
  'sceneEmote',
  'movementCompressed',
  'lookAtPosition',
  'reaction',
  'chatReaction'
]

function packetForVariant(variant: string): Uint8Array {
  return proto.Packet.encode(
    proto.Packet.fromPartial({ message: { $case: variant, [variant]: {} } } as any)
  ).finish()
}

// A variant the switch does not implement used to be dropped with no log, no metric and
// no trace at all, so an unimplemented protocol feature (or a variant newly added to
// rfc4) was indistinguishable from one that worked. It must now be reported — but only
// under a throttle, since the sender is an untrusted peer and stderr is blocking.
describe('when CommsTransportWrapper receives an rfc4 packet variant it does not implement', () => {
  let transport: {
    events: ReturnType<typeof makeEmitter>
    connect(): Promise<void>
    disconnect(): Promise<void>
    send(): void
    setVoicePosition(): void
  }
  let wrapper: CommsTransportWrapper
  let logged: string[]
  let consoleErrorSpy: jest.SpyInstance
  let nowSpy: jest.SpyInstance
  let clock: number
  let advance: (ms: number) => void

  beforeEach(() => {
    clock = 1_000_000 // arbitrary non-zero epoch
    advance = (ms: number) => (clock += ms)
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock)
    logged = []
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation((...args: any[]) => {
      logged.push(args.join(' '))
    })
    transport = {
      events: makeEmitter(),
      async connect() {},
      async disconnect() {},
      send() {},
      setVoicePosition() {}
    }
    wrapper = new CommsTransportWrapper(transport as any, 'scene')
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
    nowSpy.mockRestore()
  })

  it('should name the dropped variant and the sender address so an operator can grep for either', () => {
    transport.events.emit('message', { data: packetForVariant('playerEmote'), address: '0xpeer' })

    expect(logged).toEqual([expect.stringContaining('unhandled rfc4 packet variant "playerEmote" from 0xpeer')])
  })

  it.each(UNHANDLED_VARIANTS)('should report a dropped %s packet', (variant) => {
    transport.events.emit('message', { data: packetForVariant(variant), address: '0xpeer' })

    expect(logged).toEqual([expect.stringContaining(`"${variant}"`)])
  })

  it.each(UNHANDLED_VARIANTS)('should not emit any wrapper event for a %s packet', (variant) => {
    let dispatched = 0
    for (const [, event] of HANDLED_VARIANTS) wrapper.events.on(event as any, () => dispatched++)

    transport.events.emit('message', { data: packetForVariant(variant), address: '0xpeer' })

    expect(dispatched).toBe(0)
  })

  it('should report all six unimplemented variants, since each is throttled on its own', () => {
    for (const variant of UNHANDLED_VARIANTS) {
      transport.events.emit('message', { data: packetForVariant(variant), address: '0xpeer' })
    }

    expect(logged).toHaveLength(UNHANDLED_VARIANTS.length)
  })

  it('should strip control characters from the remote-controlled address so it cannot forge log lines', () => {
    transport.events.emit('message', {
      data: packetForVariant('playerEmote'),
      address: '0xpeer\n[FAKE] injected'
    })

    expect(logged[0]).not.toContain('\n')
  })

  describe('and the same peer keeps sending that variant', () => {
    beforeEach(() => {
      const packet = packetForVariant('movementCompressed')
      // 100 identical packets, all inside one throttle interval (the clock is frozen).
      for (let i = 0; i < 100; i++) {
        transport.events.emit('message', { data: packet, address: '0xflood' })
      }
    })

    it('should log once for the whole throttle interval instead of once per packet', () => {
      expect(logged).toHaveLength(1)
    })

    it('should report how many were suppressed on the first log after the interval elapses', () => {
      advance(10_000) // UNHANDLED_VARIANT_LOG_INTERVAL_MS
      transport.events.emit('message', { data: packetForVariant('movementCompressed'), address: '0xflood' })

      expect(logged[1]).toContain('(99 more in 10s)')
    })
  })

  describe('and a different peer sends the same variant', () => {
    beforeEach(() => {
      const packet = packetForVariant('playerEmote')
      transport.events.emit('message', { data: packet, address: '0xpeerA' })
      transport.events.emit('message', { data: packet, address: '0xpeerB' })
    })

    it("should report both peers rather than letting the first one's throttle mask the second", () => {
      expect(logged).toEqual([expect.stringContaining('0xpeerA'), expect.stringContaining('0xpeerB')])
    })
  })

  describe('and a peer cycles through many distinct addresses', () => {
    beforeEach(() => {
      const packet = packetForVariant('reaction')
      // Each address is a fresh (address, variant) throttle slot, so per-pair throttling
      // alone would emit one line per address — the global budget is what bounds it.
      for (let i = 0; i < 50; i++) {
        transport.events.emit('message', { data: packet, address: `0xchurn${i}` })
      }
    })

    it('should stop at the global per-interval budget so the flood cannot stall the event loop', () => {
      // MAX_UNHANDLED_VARIANT_LOGS_PER_INTERVAL is 20.
      expect(logged).toHaveLength(20)
    })

    it('should carry the over-budget drops into the count reported after the interval', () => {
      advance(10_000)
      transport.events.emit('message', { data: packetForVariant('reaction'), address: '0xchurn0' })

      expect(logged[20]).toContain('more in 10s)')
    })
  })
})

describe('when CommsTransportWrapper receives an rfc4 packet variant it does implement', () => {
  let transport: { events: ReturnType<typeof makeEmitter>; setVoicePosition(): void }
  let wrapper: CommsTransportWrapper
  let logged: string[]
  let consoleErrorSpy: jest.SpyInstance

  beforeEach(() => {
    logged = []
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation((...args: any[]) => {
      logged.push(args.join(' '))
    })
    transport = { events: makeEmitter(), setVoicePosition() {} }
    wrapper = new CommsTransportWrapper(transport as any, 'scene')
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  it.each(HANDLED_VARIANTS)('should dispatch a %s packet to the %s event', (variant, event) => {
    let dispatched = 0
    wrapper.events.on(event as any, () => dispatched++)

    transport.events.emit('message', { data: packetForVariant(variant), address: '0xpeer' })

    expect(dispatched).toBe(1)
  })

  it.each(HANDLED_VARIANTS)('should log nothing for a %s packet', (variant) => {
    transport.events.emit('message', { data: packetForVariant(variant), address: '0xpeer' })

    expect(logged).toEqual([])
  })
})
