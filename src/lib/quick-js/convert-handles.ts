import { QuickJSContext, QuickJSHandle } from "quickjs-emscripten-core"
import { MaybeUint8Array } from "./types"


/**
 * dumpAndDispose converts a QuickJSHandle into a native JS type outside the sandbox.
 *
 * Then it disposes the QuickJSHandle
 */
export function dumpAndDispose(vm: QuickJSContext, val: QuickJSHandle) {
  const ret = vm.getProp(vm.global, 'isUint8Array').consume((fn) => vm.callFunction(fn, vm.global, val))
  const isUint8Array = vm.unwrapResult(ret).consume(vm.dump)
  if (isUint8Array) {
    val.dispose()
    return new Uint8Array(isUint8Array)
  } else {
    const ret = vm.dump(val)
    val.dispose()
    return ret
  }
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

// Upper bound on a scene-supplied CRDT payload coerced from a plain object.
const MAX_COERCED_BYTES = 16 * 1024 * 1024

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