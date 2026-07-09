import { RuntimeAbstraction } from "./types"

const MIN_FRAME_TIME = 24

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
  }
}

// Always yield through a real timer: an early-return for small values turns the
// caller's wait loop into a microtask-speed busy-wait that pins a core until the
// deadline passes (~1-2ms of spin per tick, constantly).
export async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}