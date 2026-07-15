/**
 * Orderly process shutdown for the supervised deployment (a parent server spawns
 * and restarts these processes).
 *
 * The load-bearing constraint: calling `process.exit()` — or disposing a scene
 * isolate — WHILE a scene turn is executing on the isolate's native thread races
 * isolated-vm/V8 teardown and makes the process die with SIGSEGV/SIGABRT instead of
 * a clean exit (confirmed: ~100% mid-turn, 0% when the isolate is idle). The safe
 * sequence is to stop feeding the scene (close its RPC transport / disconnect
 * comms) so the scene's own update loop exits BETWEEN turns and `withIsolatedVm`'s
 * `finally` disposes the now-idle isolate on the main thread, THEN exit.
 *
 * Shutdown hooks perform that teardown; a bounded drain then lets the isolate reach
 * idle and dispose before we exit, so a supervisor sees a clean exit code (or, for
 * a signal, a clean signal termination) rather than a fake native crash.
 */

import { limits } from './limits'

/** Distinct exit codes so a supervisor can tell transient from permanent faults. */
export const EXIT_CODES = {
  /** Comms transport lost — transient; restart with a fresh connection/token. */
  COMMS_LOST: 10,
  /** Bad CLI args / config — permanent; a blind restart will just loop. */
  CONFIG: 78, // EX_CONFIG (sysexits.h)
  /** Startup failure (realm/scene unreachable, etc.) — usually transient. */
  STARTUP: 1
} as const

type ShutdownHook = () => void | Promise<void>

const hooks: ShutdownHook[] = []
let shuttingDown = false

/** Register teardown to run before the process exits (dispose scene, disconnect comms). */
export function registerShutdownHook(hook: ShutdownHook): void {
  hooks.push(hook)
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Run every shutdown hook (best-effort, each bounded), drain briefly so the scene
 * isolate reaches idle and disposes, then exit. Idempotent. When a POSIX signal
 * triggered the shutdown, re-raise the default signal after teardown (a clean OS
 * termination that never races isolate teardown); otherwise `process.exit(code)`.
 */
export async function runGracefulShutdown(
  exitCode: number,
  signal?: NodeJS.Signals,
  opts: { hookTimeoutMs?: number; drainMs?: number } = {}
): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  const hookTimeoutMs = opts.hookTimeoutMs ?? limits.shutdownHookTimeoutMs // HAMMURABI_SHUTDOWN_HOOK_TIMEOUT_MS
  const drainMs = opts.drainMs ?? limits.shutdownDrainMs // HAMMURABI_SHUTDOWN_DRAIN_MS

  for (const hook of hooks) {
    try {
      await Promise.race([Promise.resolve().then(hook), delay(hookTimeoutMs)])
    } catch {
      // best-effort: never let a teardown error stop the shutdown
    }
  }

  // Let the scene's update loop reach a between-turns check, exit, and dispose the
  // now-idle isolate on the main thread before we terminate.
  await delay(drainMs)

  if (signal) {
    // Re-raise the default signal for a crash-free OS termination.
    process.removeAllListeners(signal)
    process.kill(process.pid, signal)
    return
  }
  process.exit(exitCode)
}
