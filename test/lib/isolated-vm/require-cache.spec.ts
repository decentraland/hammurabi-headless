import { withIsolatedVm } from '../../../src/lib/isolated-vm/index'

// The require() bridge caches the host service object per module name, so a scene
// that calls require() many times invokes the host factory (opts.require) only
// once. In isolated-vm every host method call crosses the boundary as a promise,
// so the scene awaits each call. These tests exercise that path directly.
describe('require() host-factory caching', () => {
  describe('when a module is required repeatedly', () => {
    let requireCalls: number

    beforeEach(() => {
      requireCalls = 0
    })

    it('should return a working module every time and call the host factory exactly once', async () => {
      await withIsolatedVm(async (opts) => {
        opts.provide({
          log() {},
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
          module.exports.onStart = async function () {
            for (let i = 0; i < 50; i++) {
              const m = require('same')
              const v = await m.fn()
              if (v !== 7) throw new Error('module returned wrong value at ' + i)
            }
          }
        `)

        await opts.onStart()
      })

      // The host factory should be invoked once; subsequent requires hit the cache.
      expect(requireCalls).toBe(1)
    })
  })

  describe('when distinct modules are required', () => {
    it('should keep them independent', async () => {
      await expect(
        withIsolatedVm(async (opts) => {
          opts.provide({
            log() {},
            error() {},
            require(name: string) {
              return { name: () => name }
            }
          })

          opts.eval(`
            module.exports.onStart = async function () {
              const a = require('a')
              const b = require('b')
              const a2 = require('a')
              if (await a.name() !== 'a') throw new Error('a wrong')
              if (await b.name() !== 'b') throw new Error('b wrong')
              if (await a2.name() !== 'a') throw new Error('a2 wrong')
            }
          `)

          await opts.onStart()
        })
      ).resolves.toBeDefined()
    })
  })
})
