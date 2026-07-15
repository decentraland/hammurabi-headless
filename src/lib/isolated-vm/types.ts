import type { SceneFetchInit, SceneResponse } from '../misc/scene-fetch'
import type { HostWebSocketFactory } from '../misc/scene-websocket'

/**
 * The scene-facing capabilities installed into every scene runtime, per ADR-133.
 *
 * `log`, `error` and `require` are always provided. `fetch` and `webSocket` are
 * optional: when supplied, the corresponding global (`fetch` / `WebSocket`) is
 * installed in the isolate. Runtimes/tests that don't need network access simply
 * omit them.
 */
export type ProvideOptions = {
  // console.log
  log(...args: any[]): void
  // console.error
  error(...args: any[]): void
  // global CommonJS-like require
  require(module: string): any
  // host fetch backing the scene's global `fetch` — unprivileged (unsigned),
  // SSRF-guarded, body-capped; the optional signal lets the isolate abort an
  // in-flight request. Returns a raw response the in-realm shim wraps into a
  // WHATWG-shaped Response.
  fetch?(url: string, init?: SceneFetchInit, signal?: AbortSignal): Promise<SceneResponse>
  // backing factory for the global `WebSocket` constructor (host-side connection)
  webSocket?: HostWebSocketFactory
}

/**
 * The return surface of the sandbox wrapper. Engine-agnostic: implemented here by
 * isolated-vm, consumed by `rpc-scene-runtime.ts` and the common-runtime loop.
 */
export type RunWithVmOptions = {
  /**
   * Evaluates code inside the isolate (bounded by the synchronous deadline) and
   * returns the copied value of the final expression (undefined if not copyable).
   */
  eval(code: string, filename?: string): any
  /** Runs an update tick, calling `module.exports.onUpdate` per ADR-133. */
  onUpdate(dt: number): Promise<any>
  /** Runs `module.exports.onStart` per ADR-133. */
  onStart(): Promise<void>
  /** Installs the scene-facing capabilities. */
  provide(opts: ProvideOptions): void
}

/** Overridable ceilings for the scene isolate. Defaults are the production values. */
export type IsolatedVmLimits = {
  memoryLimitBytes?: number
  maxSyncExecutionMs?: number
  maxAsyncTurnMs?: number
}
