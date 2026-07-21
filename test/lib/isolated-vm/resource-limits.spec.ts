import { withIsolatedVm } from '../../../src/lib/isolated-vm/index'
import { limits } from '../../../src/lib/misc/limits'

// Regression coverage for the resource-exhaustion / DoS hardening: an untrusted
// scene must not be able to amplify isolate-bounded data into unbounded HOST
// memory, nor wedge the host event loop past the turn deadline.
const noop = () => {}

describe('when a scene passes an oversized payload to a host module', () => {
  let hostMaxBytes: number
  let sceneError: string

  beforeEach(async () => {
    hostMaxBytes = 0
    sceneError = ''
    await withIsolatedVm(async (opts) => {
      opts.provide({
        log: noop,
        error: noop,
        require: () => ({
          async crdtSendToRenderer(req: any) {
            hostMaxBytes = Math.max(hostMaxBytes, req?.data ? req.data.byteLength : 0)
            return {}
          }
        })
      })
      opts.eval(`
        const e = require('~system/EngineApi')
        module.exports.onStart = async () => {
          try { await e.crdtSendToRenderer({ data: new Uint8Array(64 * 1024 * 1024) }) }
          catch (err) { globalThis.__err = String(err.message) }
        }
      `)
      await opts.onStart()
      sceneError = opts.eval('globalThis.__err || ""')
    })
  })

  it('should reject in the isolate before the payload is copied into host memory', () => {
    expect(hostMaxBytes).toBe(0)
    expect(sceneError).toMatch(/too large/i)
  })
})

describe('when a scene tries to bypass the payload cap with a size-changing getter', () => {
  let hostBytes: number

  beforeEach(async () => {
    hostBytes = -1
    await withIsolatedVm(async (opts) => {
      opts.provide({
        log: noop,
        error: noop,
        require: () => ({ async crdtSendToRenderer(req: any) { hostBytes = req?.data ? req.data.byteLength : 0; return {} } })
      })
      opts.eval(`
        const e = require('~system/EngineApi')
        module.exports.onStart = async () => {
          let n = 0
          const arg = { get data() { n++; return n === 1 ? new Uint8Array(8) : new Uint8Array(64 * 1024 * 1024) } }
          try { await e.crdtSendToRenderer(arg) } catch (err) { globalThis.__e = String(err.message) }
        }
      `)
      await opts.onStart()
    })
  })

  it('should read the argument exactly once so measure and copy cannot diverge', () => {
    // The getter is invoked once by the defensive clone; the host never sees the
    // 64MB second value.
    expect(hostBytes).toBeLessThanOrEqual(8)
  })
})

describe('when a scene poisons the globals the payload cap relies on', () => {
  let hostBytes: number
  let sceneError: string

  beforeEach(async () => {
    hostBytes = 0
    sceneError = ''
    await withIsolatedVm(async (opts) => {
      opts.provide({
        log: noop,
        error: noop,
        require: () => ({ async crdtSendToRenderer(req: any) { hostBytes = req?.data ? req.data.byteLength : 0; return {} } })
      })
      opts.eval(`
        Object.keys = function () { return [] }
        ArrayBuffer.isView = function () { return false }
        Object.defineProperty(ArrayBuffer, Symbol.hasInstance, { value: function () { return false } })
        const e = require('~system/EngineApi')
        module.exports.onStart = async () => {
          try { await e.crdtSendToRenderer({ data: new Uint8Array(64 * 1024 * 1024) }) }
          catch (err) { globalThis.__e = String(err.message) }
        }
      `)
      await opts.onStart()
      sceneError = opts.eval('globalThis.__e || ""')
    })
  })

  it('should still reject the oversized payload using primordials captured before scene code ran', () => {
    expect(hostBytes).toBe(0)
    expect(sceneError).toMatch(/too large/i)
  })
})

describe('when a scene hides payload size in object keys or a bigint', () => {
  let keyBytes: number
  let bigintBytes: number

  beforeEach(async () => {
    keyBytes = -1
    bigintBytes = -1
    await withIsolatedVm(async (opts) => {
      opts.provide({
        log: noop,
        error: noop,
        require: () => ({ async subscribe(req: any) { return { got: JSON.stringify(req).length } } })
      })
      opts.eval(`
        const m = require('~system/EngineApi')
        module.exports.onStart = async () => {
          const bigKey = 'k'.repeat(40 * 1000 * 1000)
          try { await m.subscribe({ [bigKey]: 1 }) } catch (e) { globalThis.__k = String(e.message) }
          try { await m.subscribe({ n: 2n ** (8n * 33554432n) }) } catch (e) { globalThis.__b = String(e.message) }
        }
      `)
      await opts.onStart()
      keyBytes = /too large/i.test(opts.eval('globalThis.__k || ""')) ? 0 : 1
      bigintBytes = /too large/i.test(opts.eval('globalThis.__b || ""')) ? 0 : 1
    })
  })

  it('should charge property keys and bigint magnitude against the cap', () => {
    expect(keyBytes).toBe(0)
    expect(bigintBytes).toBe(0)
  })
})

describe('when a scene broadcasts one buffer aliased to several peers', () => {
  let accepted: boolean

  beforeEach(async () => {
    accepted = false
    await withIsolatedVm(async (opts) => {
      opts.provide({
        log: noop,
        error: noop,
        require: () => ({ async sendBinary() { accepted = true; return {} } })
      })
      opts.eval(`
        const m = require('~system/CommunicationsController')
        module.exports.onStart = async () => {
          const msg = new Uint8Array(3 * 1024 * 1024) // 3MB, unique
          const peerData = []
          for (let i = 0; i < 6; i++) peerData.push({ address: ['0x' + i], data: [msg] }) // same buffer x6
          try { await m.sendBinary({ data: [], peerData }) } catch (e) { globalThis.__e = String(e.message) }
        }
      `)
      await opts.onStart()
    })
  })

  it('should charge the shared buffer once so a legit broadcast is not rejected', () => {
    // 6 × 3MB would exceed 16MB if double-charged; aliasing charges 3MB once.
    expect(accepted).toBe(true)
  })
})

describe('when a scene fans out more concurrent host calls than allowed', () => {
  // Derive both the fan-out and the assertion from the configured knob (the shim
  // interpolates the same limits singleton), so a default bump can't silently
  // break this spec or leave the overflow assertion vacuous.
  const FAN_OUT = limits.maxInflightHostCalls + 8
  let hostCalls: number
  let rejections: number

  beforeEach(async () => {
    hostCalls = 0
    rejections = 0
    await withIsolatedVm(async (opts) => {
      opts.provide({
        log: noop,
        error: noop,
        require: () => ({
          // Never settles, so every call stays in-flight and the cap is exercised.
          async slow() { hostCalls++; return new Promise(() => {}) }
        })
      })
      opts.eval(`
        const m = require('~system/X')
        module.exports.onStart = async () => {
          let rej = 0
          for (let i = 0; i < ${FAN_OUT}; i++) { m.slow().catch(() => { rej++ }) }
          await new Promise((r) => setImmediate(r))
          globalThis.__rej = rej
        }
      `)
      await opts.onStart()
      rejections = opts.eval('globalThis.__rej || 0')
    })
  })

  it('should reject the calls beyond the in-flight cap', () => {
    expect(hostCalls).toBeLessThanOrEqual(limits.maxInflightHostCalls)
    expect(rejections).toBeGreaterThan(0)
  })
})

describe('when a scene runs an infinite sync loop in an await-continuation', () => {
  it('should abandon the turn at the async-turn deadline instead of wedging the host', async () => {
    let beats = 0
    const hb = setInterval(() => { beats++ }, 100)
    const start = Date.now()
    const run = withIsolatedVm(
      async (opts) => {
        opts.provide({ log: noop, error: noop, require: () => ({ async ping() { return 1 } }) })
        opts.eval(`
          const m = require('~system/X')
          module.exports.onUpdate = async () => { await m.ping(); while (true) {} }
        `)
        await opts.onUpdate(0)
      },
      { maxSyncExecutionMs: 400, maxAsyncTurnMs: 1000 }
    )
    await expect(run).rejects.toThrow(/async turn exceeded/i)
    clearInterval(hb)
    // The host timer fired reasonably close to the deadline and the loop kept
    // running throughout — proof the main thread was never blocked by the wedge.
    expect(Date.now() - start).toBeLessThan(3000)
    expect(beats).toBeGreaterThanOrEqual(3)
  })
})

describe('when a scene schedules a runaway self-requeuing setImmediate callback', () => {
  it('should tear the scene down rather than freezing the host forever', async () => {
    let beats = 0
    const hb = setInterval(() => { beats++ }, 100)
    const start = Date.now()
    const run = withIsolatedVm(
      async (opts) => {
        opts.provide({ log: noop, error: noop, require: () => ({}) })
        opts.eval(`
          function runaway(){ setImmediate(runaway); const s = Date.now(); while (Date.now() - s < 100000) {} }
          module.exports.onStart = async () => { setImmediate(runaway) }
          module.exports.onUpdate = async () => {}
        `)
        await opts.onStart()
        for (let i = 0; i < 200; i++) { await opts.onUpdate(0); await new Promise((r) => setTimeout(r, 20)) }
      },
      { maxSyncExecutionMs: 400, maxAsyncTurnMs: 3000 }
    )
    await expect(run).rejects.toThrow(/disposed/i)
    clearInterval(hb)
    expect(Date.now() - start).toBeLessThan(8000)
    expect(beats).toBeGreaterThanOrEqual(3)
  })
})
