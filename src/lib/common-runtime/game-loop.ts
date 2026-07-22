import { RuntimeAbstraction } from "./types"
import { limits } from "../misc/limits"
import { limitLogger } from "../misc/limit-logger"

const MIN_FRAME_TIME = limits.minFrameTimeMs // HAMMURABI_MIN_FRAME_TIME_MS
const MAX_SCENE_DT = limits.maxSceneDtMs // HAMMURABI_MAX_SCENE_DT_MS

// Extract an error message that survives the VM round-trip: host-side rejections
// arrive as Error instances, errors bubbled through scene code as marshalled
// objects carrying a `message` property.
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  const message = (err as { message?: unknown })?.message
  return String(message ?? err)
}

/**
 * True when `err` is the rejection @dcl/rpc's dispatcher hands every in-flight
 * request as its transport closes — the marker of a call abandoned by shutdown
 * (hot reload closing the scene port), not of a scene failure. The message
 * survives the VM round-trip, so this works both for host-side rejections and
 * for errors that bubbled through scene code.
 */
export function isTransportClosedError(err: unknown): boolean {
  return errorMessage(err).includes('RPC Transport closed')
}

/**
 * The other rejection flavor a shutdown can produce: a request already queued
 * when the transport closed reaches the server AFTER `removeTransport` dropped
 * its ports, so instead of the dispatcher's transport-closed rejection the
 * client gets the server's "invalid portId" RemoteError. Same teardown race,
 * different loser.
 */
export function isPortTeardownError(err: unknown): boolean {
  return errorMessage(err).includes('invalid portId')
}

// this is the default update loop used by the scenes. it can be overriden by tests
export async function defaultUpdateLoop(opts: RuntimeAbstraction) {
  try {
    await opts.onStart()

    // by ADR-133, the first update is always 0.0 elapsed time
    await opts.onUpdate(0.0)

    let start = performance.now()

    while (opts.isRunning()) {
      const now = performance.now()
      const dtMillis = now - start

      if (dtMillis < MIN_FRAME_TIME) {
        await sleep(MIN_FRAME_TIME - dtMillis)
        continue
      }

      start = now

      if (dtMillis > MAX_SCENE_DT) limitLogger.hit('maxSceneDtMs', `${Math.round(dtMillis)}ms elapsed`)
      const dtSecs = Math.min(dtMillis, MAX_SCENE_DT) / 1000

      await opts.onUpdate(dtSecs)
    }
  } catch (err) {
    // A turn abandoned because the scene was unloaded mid-flight (hot reload
    // closes the port while an onUpdate awaits an RPC that will never answer)
    // is a shutdown, not a scene failure. Only surface errors from a live scene.
    if (opts.isRunning()) throw err
    if (!isTransportClosedError(err) && !isPortTeardownError(err)) {
      // The port closed while this error was in flight, but the error is not
      // the shutdown rejection itself: a genuine scene failure racing the
      // shutdown. The runtime is already gone, so log it instead of losing it.
      console.error('Scene error during shutdown:', err)
    }
  }
}

// Always yield through a real timer: an early-return for small values turns the
// caller's wait loop into a microtask-speed busy-wait that pins a core until the
// deadline passes (~1-2ms of spin per tick, constantly).
export async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}