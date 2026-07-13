import { randomBytes } from "crypto"
import { QuickJSContext, QuickJSDeferredPromise, QuickJSHandle, Scope } from "quickjs-emscripten-core"
import { MaybeUint8Array } from "./types"

// Upper bound on a single scene-supplied binary payload marshalled out of the VM,
// and on one coerced from a plain object. Prevents a scene from driving an
// unbounded host allocation through the marshalling layer.
const MAX_COERCED_BYTES = 16 * 1024 * 1024
// Upper bound on how many binary payloads one value crossing the boundary may
// contain (sendBinary batches many small messages; anything past this is abuse).
const MAX_MARSHAL_BUFFERS = 4096
// Max object/array nesting the extractor descends before giving up on a value.
// Doubles as cycle protection. A (real, but pathologically deep) Uint8Array past
// this depth is left in the tree and dumped as a byte-keyed object; that is
// slower but still correct — the downstream coercion (coerceMaybeU8Array) turns
// it back into bytes — so this only ever costs performance, never correctness.
const MAX_MARSHAL_DEPTH = 512

/**
 * Builds the VM-side classifier source. It walks a value, copies every typed
 * array it contains into a fresh ArrayBuffer (collected into `buffers`) and
 * replaces it with a `{ [nonceKey]: n }` placeholder. Returns `false` when the
 * value contains no binary data at all (the host then falls back to a plain
 * `vm.dump`).
 *
 * Untrusted scene code never gets a reference to this function — the host holds
 * the only handle (see installMarshalHelpers). Every primordial it relies on
 * (the %TypedArray%.prototype buffer/byteOffset/byteLength getters, Object.keys,
 * Array.isArray) is captured BEFORE any scene code runs, so a scene cannot tamper
 * with prototypes to forge what the host reads. Binary detection uses the
 * %TypedArray% buffer getter (an internal-slot check that throws for non-typed
 * arrays) rather than a spoofable `Object.prototype.toString` brand — so a plain
 * object cannot masquerade as a typed array, and no scene-controlled code (an
 * array-like `Symbol.iterator`/getter path) is ever invoked while copying.
 *
 * `nonceKey` is a per-VM random string embedded here and known only to the host,
 * so a scene cannot hand-craft a `{ [nonceKey]: n }` object that the host would
 * mistake for an extracted-buffer placeholder.
 */
function buildExtractBinariesSource(nonceKey: string): string {
  return `;(() => {
  const U8 = Uint8Array
  const ArrayCtor = Array
  const arrPush = Array.prototype.push
  const getKeys = Object.keys
  const isArray = Array.isArray
  const taProto = Object.getPrototypeOf(Uint8Array.prototype)
  const bufferGetter = Object.getOwnPropertyDescriptor(taProto, 'buffer').get
  const byteOffsetGetter = Object.getOwnPropertyDescriptor(taProto, 'byteOffset').get
  const byteLengthGetter = Object.getOwnPropertyDescriptor(taProto, 'byteLength').get
  const NONCE = ${JSON.stringify(nonceKey)}
  const MAX_DEPTH = ${MAX_MARSHAL_DEPTH}
  // Returns a tightly-sized copy of a typed array's bytes, or null if v is not a
  // real typed array. The buffer getter throws (internal-slot check) on anything
  // that only looks like one, and every step below (ArrayBuffer + integer view,
  // typed-array-to-typed-array copy) uses internal slots — no scene code runs.
  const copyTypedArrayBytes = (v) => {
    let backing
    try { backing = bufferGetter.call(v) } catch (e) { return null }
    const view = new U8(backing, byteOffsetGetter.call(v), byteLengthGetter.call(v))
    return new U8(view)
  }
  return (value) => {
    if (value === null || typeof value !== 'object') return false
    const buffers = []
    const walk = (v, depth) => {
      if (v === null || typeof v !== 'object') return v
      const bytes = copyTypedArrayBytes(v)
      if (bytes !== null) {
        arrPush.call(buffers, bufferGetter.call(bytes))
        const ref = {}
        ref[NONCE] = buffers.length - 1
        return ref
      }
      if (depth >= MAX_DEPTH) return v
      if (isArray(v)) {
        const out = new ArrayCtor(v.length)
        for (let i = 0; i < v.length; i++) out[i] = walk(v[i], depth + 1)
        return out
      }
      const out = {}
      const ks = getKeys(v)
      for (let i = 0; i < ks.length; i++) out[ks[i]] = walk(v[ks[i]], depth + 1)
      return out
    }
    const tree = walk(value, 0)
    return buffers.length === 0 ? false : { tree, buffers }
  }
})()`
}

/**
 * Disposes a QuickJS lifetime during teardown, tolerating both a handle that was
 * already reclaimed and an FFI-level throw from a poisoned (aborted) WASM
 * module. Teardown paths use this so one failing dispose can't skip the rest of
 * the cleanup. (The library's own alive-guards don't cover the poisoned-module
 * case: the FFI free itself throws there.)
 */
export function safeDispose(disposable: { alive?: boolean; dispose(): void }) {
  if (disposable.alive === false) return
  try {
    disposable.dispose()
  } catch {
    // already reclaimed, or the WASM module aborted; keep tearing down
  }
}

// executePendingJobs returns a Disposable result whose FAIL branch owns a
// QuickJS error handle; dropping it leaks one VM handle per throwing microtask
// job, which eventually makes vm.dispose() throw and get misreported as leaking.
// Always dispose that handle. Callers must run startSyncTurn() first — draining
// jobs executes untrusted scene code, so it gets its own deadline turn.
export function drainPendingJobs(vm: QuickJSContext) {
  const result = vm.runtime.executePendingJobs()
  if ('error' in result && result.error) result.error.dispose()
}

type MarshalHelpers = {
  extractBinaries: QuickJSHandle
  wrapBytes: QuickJSHandle
  // Returns the JSON-serialized length of a value (or -1 if it can't be
  // stringified) WITHOUT returning the payload — lets the host bound the plain
  // vm.dump path before materializing a huge value.
  measureSize: QuickJSHandle
  nonceKey: string
}

const marshalHelpers = new WeakMap<QuickJSContext, MarshalHelpers>()

/**
 * Compiles the two marshalling helpers inside the VM and caches their handles,
 * keyed by context. Must run BEFORE any scene code is evaluated so the helpers
 * capture untampered primordials. The handles are host-private (never exposed on
 * the VM global object), so scene code cannot see or replace them.
 */
export function installMarshalHelpers(vm: QuickJSContext) {
  // Per-VM random placeholder key. Unpredictable to the scene, so it cannot forge
  // an extracted-buffer placeholder (see reinjectBinaries).
  const nonceKey = '__hostU8Ref_' + randomBytes(16).toString('hex') + '__'
  const extractBinaries = vm.unwrapResult(vm.evalCode(buildExtractBinariesSource(nonceKey), 'hostExtractBinaries.js'))
  // Capture Uint8Array at install time (like the extractor) so a scene poisoning
  // globalThis.Uint8Array afterward can't intercept host→VM binary delivery.
  const wrapBytes = vm.unwrapResult(
    vm.evalCode('(() => { const U8 = Uint8Array; return (ab) => new U8(ab) })()', 'hostWrapBytes.js')
  )
  // Capture JSON.stringify at install time (untampered primordial). Returns just
  // a length so a size probe never materializes the payload on the host.
  const measureSize = vm.unwrapResult(
    vm.evalCode(
      '(() => { const S = JSON.stringify; return (v) => { try { const s = S(v); return typeof s === "string" ? s.length : 0 } catch (e) { return -1 } } })()',
      'hostMeasureSize.js'
    )
  )
  marshalHelpers.set(vm, { extractBinaries, wrapBytes, measureSize, nonceKey })
}

/** Disposes the cached helper handles. Must run before `vm.dispose()`. */
export function disposeMarshalHelpers(vm: QuickJSContext) {
  const helpers = marshalHelpers.get(vm)
  if (!helpers) return
  marshalHelpers.delete(vm)
  safeDispose(helpers.extractBinaries)
  safeDispose(helpers.wrapBytes)
  safeDispose(helpers.measureSize)
}

type PromiseTracking = {
  deferreds: Set<QuickJSDeferredPromise>
  startSyncTurn: () => void
  // Set by disposePendingDeferreds. Settle callbacks gate on this instead of
  // `vm.alive`: after a THROWING vm.dispose() the library leaves vm.alive
  // stale-true (Lifetime only flips _alive after its disposer returns), so
  // vm.alive cannot be trusted on exactly the teardown path this protects.
  tornDown: boolean
}

// Host promises marshalled into the VM (nativeToVmType promise branch) hold
// resolve/reject function handles until they settle. Any still in flight when
// the VM is torn down (hot reload with an RPC call pending is the common case)
// would keep QuickJS GC objects alive and make JS_FreeRuntime abort with
// `list_empty(&rt->gc_obj_list)` — fatal in the release WASM build. Track them
// per-VM so teardown can dispose the stragglers.
const promiseTracking = new WeakMap<QuickJSContext, PromiseTracking>()

// Tracking is created lazily so the leak protection is self-enforcing: a VM set
// up outside withQuickJsVm that marshals a host promise still gets its pending
// deferreds tracked (and disposed via disposePendingDeferreds), instead of
// silently reverting to the JS_FreeRuntime abort.
function getOrCreateTracking(vm: QuickJSContext): PromiseTracking {
  let tracking = promiseTracking.get(vm)
  if (!tracking) {
    tracking = { deferreds: new Set(), startSyncTurn: () => {}, tornDown: false }
    promiseTracking.set(vm, tracking)
  }
  return tracking
}

/**
 * Registers the deadline hook for a VM's promise tracking. `startSyncTurn` is
 * invoked before draining pending jobs on settle (job execution is untrusted
 * scene code, so it gets its own deadline turn).
 */
export function installPromiseTracking(vm: QuickJSContext, startSyncTurn: () => void) {
  getOrCreateTracking(vm).startSyncTurn = startSyncTurn
}

/** Disposes deferred promises still in flight. Must run before `vm.dispose()`. */
export function disposePendingDeferreds(vm: QuickJSContext) {
  const tracking = promiseTracking.get(vm)
  if (!tracking) return
  // Flip the flag BEFORE disposing: settle callbacks captured this object and
  // must see the teardown even after the WeakMap entry is gone.
  tracking.tornDown = true
  promiseTracking.delete(vm)
  for (const deferred of tracking.deferreds) {
    safeDispose(deferred)
  }
  tracking.deferreds.clear()
}

/**
 * dumpAndDispose converts a QuickJSHandle into a native JS type outside the sandbox.
 *
 * Then it disposes the QuickJSHandle.
 *
 * Binary payloads (Uint8Array anywhere in the value) cross via the WASM
 * ArrayBuffer API — a memcpy per buffer — instead of the JSON-text detour, which
 * measured 3 orders of magnitude slower for CRDT-sized payloads.
 */
export function dumpAndDispose(vm: QuickJSContext, val: QuickJSHandle) {
  // Dispose `val` on every exit — including when readExtractedBinaries throws on
  // a hostile value (over-cap buffer count/size). A leaked handle would make
  // vm.dispose() throw at teardown and mask the real error.
  try {
    // Primitives can't contain binary payloads: dump them straight away instead
    // of paying a VM call to classify every string/number that crosses the
    // boundary.
    if (vm.typeof(val) === 'object') {
      const helpers = marshalHelpers.get(vm)
      if (helpers) {
        const callResult = vm.callFunction(helpers.extractBinaries, vm.undefined, val)
        if ('error' in callResult && callResult.error) {
          // Classifier failed (e.g. detached buffer): fall through to plain dump,
          // which preserves today's behavior for exotic values.
          callResult.error.dispose()
        } else {
          const extracted = vm.unwrapResult(callResult)
          try {
            // The extractor returns `false` (typeof boolean) when there is no
            // binary data anywhere in the value.
            if (vm.typeof(extracted) === 'object') {
              return readExtractedBinaries(vm, extracted, helpers.nonceKey)
            }
          } finally {
            extracted.dispose()
          }
        }
      }
    }
    // Bound the plain-dump path. Unlike the binary path (capped at
    // MAX_COERCED_BYTES), vm.dump has no ceiling, so a scene logging or returning
    // a huge string/object would materialize ~2x its serialized size on the host
    // every turn. Probe the serialized size inside the VM (bounded by the VM's
    // own memory cap + deadline; the probe returns a number, never the payload)
    // and reject over-cap values before dumping them. Numbers/booleans/etc. are
    // inherently small, so only object/string values pay for the probe.
    const valType = vm.typeof(val)
    if (valType === 'object' || valType === 'string') {
      const helpers = marshalHelpers.get(vm)
      if (helpers) {
        const sizeResult = vm.callFunction(helpers.measureSize, vm.undefined, val)
        if ('error' in sizeResult && sizeResult.error) {
          // Probe failed (e.g. the value can't be stringified): fall through to
          // plain dump, preserving today's behavior for exotic values.
          sizeResult.error.dispose()
        } else {
          const size = vm.unwrapResult(sizeResult).consume((h) => vm.getNumber(h))
          if (size > MAX_COERCED_BYTES) {
            throw new Error(`value too large to marshal out of the VM (${size} bytes)`)
          }
        }
      }
    }
    return vm.dump(val)
  } finally {
    // vm.dump() disposes the handle itself when the value is a promise
    // (pending/fulfilled/rejected) — disposing again would throw UseAfterFree.
    if (val.alive) val.dispose()
  }
}

/** Reads `{ tree, buffers }` produced by the VM-side extractor. */
function readExtractedBinaries(vm: QuickJSContext, extracted: QuickJSHandle, nonceKey: string): any {
  const buffers: Uint8Array[] = []
  Scope.withScope((scope) => {
    const buffersHandle = scope.manage(vm.getProp(extracted, 'buffers'))
    const count = vm.getProp(buffersHandle, 'length').consume((h) => vm.getNumber(h))
    if (!Number.isFinite(count) || count > MAX_MARSHAL_BUFFERS) {
      throw new Error(`too many binary payloads in one value (${count})`)
    }
    for (let i = 0; i < count; i++) {
      const lifetime = vm.getProp(buffersHandle, i).consume((h) => vm.getArrayBuffer(h))
      try {
        if (lifetime.value.byteLength > MAX_COERCED_BYTES) {
          throw new Error(`binary payload too large (${lifetime.value.byteLength} bytes)`)
        }
        // Copy immediately: the lifetime is a view into the WASM heap, and any
        // subsequent VM call may grow the heap and detach the view.
        buffers.push(new Uint8Array(lifetime.value))
      } finally {
        lifetime.dispose()
      }
    }
  })
  const tree = vm.getProp(extracted, 'tree').consume((h) => vm.dump(h))
  return reinjectBinaries(tree, buffers, nonceKey)
}

/** Replaces `{ [nonceKey]: n }` placeholders in the dumped tree with the real bytes. */
function reinjectBinaries(node: any, buffers: Uint8Array[], nonceKey: string, depth: number = 0): any {
  if (node === null || typeof node !== 'object') return node
  // Bound recursion so a deep dumped tree can't overflow the host stack. Use
  // `> MAX_MARSHAL_DEPTH`, NOT `>=`: the VM-side extractor extracts a typed array
  // regardless of depth (its typed-array check runs before its own depth guard),
  // so a placeholder CAN appear at tree-depth exactly MAX_MARSHAL_DEPTH — bailing
  // at `>=` would leave that placeholder unreplaced and drop the bytes. Beyond
  // MAX_MARSHAL_DEPTH the extractor stopped descending, so no placeholder exists
  // there and stopping is safe (and keeps recursion depth bounded at ~512).
  if (depth > MAX_MARSHAL_DEPTH) return node
  if (typeof node[nonceKey] === 'number' && Object.keys(node).length === 1) {
    return buffers[node[nonceKey]] ?? new Uint8Array(0)
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = reinjectBinaries(node[i], buffers, nonceKey, depth + 1)
    return node
  }
  for (const key of Object.keys(node)) {
    node[key] = reinjectBinaries(node[key], buffers, nonceKey, depth + 1)
  }
  return node
}

/**
 * This function converts a native JS type into a QuickJSHandle to be passed onto the VM
 */
export function nativeToVmType(vm: QuickJSContext, value: any, depth: number = 0): QuickJSHandle {
  if (typeof value === 'number') return vm.newNumber(value)
  if (typeof value === 'string') return vm.newString(value)
  if (typeof value === 'boolean') return value ? vm.true : vm.false
  if (value === undefined) return vm.undefined
  if (value === null) return vm.null
  // Bound structural recursion (arrays/objects below) so a pathologically deep
  // value can't overflow the host stack. Values here are host-controlled, so this
  // is defense-in-depth; deeper levels are truncated to undefined.
  if (depth >= MAX_MARSHAL_DEPTH) return vm.undefined
  if (value instanceof Uint8Array) {
    const helpers = marshalHelpers.get(vm)
    if (helpers) {
      // Fast path: one memcpy into the WASM heap, then wrap it into a Uint8Array
      // inside the VM. The view may be offset into a larger buffer (subarray
      // views are common on this path), so slice a tight copy when needed.
      const tight =
        value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
          ? value.buffer
          : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
      const abHandle = vm.newArrayBuffer(tight)
      try {
        return vm.unwrapResult(vm.callFunction(helpers.wrapBytes, vm.undefined, abHandle))
      } finally {
        abHandle.dispose()
      }
    }
    // No helpers installed for this context (VM set up outside withQuickJsVm):
    // fall back to evaluating the bytes as source.
    const code = `new Uint8Array(${JSON.stringify(Array.from(value))})`
    return vm.unwrapResult(vm.evalCode(code))
  }
  if (value && typeof value === 'object' && typeof value.then === 'function' && typeof value.catch === 'function') {
    const tracking = getOrCreateTracking(vm)
    const promise = vm.newPromise()
    tracking.deferreds.add(promise)
    // The tornDown/alive guards make a settle that races VM teardown a no-op
    // instead of a call into a disposed context.
    value
      .then(
        (result: any) => {
          if (tracking.tornDown || !vm.alive || !promise.alive) return
          nativeToVmType(vm, result).consume(($) => promise.resolve($))
        },
        (error: any) => {
          if (tracking.tornDown || !vm.alive || !promise.alive) return
          nativeToVmType(vm, error).consume(($) => promise.reject($))
        }
      )
      .catch((marshalError: any) => {
        // Marshalling the settle value itself failed (e.g. VM heap pressure on a
        // large payload). Leaving the deferred pending would hang the scene's
        // await for the VM's life — reject it with a plain VM-side error instead.
        if (tracking.tornDown || !promise.alive) return
        try {
          vm.newError(String(marshalError?.message ?? marshalError)).consume(($) => promise.reject($))
        } catch (err) {
          // The deferred stays pending but tracked, so teardown still disposes it.
          console.error('QuickJS: failed to reject deferred after a marshal error:', err)
        }
      })
    // IMPORTANT: Once you resolve an async action inside QuickJS,
    // call runtime.executePendingJobs() to run any code that was
    // waiting on the promise or callback. Its FAIL branch owns an error handle
    // that must be disposed (a throwing scene microtask would otherwise leak
    // one handle per throw and abort JS_FreeRuntime at teardown).
    void promise.settled.then(() => {
      tracking.deferreds.delete(promise)
      if (tracking.tornDown || !vm.alive) return
      try {
        tracking.startSyncTurn()
        drainPendingJobs(vm)
      } catch (err) {
        // A poisoned (aborted) WASM module throws from executePendingJobs even
        // while vm.alive reads true; contain it — an unhandled rejection here
        // would surface once per settling promise.
        console.error('QuickJS pending-jobs pump failed:', err)
      }
    })
    return promise.handle
  }
  if (typeof value === 'function') {
    return vm.newFunction('a', (...args) => {
      const localArgs = args.map(($) => $.consume(($) => dumpAndDispose(vm, $)))
      const val = value(...localArgs)

      return nativeToVmType(vm, val)
    })
  }
  if (Array.isArray(value)) {
    const array = vm.newArray()
    // Dispose the container if converting/assigning an element throws — otherwise
    // the array handle leaks. (Not scene-exploitable — values here are host
    // controlled — but a recursive throw shouldn't leak a VM handle.) On success we
    // return `array` without disposing.
    try {
      for (let i = 0; i < value.length; i++) {
        nativeToVmType(vm, value[i], depth + 1).consume(($) => vm.setProp(array, i, $))
      }
    } catch (e) {
      array.dispose()
      throw e
    }
    return array
  }
  if (typeof value === 'object') {
    const obj = vm.newObject()
    // Same handle-leak guard as the array path above.
    try {
      for (const key of Object.getOwnPropertyNames(value)) {
        nativeToVmType(vm, value[key], depth + 1).consume(($) => vm.setProp(obj, key, $))
      }
    } catch (e) {
      obj.dispose()
      throw e
    }
    return obj
  }
  /* istanbul ignore next */
  return vm.undefined
}

export function coerceMaybeU8Array(data: MaybeUint8Array): Uint8Array {
  if (data instanceof Uint8Array) return data
  // The scene may pass the payload as a plain object (documented fallback). Guard
  // against null/non-objects (would throw) and cap the size so a scene can't drive
  // an unbounded host allocation here.
  if (!data || typeof data !== 'object') return new Uint8Array(0)
  const keys = Object.keys(data)
  let maxIndex = -1
  for (const k of keys) {
    const idx = Number(k)
    if (Number.isInteger(idx) && idx >= 0 && idx > maxIndex) maxIndex = idx
  }
  const size = maxIndex + 1
  // A genuine Uint8Array always serializes to a DENSE object (keys 0..n-1, every
  // index present). Require density: `size === keys.length` holds iff the keys are
  // exactly the indices 0..n-1. Reject anything else (gaps or non-index keys) as
  // an empty buffer rather than zero-filling — zero-filling a sparse object would
  // let a tiny 2-key object (e.g. {0:0, 16777215:0}) drive a multi-MB allocation.
  if (size !== keys.length) return new Uint8Array(0)
  if (size > MAX_COERCED_BYTES) {
    throw new Error(`CRDT payload too large (${size} bytes)`)
  }
  // Index by numeric key (equals iteration position for a dense object).
  const out = new Uint8Array(size)
  for (const k of keys) {
    out[Number(k)] = Number((data as any)[k])
  }
  return out
}
