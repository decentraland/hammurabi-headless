import { withIsolatedVm } from '../../../src/lib/isolated-vm/index'

// Regression coverage for the per-turn execution deadline in withIsolatedVm.
//
// The deadline must be measured PER synchronous turn (each eval / onStart /
// onUpdate), not cumulatively across turns. A scene running many normal frames must
// not be false-killed once the *sum* of its turns crosses the budget.
describe('isolated-vm per-turn execution deadline', () => {
  describe('when many back-to-back turns each stay under the budget but their sum exceeds it', () => {
    it('should complete every turn without interrupting any of them', async () => {
      const BUDGET_MS = 1000
      const PER_TURN_MS = 80
      const TURNS = 20 // total busy time (~1600ms) is well over BUDGET_MS on purpose

      const completed: number[] = []

      await withIsolatedVm(
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
  })

  describe('when a scene runs a catastrophic-backtracking regex', () => {
    it('should interrupt it at the deadline rather than backtracking forever', async () => {
      const start = Date.now()

      await expect(
        withIsolatedVm(
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
      ).rejects.toThrow('Script execution timed out')

      // Must be the deadline that stopped it, not a real (exponential) hang.
      expect(Date.now() - start).toBeLessThan(5000)
    })
  })

  describe('when a scene runs a single runaway synchronous turn', () => {
    it('should interrupt it at the deadline', async () => {
      const start = Date.now()

      await expect(
        withIsolatedVm(
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
      ).rejects.toThrow('Script execution timed out')

      // It must be the deadline that stopped it, not a real hang.
      expect(Date.now() - start).toBeLessThan(5000)
    })
  })
})

describe('isolated-vm binary marshalling is tamper-proof', () => {
  describe('when a scene poisons prototypes/globals then passes a real Uint8Array to a host method', () => {
    it('should deliver the real bytes to the host, not the attacker-forged bytes', async () => {
      let received: any = null

      await withIsolatedVm(async (opts) => {
        // An EngineApi-like host method: it records the bytes it was handed.
        opts.provide({
          log() {},
          error() {},
          require() {
            return {
              crdtSendToRenderer(payload: Uint8Array) {
                received = payload
                return { ok: true }
              }
            }
          }
        })

        // Binary crosses the boundary via V8's structured clone (internal-slot
        // based), so poisoning the typed-array prototype chain, species, brand
        // checks, or Object/Array statics must not change what the host reads.
        opts.eval(`
          try { Object.defineProperty(Uint8Array.prototype, 'buffer', { get() { return new ArrayBuffer(3) } }) } catch (e) {}
          try { Object.getPrototypeOf(Uint8Array.prototype).slice = function () { return new Uint8Array([9, 9, 9]) } } catch (e) {}
          try { Object.defineProperty(Uint8Array, Symbol.species, { get() { return function () { return new Uint8Array([9, 9, 9]) } } }) } catch (e) {}
          try { Object.prototype.toString = function () { return '[object Object]' } } catch (e) {}
          try { Array.isArray = function () { return false } } catch (e) {}
          try { Object.keys = function () { return [] } } catch (e) {}

          module.exports.onStart = async function () {
            const engine = require('engine')
            await engine.crdtSendToRenderer(new Uint8Array([1, 2, 3]))
          }
        `)

        await opts.onStart()
      })

      expect(received).toBeInstanceOf(Uint8Array)
      expect(Array.from(received as Uint8Array)).toEqual([1, 2, 3])
    })
  })

  describe('when a scene returns a plain object merely labelled Uint8Array via Symbol.toStringTag', () => {
    it('should NOT treat it as binary but marshal it as an ordinary object', async () => {
      const { result } = await withIsolatedVm(async (opts) =>
        opts.eval(`({
          [Symbol.toStringTag]: 'Uint8Array',
          0: 1,
          1: 2,
          2: 3,
          length: 3
        })`)
      )

      expect(result).not.toBeInstanceOf(Uint8Array)
      expect(result).toEqual({ 0: 1, 1: 2, 2: 3, length: 3 })
    })
  })

  describe('when a scene returns a deeply nested Uint8Array', () => {
    it('should marshal it out without silent corruption', async () => {
      const { result } = await withIsolatedVm(async (opts) =>
        opts.eval(`
          (() => {
            let node = { data: new Uint8Array([7, 7, 7]) }
            for (let i = 0; i < 40; i++) node = { child: node }
            return node
          })()
        `)
      )

      let cursor: any = result
      for (let i = 0; i < 40; i++) cursor = cursor.child
      expect(cursor.data).toEqual(new Uint8Array([7, 7, 7]))
    })
  })
})
