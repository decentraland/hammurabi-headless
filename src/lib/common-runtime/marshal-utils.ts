/**
 * Engine-agnostic byte-coercion shared by the RPC module bindings
 * (`common-runtime/modules.ts`) and the sandbox marshalling layer. Kept out of
 * any specific engine module so it does not couple `modules.ts` to the runtime.
 */

import { limits } from '../misc/limits'
import { limitLogger } from '../misc/limit-logger'

// Upper bound on a single binary payload coerced from a plain object. Prevents a
// scene from driving an unbounded host allocation through the marshalling layer.
// (HAMMURABI_MAX_COERCED_BYTES)
const MAX_COERCED_BYTES = limits.maxCoercedBytes

// Binary payloads normally cross the sandbox boundary as real `Uint8Array`s. This
// type survives as defense in depth for the documented plain-object fallback a
// scene may still pass (a byte-keyed object).
export type MaybeUint8Array = Uint8Array | Record<string, number>

/**
 * Returns `data` as a `Uint8Array`. Real typed arrays pass through unchanged; the
 * documented plain-object fallback (a `{0,1,2,...}` byte map) is rebuilt into
 * bytes; null/non-objects become an empty array instead of throwing. The size is
 * capped before allocating so a scene cannot drive an unbounded host allocation.
 */
export function coerceMaybeU8Array(data: MaybeUint8Array): Uint8Array {
  if (data instanceof Uint8Array) {
    // Defense in depth: the sandbox already caps a scene's per-call payload before
    // it crosses the boundary, but bound it here too so no caller can hand an
    // over-large buffer downstream.
    if (data.byteLength > MAX_COERCED_BYTES) {
      limitLogger.hit('maxCoercedBytes', `${data.byteLength} bytes`)
      throw new Error(`CRDT payload too large (${data.byteLength} bytes)`)
    }
    return data
  }
  if (!data || typeof data !== 'object') return new Uint8Array(0)
  const keys = Object.keys(data)
  // Enforce the cap BEFORE allocating the output buffer and filling it.
  if (keys.length > MAX_COERCED_BYTES) {
    limitLogger.hit('maxCoercedBytes', `${keys.length} bytes`)
    throw new Error(`CRDT payload too large (${keys.length} bytes)`)
  }
  const out = new Uint8Array(keys.length)
  for (let i = 0; i < keys.length; i++) {
    out[i] = (data as any)[keys[i]]
  }
  return out
}
