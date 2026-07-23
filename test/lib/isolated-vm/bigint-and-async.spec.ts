import { withIsolatedVm } from '../../../src/lib/isolated-vm/index'

// Exercises V8's BigInt support and its async job pump (promises, Promise.all,
// setImmediate/microtask draining) through our runtime, including an async
// "process" (onStart) that asynchronously computes big numbers.
//
// console.log is delivered to the host asynchronously (fire-and-forget across the
// isolate boundary), so bare-eval logging tests yield a macrotask before asserting;
// logs emitted inside an awaited onStart flush when the turn settles.
describe('isolated-vm sandbox: BigInt and async execution', () => {
  describe('when performing BigInt arithmetic inside the VM', () => {
    let logs: any[]

    beforeEach(() => {
      logs = []
    })

    it('should compute exact big-integer results beyond Number.MAX_SAFE_INTEGER', async () => {
      await withIsolatedVm(async (opts) => {
        opts.provide({
          log: (...args) => logs.push(...args),
          error: () => {},
          require: () => {
            throw new Error('not implemented')
          }
        })

        opts.eval(`
          console.log(typeof (2n ** 128n))
          console.log((2n ** 128n).toString())
          console.log((10n ** 20n + 7n).toString())
          // beyond Number.MAX_SAFE_INTEGER: proves it's real big-integer math
          console.log((9007199254740993n * 9007199254740993n).toString())
        `)

        // Flush the asynchronous console bridge before the isolate is disposed.
        await new Promise((resolve) => setTimeout(resolve, 20))
      })

      expect(logs).toEqual([
        'bigint',
        (2n ** 128n).toString(),
        (10n ** 20n + 7n).toString(),
        (9007199254740993n * 9007199254740993n).toString()
      ])
    })
  })

  describe('when an async process computes big numbers across promises and ticks', () => {
    let logs: any[]

    beforeEach(() => {
      logs = []
    })

    it('should resolve concurrent host calls and produce the derived big numbers', async () => {
      await withIsolatedVm(async (opts) => {
        opts.provide({
          log: (...args) => logs.push(...args),
          error: () => {},
          require: (name: string) => {
            if (name === 'math') {
              return {
                // host async functions the scene awaits
                async value(x: number) {
                  return x
                }
              }
            }
            throw new Error('unknown module ' + name)
          }
        })

        opts.eval(`
          const math = require('math')
          module.exports.onStart = async function () {
            // multiple concurrent async host calls
            const [a, b] = await Promise.all([math.value(20), math.value(10)])
            // yield a full tick (setImmediate + microtask drain)
            await new Promise(setImmediate)
            // big-number computation derived from the async results
            const combined = (BigInt(a) ** 3n) + (BigInt(b) ** 2n) // 20^3 + 10^2 = 8100
            console.log('combined', combined.toString())
            // a genuinely big factorial computed after the async hop
            let fact = 1n
            for (let i = 1n; i <= 30n; i++) fact *= i
            console.log('fact30', fact.toString())
          }
        `)

        await opts.onStart()
        // Flush the asynchronous console bridge before assertions/teardown.
        await new Promise((resolve) => setTimeout(resolve, 20))
      })

      let fact30 = 1n
      for (let i = 1n; i <= 30n; i++) fact30 *= i

      expect(logs).toEqual(['combined', '8100', 'fact30', fact30.toString()])
    })
  })
})
