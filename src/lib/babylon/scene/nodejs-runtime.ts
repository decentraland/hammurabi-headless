import { createRpcServer, createRpcClient } from "@dcl/rpc"
import { MemoryTransport } from "@dcl/rpc/dist/transports/Memory"
import { LoadableScene } from "../../decentraland/scene/content-server-entity"
import { SceneContext } from "./scene-context"
import * as codegen from "@dcl/rpc/dist/codegen"
import { Scene } from "@dcl/schemas"
import { connectContextToRpcServer } from "./connect-context-rpc"
import { TestingServiceDefinition } from "@dcl/protocol/out-js/decentraland/kernel/apis/testing.gen"
import { startQuickJsSceneRuntime } from '../../quick-js/rpc-scene-runtime'
import { defaultUpdateLoop } from '../../common-runtime/game-loop'

// Create shared RPC server for this scene context
const rpcServer = createRpcServer<SceneContext>({})

declare var __DCL_TESTING_EXTENSION__: any

rpcServer.setHandler(async function handler(port) {
  // setup required services
  connectContextToRpcServer(port)
  // and a testing service
  codegen.registerService(port, TestingServiceDefinition, async () => ({
    async logTestResult(result, ctx) {
      console.log(`🧪 logTestResult(${ctx.loadableScene.urn}) ${JSON.stringify(result)}`)
      if (typeof __DCL_TESTING_EXTENSION__ !== 'undefined') return __DCL_TESTING_EXTENSION__.logTestResult(result, ctx.loadableScene.urn)
      return {}
    },
    async plan(plan, ctx) {
      console.log(`🧪 plan(${ctx.loadableScene.urn}) ${JSON.stringify(plan)}`)
      if (typeof __DCL_TESTING_EXTENSION__ !== 'undefined') return __DCL_TESTING_EXTENSION__.plan(plan, ctx.loadableScene.urn)
      return {}
    },
    async setCameraTransform(transform, ctx) {
      console.log(`🧪 setCameraTransform(${ctx.loadableScene.urn}) ${JSON.stringify(transform)}`)
      if (typeof __DCL_TESTING_EXTENSION__ !== 'undefined') return __DCL_TESTING_EXTENSION__.setCameraTransform(transform, ctx.loadableScene.urn)
      return {}
    },
    async takeAndCompareScreenshot() {
      return {
        storedSnapshotFound: false,
        error: 'Not implemented in headless mode'
      }
    }
  }))
})

export async function connectSceneContextUsingNodeJs(ctx: SceneContext, loadableScene: LoadableScene) {
  const scene = loadableScene.entity.metadata as Scene

  try {
    // Create memory transport for in-process communication
    const memoryTransport = MemoryTransport()

    // Create RPC client using memory transport
    const rpcClient = createRpcClient(memoryTransport.client)

    // Connect server to memory transport with scene context
    rpcServer.attachTransport(memoryTransport.server, ctx)

    // Initialize RPC client and create port
    const client = await rpcClient
    const clientPort = await client.createPort(`scene-${scene.scene?.base || 'unknown'}`)

    // Run the scene inside the QuickJS (WASM) sandbox. This is the security
    // boundary: scene code executes in an isolated interpreter with no access to
    // Node globals (`process`, `require`, host `Function`/`eval`), so it can
    // neither read the worker's private key from the environment nor execute
    // arbitrary host code. All host interaction goes through the RPC services
    // registered above.
    await startQuickJsSceneRuntime(clientPort, {
      // create console wrappers
      error(...args) {
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        console.error(`\x1b[90m[${timestamp}]\x1b[0m ❌`, ...args)
      },
      log(...args) {
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        console.log(`\x1b[90m[${timestamp}]\x1b[0m`, ...args)
      },
      // set the update loop
      updateLoop: defaultUpdateLoop
    })

    console.log(`[NODEJS] QuickJS runtime started successfully for scene: ${scene.display?.title}`)
  } catch (error) {
    console.error(`[NODEJS] Failed to start QuickJS runtime for scene ${scene.display?.title}:`, error)
  }
}