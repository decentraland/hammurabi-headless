import * as proto from '@dcl/protocol/out-js/decentraland/kernel/comms/rfc4/comms.gen'
import type { Player, SceneListener } from '@dcl/pulse-client'
import { PulseAdapter } from '../../../../../src/lib/decentraland/communications/transports/pulse'

// Drives a fake SceneListener through the PulseAdapter (injected via the constructor's
// connect dependency — no module mocking) and asserts the MinimumCommunicationsTransport
// contract: RFC-4 re-encoding, peer lifecycle, and the terminal-signal semantics
// (`disconnected` is terminal; `error` is not — pulse-client emits non-fatal errors for
// survivable conditions like a malformed packet, and guarantees `disconnected` fires on
// every loop exit).

type Handler = (...args: any[]) => void

class FakeListener {
  private readonly handlers = new Map<string, Handler[]>()
  close = jest.fn()

  on(event: string, handler: Handler) {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return this
  }

  emit(event: string, ...args: any[]) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args)
  }
}

const basePlayer: Player = {
  subjectId: '7',
  address: '0x00000000000000000000000000000000000000aa',
  parcelIndex: 0,
  position: { x: 1.5, y: 2.5, z: 3.5 },
  rotation: { x: 0, y: 1, z: 0, w: 0 },
  sequence: 5
}

const makeAdapter = async () => {
  const listener = new FakeListener()
  const connectFn = jest.fn().mockResolvedValue(listener as unknown as SceneListener)
  const adapter = new PulseAdapter(
    {
      host: 'localhost',
      port: 7777,
      realm: 'main',
      parcels: [{ x: 0, z: 0 }],
      authChain: '{}'
    },
    connectFn
  )
  await adapter.connect()
  return { adapter, listener, connectFn }
}

describe('PulseAdapter message re-encoding', () => {
  it('re-encodes playerJoined as PEER_CONNECTED plus a decodable RFC-4 position Packet', async () => {
    const { adapter, listener } = await makeAdapter()
    const peers: string[] = []
    const packets: Array<{ address: string; data: Uint8Array }> = []
    adapter.events.on('PEER_CONNECTED', (event) => peers.push(event.address))
    adapter.events.on('message', (event) => packets.push(event))

    listener.emit('playerJoined', basePlayer)

    expect(peers).toEqual([basePlayer.address])
    expect(packets).toHaveLength(1)
    const packet = proto.Packet.decode(packets[0].data)
    expect(packet.message?.$case).toBe('position')
    if (packet.message?.$case !== 'position') return
    expect(packet.message.position.positionX).toBeCloseTo(1.5)
    expect(packet.message.position.positionY).toBeCloseTo(2.5)
    expect(packet.message.position.positionZ).toBeCloseTo(3.5)
    expect(packet.message.position.rotationY).toBeCloseTo(1)
    expect(packet.message.position.index).toBe(5)
  })

  it('falls back to the identity rotation when the player has none', async () => {
    const { adapter, listener } = await makeAdapter()
    const packets: Array<{ data: Uint8Array }> = []
    adapter.events.on('message', (event) => packets.push(event))

    const { rotation: _rotation, ...withoutRotation } = basePlayer
    listener.emit('playerUpdated', withoutRotation)

    const packet = proto.Packet.decode(packets[0].data)
    if (packet.message?.$case !== 'position') throw new Error('expected a position packet')
    expect(packet.message.position.rotationW).toBeCloseTo(1)
  })

  it('resolves playerLeft to the joined address even though the event only carries a subjectId', async () => {
    const { adapter, listener } = await makeAdapter()
    const gone: string[] = []
    adapter.events.on('PEER_DISCONNECTED', (event) => gone.push(event.address))

    listener.emit('playerJoined', basePlayer)
    listener.emit('playerLeft', basePlayer.subjectId)

    expect(gone).toEqual([basePlayer.address])
  })

  it('handles playerLeft for an untracked subjectId without throwing (subjectId as address)', async () => {
    const { adapter, listener } = await makeAdapter()
    const gone: string[] = []
    adapter.events.on('PEER_DISCONNECTED', (event) => gone.push(event.address))

    listener.emit('playerLeft', '99')

    expect(gone).toEqual(['99'])
  })
})

describe('PulseAdapter terminal-signal semantics', () => {
  it('reports connected through getRoomInfo after connect()', async () => {
    const { adapter } = await makeAdapter()
    expect(adapter.getRoomInfo()).toEqual({ roomName: 'main', isConnected: true })
  })

  it('emits DISCONNECTION and flips isConnected on the terminal disconnected event', async () => {
    const { adapter, listener } = await makeAdapter()
    const disconnections: any[] = []
    adapter.events.on('DISCONNECTION', (event) => disconnections.push(event))

    listener.emit('disconnected', 'server restart')

    expect(disconnections).toHaveLength(1)
    expect(disconnections[0].error?.message).toBe('server restart')
    expect(adapter.getRoomInfo()?.isConnected).toBe(false)
  })

  it('treats error as non-fatal: forwards it, stays connected, no DISCONNECTION', async () => {
    const { adapter, listener } = await makeAdapter()
    const errors: Error[] = []
    const disconnections: any[] = []
    adapter.events.on('error', (error) => errors.push(error))
    adapter.events.on('DISCONNECTION', (event) => disconnections.push(event))

    listener.emit('error', new Error('one malformed packet'))

    expect(errors).toHaveLength(1)
    expect(disconnections).toHaveLength(0)
    expect(adapter.getRoomInfo()?.isConnected).toBe(true)
  })

  it('emits DISCONNECTION exactly once when an error precedes the terminal disconnected', async () => {
    const { adapter, listener } = await makeAdapter()
    const disconnections: any[] = []
    adapter.events.on('error', () => undefined)
    adapter.events.on('DISCONNECTION', (event) => disconnections.push(event))

    listener.emit('error', new Error('socket died'))
    listener.emit('disconnected', 'socket died')
    listener.emit('disconnected', 'socket died')

    expect(disconnections).toHaveLength(1)
  })
})

describe('PulseAdapter disposal', () => {
  it('closes the listener and reports disconnected exactly once', async () => {
    const { adapter, listener } = await makeAdapter()
    await adapter.disconnect()
    await adapter.disconnect()
    expect(listener.close).toHaveBeenCalledTimes(1)
    expect(adapter.getRoomInfo()?.isConnected).toBe(false)
  })

  it('emits nothing for events arriving after disposal', async () => {
    const { adapter, listener } = await makeAdapter()
    const emitted: string[] = []
    adapter.events.on('PEER_CONNECTED', () => emitted.push('PEER_CONNECTED'))
    adapter.events.on('message', () => emitted.push('message'))
    adapter.events.on('DISCONNECTION', () => emitted.push('DISCONNECTION'))

    await adapter.disconnect()
    listener.emit('playerJoined', basePlayer)
    listener.emit('disconnected', 'late')

    expect(emitted).toEqual([])
  })
})
