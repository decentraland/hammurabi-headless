import { QuickJSHandle, QuickJSContext, Scope, newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core'
import { quickJsVariant } from './variant'
import { dumpAndDispose, nativeToVmType, installMarshalHelpers, disposeMarshalHelpers } from './convert-handles';
import { RunWithVmOptions } from './types';

export * from './types'

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
}

// executePendingJobs returns a Disposable result whose FAIL branch owns a
// QuickJS error handle; dropping it leaks one VM handle per throwing microtask
// job, which eventually makes vm.dispose() throw and get misreported as leaking.
// Always dispose that handle. Callers must run startSyncTurn() first — draining
// jobs executes untrusted scene code, so it gets its own deadline turn.
function drainPendingJobs(vm: QuickJSContext) {
  const result = vm.runtime.executePendingJobs()
  if ('error' in result && result.error) result.error.dispose()
}

export async function withQuickJsVm<T>(
  cb: (opts: RunWithVmOptions) => Promise<T>,
  limits: QuickJsVmLimits = {}
): Promise<{ result: T; leaking: boolean }> {
  const Q = await getQuickJsModule()
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
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`scene async turn exceeded ${MAX_ASYNC_TURN_MS}ms`)),
        MAX_ASYNC_TURN_MS
      )
    })
    try {
      return await Promise.race([vm.resolvePromise(promiseHandle), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const immediates = setupSetImmediate(vm, startSyncTurn)

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
      }
    })
  } catch (err: any) {
    failures.push(err)
    if (err instanceof Error)
      throw err
    else
      throw Object.assign(new Error(err.message || `${err}`), err)
  } finally {
    // Drain pending immediates/jobs, but bound the wait and NEVER let an early
    // throw here skip disposal — that would leak the VM, the setInterval, and the
    // interrupt handler for the life of the worker.
    let counter = 1000
    let drained = true
    while (immediates.hasPendingJobs() || vm.runtime.hasPendingJob()) {
      if (!counter--) {
        drained = false
        break
      }
      await new Promise((res) => setTimeout(res, 1))
    }

    for (const handle of requireCache.values()) {
      try {
        handle.dispose()
      } catch {
        // handle may already have been reclaimed by VM teardown; ignore
      }
    }
    requireCache.clear()

    immediates.dispose()
    disposeMarshalHelpers(vm)
    vm.runtime.removeInterruptHandler()
    try {
      vm.dispose()
    } catch (err: any) {
      if (err.toString().includes('list_empty(&rt->gc_obj_list)') && !failures.length) {
        leaking = true
      } else throw err
    }
    if (failures.length) {
      throw failures[0]
    }
    if (!drained) {
      throw new Error("VM won't finish immediates or pending jobs")
    }
  }
  return { result, leaking }
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
    while (immediates.length) {
      const elem = immediates.shift()!

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
    }
  }
}