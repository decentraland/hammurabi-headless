import { withQuickJsVm } from '../../../src/lib/quick-js/index'

// The require() bridge caches the wrapped module handle and hands out duplicates,
// so a scene that calls require() many times doesn't re-wrap the host service into
// fresh VM handles (a host-memory leak). These tests exercise that path directly:
// repeated require of the SAME module must stay correct and must not leak handles
// (withQuickJsVm's teardown asserts the VM disposes cleanly).
describe('require() handle caching', () => {
  it('returns a working module on every call and does not leak when required repeatedly', async () => {
    let requireCalls = 0

    const { leaking } = await withQuickJsVm(async (opts) => {
      const logs: any[] = []
      opts.provide({
        log(...args) {
          logs.push(...args)
        },
        error() {},
        require(name: string) {
          requireCalls++
          if (name === 'same') {
            return {
              fn() {
                return 7
              }
            }
          }
          return {}
        }
      })

      opts.eval(`
        for (let i = 0; i < 50; i++) {
          const m = require('same')
          if (m.fn() !== 7) throw new Error('module returned wrong value at ' + i)
        }
        module.exports.onStart = async function () {}
      `)

      await opts.onStart()
    })

    expect(leaking).toBe(false)
    // The host factory should be invoked once; subsequent requires hit the cache.
    expect(requireCalls).toBe(1)
  })

  it('keeps distinct modules independent', async () => {
    const { leaking } = await withQuickJsVm(async (opts) => {
      const logs: any[] = []
      opts.provide({
        log(...args) {
          logs.push(...args)
        },
        error() {},
        require(name: string) {
          return { name: () => name }
        }
      })

      opts.eval(`
        const a = require('a')
        const b = require('b')
        const a2 = require('a')
        if (a.name() !== 'a') throw new Error('a wrong')
        if (b.name() !== 'b') throw new Error('b wrong')
        if (a2.name() !== 'a') throw new Error('a2 wrong')
        module.exports.onStart = async function () {}
      `)

      await opts.onStart()
    })

    expect(leaking).toBe(false)
  })
})
