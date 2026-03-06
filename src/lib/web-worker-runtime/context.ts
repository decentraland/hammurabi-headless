import type { RpcClientPort } from '@dcl/rpc'
import WebSocket from 'ws'
import { loadModuleForPort } from '../common-runtime/modules'
import { RpcSceneRuntimeOptions, RuntimeAbstraction } from '../common-runtime/types'

export type GenericRpcModule = Record<string, (...args: any) => Promise<unknown>>

export type SceneInterface = {
  onUpdate(dt: number): Promise<void>
  onStart(): Promise<void>
}

export type SDK7Module = RuntimeAbstraction & {
  readonly exports: Partial<SceneInterface>
}

const DEFAULT_FETCH_TIMEOUT_MS = 30_000

function createRestrictedFetch(isLocalSceneDevelopment: boolean): typeof fetch {
  return (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!isLocalSceneDevelopment && !url.toLowerCase().startsWith('https://')) {
      throw new Error(`Can't make an unsafe http request, please upgrade to https. url=${url}`)
    }
    const signal = init?.signal ?? AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS)
    return fetch(input, { ...init, signal })
  }
}

function createRestrictedWebSocket(isLocalSceneDevelopment: boolean) {
  return class RestrictedWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const urlStr = url.toString()
      if (!isLocalSceneDevelopment && !urlStr.toLowerCase().startsWith('wss://')) {
        throw new Error(`Can't start an unsafe ws connection, please upgrade to wss. url=${urlStr}`)
      }
      super(url, protocols)
    }
  }
}

export function createModuleRuntime(
  clientPort: RpcClientPort,
  console: Pick<RpcSceneRuntimeOptions, 'log' | 'error'>,
  globalObject: Record<string, any>,
  isLocalSceneDevelopment: boolean = false
): SDK7Module {
  const exports: Partial<SceneInterface> = {}

  const module = { exports }

  Object.defineProperty(globalObject, 'module', {
    configurable: false,
    get() {
      return module
    }
  })

  Object.defineProperty(globalObject, 'exports', {
    configurable: false,
    get() {
      return module.exports
    }
  })

  Object.defineProperty(globalObject, 'console', {
    value: {
      log: console.log.bind(console),
      info: console.log.bind(console),
      debug: console.log.bind(console),
      trace: console.log.bind(console),
      warning: console.error.bind(console),
      error: console.error.bind(console)
    }
  })

  const runtimeGlobals: Record<string, unknown> = {
    fetch: createRestrictedFetch(isLocalSceneDevelopment),
    Headers, Request, Response,
    WebSocket: createRestrictedWebSocket(isLocalSceneDevelopment)
  }

  for (const [name, value] of Object.entries(runtimeGlobals)) {
    Object.defineProperty(globalObject, name, { configurable: false, value })
  }

  const loadedModules: Record<string, GenericRpcModule> = {}

  Object.defineProperty(globalObject, 'require', {
    configurable: false,
    value: (moduleName: string) => {
      if (moduleName in loadedModules) return loadedModules[moduleName]
      const module = loadModuleForPort(clientPort, moduleName)
      loadedModules[moduleName] = module
      return module
    }
  })

  const setImmediateList: Array<() => Promise<void>> = []

  Object.defineProperty(globalObject, 'setImmediate', {
    configurable: false,
    value: (fn: () => Promise<void>) => {
      setImmediateList.push(fn)
    }
  })

  async function runSetImmediate(): Promise<void> {
    if (setImmediateList.length) {
      for (const fn of setImmediateList) {
        try {
          await fn()
        } catch (err: any) {
          console.error(err)
        }
      }
      setImmediateList.length = 0
    }
  }

  return {
    get exports() {
      return module.exports
    },
    async onStart() {
      if (module.exports.onStart) {
        try {
          await module.exports.onStart()
        } catch (err: any) {
          console.error(err)
          console.error('⚠️⚠️⚠️⚠️ THE SCENE HAS SUFFERED AN ERROR AND WILL NOW BE TERMINATED ⚠️⚠️⚠️⚠️')
          throw err
        }
      }
      await runSetImmediate()
    },
    async onUpdate(deltaTime: number) {
      if (module.exports.onUpdate) {
        try {
          await module.exports.onUpdate(deltaTime)
        } catch (err) {
          console.error(err)
          console.error('⚠️⚠️⚠️⚠️ THE SCENE HAS SUFFERED AN ERROR AND WILL NOW BE TERMINATED ⚠️⚠️⚠️⚠️')
          throw err
        }
      }
      await runSetImmediate()
    },
    isRunning() {
      return true
    }
  }
}
