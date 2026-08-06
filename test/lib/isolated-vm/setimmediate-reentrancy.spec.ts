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
      let elapsedMs = 0

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
        const started = Date.now()
        await new Promise((resolve) => setTimeout(resolve, 100))
        elapsedMs = Date.now() - started

        count = opts.eval('globalThis.count') as number

        // Stop the self-requeue so VM teardown can drain the queue cleanly.
        opts.eval('globalThis.stop = true')
        await new Promise((resolve) => setTimeout(resolve, 50))
      })

      // It ran (the queue is being serviced)...
      expect(count).toBeGreaterThan(0)

      // ...but at most once per ~16ms drain tick. Expressed against the time that
      // ACTUALLY elapsed rather than the 100ms asked for, because the two come apart
      // exactly when this suite runs alongside the others: a congested event loop
      // delivers the timer late, more drain ticks fit inside the window, and a fixed
      // ceiling of 64 fails for a reason that has nothing to do with the invariant.
      // Measured flaking under full-suite load and under coverage instrumentation,
      // while passing in isolation — which is the failure mode that reads as a
      // surviving mutant in an automated audit.
      //
      // The bound still discriminates: a live-queue drain spins forever inside the
      // FIRST tick, so `count` would be effectively unbounded and the 100ms timer
      // would never be delivered at all (the case this test exists for makes it time
      // out rather than overshoot).
      const drainTicks = Math.ceil(elapsedMs / 16)
      expect(count).toBeLessThanOrEqual(drainTicks + 8)
    }, 15_000)
  })
})
