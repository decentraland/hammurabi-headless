import mitt from 'mitt'
import { CommsRouter } from '../../../../src/lib/decentraland/communications/comms-router'
import { resolveRouting } from '../../../../src/lib/decentraland/communications/comms-routing'

const makeFakeWrapper = () => ({
  events: mitt<any>(),
  connect: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
  sendParcelSceneMessage: jest.fn().mockResolvedValue(undefined),
  getRoomInfo: jest.fn().mockReturnValue(undefined)
})

describe('CommsRouter (pulse on: position→pulse, rest→livekit)', () => {
  const build = () => {
    const pulse = makeFakeWrapper()
    const livekit = makeFakeWrapper()
    const router = new CommsRouter(resolveRouting(true), { pulse: pulse as any, livekit: livekit as any })
    return { pulse, livekit, router }
  }

  it('forwards position only from Pulse and drops LiveKit position', () => {
    const { pulse, livekit, router } = build()
    const positions: any[] = []
    router.events.on('position', (e) => positions.push(e))

    pulse.events.emit('position', { address: 'from-pulse', data: {} })
    livekit.events.emit('position', { address: 'from-livekit', data: {} })

    expect(positions).toEqual([{ address: 'from-pulse', data: {} }])
  })

  it('forwards presence, scene bus, and chat from LiveKit', () => {
    const { pulse, livekit, router } = build()
    const seen: string[] = []
    router.events.on('PEER_CONNECTED', () => seen.push('presence'))
    router.events.on('sceneMessageBus', () => seen.push('sceneBus'))
    router.events.on('chatMessage', () => seen.push('chat'))

    livekit.events.emit('PEER_CONNECTED', { address: 'x' })
    livekit.events.emit('sceneMessageBus', { address: 'x', data: {} })
    livekit.events.emit('chatMessage', { address: 'x', data: {} })
    // Pulse does not own presence — even if it emitted one, it must be dropped.
    pulse.events.emit('PEER_CONNECTED', { address: 'y' })

    expect(seen).toEqual(['presence', 'sceneBus', 'chat'])
  })

  it('forwards DISCONNECTION from either transport', () => {
    const { pulse, livekit, router } = build()
    const disconnections: any[] = []
    router.events.on('DISCONNECTION', (e) => disconnections.push(e))

    pulse.events.emit('DISCONNECTION', { kicked: false })
    livekit.events.emit('DISCONNECTION', { kicked: false })

    expect(disconnections).toHaveLength(2)
  })

  it('routes outbound scene messages to LiveKit only', async () => {
    const { pulse, livekit, router } = build()
    await router.sendParcelSceneMessage({} as any, ['peer'])

    expect(livekit.sendParcelSceneMessage).toHaveBeenCalledTimes(1)
    expect(pulse.sendParcelSceneMessage).not.toHaveBeenCalled()
  })

  it('connects every transport in the connection set', async () => {
    const { pulse, livekit, router } = build()
    await router.connect()

    expect(pulse.connect).toHaveBeenCalledTimes(1)
    expect(livekit.connect).toHaveBeenCalledTimes(1)
  })

  it('prefers the LiveKit room identity in getRoomInfo', () => {
    const { pulse, livekit, router } = build()
    livekit.getRoomInfo.mockReturnValue({ roomName: 'realm-room', isConnected: true })
    pulse.getRoomInfo.mockReturnValue({ roomName: 'main', isConnected: true })

    expect(router.getRoomInfo()).toEqual({ roomName: 'realm-room', isConnected: true })
  })
})

describe('CommsRouter (pulse off: everything on livekit)', () => {
  it('forwards position from LiveKit and never touches Pulse', async () => {
    const livekit = makeFakeWrapper()
    const router = new CommsRouter(resolveRouting(false), { livekit: livekit as any })
    const positions: any[] = []
    router.events.on('position', (e) => positions.push(e))

    livekit.events.emit('position', { address: 'lk', data: {} })
    await router.connect()

    expect(positions).toHaveLength(1)
    expect(livekit.connect).toHaveBeenCalledTimes(1)
  })
})
