/**
 * Runs the scene runtime inside an isolated-vm sandbox in the context of an
 * RpcClient (ADR-133). Based on the static @dcl/rpc service definitions, the
 * framework generates asynchronous clients to communicate with the RPC counterpart.
 *
 * This is the isolated-vm counterpart of the former QuickJS runtime: same seam
 * (`RunWithVmOptions` / `RpcSceneRuntimeOptions`), same RPC bridge, same CommonJS
 * bundle evaluation — only the sandbox engine differs.
 */

import { RpcClientPort } from '@dcl/rpc'
import { withIsolatedVm } from '.'
import { wrapSceneBundle } from './globals'
import { loadModuleForPort } from '../common-runtime/modules'
import { RpcSceneRuntimeOptions } from '../common-runtime/types'
import { getStartupData } from '../common-runtime/startup'
import { createSceneFetch } from '../misc/scene-fetch'
import { createSceneWebSocketFactory } from '../misc/scene-websocket'

export async function startIsolatedVmSceneRuntime(port: RpcClientPort, options: RpcSceneRuntimeOptions) {
  const { mainFile, mainFileName } = await getStartupData(port)
  // The scene's unprivileged network globals (ADR-133): an unsigned, SSRF-guarded
  // `fetch` and a `WebSocket` constructor. Both use the real SSRF guard by default.
  const sceneFetch = createSceneFetch()
  const sceneWebSocket = createSceneWebSocketFactory()

  await withIsolatedVm(async (opts) => {
    opts.provide({
      ...options,
      require(moduleName) {
        return loadModuleForPort(port, moduleName)
      },
      fetch: sceneFetch,
      webSocket: sceneWebSocket
    })

    // Evaluate the scene bundle inside a CommonJS-style function scope (decoded on
    // the host — the isolate has no TextDecoder). A top-level `var` in the bundle
    // must NOT become a globalThis property; scenes depend on those semantics
    // (e.g. the SDK's `var DEBUG_NETWORK_MESSAGES` vs the documented
    // `globalThis.DEBUG_NETWORK_MESSAGES` debug flag).
    const decoder = new TextDecoder()
    const sceneCode = decoder.decode(mainFile.content)
    opts.eval(wrapSceneBundle(sceneCode), mainFileName)

    await options.updateLoop({ ...opts, isRunning: () => port.state === 'open' })
  })
}
