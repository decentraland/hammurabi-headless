import { withIsolatedVm } from '../../../src/lib/isolated-vm/index'

// Engine-agnostic teardown behavior re-homed from the QuickJS pending-promise-leak
// suite. isolated-vm has no handle-leak / JS_FreeRuntime failure mode, so the
// leak-flag assertions are gone; what remains is the observable contract: a
// never-settling turn is abandoned by the async-turn deadline, and disposing the
// isolate with in-flight host work in it does not crash.
const noop = () => {}

describe('when a scene turn never settles', () => {
  it('should abandon the turn once the async-turn deadline passes', async () => {
    await expect(
      withIsolatedVm(
        async (opts) => {
          opts.provide({ log: noop, error: noop, require: () => ({}) })
          opts.eval(`module.exports.onUpdate = () => new Promise(function () {})`)
          await opts.onUpdate(0)
        },
        { maxAsyncTurnMs: 100 }
      )
    ).rejects.toThrow('scene async turn exceeded 100ms')
  })
})

describe('when a host call is still pending at teardown', () => {
  it('should dispose the isolate cleanly and return the result', async () => {
    const { result } = await withIsolatedVm(async (opts) => {
      opts.provide({
        log: noop,
        error: noop,
        // A host method whose promise never settles — the scene fires it and never
        // awaits, leaving an in-flight host call when the isolate is disposed.
        require: () => ({ async slow() { return new Promise(() => {}) } })
      })
      opts.eval(`
        const m = require('~system/Never')
        module.exports.onStart = async () => { m.slow() }
      `)
      await opts.onStart()
      return 'ok'
    })
    expect(result).toBe('ok')
  })
})

describe('when a scene throws synchronously in a turn', () => {
  it('should surface the error and still tear down', async () => {
    await expect(
      withIsolatedVm(async (opts) => {
        opts.provide({ log: noop, error: noop, require: () => ({}) })
        opts.eval(`module.exports.onStart = () => { throw new Error('boom from scene') }`)
        await opts.onStart()
      })
    ).rejects.toThrow('boom from scene')
  })
})
