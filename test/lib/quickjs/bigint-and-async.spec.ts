import { withQuickJsVm } from '../../../src/lib/quick-js/index'

// Exercises quickjs-ng's BigInt support and its async job pump (promises,
// Promise.all, setImmediate/microtask draining) through our runtime, including
// an async "process" (onStart) that asynchronously computes big numbers.
describe('quickjs-ng sandbox: BigInt and async execution', () => {
  it('performs BigInt arithmetic inside the VM', async () => {
    const logs: any[] = []

    await withQuickJsVm(async (opts) => {
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
    })

    expect(logs).toEqual([
      'bigint',
      (2n ** 128n).toString(),
      (10n ** 20n + 7n).toString(),
      (9007199254740993n * 9007199254740993n).toString()
    ])
  })

  it('runs an async process that computes big numbers across promises and ticks', async () => {
    const logs: any[] = []

    await withQuickJsVm(async (opts) => {
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
    })

    let fact30 = 1n
    for (let i = 1n; i <= 30n; i++) fact30 *= i

    expect(logs).toEqual(['combined', '8100', 'fact30', fact30.toString()])
  })
})
