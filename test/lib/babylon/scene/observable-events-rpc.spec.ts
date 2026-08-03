import type { RpcClientPort } from '@dcl/rpc'
import { Scene } from '@dcl/schemas'
import mitt from 'mitt'
import { MsgType } from '../../../../src/lib/babylon/scene/scene-context'
import { SDK_OBSERVABLE_EVENTS } from '../../../../src/lib/babylon/scene/logic/observable-events'
import { limits } from '../../../../src/lib/misc/limits'
import { testWithEngine } from '../babylon-test-helper'

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

type DrainedEvent = { eventId: string; data: any }

testWithEngine(
  'sdk observable events over rpc',
  {
    baseUrl: '/',
    entity: { content: [], metadata: SCENE_METADATA, type: 'scene' },
    urn: 'observable-events-spec'
  },
  ($) => {
    let transport: { events: ReturnType<typeof makeEmitter> }
    let engineApi: any

    beforeEach(async () => {
      playerEntityManager.clear()
      transport = { events: makeEmitter() }
      $.ctx.attachLivekitTransport(transport as any)

      const rpcServer = createRpcServer({})
      rpcServer.setHandler(async (port: any) => connectContextToRpcServer(port))
      const { client: clientSocket, server: serverSocket } = MemoryTransport()
      const clientPromise = createRpcClient(clientSocket)
      rpcServer.attachTransport(serverSocket, $.ctx)
      const client = await clientPromise
      const port: RpcClientPort = await client.createPort('observable-events-test')
      engineApi = loadModuleForPort(port, '~system/EngineApi')

      // Each test starts from a clean queue and no subscriptions: the
      // SceneContext is shared across this file.
      for (const eventId of Object.values(SDK_OBSERVABLE_EVENTS)) {
        $.ctx.observableEvents.unsubscribe(eventId)
      }
      $.ctx.observableEvents.drain()
    })

    afterEach(() => {
      playerEntityManager.clear()
    })

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
        $.ctx.update(() => true)
        expect(idsOf(await drain())).toContain(SDK_OBSERVABLE_EVENTS.playerConnected)
      })

      it('should drain the queue so the same event is not delivered twice', async () => {
        transport.events.emit('position', { address: '0xAlice', data: positionPacket(8, 0, 8) })
        $.ctx.update(() => true)
        await drain()
        expect(await drain()).toEqual([])
      })
    })

    describe('when a scene has not subscribed to an event that occurs', () => {
      beforeEach(() => {
        transport.events.emit('position', { address: '0xAlice', data: positionPacket(8, 0, 8) })
        $.ctx.update(() => true)
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
        $.ctx.update(() => true)
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
        $.ctx.update(() => true)
        await drain()

        transport.events.emit('position', { address: '0xAlice', data: positionPacket(500, 0, 500) })
        $.ctx.update(() => true)
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
        $.ctx.update(() => true)
        await drain()

        transport.events.emit('position', { address: '0xAlice', data: positionPacket(9, 0, 9) })
        $.ctx.update(() => true)
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
        $.ctx.update(() => true)
        await drain()

        transport.events.emit('PEER_DISCONNECTED', { address: '0xAlice' })
        $.ctx.update(() => true)
        events = await drain()
      })

      // A scene tracking occupancy must not be left with a stale occupant, so
      // the leave is emitted before the disconnect.
      it('should report it leaving the scene before disconnecting', () => {
        expect(idsOf(events)).toEqual([
          SDK_OBSERVABLE_EVENTS.leaveScene,
          SDK_OBSERVABLE_EVENTS.playerDisconnected
        ])
      })
    })

    describe('when a remote peer plays an emote', () => {
      let events: DrainedEvent[]

      beforeEach(async () => {
        await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.playerExpression })
        transport.events.emit('position', { address: '0xAlice', data: positionPacket(8, 0, 8) })
        transport.events.emit('playerEmote', { address: '0xAlice', data: { urn: 'wave' } })
        events = await drain()
      })

      it('should report the expression id the peer sent', () => {
        expect(events).toEqual([
          { eventId: SDK_OBSERVABLE_EVENTS.playerExpression, data: { expressionId: 'wave' } }
        ])
      })
    })

    describe('when a peer sends a string message bus payload', () => {
      let events: DrainedEvent[]

      beforeEach(async () => {
        await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.comms })
        // [MsgType.String]['h','i']
        transport.events.emit('sceneMessageBus', {
          address: '0xAlice',
          data: { sceneId: $.ctx.entityId, data: new Uint8Array([MsgType.String, 104, 105]) }
        })
        events = await drain()
      })

      it('should report it on the comms observable with its sender', () => {
        expect(events).toEqual([
          { eventId: SDK_OBSERVABLE_EVENTS.comms, data: { sender: '0xAlice', message: 'hi' } }
        ])
      })
    })

    describe('when a peer sends a binary message bus payload', () => {
      beforeEach(async () => {
        await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.comms })
        transport.events.emit('sceneMessageBus', {
          address: '0xAlice',
          data: { sceneId: $.ctx.entityId, data: new Uint8Array([MsgType.Uint8Array, 1, 2, 3]) }
        })
      })

      // Binary MessageBus traffic is the SDK's own network protocol, not
      // scene-authored chat; decoding it as text would hand scenes mojibake.
      it('should not report it on the comms observable', async () => {
        expect(await drain()).toEqual([])
      })
    })

    describe('when a scene unsubscribes from an event it had queued', () => {
      beforeEach(async () => {
        await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.playerConnected })
        transport.events.emit('position', { address: '0xAlice', data: positionPacket(8, 0, 8) })
        $.ctx.update(() => true)
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
        expect($.ctx.observableEvents.isSubscribed('notARealEvent')).toBe(false)
      })
    })

    describe('when a scene subscribes but never polls while peers churn', () => {
      beforeEach(async () => {
        await engineApi.subscribe({ eventId: SDK_OBSERVABLE_EVENTS.comms })
        for (let i = 0; i < limits.maxObservableEventQueue + 50; i++) {
          transport.events.emit('sceneMessageBus', {
            address: '0xAlice',
            data: { sceneId: $.ctx.entityId, data: new Uint8Array([MsgType.String, 104, 105]) }
          })
        }
      })

      it('should bound the queue at its cap', async () => {
        expect(await drain()).toHaveLength(limits.maxObservableEventQueue)
      })
    })
  }
)
