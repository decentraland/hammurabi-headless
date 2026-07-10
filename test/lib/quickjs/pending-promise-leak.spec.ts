import { QuickJSContext, newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core'
import { withQuickJsVm, setupSetImmediate } from '../../../src/lib/quick-js/index'
import { quickJsVariant } from '../../../src/lib/quick-js/variant'

// Regression tests for the JS_FreeRuntime `list_empty(&rt->gc_obj_list)` abort:
// any host-side handle still alive at vm.dispose() (deferred promise resolvers,
// queued setImmediate callbacks, dropped executePendingJobs error handles) trips
// a fatal assert in the release WASM build. The common trigger is a hot reload
// tearing the VM down while an RPC promise is still in flight.
describe('quick-js handle leaks at teardown', () => {
  let modules: Record<string, any>

  function provideRequire(opts: any) {
    opts.provide({
      log() {},
      error() {},
      require(name: string) {
        return modules[name]
      }
    })
  }

  describe('when a host promise is still in flight at teardown', () => {
    let leaking: boolean

    beforeEach(async () => {
      modules = { '~test': { neverSettles: () => new Promise(() => {}) } }
      // The scene awaits a promise that never settles; the VM is torn down with
      // the deferred still pending.
      ;({ leaking } = await withQuickJsVm(async (opts) => {
        provideRequire(opts)
        opts.eval(`
          const mod = require('~test')
          mod.neverSettles().then(() => {})
        `)
      }))
    })

    it('should dispose the pending deferred without leaking', () => {
      expect(leaking).toBe(false)
    })
  })

  describe('when a scene microtask throws after a host promise settles', () => {
    let leaking: boolean

    beforeEach(async () => {
      modules = { '~test': { resolvesSoon: () => Promise.resolve(42) } }
      ;({ leaking } = await withQuickJsVm(async (opts) => {
        provideRequire(opts)
        opts.eval(`
          const mod = require('~test')
          mod.resolvesSoon().then(() => { throw new Error('scene microtask boom') })
        `)
        // let the host promise settle and the pending-jobs pump run the throwing
        // scene callback (its error handle must be disposed, not dropped)
        await new Promise((res) => setTimeout(res, 50))
      }))
    })

    it('should dispose the pending-jobs error handle without leaking', () => {
      expect(leaking).toBe(false)
    })
  })

  describe('when a host promise rejects', () => {
    let leaking: boolean
    let sceneObserved: unknown

    beforeEach(async () => {
      modules = { '~test': { rejectsSoon: () => Promise.reject(new Error('host boom')) } }
      ;({ leaking } = await withQuickJsVm(async (opts) => {
        provideRequire(opts)
        opts.eval(`
          globalThis.observed = 'pending'
          require('~test').rejectsSoon().then(
            () => { globalThis.observed = 'resolved' },
            (err) => { globalThis.observed = 'rejected:' + err.message }
          )
        `)
        // let the rejection marshal into the VM and the pump run the scene handler
        await new Promise((res) => setTimeout(res, 50))
        sceneObserved = opts.eval('globalThis.observed')
      }))
    })

    it('should deliver the rejection to the scene', () => {
      expect(sceneObserved).toBe('rejected:host boom')
    })

    it('should not leak the settled deferred', () => {
      expect(leaking).toBe(false)
    })
  })

  describe('when marshalling a host promise result fails', () => {
    let leaking: boolean
    let sceneObserved: unknown

    beforeEach(async () => {
      // Marshalling this value throws: nativeToVmType walks own properties and
      // the getter explodes, exercising the fallback that must reject the
      // deferred instead of leaving the scene's await pending forever.
      const poison = {}
      Object.defineProperty(poison, 'boom', {
        enumerable: true,
        get() {
          throw new Error('marshal boom')
        }
      })
      modules = { '~test': { poisoned: () => Promise.resolve(poison) } }
      ;({ leaking } = await withQuickJsVm(async (opts) => {
        provideRequire(opts)
        opts.eval(`
          globalThis.observed = 'pending'
          require('~test').poisoned().then(
            () => { globalThis.observed = 'resolved' },
            (err) => { globalThis.observed = 'rejected:' + err.message }
          )
        `)
        await new Promise((res) => setTimeout(res, 50))
        sceneObserved = opts.eval('globalThis.observed')
      }))
    })

    it('should reject the scene promise instead of leaving it pending forever', () => {
      expect(sceneObserved).toBe('rejected:marshal boom')
    })

    it('should not leak the deferred', () => {
      expect(leaking).toBe(false)
    })
  })

  describe('when a host promise settles after the VM is disposed', () => {
    let leaking: boolean
    let settle: (v: number) => void

    beforeEach(async () => {
      settle = () => {}
      modules = { '~test': { settlesLater: () => new Promise<number>((res) => (settle = res)) } }
      ;({ leaking } = await withQuickJsVm(async (opts) => {
        provideRequire(opts)
        opts.eval(`require('~test').settlesLater().then(() => {})`)
      }))
    })

    it('should ignore the settle instead of calling into the disposed context', async () => {
      expect(leaking).toBe(false)
      settle(1)
      await new Promise((res) => setTimeout(res, 10))
    })
  })

  describe('when an async turn times out', () => {
    let leaking: boolean
    let turnError: unknown

    // Runs a scene whose onUpdate awaits a host promise that outlives the 50ms
    // turn timeout, then settles it after the turn was abandoned. The late
    // settle produces a freshly-dup'd turn-result handle that the
    // abandoned-turn observer must dispose or JS_FreeRuntime aborts at teardown.
    async function runAbandonedTurn(mode: 'resolve' | 'reject') {
      let resolveLater: (v: number) => void = () => {}
      let rejectLater: (e: Error) => void = () => {}
      modules = {
        '~test': {
          settlesLater: () =>
            new Promise<number>((res, rej) => {
              resolveLater = res
              rejectLater = rej
            })
        }
      }
      turnError = undefined
      ;({ leaking } = await withQuickJsVm(
        async (opts) => {
          provideRequire(opts)
          opts.eval(`module.exports.onUpdate = () => require('~test').settlesLater()`)
          try {
            await opts.onUpdate(0)
          } catch (err) {
            turnError = err
          }
          if (mode === 'resolve') resolveLater(42)
          else rejectLater(new Error('late boom'))
          await new Promise((res) => setTimeout(res, 50))
        },
        { maxAsyncTurnMs: 50 }
      ))
    }

    describe('and its promise resolves later', () => {
      beforeEach(async () => {
        await runAbandonedTurn('resolve')
      })

      it('should abandon the turn with a timeout error', () => {
        expect(turnError).toBeInstanceOf(Error)
        expect((turnError as Error).message).toContain('scene async turn exceeded 50ms')
      })

      it('should dispose the late-resolving turn result without leaking', () => {
        expect(leaking).toBe(false)
      })
    })

    describe('and its promise rejects later', () => {
      beforeEach(async () => {
        await runAbandonedTurn('reject')
      })

      it('should abandon the turn with a timeout error', () => {
        expect(turnError).toBeInstanceOf(Error)
        expect((turnError as Error).message).toContain('scene async turn exceeded 50ms')
      })

      it('should dispose the late-rejecting turn result without leaking', () => {
        expect(leaking).toBe(false)
      })
    })
  })

  describe('when setImmediate callbacks are queued at teardown', () => {
    let leaking: boolean

    beforeEach(async () => {
      modules = {}
      ;({ leaking } = await withQuickJsVm(async (opts) => {
        provideRequire(opts)
        // Queue a callback and return before the 16ms pump can run it. The
        // drain loop in the finally block runs it via the interval pump; this
        // pins that no handle leaks on that path.
        opts.eval(`setImmediate(() => {})`)
      }))
    })

    it('should run the queued callback during the teardown drain without leaking', () => {
      expect(leaking).toBe(false)
    })
  })

  describe('when the setImmediate pump is disposed with callbacks still queued', () => {
    let vm: QuickJSContext
    let immediates: ReturnType<typeof setupSetImmediate>

    beforeEach(async () => {
      const Q = await newQuickJSWASMModuleFromVariant(quickJsVariant)
      vm = Q.newContext()
      immediates = setupSetImmediate(vm)
    })

    afterEach(() => {
      immediates.dispose()
      if (vm.alive) vm.dispose()
    })

    it('should dispose the queued callback handles so vm.dispose does not abort', () => {
      // Queue and dispose in the same synchronous block so the 16ms interval
      // pump cannot run the callback first — this is the drain-loop-timed-out
      // path the queue flush in dispose() exists for.
      vm.unwrapResult(vm.evalCode('setImmediate(() => {})')).dispose()
      expect(immediates.hasPendingJobs()).toBe(true)
      immediates.dispose()
      expect(immediates.hasPendingJobs()).toBe(false)
      // a leaked callback handle would abort JS_FreeRuntime here
      vm.dispose()
    })
  })
})
