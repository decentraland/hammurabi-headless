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
import { assertPublicSceneUrl } from '../misc/ssrf'
import { currentRealm } from '../decentraland/state'
import { isLocalhostRealm } from '../decentraland/realm/resolution'

export async function startIsolatedVmSceneRuntime(port: RpcClientPort, options: RpcSceneRuntimeOptions) {
  const { mainFile, mainFileName } = await getStartupData(port)
  // The scene's unprivileged network globals (ADR-133): an unsigned, SSRF-guarded
  // `fetch` and a `WebSocket` constructor. Both use the real SSRF guard; in local
  // preview (localhost realm) the guard admits LOOPBACK destinations only, so a
  // scene's server code can reach the developer's own local backends the same way
  // its client half can in the browser. Evaluated per request (not at construction)
  // so it always reflects the actual realm, and production realms (worlds,
  // catalysts) never relax anything.
  const assertPublicUrl = (url: string) => {
    const realm = currentRealm.getOrNull()
    return assertPublicSceneUrl(url, { allowLoopback: realm !== null && isLocalhostRealm(realm.baseUrl) })
  }
  const sceneFetch = createSceneFetch({ assertPublicUrl })
  const sceneWebSocket = createSceneWebSocketFactory({ assertPublicUrl })

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
