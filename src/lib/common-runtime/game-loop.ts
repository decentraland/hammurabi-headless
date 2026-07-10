import { RuntimeAbstraction } from "./types"

const MIN_FRAME_TIME = 24

/**
 * True when `err` is the rejection @dcl/rpc's dispatcher hands every in-flight
 * request as its transport closes — the marker of a call abandoned by shutdown
 * (hot reload closing the scene port), not of a scene failure. The message
 * survives the VM round-trip as the `message` property of the marshalled
 * rejection, so this works both for host-side rejections and for errors that
 * bubbled through scene code.
 */
export function isTransportClosedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String((err as any)?.message ?? err)
  return message.includes('RPC Transport closed')
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

      const dtSecs = dtMillis / 1000

      await opts.onUpdate(dtSecs)
    }
  } catch (err) {
    // A turn abandoned because the scene was unloaded mid-flight (hot reload
    // closes the port while an onUpdate awaits an RPC that will never answer)
    // is a shutdown, not a scene failure. Only surface errors from a live scene.
    if (opts.isRunning()) throw err
    if (!isTransportClosedError(err)) {
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