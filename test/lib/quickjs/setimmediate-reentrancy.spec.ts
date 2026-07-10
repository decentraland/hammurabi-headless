import { withQuickJsVm } from '../../../src/lib/quick-js/index'

// Regression coverage for the setImmediate drain in setupSetImmediate.
//
// The 16ms interval used to drain the queue with `while (immediates.length)`,
// running each callback synchronously INSIDE the loop. A scene callback that
// re-queues itself therefore kept the queue non-empty forever, and because each
// iteration reset the per-turn deadline, the interrupt handler never fired: one
// scene wedged the whole host event loop (all scenes, comms, render loop). The
// fix drains a snapshot per tick, so re-queued callbacks run on the NEXT tick —
// matching Node's own setImmediate semantics.
describe('QuickJS setImmediate re-entrancy', () => {
  describe('when a scene queues a setImmediate callback that re-queues itself forever', () => {
    it('should run it once per interval tick instead of wedging the host event loop', async () => {
      await withQuickJsVm(async (opts) => {
        opts.eval(`
          globalThis.count = 0
          globalThis.stop = false
          function f() {
            globalThis.count++
            if (!globalThis.stop) setImmediate(f)
          }
          setImmediate(f)
        `)

        // With the live-queue drain this timer never fired: the first interval
        // tick spun forever inside the drain loop, blocking the event loop.
        await new Promise((resolve) => setTimeout(resolve, 100))

        const count = opts.eval('globalThis.count') as number
        // It ran (the queue is being serviced)...
        expect(count).toBeGreaterThan(0)
        // ...but at most once per ~16ms tick — not unbounded within one tick.
        expect(count).toBeLessThan(64)

        // Stop the self-requeue so VM teardown can drain the queue cleanly.
        opts.eval('globalThis.stop = true')
        await new Promise((resolve) => setTimeout(resolve, 50))
      })
    }, 15_000)
  })
})
