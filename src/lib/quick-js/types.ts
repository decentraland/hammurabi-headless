import type { SceneFetchInit, SceneResponse } from '../misc/scene-fetch'
import type { HostWebSocketFactory } from '../misc/scene-websocket'

/**
 * The following object specifies the global functions added to all scene runtimes
 * as defined in https://adr.decentraland.org/adr/ADR-133.
 *
 * `log`, `error` and `require` are always provided. `fetch` and `webSocket` are
 * optional: when supplied, the corresponding global (`fetch` / `WebSocket`) is
 * installed in the VM. Runtimes/tests that don't need network access simply omit
 * them.
 **/
export type ProvideOptions = {
  // console.log
  log(...args: any[]): void
  // console.error
  error(...args: any[]): void
  // global Common.js-like require
  require(module: string): any
  // host fetch backing the scene's global `fetch` — unprivileged (unsigned),
  // SSRF-guarded, body-capped; the optional signal lets the VM abort an in-flight
  // request. Returns a raw response the VM shim wraps into a WHATWG-shaped Response.
  fetch?(url: string, init?: SceneFetchInit, signal?: AbortSignal): Promise<SceneResponse>
  // backing factory for the global `WebSocket` constructor (host-side connection)
  webSocket?: HostWebSocketFactory
}

/**
 * This is the return type of a VM wrapper
 */
export type RunWithVmOptions = {
  /**
   * Evaluates code inside the VM
   */
  eval(code: string, filename?: string): void
  /**
   * Runs an update tick, calling the exports.onUpdate function as per ADR-133
   */
  onUpdate(dt: number): Promise<any>
  /**
   * Runs the exports.onStart function as per ADR-133
   */
  onStart(): Promise<void>
  /**
   * Used to configure the VM with custom handlers.
   */
  provide(opts: ProvideOptions): void
}

// Binary payloads normally cross the VM boundary as real Uint8Arrays (see
// convert-handles.ts). This type survives as defense in depth for the documented
// plain-object fallback a scene may still pass.
export type MaybeUint8Array = Uint8Array | Record<string, number>