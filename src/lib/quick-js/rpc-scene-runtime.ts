/**
 * This file implements a QuickJS runtime that runs in the context of a RpcClient.
 * It can run inside WebWorkers and the RPC will abstract all the communication with
 * the main thread. The @dcl/rpc module was designed with the performance considerations
 * of this application in mind.
 * 
 * Based on static service definitions (i.e. EngineApiServiceDefinition) the @dcl/rpc
 * framework tenerates asynchronous clients to communicate with the rpc counterpart.
 */

import { RpcClientPort } from '@dcl/rpc'
import { withQuickJsVm } from '.'
import { loadModuleForPort } from '../common-runtime/modules'
import { RpcSceneRuntimeOptions } from '../common-runtime/types'
import { getStartupData } from '../common-runtime/startup'

// this function starts the scene runtime as explained in ADR-133
export async function startQuickJsSceneRuntime(port: RpcClientPort, options: RpcSceneRuntimeOptions) {
  const { mainFile, mainFileName } = await getStartupData(port)
  await withQuickJsVm(async (opts) => {
    opts.provide({
      ...options,
      require(moduleName) {
        return loadModuleForPort(port, moduleName)
      },
    })

    const decoder = new TextDecoder()
    // Evaluate the scene bundle inside a CommonJS-style function scope instead of
    // as a raw global script. Reference runtimes (scene-runtime, explorers) do the
    // same, and scenes depend on those semantics: a top-level `var` in the bundle
    // must NOT become a globalThis property. Example that crashes otherwise: the
    // SDK declares `var DEBUG_NETWORK_MESSAGES = () => globalThis.DEBUG_NETWORK_MESSAGES ?? false`
    // and scenes enable debugging via `globalThis.DEBUG_NETWORK_MESSAGES = true` —
    // at global scope that assignment overwrites the SDK's function and the next
    // call throws "not a function". The wrapper stays on one line so the bundle's
    // stack-trace line numbers are preserved.
    const sceneCode = decoder.decode(mainFile.content)
    await opts.eval(
      `;(function (module, exports) { ${sceneCode}\n}).call(module.exports, module, module.exports);`,
      mainFileName
    )

    await options.updateLoop({ ...opts, isRunning: () => (port.state === 'open') })
  })
}

