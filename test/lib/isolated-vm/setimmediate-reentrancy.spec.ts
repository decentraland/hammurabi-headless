import { withIsolatedVm } from '../../../src/lib/isolated-vm/index'

// Regression coverage for the setImmediate drain (globals.ts `provideSetImmediate`).
//
// The host drains a SNAPSHOT of the queue each 16ms tick, so a scene callback that
// re-queues itself runs on the NEXT tick — it can't keep the queue non-empty within
// a single drain and wedge the host event loop (all scenes, comms, render loop).
// This matches Node's own setImmediate semantics and the QuickJS runtime it
// replaces. Here we drive setImmediate through withIsolatedVm rather than importing
// an internal helper (there is no longer a standalone `setupSetImmediate` export).
describe('isolated-vm setImmediate re-entrancy', () => {
  describe('when a scene queues a setImmediate callback that re-queues itself forever', () => {
    it('should run it a bounded number of times per tick instead of wedging the host event loop', async () => {
      let count = 0

      await withIsolatedVm(async (opts) => {
        // setImmediate is installed by provide(); a scene needs it available.
        opts.provide({
          log() {},
          error() {},
          require() {
            throw new Error('not implemented')
          }
        })

        opts.eval(`
          globalThis.count = 0
          globalThis.stop = false
          function f() {
            globalThis.count++
            if (!globalThis.stop) setImmediate(f)
          }
          setImmediate(f)
        `)

        // With a live-queue drain the first tick would spin forever inside the
        // drain loop, blocking the event loop and this timer would never fire.
        await new Promise((resolve) => setTimeout(resolve, 100))

        count = opts.eval('globalThis.count') as number

        // Stop the self-requeue so VM teardown can drain the queue cleanly.
        opts.eval('globalThis.stop = true')
        await new Promise((resolve) => setTimeout(resolve, 50))
      })

      // It ran (the queue is being serviced)...
      expect(count).toBeGreaterThan(0)
      // ...but at most once per ~16ms tick — not unbounded within one tick.
      expect(count).toBeLessThan(64)
    }, 15_000)
  })
})
