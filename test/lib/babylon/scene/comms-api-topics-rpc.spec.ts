import type { RpcClientPort } from '@dcl/rpc'
import { Scene } from '@dcl/schemas'
import mitt from 'mitt'
import { MsgType } from '../../../../src/lib/babylon/scene/scene-context'
import { testWithEngine } from '../babylon-test-helper'
import { limits } from '../../../../src/lib/misc/limits'

// NOTE: this project's jest transformer (esbuild) does not hoist `jest.mock`
// above imports, so the RPC pieces are `require`d rather than imported.
const { createRpcClient, createRpcServer } = require('@dcl/rpc')
const { MemoryTransport } = require('@dcl/rpc/dist/transports/Memory')
const { connectContextToRpcServer } = require('../../../../src/lib/babylon/scene/connect-context-rpc')
const { loadModuleForPort } = require('../../../../src/lib/common-runtime/modules')

// End-to-end coverage of ~system/CommsApi topics: a scene call crosses a real
// @dcl/rpc port into the real SceneContext, and inbound peer packets arrive the
// way the transport delivers them.

const textDecoder = new TextDecoder()
const makeEmitter = () => mitt<Record<string, any>>()

type SentMessage = { sceneId: string; data: Uint8Array }

testWithEngine(
  'comms api topics over rpc',
  {
    baseUrl: '/',
    entity: { content: [], metadata: {} as Scene, type: 'scene' },
    urn: 'comms-api-rpc-spec'
  },
  ($) => {
    let transport: { events: ReturnType<typeof makeEmitter>; sendParcelSceneMessage: jest.Mock }
    let sent: SentMessage[]
    let commsApi: any

    beforeEach(async () => {
      sent = []
      transport = {
        events: makeEmitter(),
        sendParcelSceneMessage: jest.fn(async (message: SentMessage) => {
          sent.push(message)
        })
      }
      $.ctx.attachLivekitTransport(transport as any)

      const rpcServer = createRpcServer({})
      rpcServer.setHandler(async (port: any) => connectContextToRpcServer(port))
      const { client: clientSocket, server: serverSocket } = MemoryTransport()
      const clientPromise = createRpcClient(clientSocket)
      rpcServer.attachTransport(serverSocket, $.ctx)
      const client = await clientPromise
      const port: RpcClientPort = await client.createPort('comms-api-test')
      commsApi = loadModuleForPort(port, '~system/CommsApi')
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    describe('when a scene publishes data to a topic', () => {
      beforeEach(async () => {
        await commsApi.publishData({ topic: 'chat', data: 'hello' })
      })

      it('should send exactly one scene packet over the transport', () => {
        expect(sent).toHaveLength(1)
      })

      it('should tag the packet as CommsData so real clients route it to their topic buffers', () => {
        expect(sent[0].data[0]).toBe(MsgType.CommsData)
      })

      it('should carry the topic and payload after the type byte', () => {
        expect(textDecoder.decode(sent[0].data.subarray(3))).toBe('chathello')
      })
    })

    describe('when a scene publishes a payload larger than the per-message cap', () => {
      beforeEach(async () => {
        await commsApi.publishData({ topic: 'chat', data: 'x'.repeat(limits.maxCommsMessageBytes + 1) })
      })

      // Same ceiling sendBinary applies: this is scene-controlled data going out
      // over LiveKit, so an oversized publish must not reach the transport.
      it('should not send anything over the transport', () => {
        expect(sent).toHaveLength(0)
      })
    })

    describe('when a peer sends topic data the scene is subscribed to', () => {
      let consumed: { messages: Array<{ sender: string; data: string }> }

      beforeEach(async () => {
        await commsApi.subscribeToTopic({ topic: 'chat' })
        const frame = new Uint8Array([MsgType.CommsData, 4, 0, 99, 104, 97, 116, 104, 105])
        transport.events.emit('sceneMessageBus', {
          address: '0xpeer',
          data: { sceneId: $.ctx.entityId, data: frame }
        })
        consumed = await commsApi.consumeMessages({ topic: 'chat' })
      })

      it('should deliver the payload to the subscribing scene', () => {
        expect(consumed.messages).toEqual([{ sender: '0xpeer', data: 'hi' }])
      })

      // The MessageBus and CommsApi share the rfc4 Scene packet. Before the type
      // check, every topic payload was ALSO appended to the MessageBus queue as
      // an untagged blob the scene had no way to distinguish.
      it('should not also deliver it to the MessageBus queue', () => {
        expect($.ctx.getNetworkMessages()).toHaveLength(0)
      })
    })

    describe('when a peer sends an ordinary MessageBus packet', () => {
      beforeEach(() => {
        transport.events.emit('sceneMessageBus', {
          address: '0xpeer',
          data: { sceneId: $.ctx.entityId, data: new Uint8Array([MsgType.Uint8Array, 1, 2, 3]) }
        })
      })

      it('should still route it to the MessageBus queue', () => {
        expect($.ctx.getNetworkMessages()).toHaveLength(1)
      })
    })

    describe('when a scene unsubscribes and a peer keeps publishing on that topic', () => {
      let consumed: { messages: Array<{ sender: string; data: string }> }

      beforeEach(async () => {
        await commsApi.subscribeToTopic({ topic: 'chat' })
        await commsApi.unsubscribeFromTopic({ topic: 'chat' })
        transport.events.emit('sceneMessageBus', {
          address: '0xpeer',
          data: { sceneId: $.ctx.entityId, data: new Uint8Array([MsgType.CommsData, 4, 0, 99, 104, 97, 116, 104, 105]) }
        })
        consumed = await commsApi.consumeMessages({ topic: 'chat' })
      })

      it('should stop buffering messages for it', () => {
        expect(consumed.messages).toEqual([])
      })
    })
  }
)
