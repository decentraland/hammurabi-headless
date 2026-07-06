import { QuickJSContext, QuickJSHandle, Scope } from "quickjs-emscripten-core"
import { MaybeUint8Array } from "./types"

// Upper bound on a single scene-supplied binary payload marshalled out of the VM,
// and on one coerced from a plain object. Prevents a scene from driving an
// unbounded host allocation through the marshalling layer.
const MAX_COERCED_BYTES = 16 * 1024 * 1024
// Upper bound on how many binary payloads one value crossing the boundary may
// contain (sendBinary batches many small messages; anything past this is abuse).
const MAX_MARSHAL_BUFFERS = 4096
// Placeholder key the VM-side extractor uses to mark where a Uint8Array was
// lifted out of the value tree. Host side re-injects the real bytes at these
// spots after dumping the (now binary-free) tree as JSON.
const U8_REF_KEY = '__hostU8Ref__'

/**
 * VM-side classifier: walks a value, copies every Uint8Array it contains into a
 * fresh ArrayBuffer (collected into `buffers`) and replaces it with a
 * `{ __hostU8Ref__: n }` placeholder. Returns `false` when the value contains no
 * binary data at all (the host then falls back to a plain `vm.dump`).
 *
 * Untrusted scene code never gets a reference to this function — the host holds
 * the only handle (see installMarshalHelpers) — and every primordial it relies
 * on (Object.prototype.toString brand check, the %TypedArray%.prototype.buffer
 * getter, Object.keys, Array.isArray) is captured BEFORE any scene code runs, so
 * a scene cannot tamper with prototypes to forge what the host reads.
 */
const EXTRACT_BINARIES_SOURCE = `;(() => {
  const U8 = Uint8Array
  const tag = Object.prototype.toString
  const getKeys = Object.keys
  const isArray = Array.isArray
  const bufferGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer').get
  const MAX_DEPTH = 64
  return (value) => {
    if (value === null || typeof value !== 'object') return false
    const buffers = []
    const walk = (v, depth) => {
      if (v === null || typeof v !== 'object') return v
      if (tag.call(v) === '[object Uint8Array]') {
        // new Uint8Array(typedArray) copies via internal slots (no user code, no
        // species constructor), yielding a tightly-sized buffer at offset 0.
        const copy = new U8(v)
        buffers.push(bufferGetter.call(copy))
        return { ${U8_REF_KEY}: buffers.length - 1 }
      }
      if (depth >= MAX_DEPTH) return v
      if (isArray(v)) {
        const out = new Array(v.length)
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

type MarshalHelpers = {
  extractBinaries: QuickJSHandle
  wrapBytes: QuickJSHandle
}

const marshalHelpers = new WeakMap<QuickJSContext, MarshalHelpers>()

/**
 * Compiles the two marshalling helpers inside the VM and caches their handles,
 * keyed by context. Must run BEFORE any scene code is evaluated so the helpers
 * capture untampered primordials. The handles are host-private (never exposed on
 * the VM global object), so scene code cannot see or replace them.
 */
export function installMarshalHelpers(vm: QuickJSContext) {
  const extractBinaries = vm.unwrapResult(vm.evalCode(EXTRACT_BINARIES_SOURCE, 'hostExtractBinaries.js'))
  const wrapBytes = vm.unwrapResult(vm.evalCode('(ab) => new Uint8Array(ab)', 'hostWrapBytes.js'))
  marshalHelpers.set(vm, { extractBinaries, wrapBytes })
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
  // Primitives can't contain binary payloads: dump them straight away instead of
  // paying a VM call to classify every string/number that crosses the boundary.
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
            const value = readExtractedBinaries(vm, extracted)
            val.dispose()
            return value
          }
        } finally {
          extracted.dispose()
        }
      }
    }
  }
  const ret = vm.dump(val)
  val.dispose()
  return ret
}

/** Reads `{ tree, buffers }` produced by the VM-side extractor. */
function readExtractedBinaries(vm: QuickJSContext, extracted: QuickJSHandle): any {
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
  return reinjectBinaries(tree, buffers)
}

/** Replaces `{ __hostU8Ref__: n }` placeholders in the dumped tree with the real bytes. */
function reinjectBinaries(node: any, buffers: Uint8Array[]): any {
  if (node === null || typeof node !== 'object') return node
  if (typeof node[U8_REF_KEY] === 'number' && Object.keys(node).length === 1) {
    return buffers[node[U8_REF_KEY]] ?? new Uint8Array(0)
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = reinjectBinaries(node[i], buffers)
    return node
  }
  for (const key of Object.keys(node)) {
    node[key] = reinjectBinaries(node[key], buffers)
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
