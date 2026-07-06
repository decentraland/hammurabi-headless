import { withQuickJsVm } from '../../../src/lib/quick-js/index'

// Regression coverage for the per-turn execution deadline in withQuickJsVm.
//
// The deadline must be measured PER synchronous turn (each eval / onStart /
// onUpdate), not cumulatively across turns. A previous implementation reset the
// deadline only when the gap between interrupt-handler calls exceeded a
// threshold; because the handler fires continuously during a busy turn, the
// deadline was effectively never reset and a scene running many normal frames was
// eventually false-killed once the *sum* of its turns crossed the budget.
describe('QuickJS per-turn execution deadline', () => {
  it('does NOT interrupt many back-to-back turns whose sum exceeds the budget', async () => {
    const BUDGET_MS = 1000
    const PER_TURN_MS = 80
    const TURNS = 20 // total busy time (~1600ms) is well over BUDGET_MS on purpose

    const completed: number[] = []

    await withQuickJsVm(
      async (opts) => {
        opts.provide({
          log() {},
          error() {},
          require() {
            throw new Error('not implemented')
          }
        })

        opts.eval(`
          module.exports.onUpdate = async function (i) {
            const start = Date.now()
            while (Date.now() - start < ${PER_TURN_MS}) {}
            return i
          }
        `)

        for (let i = 0; i < TURNS; i++) {
          await opts.onUpdate(i)
          completed.push(i)
        }
      },
      { maxSyncExecutionMs: BUDGET_MS }
    )

    // Every turn must have completed; none should have been interrupted even
    // though the cumulative busy time far exceeds a single turn's budget.
    expect(completed).toHaveLength(TURNS)
  })

  it('interrupts a catastrophic-backtracking regex (quickjs-ng polls the handler in regex)', async () => {
    // The old pinned 2021 engine did NOT poll the interrupt handler inside the
    // regex engine, so this would run (effectively) forever and defeat the
    // deadline. quickjs-ng polls in regex, so the deadline bounds it.
    const start = Date.now()

    await expect(
      withQuickJsVm(
        async (opts) => {
          opts.eval(`
            module.exports.onStart = async function () {
              /(a+)+$/.test('a'.repeat(50) + '!')
            }
          `)
          await opts.onStart()
        },
        { maxSyncExecutionMs: 300 }
      )
    ).rejects.toThrow()

    // Must be the deadline that stopped it, not a real (exponential) hang.
    expect(Date.now() - start).toBeLessThan(5000)
  })

  it('DOES interrupt a single runaway synchronous turn', async () => {
    const start = Date.now()

    await expect(
      withQuickJsVm(
        async (opts) => {
          opts.eval(`
            module.exports.onStart = async function () {
              while (true) {}
            }
          `)
          await opts.onStart()
        },
        { maxSyncExecutionMs: 200 }
      )
    ).rejects.toThrow()

    // It must be the deadline that stopped it, not a real hang.
    expect(Date.now() - start).toBeLessThan(5000)
  })
})

describe('QuickJS binary marshalling is tamper-proof', () => {
  it('an untrusted scene cannot tamper with prototypes or globals to forge host-side bytes', async () => {
    await withQuickJsVm(async (opts) => {
      // The marshalling helpers are host-private (there is no global for the
      // scene to overwrite) and captured their primordials before any scene code
      // ran, so poisoning the typed-array prototype chain, brand checks, or
      // Object/Array statics must not change what the host reads.
      opts.eval(`
        try { Object.defineProperty(Uint8Array.prototype, 'buffer', { get() { return new ArrayBuffer(3) } }) } catch (e) {}
        try { Object.getPrototypeOf(Uint8Array.prototype).slice = function () { return new Uint8Array([9, 9, 9]) } } catch (e) {}
        try { Object.defineProperty(Uint8Array, Symbol.species, { get() { return function () { return new Uint8Array([9, 9, 9]) } } }) } catch (e) {}
        try { Object.prototype.toString = function () { return '[object Object]' } } catch (e) {}
        try { Array.isArray = function () { return false } } catch (e) {}
        try { Object.keys = function () { return [] } } catch (e) {}
        try { globalThis.isUint8Array = function () { return [9, 9, 9] } } catch (e) {}
      `)

      // The host must still marshal the real bytes, not the attacker's [9,9,9].
      expect(opts.eval(`new Uint8Array([1, 2, 3])`)).toEqual(new Uint8Array([1, 2, 3]))
      // Nested payloads (the crdtSendToRenderer shape) must survive tampering too.
      expect(opts.eval(`({ data: new Uint8Array([4, 5, 6]) })`)).toEqual({ data: new Uint8Array([4, 5, 6]) })
    })
  })
})
