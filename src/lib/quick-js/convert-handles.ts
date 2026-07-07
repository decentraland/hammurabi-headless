import { randomBytes } from "crypto"
import { QuickJSContext, QuickJSHandle, Scope } from "quickjs-emscripten-core"
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

type MarshalHelpers = {
  extractBinaries: QuickJSHandle
  wrapBytes: QuickJSHandle
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
  marshalHelpers.set(vm, { extractBinaries, wrapBytes, nonceKey })
}

/** Disposes the cached helper handles. Must run before `vm.dispose()`. */
export function disposeMarshalHelpers(vm: QuickJSContext) {
  const helpers = marshalHelpers.get(vm)
  if (!helpers) return
  marshalHelpers.delete(vm)
  helpers.extractBinaries.dispose()
  helpers.wrapBytes.dispose()
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
    return vm.dump(val)
  } finally {
    val.dispose()
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
function reinjectBinaries(node: any, buffers: Uint8Array[], nonceKey: string): any {
  if (node === null || typeof node !== 'object') return node
  if (typeof node[nonceKey] === 'number' && Object.keys(node).length === 1) {
    return buffers[node[nonceKey]] ?? new Uint8Array(0)
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = reinjectBinaries(node[i], buffers, nonceKey)
    return node
  }
  for (const key of Object.keys(node)) {
    node[key] = reinjectBinaries(node[key], buffers, nonceKey)
  }
  return node
}

/**
 * This function converts a native JS type into a QuickJSHandle to be passed onto the VM
 */
export function nativeToVmType(vm: QuickJSContext, value: any): QuickJSHandle {
  if (typeof value === 'number') return vm.newNumber(value)
  if (typeof value === 'string') return vm.newString(value)
  if (typeof value === 'boolean') return value ? vm.true : vm.false
  if (value === undefined) return vm.undefined
  if (value === null) return vm.null
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
    const promise = vm.newPromise()
    value
      .then((result: any) => nativeToVmType(vm, result).consume(($) => promise.resolve($)))
      .catch((error: any) => nativeToVmType(vm, error).consume(($) => promise.reject($)))
    // IMPORTANT: Once you resolve an async action inside QuickJS,
    // call runtime.executePendingJobs() to run any code that was
    // waiting on the promise or callback.
    void promise.settled.then(vm.runtime.executePendingJobs)
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
    for (let i = 0; i < value.length; i++) {
      nativeToVmType(vm, value[i]).consume(($) => vm.setProp(array, i, $))
    }
    return array
  }
  if (typeof value === 'object') {
    const obj = vm.newObject()
    for (const key of Object.getOwnPropertyNames(value)) {
      nativeToVmType(vm, value[key]).consume(($) => vm.setProp(obj, key, $))
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
  // Enforce the cap BEFORE allocating the output buffer and filling it.
  if (keys.length > MAX_COERCED_BYTES) {
    throw new Error(`CRDT payload too large (${keys.length} bytes)`)
  }
  const out = new Uint8Array(keys.length)
  for (let i = 0; i < keys.length; i++) {
    out[i] = (data as any)[keys[i]]
  }
  return out
}
