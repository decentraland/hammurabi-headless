import { QuickJSHandle, QuickJSContext, Scope, newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core'
import { quickJsVariant } from './variant'
import { dumpAndDispose, nativeToVmType, installMarshalHelpers, disposeMarshalHelpers, installPromiseTracking, disposePendingDeferreds, drainPendingJobs, safeDispose } from './convert-handles';
import { RunWithVmOptions } from './types';
import { HostWebSocketFactory, WS_CONNECTING, WS_OPEN, WS_CLOSED } from '../misc/scene-websocket';

export * from './types'

// WebAssembly is a Node.js global, but this headless project compiles against
// lib ES2022 without DOM and @types/node 20 doesn't declare it — declare the
// minimal surface the teardown catch below needs.
declare const WebAssembly: { RuntimeError: new (message?: string) => Error }

// Untrusted scene code runs inside quickjs-ng (the actively-maintained QuickJS
// fork) compiled to WASM. We load the module once per process and reuse it.
// quickjs-ng (unlike the old pinned 2021 engine) polls the interrupt handler
// during regex matching too, so the per-turn deadline below also bounds
// catastrophic-backtracking regexes.
let quickJsModulePromise: ReturnType<typeof newQuickJSWASMModuleFromVariant> | undefined
function getQuickJsModule(): ReturnType<typeof newQuickJSWASMModuleFromVariant> {
  return (quickJsModulePromise ??= newQuickJSWASMModuleFromVariant(quickJsVariant))
}

// Resource ceilings for the untrusted scene VM. These bound a misbehaving or
// malicious scene so it cannot exhaust the worker's memory or wedge its event
// loop. Generous enough that legitimate scenes are unaffected.
const SCENE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024 // 256 MB of JS heap for the scene
const SCENE_MAX_STACK_BYTES = 1024 * 1024 // 1 MB call stack (QuickJS throws a catchable error past this)
// Max wall-clock time a single *synchronous* turn (the initial eval, onStart, one
// onUpdate, a setImmediate callback, or one executePendingJobs pass) may run
// before the interrupt handler aborts it.
const MAX_SYNC_EXECUTION_MS = 10_000
// Max wall-clock time an *asynchronous* turn (the promise returned by onStart /
// onUpdate) may take to settle. A scene that awaits a promise which never
// resolves would otherwise wedge the host loop forever; this abandons the turn.
const MAX_ASYNC_TURN_MS = 60_000

/** Overridable ceilings for the scene VM. Defaults are the production values. */
export type QuickJsVmLimits = {
  memoryLimitBytes?: number
  maxStackBytes?: number
  maxSyncExecutionMs?: number
  maxAsyncTurnMs?: number
}

/**
 * Classifies an error thrown by `vm.dispose()` at teardown. Pure so every branch
 * is unit-testable without provoking a real WASM abort.
 *
 * - `dropCache`: any Emscripten-level abort permanently poisons the WASM module
 *   for the whole process — every later newContext() would fail with "Aborted".
 *   Aborts always surface as a WebAssembly.RuntimeError, so match the TYPE, not
 *   the assert wording (JS_FreeRuntime has many asserts besides gc_obj_list,
 *   e.g. `p->ref_count > 0`). The caller must additionally check the cache still
 *   holds the module this VM was built from before clearing it.
 * - `leaking`: the gc_obj_list assert specifically means a host-side handle
 *   survived teardown (the leak class the pending-promise-leak tests pin).
 * - `rethrow`: a non-leak teardown error surfaces only when the scene itself did
 *   not fail — a pending scene failure always wins (the teardown error is logged
 *   by the caller instead of masking it).
 */
export function classifyTeardownError(
  err: unknown,
  hasFailures: boolean
): { dropCache: boolean; leaking: boolean; rethrow: boolean } {
  const leaking = String(err).includes('list_empty(&rt->gc_obj_list)')
  return {
    dropCache: err instanceof WebAssembly.RuntimeError,
    leaking,
    rethrow: !leaking && !hasFailures
  }
}

export async function withQuickJsVm<T>(
  cb: (opts: RunWithVmOptions) => Promise<T>,
  limits: QuickJsVmLimits = {}
): Promise<{ result: T; leaking: boolean }> {
  // Keep the module promise this VM was built from: if teardown aborts, only
  // drop the cache when it still holds OUR module — a stale VM tearing down
  // late must not clobber a fresh healthy module another scene already loaded.
  const modulePromise = getQuickJsModule()
  const Q = await modulePromise
  const vm = Q.newContext()

  // Bound the scene VM's resources. The interrupt handler enforces a per-turn
  // deadline. `startSyncTurn()` is called at the start of every synchronous entry
  // into the VM (eval, onStart, onUpdate, each setImmediate callback, each
  // executePendingJobs pass); the handler only fires while the VM is executing,
  // so a long-lived scene running many frames is fine — only a single runaway
  // synchronous turn (e.g. `while (true) {}`) trips the deadline. The previous
  // gap-heuristic reset was time-based and false-killed long-but-legitimate turns.
  const memoryLimitBytes = limits.memoryLimitBytes ?? SCENE_MEMORY_LIMIT_BYTES
  const maxStackBytes = limits.maxStackBytes ?? SCENE_MAX_STACK_BYTES
  const maxSyncExecutionMs = limits.maxSyncExecutionMs ?? MAX_SYNC_EXECUTION_MS
  const maxAsyncTurnMs = limits.maxAsyncTurnMs ?? MAX_ASYNC_TURN_MS
  vm.runtime.setMemoryLimit(memoryLimitBytes)
  vm.runtime.setMaxStackSize(maxStackBytes)
  let syncDeadline = Number.POSITIVE_INFINITY
  const startSyncTurn = () => {
    syncDeadline = Date.now() + maxSyncExecutionMs
  }
  vm.runtime.setInterruptHandler(() => Date.now() > syncDeadline)

  vm.newObject().consume((exports) => {
    vm.newObject().consume((module) => {
      vm.setProp(module, 'exports', exports)
      vm.setProp(vm.global, 'module', module)
    })

    vm.setProp(vm.global, 'exports', exports)
  })

  vm.setProp(vm.global, 'self', vm.global)
  vm.setProp(vm.global, 'global', vm.global)
  const failures: any[] = []

  // Compile the host-private marshalling helpers (binary classifier + byte
  // wrapper) BEFORE any scene code runs so they capture untampered primordials.
  // The host holds the only handles to them — they are never exposed on the VM
  // global object, so an untrusted scene can't see or replace what the host
  // calls to classify/read its values and feed it attacker-chosen bytes.
  installMarshalHelpers(vm)

  // Track host promises marshalled into the VM so any still in flight at
  // teardown (hot reload with an RPC call pending) can be disposed — a pending
  // deferred holds resolve/reject handles, and a leaked handle aborts
  // JS_FreeRuntime (`list_empty(&rt->gc_obj_list)`).
  installPromiseTracking(vm, startSyncTurn)

  let result: T
  let leaking = false

  // Cache of VM handles returned by `require(name)`. Without it, every require()
  // call re-wraps the whole host service into fresh VM function handles, so a
  // scene calling require() in a loop leaks host memory unbounded. We keep the
  // canonical handle here and hand callers a duplicate.
  const requireCache = new Map<string, QuickJSHandle>()

  // Convert a settled VM promise to a native value, bounding how long we wait so
  // a never-resolving scene promise can't wedge the host loop forever.
  async function resolveTurnPromise(promiseHandle: QuickJSHandle) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const settled = vm.resolvePromise(promiseHandle)
    // resolvePromise itself queues the VM job that settles `settled` (it
    // attaches a .then inside the VM). Nothing else drains that job until the
    // 16ms setImmediate interval fires, which taxed EVERY turn (onStart,
    // onUpdate, in-turn RPC round-trips) with up to a frame of dead latency —
    // measured ~16ms/turn vs ~0.07ms with this pump. Job execution runs
    // untrusted scene continuations, so it gets its own deadline turn.
    startSyncTurn()
    drainPendingJobs(vm)
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`scene async turn exceeded ${maxAsyncTurnMs}ms`)), maxAsyncTurnMs)
    })
    try {
      return await Promise.race([settled, timeout])
    } catch (err) {
      // The timeout won the race and this turn is abandoned, but the VM promise
      // can still settle later — and its result owns a freshly-dup'd handle;
      // dispose it or it leaks and JS_FreeRuntime aborts at teardown. The
      // observer is attached only here so the normal path (every frame) pays
      // nothing. safeDispose, not a vm.alive check: after a throwing
      // vm.dispose() the vm.alive flag is stale-true.
      void settled.then(
        (result) => safeDispose(result),
        () => {}
      )
      throw err
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const immediates = setupSetImmediate(vm, startSyncTurn)
  // Set up in provide() when the runtime supplies a WebSocket factory; disposed in
  // the finally so open sockets close and retained VM handles are freed at teardown.
  let webSocketManager: { closeAll: () => void } | undefined

  try {
    result = await cb({
      eval(code: string, filename?: string) {
        startSyncTurn()
        const result = vm.evalCode(code, filename)

        if (result.error) {
          const error = dumpAndDispose(vm, result.error)
          if (error instanceof Error) throw error
          throw Object.assign(new Error(error.toString()), error)
        }

        const $ = vm.unwrapResult(result)
        const ret = dumpAndDispose(vm, $)
        return ret
      },
      async onUpdate(dt) {
        startSyncTurn()
        // Look up module.exports.onUpdate with property gets and call it directly:
        // evalCode would lex/parse/compile a fresh script on every tick. The
        // lookup stays per-tick (not cached) so a scene that reassigns onUpdate
        // at runtime keeps working exactly as before.
        const promiseHandle = Scope.withScope((scope) => {
          const moduleHandle = scope.manage(vm.getProp(vm.global, 'module'))
          const exportsHandle = scope.manage(vm.getProp(moduleHandle, 'exports'))
          const fnHandle = scope.manage(vm.getProp(exportsHandle, 'onUpdate'))
          const dtHandle = scope.manage(vm.newNumber(dt))
          return vm.unwrapResult(vm.callFunction(fnHandle, exportsHandle, dtHandle))
        })

        // Drain the microtasks the synchronous part of onUpdate queued (e.g. a
        // turn ending in Promise.resolve()): without this, a turn that never
        // awaits a host promise only settles when the 16ms interval fires,
        // adding up to a frame of latency. Job execution is untrusted scene
        // code, so it gets its own deadline turn.
        startSyncTurn()
        drainPendingJobs(vm)

        // Convert the promise handle into a native promise and await it (bounded).
        // Dispose the handle in a finally so an async-turn timeout (or a throw
        // from unwrapResult) can't leak it — a leaked handle makes vm.dispose()
        // throw and mask the real error.
        try {
          const resolvedResult = await resolveTurnPromise(promiseHandle)
          const resolvedHandle = vm.unwrapResult(resolvedResult)
          return dumpAndDispose(vm, resolvedHandle)
        } finally {
          promiseHandle.dispose()
        }
      },
      async onStart() {
        startSyncTurn()
        const result = vm.evalCode(`module.exports.onStart ? module.exports.onStart() : Promise.resolve()`, 'onStart')

        const promiseHandle = vm.unwrapResult(result)

        // See onUpdate: settle VM-internal promise chains without waiting for
        // the 16ms interval pump.
        startSyncTurn()
        drainPendingJobs(vm)

        // See onUpdate: always dispose the promise handle.
        try {
          const resolvedResult = await resolveTurnPromise(promiseHandle)
          const resolvedHandle = vm.unwrapResult(resolvedResult)
          return dumpAndDispose(vm, resolvedHandle)
        } finally {
          promiseHandle.dispose()
        }
      },
      provide(opts) {
        // create the "console" object
        vm.newObject().consume((console) => {
          vm.newFunction('log', (...args) => {
            const localArgs = args.map(($) => $.consume(($) => dumpAndDispose(vm, $)))
            opts.log(...localArgs)
          }).consume((fn) => vm.setProp(console, 'log', fn))

          vm.newFunction('error', (...args) => {
            const localArgs = args.map(($) => $.consume(($) => dumpAndDispose(vm, $)))
            opts.error(...localArgs)
          }).consume((fn) => vm.setProp(console, 'error', fn))

          vm.setProp(vm.global, 'console', console)
        })

        // create a proxy function for "require"
        vm.newFunction('require', (...args) => {
          const localArgs = args.map(($) => $.consume(($) => dumpAndDispose(vm, $)))
          const moduleName = localArgs[0]
          // Return a duplicate of the cached module handle so repeated require()
          // calls don't re-wrap the whole host service into new handles (leak).
          if (typeof moduleName === 'string') {
            const cached = requireCache.get(moduleName)
            if (cached) return cached.dup()
          }
          const fns = opts.require(moduleName)
          const handle = nativeToVmType(vm, fns)
          if (typeof moduleName === 'string' && typeof (handle as any)?.dup === 'function') {
            requireCache.set(moduleName, handle)
            return handle.dup()
          }
          return handle
        }).consume((fn) => vm.setProp(vm.global, 'require', fn))

        // Global `fetch` (ADR-133): unprivileged, SSRF-guarded, body-capped.
        // Installed only when the runtime supplies a host fetch. The host returns a
        // Promise; nativeToVmType turns it into a VM promise the scene can await.
        if (opts.fetch) {
          const hostFetch = opts.fetch
          vm.newFunction('fetch', (...args) => {
            const localArgs = args.map(($) => $.consume(($) => dumpAndDispose(vm, $)))
            return nativeToVmType(vm, hostFetch(localArgs[0], localArgs[1]))
          }).consume((fn) => vm.setProp(vm.global, 'fetch', fn))
        }

        // Global `WebSocket` (ADR-133): backed by a host connection, with events
        // bridged into the scene's on* handlers. Installed only when supplied.
        if (opts.webSocket) {
          webSocketManager = setupSceneWebSocket(vm, startSyncTurn, opts.webSocket)
        }
      }
    })
  } catch (err: any) {
    failures.push(err)
    if (err instanceof Error)
      throw err
    else
      throw Object.assign(new Error(err.message || `${err}`), err)
  } finally {
    // Close any open scene WebSockets and free their retained VM handles FIRST, so
    // no late socket event can dispatch into a VM that is being torn down, and no
    // host-held handle survives into vm.dispose() (which would abort JS_FreeRuntime).
    try {
      webSocketManager?.closeAll()
    } catch (err) {
      console.error('QuickJS WebSocket teardown failed:', err)
    }

    // Drain pending immediates/jobs, but bound the wait and NEVER let an early
    // throw here skip disposal — that would leak the VM, the setInterval, and the
    // interrupt handler for the life of the worker.
    let counter = 1000
    let drained = true
    let drainFailed = false
    try {
      while (immediates.hasPendingJobs() || vm.runtime.hasPendingJob()) {
        if (!counter--) {
          drained = false
          break
        }
        await new Promise((res) => setTimeout(res, 1))
      }
    } catch (err) {
      // hasPendingJob is an FFI call: it throws if the WASM module aborted (e.g.
      // a sibling VM's teardown assert). Keep tearing down — an early exit here
      // would leak the 16ms interval for the life of the process.
      drained = false
      drainFailed = true
      console.error('QuickJS drain loop failed at teardown:', err)
    }

    for (const handle of requireCache.values()) {
      safeDispose(handle)
    }
    requireCache.clear()

    immediates.dispose()
    disposeMarshalHelpers(vm)
    disposePendingDeferreds(vm)
    try {
      vm.runtime.removeInterruptHandler()
    } catch (err) {
      // Also an FFI call; a poisoned module must not stop vm.dispose() below.
      console.error('QuickJS removeInterruptHandler failed at teardown:', err)
    }
    try {
      vm.dispose()
    } catch (err: any) {
      const teardown = classifyTeardownError(err, failures.length > 0)
      if (teardown.dropCache && quickJsModulePromise === modulePromise) {
        quickJsModulePromise = undefined
      }
      if (teardown.leaking) {
        leaking = true
        // Surface the leak: callers discard the `leaking` flag in production,
        // and a silent recovery would hide handle-leak regressions until the
        // WASM-module churn becomes visible some other way.
        console.error('QuickJS VM leaked handles at teardown (JS_FreeRuntime abort):', err)
      } else if (teardown.rethrow) {
        throw err
      } else {
        // Don't let a teardown error mask the scene's own failure (thrown below).
        console.error('QuickJS teardown error (suppressed in favor of scene failure):', err)
      }
    }
    if (failures.length) {
      throw failures[0]
    }
    if (!drained && !drainFailed) {
      // Only the timed-out case: when the drain loop itself failed (poisoned
      // module) the real cause was already logged above and this message would
      // mislead.
      throw new Error("VM won't finish immediates or pending jobs")
    }
  }
  return { result, leaking }
}

/**
 * Install the scene-facing global `WebSocket` constructor, backed by host
 * connections from `factory`. Push events (open/message/error/close) are bridged
 * into the instance's `on*` handlers via callFunction; `startSyncTurn` resets the
 * per-turn deadline for each host→VM entry and pending jobs are pumped afterward.
 * Returns a manager whose `closeAll()` closes every live socket and disposes the
 * host-retained instance handles — call it before `vm.dispose()` at teardown, or a
 * surviving handle aborts JS_FreeRuntime.
 */
function setupSceneWebSocket(
  vm: QuickJSContext,
  startSyncTurn: () => void,
  factory: HostWebSocketFactory
): { closeAll: () => void } {
  type Entry = { socket: ReturnType<HostWebSocketFactory>; held: QuickJSHandle }
  const live = new Set<Entry>()
  let tornDown = false
  // Cap concurrent sockets so untrusted scene code can't exhaust host connections
  // with a `new WebSocket()` loop. Closed sockets leave `live`, so this bounds the
  // simultaneously-open count, not the lifetime total. Generous for real scenes.
  const MAX_OPEN_SOCKETS = 32

  // Call the scene's `on<event>` handler (when it is a function) with `arg`.
  function dispatch(instance: QuickJSHandle, handlerName: string, arg: unknown): void {
    if (tornDown || !vm.alive) return
    startSyncTurn()
    let handler: QuickJSHandle | undefined
    try {
      handler = vm.getProp(instance, handlerName)
      if (vm.typeof(handler) === 'function') {
        const argHandle = nativeToVmType(vm, arg)
        try {
          const call = vm.callFunction(handler, instance, argHandle)
          // Dispose whichever handle came back — a scene handler that throws must
          // not leak its error handle (a live handle aborts JS_FreeRuntime).
          if (call.error) call.error.dispose()
          else call.value.dispose()
        } finally {
          argHandle.dispose()
        }
      }
    } catch (err) {
      console.error('QuickJS WebSocket dispatch failed:', err)
    } finally {
      handler?.dispose()
      try {
        if (!tornDown && vm.alive) drainPendingJobs(vm)
      } catch (err) {
        console.error('QuickJS WebSocket pending-jobs pump failed:', err)
      }
    }
  }

  const setReadyState = (held: QuickJSHandle, state: number): void => {
    if (tornDown || !vm.alive) return
    try {
      nativeToVmType(vm, state).consume(($) => vm.setProp(held, 'readyState', $))
    } catch (err) {
      console.error('QuickJS WebSocket readyState update failed:', err)
    }
  }

  // quickjs-emscripten host functions are not constructable, so expose a plain
  // host factory and wrap it in a VM-side `WebSocket` function (which IS) via a
  // shim below. `new WebSocket(url)` then returns the host-built instance object.
  vm.newFunction('__hammurabiCreateWebSocket', (urlHandle, protocolsHandle) => {
    const url = urlHandle ? urlHandle.consume(($) => dumpAndDispose(vm, $)) : undefined
    const protocols = protocolsHandle ? protocolsHandle.consume(($) => dumpAndDispose(vm, $)) : undefined
    if (typeof url !== 'string') {
      throw new Error('WebSocket: url must be a string')
    }
    if (live.size >= MAX_OPEN_SOCKETS) {
      throw new Error('WebSocket: too many open connections for this scene')
    }

    const socket = factory(url, protocols as string | string[] | undefined)
    const instance = vm.newObject()
    nativeToVmType(vm, WS_CONNECTING).consume(($) => vm.setProp(instance, 'readyState', $))
    nativeToVmType(vm, url).consume(($) => vm.setProp(instance, 'url', $))

    vm.newFunction('send', (dataHandle) => {
      const data = dataHandle ? dataHandle.consume(($) => dumpAndDispose(vm, $)) : undefined
      socket.send(data)
    }).consume((fn) => vm.setProp(instance, 'send', fn))

    vm.newFunction('close', (codeHandle, reasonHandle) => {
      const code = codeHandle ? codeHandle.consume(($) => dumpAndDispose(vm, $)) : undefined
      const reason = reasonHandle ? reasonHandle.consume(($) => dumpAndDispose(vm, $)) : undefined
      socket.close(typeof code === 'number' ? code : undefined, typeof reason === 'string' ? reason : undefined)
      // Reflect the synchronous state move (CLOSING, or CLOSED if never connected)
      // to the scene, matching WHATWG — otherwise readyState reads OPEN until the
      // async 'close' event and a readyState-gated send() would wrongly fire.
      setReadyState(held, socket.readyState)
    }).consume((fn) => vm.setProp(instance, 'close', fn))

    // Retain a dup for the socket's lifetime so events can dispatch into it after
    // the constructor returns; the VM takes ownership of the returned `instance`.
    const held = instance.dup()
    const entry: Entry = { socket, held }
    live.add(entry)

    socket.on('open', () => {
      setReadyState(held, WS_OPEN)
      dispatch(held, 'onopen', {})
    })
    socket.on('message', (data) => dispatch(held, 'onmessage', { data }))
    socket.on('error', (message) => dispatch(held, 'onerror', { message, type: 'error' }))
    socket.on('close', (code, reason) => {
      setReadyState(held, WS_CLOSED)
      dispatch(held, 'onclose', { code, reason })
      // delete returns false if closeAll already reclaimed it — avoids a double free.
      if (live.delete(entry)) safeDispose(held)
    })

    return instance
  }).consume((fn) => vm.setProp(vm.global, '__hammurabiCreateWebSocket', fn))

  // Define the constructable `WebSocket` in the VM: it captures the host factory,
  // then removes it from the global so scenes only see the standard constructor.
  const shim = vm.evalCode(
    ';(function () {' +
      'var create = globalThis.__hammurabiCreateWebSocket;' +
      // Prototype-link the host-built instance so `ws instanceof WebSocket` holds and
      // the ready-state constants resolve on the instance (ws.OPEN), not just the
      // constructor (WebSocket.OPEN) — WHATWG exposes them on both.
      'function WebSocket(url, protocols) {' +
      '  var socket = create(url, protocols);' +
      '  Object.setPrototypeOf(socket, WebSocket.prototype);' +
      '  return socket;' +
      '}' +
      'WebSocket.CONNECTING = WebSocket.prototype.CONNECTING = 0;' +
      'WebSocket.OPEN = WebSocket.prototype.OPEN = 1;' +
      'WebSocket.CLOSING = WebSocket.prototype.CLOSING = 2;' +
      'WebSocket.CLOSED = WebSocket.prototype.CLOSED = 3;' +
      'globalThis.WebSocket = WebSocket;' +
      'delete globalThis.__hammurabiCreateWebSocket;' +
      '})();'
  )
  if (shim.error) {
    const err = dumpAndDispose(vm, shim.error)
    throw err instanceof Error ? err : new Error(String(err))
  }
  shim.value.dispose()

  return {
    closeAll: () => {
      tornDown = true
      for (const entry of live) {
        try {
          // 1000 (normal): the scene-facing close-code rule rejects 1001, and this
          // goes through the same validated close() path.
          entry.socket.close(1000, 'scene shutdown')
        } catch {
          // best-effort: teardown continues regardless
        }
        safeDispose(entry.held)
      }
      live.clear()
    }
  }
}

// Notice: setImmediate will be removed from the protocol requirements, until then
// we are implementing a good-enough replacement:
export function setupSetImmediate(vm: QuickJSContext, startSyncTurn: () => void = () => {}) {
  const immediates: QuickJSHandle[] = []

  vm.newFunction('setImmediate', (fn) => {
    immediates.push(fn.dupable ? fn.dup() : fn)
    fn.dispose()
  }).consume((fn) => vm.setProp(vm.global, 'setImmediate', fn))

  const int = setInterval(() => {
    // Drain a SNAPSHOT of the queue, never the live array: callbacks run
    // synchronously here and can call setImmediate again, so a live
    // `while (immediates.length)` drain spins forever on a self-requeuing
    // callback (`function f(){ setImmediate(f) }`) — each iteration resets the
    // per-turn deadline, so the interrupt handler never fires and the whole
    // host event loop (all scenes, comms, render loop) wedges. With a snapshot,
    // re-queued callbacks run on the NEXT tick, matching Node's own
    // setImmediate semantics.
    for (const elem of immediates.splice(0)) {
      try {
        // Each callback is its own synchronous turn: reset the deadline so a slow
        // (but legitimate) callback isn't charged against a previous one, while a
        // single runaway callback is still interrupted.
        startSyncTurn()
        vm.unwrapResult(vm.callFunction(elem, vm.undefined)).dispose()
      } catch (e: any) {
        console.error(e.message)
      }

      elem.dispose()
    }

    // Draining microtasks (resolved scene promises) is also untrusted execution.
    startSyncTurn()
    drainPendingJobs(vm)
  }, 16)

  return {
    hasPendingJobs() {
      return immediates.length > 0
    },
    dispose() {
      clearInterval(int)
      // Callbacks still queued here (the drain loop timed out) are live handles;
      // any that survives vm.dispose() trips the JS_FreeRuntime leak assert.
      for (const elem of immediates.splice(0)) {
        safeDispose(elem)
      }
    }
  }
}