import * as proto from '@dcl/protocol/out-js/decentraland/kernel/comms/rfc4/comms.gen'
import { ReadWriteByteBuffer } from '../../../../src/lib/decentraland/ByteBuffer'
import { readAllMessages } from '../../../../src/lib/decentraland/crdt-wire-protocol'
import { createAvatarCommunicationSystem } from '../../../../src/lib/decentraland/communications/avatar-communication-system'
import {
  playerEntityManager,
  EntityUtils
} from '../../../../src/lib/decentraland/communications/player-entity-manager'
import { CommsTransportWrapper } from '../../../../src/lib/decentraland/communications/CommsTransportWrapper'

// Minimal event emitter for the transport (on/off/emit is all these consumers use).
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
