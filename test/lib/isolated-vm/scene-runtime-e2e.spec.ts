import { Quaternion, Vector3 } from '@babylonjs/core'
import { Scene } from '@dcl/schemas'
import { createRpcClient, createRpcServer } from '@dcl/rpc'
import { MemoryTransport } from '@dcl/rpc/dist/transports/Memory'
import { connectContextToRpcServer } from '../../../src/lib/babylon/scene/connect-context-rpc'
import { startIsolatedVmSceneRuntime } from '../../../src/lib/isolated-vm/rpc-scene-runtime'
import type { SceneContext } from '../../../src/lib/babylon/scene/scene-context'
import { sceneIdentity, currentRealm } from '../../../src/lib/decentraland/state'
import { ReadWriteByteBuffer } from '../../../src/lib/decentraland/ByteBuffer'
import { DeleteEntity, PutComponentOperation } from '../../../src/lib/decentraland/crdt-wire-protocol'
import { transformComponent } from '../../../src/lib/decentraland/sdk-components/transform-component'
import { Entity } from '../../../src/lib/decentraland/types'
import { testWithEngine } from '../babylon/babylon-test-helper'

// End-to-end coverage for the PRODUCTION per-scene runtime (startIsolatedVmSceneRuntime,
// used by src/lib/babylon/scene/nodejs-runtime.ts). It drives a real, compiled scene
// bundle through the isolated-vm sandbox and the RPC bridge:
//
//   scene JS  →  isolated-vm eval  →  require('~system/...')  →  @dcl/rpc client
//             →  MemoryTransport  →  connectContextToRpcServer handlers  →  back
//
// Everything is in-memory and mockable — no content server, no LiveKit, no network.
// The repo's other end-to-end coverage (test/integration/*) needs external
// `testing-realm/` scene fixtures that aren't in the tree, so this fills the gap.

const encoder = new TextEncoder()

/**
 * Run `source` as a scene through the real runtime against `context` and return
 * everything it logged. If `start` is provided it runs before onStart (used to
 * start the Babylon render loop so CRDT ticks are processed).
 */
async function runSceneWithContext(
  context: unknown,
  source: string,
  opts: { start?: () => void } = {}
) {
  const rpcServer = createRpcServer<SceneContext>({})
  rpcServer.setHandler(async (port) => {
    connectContextToRpcServer(port)
  })

  const { client: clientSocket, server: serverSocket } = MemoryTransport()
  const clientPromise = createRpcClient(clientSocket)
  rpcServer.attachTransport(serverSocket, context as SceneContext)
  const client = await clientPromise
  const port = await client.createPort('e2e-scene')

  const logs: any[] = []
  const errors: any[] = []

  await startIsolatedVmSceneRuntime(port, {
    log: (...args: any[]) => logs.push(...args),
    error: (...args: any[]) => errors.push(...args),
    async updateLoop(o) {
      if (opts.start) opts.start()
      await o.onStart()
      await o.onUpdate(0)
    }
  })

  return { logs, errors }
}

/** Minimal host context: enough for getStartupData + common RPC handlers. */
function makeFakeContext(source: string, overrides: Record<string, unknown> = {}) {
  return {
    loadableScene: {
      baseUrl: '/',
      urn: '123',
      // `scene.base` is read by the SignedFetch handler when building request metadata.
      entity: { content: [], metadata: { main: 'game.js', scene: { base: '0,0' } } }
    },
    async readFile(fileName: string) {
      if (fileName === 'game.js') return { content: encoder.encode(source), hash: '123' }
      throw new Error('file not found: ' + fileName)
    },
    async crdtGetState() {
      return { data: [], hasEntities: false }
    },
    async crdtSendToRenderer() {
      return { data: [] }
    },
    ...overrides
  }
}

async function runScene(source: string, overrides: Record<string, unknown> = {}) {
  return runSceneWithContext(makeFakeContext(source, overrides), source)
}

/** Serialize a transform component (position only varies) to CRDT component bytes. */
function transformBytes(x: number, y: number, z: number): Uint8Array {
  const b = new ReadWriteByteBuffer()
  transformComponent.serialize(
    { parent: 0 as Entity, position: new Vector3(x, y, z), scale: Vector3.One(), rotation: Quaternion.Identity() },
    b
  )
  return b.toBinary()
}

/** Run a scene (against a real SceneContext) whose onStart sends `crdtBytes` to the host. */
async function runSceneSendingCrdt(env: any, crdtBytes: Uint8Array) {
  const source = `
    const engineApi = require('~system/EngineApi')
    module.exports.onStart = async function () {
      await engineApi.crdtSendToRenderer({ data: new Uint8Array([${Array.from(crdtBytes).join(',')}]) })
    }
    module.exports.onUpdate = async function () {}
  `
  const originalReadFile = env.ctx.readFile.bind(env.ctx)
  jest.spyOn(env.ctx, 'readFile').mockImplementation(async (fileName: string) => {
    if (fileName === 'game.js') return { content: encoder.encode(source), hash: '123' }
    return originalReadFile(fileName)
  })
  return runSceneWithContext(env.ctx, source, { start: () => env.startEngine() })
}

const CRDT_SCENE_PARAMS = {
  baseUrl: '/',
  entity: { content: [{ file: 'game.js', hash: '123' }], metadata: { main: 'game.js' } as Scene, type: 'scene' },
  urn: '123'
} as const

describe('scene runtime end-to-end (isolated-vm + RPC, fully in-memory)', () => {
  it('runs a working scene through the production runtime and round-trips over RPC', async () => {
    const source = `
      const runtime = require('~system/Runtime')
      const engineApi = require('~system/EngineApi')
      module.exports.onStart = async function () {
        console.log('onStart')
        // Real RPC round trip returning host-derived data.
        const info = await runtime.getSceneInformation({})
        console.log('main', JSON.parse(info.metadataJson).main)
        // Real RPC round trip returning bytes: exercises Uint8Array marshalling host -> scene.
        const file = await runtime.readFile({ fileName: 'game.js' })
        console.log('fileIsU8', file.content instanceof Uint8Array)
        // Scene -> host bytes: exercises the EngineApi crdt bridge + coerceMaybeU8Array.
        const r = await engineApi.crdtSendToRenderer({ data: new Uint8Array(0) })
        console.log('crdtDataIsArray', Array.isArray(r.data))
      }
      module.exports.onUpdate = async function (dt) {
        console.log('onUpdate', dt)
      }
    `

    const { logs, errors } = await runScene(source)

    expect(errors).toEqual([])
    expect(logs).toEqual([
      'onStart',
      'main',
      'game.js',
      'fileIsU8',
      true,
      'crdtDataIsArray',
      true,
      'onUpdate',
      0
    ])
  })

  it('evaluates the bundle in a module scope: top-level var does not collide with a globalThis flag', async () => {
    // Regression: the SDK's message-bus-sync declares
    //   var DEBUG_NETWORK_MESSAGES = () => globalThis.DEBUG_NETWORK_MESSAGES ?? false
    // and scenes enable debug logging with `globalThis.DEBUG_NETWORK_MESSAGES = true`.
    // When the bundle was evaluated as a raw global script the var landed on
    // globalThis, the flag assignment overwrote the function, and the next call
    // crashed the scene with "not a function" (seen live with Tower of Madness on
    // player join). Reference runtimes evaluate scenes in a function scope.
    const source = `
      var DEBUG_NETWORK_MESSAGES = () => globalThis.DEBUG_NETWORK_MESSAGES ?? false
      globalThis.DEBUG_NETWORK_MESSAGES = true
      module.exports.onStart = async function () {
        console.log('flagIsBoolean', typeof globalThis.DEBUG_NETWORK_MESSAGES)
        console.log('debugEnabled', DEBUG_NETWORK_MESSAGES())
      }
      module.exports.onUpdate = async function () {}
    `

    const { logs, errors } = await runScene(source)

    expect(errors).toEqual([])
    expect(logs).toEqual(['flagIsBoolean', 'boolean', 'debugEnabled', true])
  })

  it('keeps the sandbox closed for untrusted scene code driven through the runtime', async () => {
    const source = `
      module.exports.onStart = async function () {
        // The classic realm escape resolves to the VM global, which has no host process.
        const g = Function('return this')()
        console.log('processType', typeof g.process)
        // The require bridge only resolves ~system/* modules, never host modules.
        try { require('fs'); console.log('fsBlocked', false) } catch (e) { console.log('fsBlocked', true) }
      }
      module.exports.onUpdate = async function () {}
    `

    const { logs, errors } = await runScene(source)

    expect(errors).toEqual([])
    expect(logs).toEqual(['processType', 'undefined', 'fsBlocked', true])
  })

  it('surfaces a scene error via the error channel without reaching the host', async () => {
    const source = `
      module.exports.onStart = async function () {
        console.error('boom from scene')
      }
      module.exports.onUpdate = async function () {}
    `

    const { logs, errors } = await runScene(source)

    expect(logs).toEqual([])
    expect(errors).toEqual(['boom from scene'])
  })

  describe('security capabilities exposed to the scene', () => {
    beforeEach(() => {
      // The scene must only ever see the unprivileged GUEST identity — never the
      // authoritative server key. currentRealm must be set so the SignedFetch
      // handler can build its metadata.
      sceneIdentity.swap({
        address: '0xguest',
        isGuest: true,
        authChain: [] as any,
        signer: (async () => 'sig') as any
      } as any)
      currentRealm.swap({
        baseUrl: 'https://realm.example',
        connectionString: 'https://realm.example',
        aboutResponse: { configurations: { realmName: 'test-realm' } } as any
      } as any)
    })

    it('reports the guest identity and blocks SSRF, end-to-end through the runtime', async () => {
      const source = `
        const userIdentity = require('~system/UserIdentity')
        const signedFetch = require('~system/SignedFetch')
        module.exports.onStart = async function () {
          const u = await userIdentity.getUserData({})
          console.log('userId', u.data.userId)
          console.log('web3', u.data.hasConnectedWeb3)
          // SSRF: a scene must not be able to reach the cloud-metadata endpoint.
          const res = await signedFetch.signedFetch({
            url: 'http://169.254.169.254/latest/meta-data/',
            init: { method: 'GET', headers: {} }
          })
          console.log('ssrfOk', res.ok)
        }
        module.exports.onUpdate = async function () {}
      `

      const { logs, errors } = await runScene(source)

      expect(errors).toEqual([])
      // Guest identity, not the authoritative server; SSRF request refused (ok:false).
      expect(logs).toEqual(['userId', '0xguest', 'web3', false, 'ssrfOk', false])
    })
  })
})

// A full CRDT round-trip needs a real SceneContext (a Babylon NullEngine), still
// fully in-memory. It proves an untrusted scene's CRDT bytes traverse isolated-vm + RPC
// and actually materialize a host entity + component (through the hardened reader).
testWithEngine(
  'scene runtime end-to-end: CRDT ingest materializes a host entity',
  {
    baseUrl: '/',
    entity: { content: [{ file: 'game.js', hash: '123' }], metadata: { main: 'game.js' } as Scene, type: 'scene' },
    urn: '123'
  },
  ($) => {
    test("a scene's CRDT PutComponent creates the entity and component on the host", async () => {
      const entityId = 512 as Entity

      // Build a valid CRDT PutComponent (transform) on the host and embed its bytes
      // in the scene so the scene sends real, well-formed CRDT over the wire.
      const componentBuffer = new ReadWriteByteBuffer()
      transformComponent.serialize(
        { parent: 0 as Entity, position: new Vector3(7, 8, 9), scale: Vector3.One(), rotation: Quaternion.Identity() },
        componentBuffer
      )
      const crdt = new ReadWriteByteBuffer()
      PutComponentOperation.write(
        { entityId, componentId: transformComponent.componentId, timestamp: 1, data: componentBuffer.toBinary() },
        crdt
      )
      const bytes = Array.from(crdt.toBinary())

      const source = `
        const engineApi = require('~system/EngineApi')
        module.exports.onStart = async function () {
          await engineApi.crdtSendToRenderer({ data: new Uint8Array([${bytes.join(',')}]) })
        }
        module.exports.onUpdate = async function () {}
      `

      // Serve the scene bundle via the runtime's readFile.
      const originalReadFile = $.ctx.readFile.bind($.ctx)
      jest.spyOn($.ctx, 'readFile').mockImplementation(async (fileName: string) => {
        if (fileName === 'game.js') return { content: encoder.encode(source), hash: '123' }
        return originalReadFile(fileName)
      })

      expect($.ctx.entities.has(entityId)).toBe(false)

      const { errors } = await runSceneWithContext($.ctx, source, { start: () => $.startEngine() })

      expect(errors).toEqual([])
      // The untrusted scene's CRDT reached the host entity graph.
      expect($.ctx.entities.has(entityId)).toBe(true)
      // ...and the component data round-tripped intact.
      const transform: any = $.ctx.components[transformComponent.componentId].getOrNull(entityId)
      expect(transform).not.toBeNull()
      expect(transform.position.x).toBeCloseTo(7, 4)
    })
  }
)

testWithEngine(
  'scene runtime end-to-end: DELETE_ENTITY removes only the targeted host entity',
  CRDT_SCENE_PARAMS,
  ($) => {
    test('a scene that creates two entities and deletes one leaves the other intact', async () => {
      const keep = 601 as Entity
      const drop = 602 as Entity

      const crdt = new ReadWriteByteBuffer()
      PutComponentOperation.write(
        { entityId: keep, componentId: transformComponent.componentId, timestamp: 1, data: transformBytes(1, 1, 1) },
        crdt
      )
      PutComponentOperation.write(
        { entityId: drop, componentId: transformComponent.componentId, timestamp: 1, data: transformBytes(2, 2, 2) },
        crdt
      )
      DeleteEntity.write({ entityId: drop }, crdt)

      const { errors } = await runSceneSendingCrdt($, crdt.toBinary())

      expect(errors).toEqual([])
      expect($.ctx.entities.has(keep)).toBe(true)
      expect($.ctx.entities.has(drop)).toBe(false)
    })
  }
)

testWithEngine(
  'scene runtime end-to-end: CRDT LWW conflict resolution',
  CRDT_SCENE_PARAMS,
  ($) => {
    test('the highest-timestamp write wins and a stale write is rejected', async () => {
      const entityId = 700 as Entity

      const crdt = new ReadWriteByteBuffer()
      // ts 1 → x=1, then ts 2 → x=2 (should win), then a stale ts 1 → x=99 (must be rejected).
      PutComponentOperation.write(
        { entityId, componentId: transformComponent.componentId, timestamp: 1, data: transformBytes(1, 0, 0) },
        crdt
      )
      PutComponentOperation.write(
        { entityId, componentId: transformComponent.componentId, timestamp: 2, data: transformBytes(2, 0, 0) },
        crdt
      )
      PutComponentOperation.write(
        { entityId, componentId: transformComponent.componentId, timestamp: 1, data: transformBytes(99, 0, 0) },
        crdt
      )

      const { errors } = await runSceneSendingCrdt($, crdt.toBinary())

      expect(errors).toEqual([])
      const transform: any = $.ctx.components[transformComponent.componentId].getOrNull(entityId)
      expect(transform).not.toBeNull()
      expect(transform.position.x).toBeCloseTo(2, 4)
    })
  }
)
