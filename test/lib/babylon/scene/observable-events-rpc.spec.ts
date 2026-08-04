import type { RpcClientPort } from '@dcl/rpc'
import * as BABYLON from '@babylonjs/core'
import { Scene } from '@dcl/schemas'
import mitt from 'mitt'
import { MsgType, SceneContext } from '../../../../src/lib/babylon/scene/scene-context'
import { SDK_OBSERVABLE_EVENTS } from '../../../../src/lib/babylon/scene/logic/observable-events'
import { limits } from '../../../../src/lib/misc/limits'

// NOTE: this project's jest transformer (esbuild) does not hoist `jest.mock`
// above imports, so the RPC pieces are `require`d rather than imported.
const { createRpcClient, createRpcServer } = require('@dcl/rpc')
const { MemoryTransport } = require('@dcl/rpc/dist/transports/Memory')
const { connectContextToRpcServer } = require('../../../../src/lib/babylon/scene/connect-context-rpc')
const { loadModuleForPort } = require('../../../../src/lib/common-runtime/modules')
const { playerEntityManager } = require('../../../../src/lib/decentraland/communications/player-entity-manager')

// EngineApi.subscribe/unsubscribe used to throw `not implemented` and sendBatch
// always returned an empty list, so `@dcl/sdk/observables` got a rejection.
// These drive the real RPC surface and feed peers in over the transport.

const makeEmitter = () => mitt<Record<string, any>>()

// Scene occupies parcel 0,0 only: world x/z in [0,16) is inside it.
const SCENE_METADATA = { scene: { base: '0,0', parcels: ['0,0'] } } as unknown as Scene

function positionPacket(x: number, y: number, z: number) {
  return { positionX: x, positionY: y, positionZ: z, rotationX: 0, rotationY: 0, rotationZ: 0, rotationW: 1 }
}

function stringMessageBusPayload(message: string): Uint8Array {
  const body = new TextEncoder().encode(message)
  const payload = new Uint8Array(body.byteLength + 1)
  payload[0] = MsgType.String
  payload.set(body, 1)
  return payload
}

type DrainedEvent = { eventId: string; data: any }

describe('sdk observable events over rpc', () => {
  // A SceneContext PER TEST. The shared one this file used to build in `beforeAll`
  // never disposed the avatar system `attachLivekitTransport` creates, so undisposed
  // systems and their subscriptions piled up across the file -- and the peer snapshot
  // and the sceneStart latch leaked between tests, which are exactly what several of
  // these assert on.
  let engine: BABYLON.NullEngine
  let babylonScene: BABYLON.Scene
  let ctx: SceneContext
  let transport: { events: ReturnType<typeof makeEmitter> }
  let engineApi: any

  beforeEach(async () => {
    playerEntityManager.clear()
    engine = new BABYLON.NullEngine()
    babylonScene = new BABYLON.Scene(engine)
    ctx = new SceneContext(
      babylonScene,
      { baseUrl: '/', entity: { content: [], metadata: SCENE_METADATA, type: 'scene' }, urn: 'observable-events-spec' },
      false,
      ''
    )
    ctx.log = () => void 0
    transport = { events: makeEmitter() }
    ctx.attachLivekitTransport(transport as any)

    const rpcServer = createRpcServer({})
    rpcServer.setHandler(async (port: any) => connectContextToRpcServer(port))
    const { client: clientSocket, server: serverSocket } = MemoryTransport()
    const clientPromise = createRpcClient(clientSocket)
    rpcServer.attachTransport(serverSocket, ctx)
    const client = await clientPromise
    const port: RpcClientPort = await client.createPort('observable-events-test')
    engineApi = loadModuleForPort(port, '~system/EngineApi')
  })

  afterEach(() => {
    ctx.dispose()
    babylonScene.dispose()
    engine.dispose()
    playerEntityManager.clear()
    jest.restoreAllMocks()
  })

  /** One renderer frame: the peer diff runs at the end of update(). */
  function frame() {
    ctx.update(() => true)
  }

  /** A frame that is actually DELIVERED to the scene, which is what emits sceneStart. */
  async function deliveredFrame() {
    ctx.update(() => true)
    const delivered = ctx.nextTick()
    ctx.lateUpdate()
    await delivered
  }

  async function drain(): Promise<DrainedEvent[]> {
    const batch = await engineApi.sendBatch({ actions: [] })
    return batch.events.map((event: any) => ({
      eventId: event.generic.eventId,
      data: JSON.parse(event.generic.eventData)
    }))
  }

  function idsOf(events: DrainedEvent[]): string[] {
    return events.map((event) => event.eventId)
  }

  describe('when a scene subscribes to an event', () => {
    beforeEach(async () => {
      await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.playerConnected })
    })

    it('should resolve instead of throwing not-implemented', async () => {
      await expect(engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.playerConnected })).resolves.toBeDefined()
    })

    it('should deliver a matching event on the next sendBatch', async () => {
      transport.events.emit('position', { address: '0xAlice', data: positionPacket(8, 0, 8) })
      frame()
      expect(idsOf(await drain())).toContain(SDK_OBSERVABLE_EVENTS.playerConnected)
    })

    it('should drain the queue so the same event is not delivered twice', async () => {
      transport.events.emit('position', { address: '0xAlice', data: positionPacket(8, 0, 8) })
      frame()
      await drain()
      expect(await drain()).toEqual([])
    })
  })

  describe('when a scene has not subscribed to an event that occurs', () => {
    beforeEach(() => {
      transport.events.emit('position', { address: '0xAlice', data: positionPacket(8, 0, 8) })
      frame()
    })

    it('should not queue it', async () => {
      expect(await drain()).toEqual([])
    })
  })

  describe('when a peer connects inside the scene parcels', () => {
    let events: DrainedEvent[]

    beforeEach(async () => {
      await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.playerConnected })
      await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.enterScene })
      transport.events.emit('position', { address: '0xAlice', data: positionPacket(8, 0, 8) })
      frame()
      events = await drain()
    })

    it('should report the connection', () => {
      expect(idsOf(events)).toContain(SDK_OBSERVABLE_EVENTS.playerConnected)
    })

    it('should also report it entering the scene', () => {
      expect(idsOf(events)).toContain(SDK_OBSERVABLE_EVENTS.enterScene)
    })

    it('should carry the peer address as the userId', () => {
      expect(events.find((e) => e.eventId === SDK_OBSERVABLE_EVENTS.playerConnected)!.data).toEqual({
        userId: '0xalice'
      })
    })
  })

  describe('when a peer walks out of the scene parcels', () => {
    let events: DrainedEvent[]

    beforeEach(async () => {
      await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.enterScene })
      await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.leaveScene })
      transport.events.emit('position', { address: '0xAlice', data: positionPacket(8, 0, 8) })
      frame()
      await drain()

      transport.events.emit('position', { address: '0xAlice', data: positionPacket(500, 0, 500) })
      frame()
      events = await drain()
    })

    it('should report it leaving the scene', () => {
      expect(idsOf(events)).toEqual([SDK_OBSERVABLE_EVENTS.leaveScene])
    })
  })

  describe('when a peer stays inside the scene across frames', () => {
    let events: DrainedEvent[]

    beforeEach(async () => {
      await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.enterScene })
      transport.events.emit('position', { address: '0xAlice', data: positionPacket(8, 0, 8) })
      frame()
      await drain()

      transport.events.emit('position', { address: '0xAlice', data: positionPacket(9, 0, 9) })
      frame()
      events = await drain()
    })

    // Enter/leave are transitions. Re-emitting every frame would flood a scene
    // that just wants to know when occupancy changes.
    it('should not re-report the enter event', () => {
      expect(events).toEqual([])
    })
  })

  describe('when a peer disconnects while standing inside the scene', () => {
    let events: DrainedEvent[]

    beforeEach(async () => {
      await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.leaveScene })
      await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.playerDisconnected })
      transport.events.emit('position', { address: '0xAlice', data: positionPacket(8, 0, 8) })
      frame()
      await drain()

      transport.events.emit('PEER_DISCONNECTED', { address: '0xAlice' })
      frame()
      events = await drain()
    })

    // A scene tracking occupancy must not be left with a stale occupant, so
    // the leave is emitted before the disconnect.
    it('should report it leaving the scene before disconnecting', () => {
      expect(idsOf(events)).toEqual([SDK_OBSERVABLE_EVENTS.leaveScene, SDK_OBSERVABLE_EVENTS.playerDisconnected])
    })
  })

  describe('when a peer disconnects and reconnects between two frames', () => {
    let events: DrainedEvent[]

    beforeEach(async () => {
      for (const eventId of [
        SDK_OBSERVABLE_EVENTS.playerConnected,
        SDK_OBSERVABLE_EVENTS.playerDisconnected,
        SDK_OBSERVABLE_EVENTS.enterScene,
        SDK_OBSERVABLE_EVENTS.leaveScene
      ]) {
        await engineApi.subscribe({ eventId })
      }
      // A stationary peer standing inside the scene: it never moves, so nothing but
      // the reconnect itself can produce an enter/leave.
      transport.events.emit('position', { address: '0xAlice', data: positionPacket(8, 0, 8) })
      frame()
      await drain()

      transport.events.emit('PEER_DISCONNECTED', { address: '0xAlice' })
      transport.events.emit('PEER_CONNECTED', { address: '0xAlice' })
      transport.events.emit('position', { address: '0xAlice', data: positionPacket(8, 0, 8) })
      frame()
      events = await drain()
    })

    // The address never left the peer set across a frame boundary, so an
    // address-keyed diff saw no change at all -- while the reconnect HAD cleared the
    // peer's last known position, which fabricated a phantom onLeaveScene for a
    // player that never moved and hid the reconnect entirely. Presence is keyed on
    // the generationally-versioned entity id instead.
    it('should report the session ending and a new one starting', () => {
      expect(idsOf(events)).toEqual([
        SDK_OBSERVABLE_EVENTS.leaveScene,
        SDK_OBSERVABLE_EVENTS.playerDisconnected,
        SDK_OBSERVABLE_EVENTS.playerConnected,
        SDK_OBSERVABLE_EVENTS.enterScene
      ])
    })
  })

  describe('when a peer is already present before the scene subscribes', () => {
    beforeEach(async () => {
      // The normal path: attachLivekitTransport runs before the scene bundle, so
      // update() has been running for frames by the time the SDK issues its first
      // subscribe (it only does so when the scene registers an observer in main()).
      transport.events.emit('position', { address: '0xAlice', data: positionPacket(8, 0, 8) })
      frame()

      for (const eventId of [
        SDK_OBSERVABLE_EVENTS.playerConnected,
        SDK_OBSERVABLE_EVENTS.playerDisconnected,
        SDK_OBSERVABLE_EVENTS.enterScene,
        SDK_OBSERVABLE_EVENTS.leaveScene
      ]) {
        await engineApi.subscribe({ eventId })
      }
    })

    it('should not replay it as a fresh connection', async () => {
      frame()
      expect(await drain()).toEqual([])
    })

    describe('and that peer then disconnects', () => {
      beforeEach(() => {
        frame()
        transport.events.emit('PEER_DISCONNECTED', { address: '0xAlice' })
        frame()
      })

      // The scene was never told this peer arrived, so it must not be told it left:
      // a leave-without-enter (or disconnect-without-connect) corrupts any occupancy
      // map a scene builds from these events.
      it('should not report a departure for a peer it was never told about', async () => {
        expect(await drain()).toEqual([])
      })
    })

    describe('and that peer then walks out of the scene', () => {
      let events: DrainedEvent[]

      beforeEach(async () => {
        frame()
        transport.events.emit('position', { address: '0xAlice', data: positionPacket(500, 0, 500) })
        frame()
        events = await drain()
      })

      // Introduced first, and with the state it HAD, so the scene sees a coherent
      // arrival-then-departure rather than a leave for someone who never entered.
      it('should introduce it before reporting the move out', () => {
        expect(idsOf(events)).toEqual([
          SDK_OBSERVABLE_EVENTS.playerConnected,
          SDK_OBSERVABLE_EVENTS.enterScene,
          SDK_OBSERVABLE_EVENTS.leaveScene
        ])
      })
    })
  })

  describe('when a peer announces a new profile version', () => {
    let events: DrainedEvent[]

    beforeEach(async () => {
      await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.profileChanged })
      transport.events.emit('position', { address: '0xAlice', data: positionPacket(8, 0, 8) })
      frame()
      await drain()

      jest.spyOn(ctx.avatarSystem as any, 'listKnownPeers').mockImplementation(() => [
        { address: '0xalice', entity: 32, worldPosition: new BABYLON.Vector3(8, 0, 8), profile: { version: 5 } }
      ])
      frame()
      events = await drain()
    })

    it('should report the change with the announced version', () => {
      expect(events).toEqual([
        { eventId: SDK_OBSERVABLE_EVENTS.profileChanged, data: { ethAddress: '0xalice', version: 5 } }
      ])
    })

    describe('and the same version is announced again', () => {
      beforeEach(async () => {
        frame()
        events = await drain()
      })

      // Only a version that moved FORWARD is a change. Announcements are
      // peer-controlled, so a replayed or equal version must not re-fire.
      it('should not report it again', () => {
        expect(events).toEqual([])
      })
    })

    describe('and a LOWER version is announced afterwards', () => {
      beforeEach(async () => {
        jest.spyOn(ctx.avatarSystem as any, 'listKnownPeers').mockImplementation(() => [
          { address: '0xalice', entity: 32, worldPosition: new BABYLON.Vector3(8, 0, 8), profile: { version: 2 } }
        ])
        frame()
        events = await drain()
      })

      it('should not report an out-of-order rollback as a change', () => {
        expect(events).toEqual([])
      })
    })
  })

  describe('when the scene starts', () => {
    beforeEach(async () => {
      // sceneStart is emitted on the frame that resolves the scene's FIRST crdt rpc,
      // which is strictly before a scene registering observers in main() can have
      // subscribed. It is also the one event with no natural re-trigger.
      await deliveredFrame()
    })

    it('should deliver it to a scene that subscribes afterwards', async () => {
      await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.sceneStart })
      expect(idsOf(await drain())).toEqual([SDK_OBSERVABLE_EVENTS.sceneStart])
    })

    it('should deliver it exactly once', async () => {
      await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.sceneStart })
      await drain()
      await deliveredFrame()
      expect(await drain()).toEqual([])
    })

    it('should not deliver it to a scene that never subscribes', async () => {
      expect(await drain()).toEqual([])
    })
  })

  describe('when a scene subscribes to sceneStart before the first frame is delivered', () => {
    beforeEach(async () => {
      await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.sceneStart })
      await deliveredFrame()
    })

    it('should deliver it on the next sendBatch', async () => {
      expect(idsOf(await drain())).toEqual([SDK_OBSERVABLE_EVENTS.sceneStart])
    })
  })

  describe('when a remote peer plays an emote', () => {
    beforeEach(async () => {
      await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.playerExpression })
      transport.events.emit('position', { address: '0xAlice', data: positionPacket(8, 0, 8) })
      transport.events.emit('playerEmote', { address: '0xAlice', data: { urn: 'wave' } })
      frame()
    })

    // playerExpression is the LOCAL player's expression: the reference client's
    // payload has no user field, so routing 224 remote peers into it hands the scene
    // an event it cannot attribute. Remote emotes reach SDK7 scenes as
    // AvatarEmoteCommand on the emoting peer's own entity instead.
    it('should not report it on the playerExpression observable', async () => {
      expect(await drain()).toEqual([])
    })
  })

  describe('when a peer sends a string message bus payload', () => {
    let events: DrainedEvent[]

    beforeEach(async () => {
      await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.comms })
      transport.events.emit('sceneMessageBus', {
        address: '0xAliCE',
        data: { sceneId: ctx.entityId, data: stringMessageBusPayload('hi') }
      })
      events = await drain()
    })

    it('should report it on the comms observable with its message', () => {
      expect(events.map((event) => event.data.message)).toEqual(['hi'])
    })

    // Every other event, and everything ~system/Players reports, is lowercase.
    // LiveKit identities are checksummed, so a raw-case sender broke the canonical
    // `if (connectedPlayers.has(sender))` MessageBus pattern.
    it('should report the sender normalized', () => {
      expect(events.map((event) => event.data.sender)).toEqual(['0xalice'])
    })
  })

  describe('when a peer sends a binary message bus payload', () => {
    beforeEach(async () => {
      await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.comms })
      transport.events.emit('sceneMessageBus', {
        address: '0xAlice',
        data: { sceneId: ctx.entityId, data: new Uint8Array([MsgType.Uint8Array, 1, 2, 3]) }
      })
    })

    // Binary MessageBus traffic is the SDK's own network protocol, not
    // scene-authored chat; decoding it as text would hand scenes mojibake.
    it('should not report it on the comms observable', async () => {
      expect(await drain()).toEqual([])
    })
  })

  describe('when a peer sends a message bus payload with an oversized sender', () => {
    beforeEach(async () => {
      await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.comms })
      transport.events.emit('sceneMessageBus', {
        address: '0x'.padEnd(402, 'a'),
        data: { sceneId: ctx.entityId, data: stringMessageBusPayload('hi') }
      })
    })

    // The MessageBus framing drops it (the sender length is a single byte). One
    // packet must not be delivered on one channel and dropped on the other.
    it('should drop it on the comms observable too', async () => {
      expect(await drain()).toEqual([])
    })

    it('should drop it on the message bus', () => {
      expect(ctx.getNetworkMessages()).toEqual([])
    })
  })

  describe('when a scene unsubscribes from an event it had queued', () => {
    beforeEach(async () => {
      await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.playerConnected })
      transport.events.emit('position', { address: '0xAlice', data: positionPacket(8, 0, 8) })
      frame()
      await engineApi.unsubscribe({ eventId: SDK_OBSERVABLE_EVENTS.playerConnected })
    })

    it('should discard the backlog nothing can consume any more', async () => {
      expect(await drain()).toEqual([])
    })
  })

  describe('when a scene subscribes to an event id this server does not produce', () => {
    beforeEach(async () => {
      await engineApi.subscribe({ eventId: 'notARealEvent' })
    })

    it('should accept the call without recording the subscription', () => {
      expect(ctx.observableEvents.isSubscribed('notARealEvent')).toBe(false)
    })
  })

  describe('when a scene subscribes to an event this server accepts but never fires', () => {
    beforeEach(async () => {
      await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.playerClicked })
      await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.realmChanged })
      transport.events.emit('position', { address: '0xAlice', data: positionPacket(8, 0, 8) })
      transport.events.emit('playerEmote', { address: '0xAlice', data: { urn: 'wave' } })
      frame()
    })

    // playerClicked needs pointer picking against avatar meshes headless does not
    // have; onRealmChanged cannot happen when a worker serves one scene in one realm
    // for its whole life. Both are accepted so the scene keeps running.
    it('should record the subscription so the scene keeps running', () => {
      expect(ctx.observableEvents.isSubscribed(SDK_OBSERVABLE_EVENTS.playerClicked)).toBe(true)
    })

    it('should never deliver anything for them', async () => {
      expect(await drain()).toEqual([])
    })
  })

  describe('when a scene subscribes but never polls while peers chat', () => {
    let events: DrainedEvent[]

    beforeEach(async () => {
      await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.comms })
      // Distinguishable payloads: identical ones cannot tell drop-oldest from
      // drop-newest, which is the only thing this cap has to get right.
      for (let i = 0; i < limits.maxObservableEventQueue + 50; i++) {
        transport.events.emit('sceneMessageBus', {
          address: '0xAlice',
          data: { sceneId: ctx.entityId, data: stringMessageBusPayload(`m${i}`) }
        })
      }
      events = await drain()
    })

    it('should bound the queue at its cap', () => {
      expect(events).toHaveLength(limits.maxObservableEventQueue)
    })

    it('should keep the newest messages and drop the oldest', () => {
      expect(events[events.length - 1].data.message).toBe(`m${limits.maxObservableEventQueue + 49}`)
    })

    it('should have dropped exactly the first ones', () => {
      expect(events[0].data.message).toBe('m50')
    })
  })

  describe('when a scene subscribes but never polls while peers send large messages', () => {
    beforeEach(async () => {
      await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.comms })
      // Each comms event embeds the whole message body, so the count cap alone let
      // this queue hold cap x maxCommsMessageBytes -- ~30MB per scene.
      const body = 'x'.repeat(20_000)
      for (let i = 0; i < 250; i++) {
        transport.events.emit('sceneMessageBus', {
          address: '0xAlice',
          data: { sceneId: ctx.entityId, data: stringMessageBusPayload(body) }
        })
      }
    })

    it('should hold it under the byte cap', () => {
      expect(ctx.observableEvents.queuedBytes).toBeLessThanOrEqual(limits.maxObservableEventQueueBytes)
    })

    it('should bound it by bytes long before the count cap is reached', () => {
      expect(ctx.observableEvents.queued).toBeLessThan(limits.maxObservableEventQueue)
    })

    it('should still deliver the newest messages it kept', async () => {
      const events = await drain()
      expect(events[events.length - 1].data.message).toHaveLength(20_000)
    })
  })

  describe('when the scene is disposed', () => {
    beforeEach(async () => {
      await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.comms })
      transport.events.emit('sceneMessageBus', {
        address: '0xAlice',
        data: { sceneId: ctx.entityId, data: stringMessageBusPayload('hi') }
      })
      ctx.dispose()
    })

    it('should drop the queued events nothing will ever drain', () => {
      expect(ctx.observableEvents.queued).toBe(0)
    })

    it('should drop the subscriptions', () => {
      expect(ctx.observableEvents.isSubscribed(SDK_OBSERVABLE_EVENTS.comms)).toBe(false)
    })
  })
})
