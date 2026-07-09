import { withQuickJsVm } from '../../../src/lib/quick-js/index'

// Regression tests for the JS_FreeRuntime `list_empty(&rt->gc_obj_list)` abort:
// any host-side handle still alive at vm.dispose() (deferred promise resolvers,
// queued setImmediate callbacks, dropped executePendingJobs error handles) trips
// a fatal assert in the release WASM build. The common trigger is a hot reload
// tearing the VM down while an RPC promise is still in flight.
describe('quick-js handle leaks at teardown', () => {
  function provideRequire(opts: any, modules: Record<string, any>) {
    opts.provide({
      log() {},
      error() {},
      require(name: string) {
        return modules[name]
      }
    })
  }

  it('does not leak when a host promise is still in flight at teardown', async () => {
    const { leaking } = await withQuickJsVm(async (opts) => {
      provideRequire(opts, {
        '~test': {
          neverSettles: () => new Promise(() => {})
        }
      })
      // The scene awaits a promise that never settles; the VM is torn down with
      // the deferred still pending.
      opts.eval(`
        const mod = require('~test')
        mod.neverSettles().then(() => {})
      `)
    })
    expect(leaking).toBe(false)
  })

  it('does not leak when a scene microtask throws after a host promise settles', async () => {
    const { leaking } = await withQuickJsVm(async (opts) => {
      provideRequire(opts, {
        '~test': {
          resolvesSoon: () => Promise.resolve(42)
        }
      })
      opts.eval(`
        const mod = require('~test')
        mod.resolvesSoon().then(() => { throw new Error('scene microtask boom') })
      `)
      // let the host promise settle and the pending-jobs pump run the throwing
      // scene callback (its error handle must be disposed, not dropped)
      await new Promise((res) => setTimeout(res, 50))
    })
    expect(leaking).toBe(false)
  })

  it('ignores a host promise that settles after the VM is disposed', async () => {
    let settle: (v: number) => void = () => {}
    const { leaking } = await withQuickJsVm(async (opts) => {
      provideRequire(opts, {
        '~test': {
          settlesLater: () => new Promise<number>((res) => (settle = res))
        }
      })
      opts.eval(`require('~test').settlesLater().then(() => {})`)
    })
    expect(leaking).toBe(false)
    // settles after teardown: must be a no-op, not a call into a disposed context
    settle(1)
    await new Promise((res) => setTimeout(res, 10))
  })

  it('does not leak setImmediate callbacks queued at teardown', async () => {
    const { leaking } = await withQuickJsVm(async (opts) => {
      opts.provide({ log() {}, error() {}, require() { throw new Error('none') } })
      // Queue a callback and return before the 16ms pump can run it. The drain
      // loop in the finally block will run it; this pins that no handle leaks
      // either way.
      opts.eval(`setImmediate(() => {})`)
    })
    expect(leaking).toBe(false)
  })
})
