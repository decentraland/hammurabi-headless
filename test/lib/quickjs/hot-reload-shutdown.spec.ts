import { createRpcClient, createRpcServer } from '@dcl/rpc'
import { MemoryTransport } from '@dcl/rpc/dist/transports/Memory'
import { connectContextToRpcServer } from '../../../src/lib/babylon/scene/connect-context-rpc'
import { startQuickJsSceneRuntime } from '../../../src/lib/quick-js/rpc-scene-runtime'
import { defaultUpdateLoop, isTransportClosedError } from '../../../src/lib/common-runtime/game-loop'
import type { SceneContext } from '../../../src/lib/babylon/scene/scene-context'

// End-to-end pin for the hot-reload shutdown path, using the PRODUCTION update
// loop (defaultUpdateLoop): closing the scene's RPC transport — what
// SceneContext.dispose() does on hot reload — must end the runtime CLEANLY,
// with the abandoned in-flight RPC classified as a shutdown rather than
// surfacing as the spurious error this fix removed. Before the fix the old VM
// hung on the dead RPC until the 60s async-turn timeout killed it.

const encoder = new TextEncoder()

type Harness = {
  runtime: Promise<void>
  close: () => void
  logs: any[]
  errors: any[]
}

async function startRuntime(source: string, contextOverrides: Record<string, unknown>): Promise<Harness> {
  const rpcServer = createRpcServer<SceneContext>({})
  rpcServer.setHandler(async (port) => {
    connectContextToRpcServer(port)
  })

  const context = {
    loadableScene: {
      baseUrl: '/',
      urn: 'hot-reload-test',
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
    ...contextOverrides
  }

  const memoryTransport = MemoryTransport()
  const clientPromise = createRpcClient(memoryTransport.client)
  rpcServer.attachTransport(memoryTransport.server, context as unknown as SceneContext)
  const client = await clientPromise
  const port = await client.createPort('hot-reload-test-scene')

  const logs: any[] = []
  const errors: any[] = []

  const runtime = startQuickJsSceneRuntime(port, {
    log: (...args: any[]) => logs.push(...args),
    error: (...args: any[]) => errors.push(...args),
    updateLoop: defaultUpdateLoop
  })

  return { runtime, close: () => memoryTransport.client.close(), logs, errors }
}

describe('hot-reload shutdown of the scene runtime', () => {
  let consoleErrorSpy: jest.SpyInstance

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  describe('when the transport closes while an onUpdate RPC is in flight', () => {
    let harness: Harness

    beforeEach(async () => {
      // The scene issues one RPC per frame. After the second frame the host
      // handler hangs (never answers), pinning the scene mid-await — the exact
      // state a hot reload finds it in — and then we close the transport.
      let frames = 0
      let reachedHang: () => void = () => {}
      const hangReached = new Promise<void>((res) => (reachedHang = res))

      harness = await startRuntime(
        `
          const engineApi = require('~system/EngineApi')
          module.exports.onStart = async function () {}
          module.exports.onUpdate = async function () {
            console.log('frame')
            await engineApi.crdtSendToRenderer({ data: new Uint8Array(0) })
          }
        `,
        {
          async crdtSendToRenderer() {
            frames++
            if (frames > 2) {
              reachedHang()
              return new Promise(() => {})
            }
            return { data: [] }
          }
        }
      )

      await hangReached
      harness.close()
    })

    it('should end the runtime cleanly instead of failing or hanging for the async-turn timeout', async () => {
      await expect(harness.runtime).resolves.toBeUndefined()
      // the scene actually ran before the reload
      expect(harness.logs.filter(($) => $ === 'frame').length).toBeGreaterThanOrEqual(2)
      // the abandoned RPC was classified as a shutdown: nothing reached the
      // scene error channel and nothing was logged as a scene error
      expect(harness.errors).toEqual([])
      expect(consoleErrorSpy).not.toHaveBeenCalledWith('Scene error during shutdown:', expect.anything())
    })
  })

  describe('when the transport closes during scene startup', () => {
    let harness: Harness

    beforeEach(async () => {
      // getStartupData's readFile RPC never answers; the close lands while
      // startup is in flight (an editor double-save).
      let reachedReadFile: () => void = () => {}
      const readFileReached = new Promise<void>((res) => (reachedReadFile = res))

      harness = await startRuntime('', {
        readFile() {
          reachedReadFile()
          return new Promise(() => {})
        }
      })

      await readFileReached
      harness.close()
    })

    it('should reject with the transport-closed error the runtime connector classifies as a shutdown', async () => {
      const rejection = await harness.runtime.then(
        () => {
          throw new Error('expected the runtime to reject')
        },
        (err) => err
      )
      // this exact shape is what nodejs-runtime's catch turns into the
      // "stopped during startup" log instead of "terminated with error"
      expect(isTransportClosedError(rejection)).toBe(true)
    })
  })
})
