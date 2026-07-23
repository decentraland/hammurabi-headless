import ivm from 'isolated-vm'
import { IsolatedVmLimits, ProvideOptions, RunWithVmOptions } from './types'
import { BOOTSTRAP_SOURCE, provideConsole, provideRequire, provideSetImmediate } from './globals'
import { provideFetch, provideWebSocket } from './network-globals'
import { limits as configuredLimits } from '../misc/limits'
import { limitLogger } from '../misc/limit-logger'

export * from './types'

// Resource ceilings for the untrusted scene isolate. These bound a misbehaving or
// malicious scene so it cannot exhaust the worker's memory or wedge its event
// loop. Generous enough that legitimate scenes are unaffected.
const SCENE_MEMORY_LIMIT_BYTES = configuredLimits.isolateMemoryLimitBytes // JS heap ceiling for the scene (HAMMURABI_ISOLATE_MEMORY_LIMIT_MB)
// Max wall-clock time a single *synchronous* turn (the initial eval, onStart, one
// onUpdate's synchronous part, or a setImmediate drain) may run before V8
// terminates it. isolated-vm's `timeout` TERMINATES the running script but does
// NOT dispose the isolate — for onStart/onUpdate the thrown error propagates and
// the `finally` disposes; the setImmediate/WebSocket pumps dispose explicitly on a
// deadline (a swallowed deadline error there would let a runaway callback re-fire
// forever).
const MAX_SYNC_EXECUTION_MS = configuredLimits.maxSyncExecutionMs
// Max wall-clock time an *asynchronous* turn (the promise returned by onStart /
// onUpdate) may take to settle. A scene that awaits a promise which never resolves
// (or awaits then runs an infinite sync loop in the continuation, which the sync
// `timeout` can't reach) would otherwise wedge the host forever; this abandons the
// turn and disposes the isolate. Load-bearing that the main-thread pumps use async
// `apply` so this host timer can still fire while such a turn is in flight.
const MAX_ASYNC_TURN_MS = configuredLimits.maxAsyncTurnMs

/**
 * Runs a callback with a fresh isolated-vm sandbox implementing
 * {@link RunWithVmOptions}. Untrusted scene code executes in a V8 isolate with no
 * access to host (Node) globals — it starts as an empty realm and only sees the
 * capabilities installed by `provide()` (each bridged over an `ivm.Reference` so
 * the `.constructor` walk that breaks a bare `vm` context cannot reach the host).
 * The isolate is always disposed on exit.
 */
export async function withIsolatedVm<T>(
  cb: (opts: RunWithVmOptions) => Promise<T>,
  limits: IsolatedVmLimits = {}
): Promise<{ result: T }> {
  const memoryLimitMb = Math.max(8, Math.ceil((limits.memoryLimitBytes ?? SCENE_MEMORY_LIMIT_BYTES) / (1024 * 1024)))
  const maxSyncMs = limits.maxSyncExecutionMs ?? MAX_SYNC_EXECUTION_MS
  const maxAsyncMs = limits.maxAsyncTurnMs ?? MAX_ASYNC_TURN_MS

  const isolate = new ivm.Isolate({ memoryLimit: memoryLimitMb })
  let context: ivm.Context
  let callExportRef: ivm.Reference<any>
  try {
    context = isolate.createContextSync()
    // Make the global self-referential (globalThis/global/self) and install the
    // CommonJS module surface + the host-private turn dispatcher.
    context.global.setSync('global', context.global.derefInto())
    context.evalSync(BOOTSTRAP_SOURCE)
    callExportRef = context.global.getSync('__callExport', { reference: true }) as ivm.Reference<any>
    // Remove it from the scene global (the host keeps it via the captured Reference).
    context.evalSync('delete globalThis.__callExport')
  } catch (err) {
    // Bootstrap failed — dispose the isolate we just created so it doesn't leak.
    try { isolate.dispose() } catch { /* nothing to clean up */ }
    throw err
  }

  let provided = false
  let setImmediateManager: { dispose: () => void } | undefined
  let webSocketManager: { closeAll: () => void } | undefined
  let fetchManager: { abortAll: () => void } | undefined

  // Convert a scene turn (onStart/onUpdate) into a host promise, bounding both the
  // synchronous part (V8 `timeout` → isolate disposed) and the async settle (a
  // never-resolving turn is abandoned after maxAsyncTurnMs).
  async function runTurn(name: 'onStart' | 'onUpdate', dt?: number): Promise<any> {
    const args = dt === undefined ? [name] : [name, dt]
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = callExportRef.apply(undefined, args, {
      arguments: { copy: true },
      result: { promise: true, copy: true },
      timeout: maxSyncMs
    })
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        limitLogger.hit('maxAsyncTurnMs', name)
        reject(new Error(`scene async turn exceeded ${maxAsyncMs}ms`))
      }, maxAsyncMs)
    })
    try {
      return await Promise.race([settle, timeout])
    } finally {
      if (timer) clearTimeout(timer)
      // If the async-turn timeout won the race, the isolate promise may still
      // settle later — swallow it so it doesn't surface as an unhandled rejection.
      settle.catch(() => {})
    }
  }

  let result: T
  try {
    result = await cb({
      eval(code: string, filename?: string) {
        // Run first, THEN try to copy the result out, so an execution error
        // (real scene failure) is distinguished from a non-transferable result: a
        // throw from `evalSync` is the code failing and propagates; a throw from
        // `copySync` means the code ran fine but its final value isn't
        // structured-cloneable (a function / Symbol / proxy — e.g.
        // `module.exports.onStart = () => {}`), which is not an error and returns
        // undefined. Callers that read a value only eval simple expressions.
        const ref = context.evalSync(code, { filename, timeout: maxSyncMs, reference: true }) as ivm.Reference<any>
        try {
          return ref.copySync()
        } catch {
          return undefined
        } finally {
          ref.release()
        }
      },
      onStart() {
        return runTurn('onStart')
      },
      onUpdate(dt: number) {
        return runTurn('onUpdate', dt)
      },
      provide(opts: ProvideOptions) {
        // Guard against a second provide() leaking the prior interval / sockets.
        if (provided) {
          try { setImmediateManager?.dispose() } catch { /* already gone */ }
          try { webSocketManager?.closeAll() } catch { /* already gone */ }
          try { fetchManager?.abortAll() } catch { /* already gone */ }
        }
        provided = true
        provideConsole(context, opts)
        provideRequire(context, opts)
        setImmediateManager = provideSetImmediate(context, isolate, maxSyncMs)
        if (opts.fetch) fetchManager = provideFetch(context, opts)
        if (opts.webSocket) webSocketManager = provideWebSocket(context, isolate, opts.webSocket, maxSyncMs)
      }
    })
  } finally {
    // Close host resources first (sockets, the setImmediate interval) so no late
    // callback dispatches into an isolate that is being torn down, then dispose.
    // Every step is throw-proofed so one failure can't skip the isolate dispose.
    try {
      webSocketManager?.closeAll()
    } catch (err) {
      console.error('isolated-vm WebSocket teardown failed:', err)
    }
    try {
      setImmediateManager?.dispose()
    } catch (err) {
      console.error('isolated-vm setImmediate teardown failed:', err)
    }
    try {
      fetchManager?.abortAll()
    } catch (err) {
      console.error('isolated-vm fetch teardown failed:', err)
    }
    try {
      callExportRef.release()
    } catch {
      // isolate may already be disposed (async-turn timeout / OOM)
    }
    try {
      if (!isolate.isDisposed) isolate.dispose()
    } catch (err) {
      console.error('isolated-vm dispose failed:', err)
    }
  }
  return { result }
}
