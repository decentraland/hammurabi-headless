import { withIsolatedVm } from '../../../src/lib/isolated-vm/index'

// Broad behavioural suite for the isolated-vm sandbox, ported from the QuickJS
// vm.spec.ts. Two isolated-vm-specific adaptations run throughout:
//  - console.log crosses the isolate boundary asynchronously (fire-and-forget), so
//    bare-eval logging tests yield a macrotask (`setTimeout`) before asserting;
//    logs emitted inside an awaited onStart/onUpdate flush when the turn settles.
//  - every host module method (from `require`) returns a promise, so scenes await
//    the result rather than reading a synchronous value.
describe('isolated-vm scene runtime', () => {
  describe('when evaluating simple expressions', () => {
    it('should run with no code without throwing', async () => {
      await expect(withIsolatedVm(async () => {})).resolves.toBeDefined()
    })

    it('should return undefined for an empty script', async () => {
      await withIsolatedVm(async (opts) => {
        expect(opts.eval(``)).toEqual(void 0)
      })
    })

    it('should evaluate expressions and return their values', async () => {
      await withIsolatedVm(async (opts) => {
        expect(opts.eval(`void 0`)).toEqual(void 0)
        expect(opts.eval(`1==1`)).toEqual(true)
      })
    })

    it('should convert VM values to native JS values, including Uint8Array', async () => {
      await withIsolatedVm(async (opts) => {
        expect(opts.eval(`true`)).toEqual(true)
        expect(opts.eval(`false`)).toEqual(false)
        expect(opts.eval(`null`)).toEqual(null)
        expect(opts.eval(`123`)).toEqual(123)
        expect(opts.eval(`"123"`)).toEqual('123')
        expect(opts.eval(`["123"]`)).toEqual(['123'])
        expect(opts.eval(`(() => ({a: "123"}))()`)).toEqual({ a: '123' })
        expect(opts.eval(`new Uint8Array([1,2,3])`)).toEqual(new Uint8Array([1, 2, 3]))
      })
    })
  })

  describe('when evaluating code that fails', () => {
    it('should propagate a write to an undefined reference as a TypeError', async () => {
      await expect(
        withIsolatedVm(async (opts) => {
          opts.eval(`undefined.a = 1`)
        })
      ).rejects.toThrow("Cannot set properties of undefined (setting 'a')")
    })

    it('should propagate a thrown Error from evaluated code', async () => {
      await expect(
        withIsolatedVm(async (opts) => {
          opts.eval(`
            function test () {
              throw new Error('test error')
            }
            test()
          `)
        })
      ).rejects.toThrow('test error')
    })

    it('should propagate a syntax error', async () => {
      await expect(
        withIsolatedVm(async (opts) => {
          opts.eval(`as{d`)
        })
      ).rejects.toThrow('Unexpected token')
    })
  })

  describe('when installing capabilities via provide', () => {
    it('should install log/error/require without throwing', async () => {
      await withIsolatedVm(async (opts) => {
        const values: any[] = []
        opts.provide({
          log(...args) {
            values.push(args)
          },
          error() {
            throw new Error('not implemented')
          },
          require() {
            throw new Error('not implemented')
          }
        })
      })
    })
  })

  describe('when the scene logs through console', () => {
    let values: any[]

    beforeEach(() => {
      values = []
    })

    it('should forward each logged value to the host log/error', async () => {
      await withIsolatedVm(async (opts) => {
        opts.provide({
          log(...args) {
            values.push(args)
          },
          error(...args) {
            values.push(args)
          },
          require() {
            throw new Error('not implemented')
          }
        })

        opts.eval(`
          console.log(true)
          console.log(false)
          console.log(null)
          console.log(123)
          console.log("123")
          console.log(["123"])
          console.error((() => ({a: "123"}))())
          console.log(new Uint8Array([1,2,3]))
        `)

        await new Promise((resolve) => setTimeout(resolve, 20))
      })

      expect(values).toEqual([
        [true],
        [false],
        [null],
        [123],
        ['123'],
        [['123']],
        [{ a: '123' }],
        [new Uint8Array([1, 2, 3])]
      ])
    })

    it('should expose module/exports as objects inside the sandbox', async () => {
      const logs: any[] = []
      await withIsolatedVm(async (opts) => {
        opts.provide({
          log(...args) {
            logs.push(...args)
          },
          error(...args) {
            logs.push(...args)
          },
          require() {
            throw 'Not implemented'
          }
        })

        opts.eval(`
          console.log(1)
          console.log(typeof exports)
          console.log(typeof module)
          console.log(typeof module.exports)
          console.log(typeof module.asd)
        `)

        await new Promise((resolve) => setTimeout(resolve, 20))
      })

      expect(logs).toEqual([1, 'object', 'object', 'object', 'undefined'])
    })
  })

  describe('when the scene calls a host module method', () => {
    let values: any[]

    beforeEach(() => {
      values = []
    })

    it('should deliver every native argument type to the host, including Uint8Array', async () => {
      await withIsolatedVm(async (opts) => {
        opts.provide({
          log() {
            throw new Error('not implemented')
          },
          error() {
            throw new Error('not implemented')
          },
          require() {
            return {
              fn(...args: any[]) {
                values.push(args)
              }
            }
          }
        })

        // Host method calls resolve asynchronously, so the scene awaits each one.
        opts.eval(`
          module.exports.onStart = async function () {
            const m = require('test')
            await m.fn(true)
            await m.fn(false)
            await m.fn(null)
            await m.fn(123)
            await m.fn("123")
            await m.fn(["123"])
            await m.fn((() => ({a: "123"}))())
            await m.fn(new Uint8Array([1,2,3]))
          }
        `)

        await opts.onStart()
      })

      expect(values).toEqual([
        [true],
        [false],
        [null],
        [123],
        ['123'],
        [['123']],
        [{ a: '123' }],
        [new Uint8Array([1, 2, 3])]
      ])
    })

    it('should return native types including bytes from host methods', async () => {
      const logs: any[] = []
      await withIsolatedVm(async (opts) => {
        opts.provide({
          log(...args) {
            logs.push(...args)
          },
          error(...args) {
            logs.push(...args)
          },
          require(moduleName) {
            if (moduleName === 'test') {
              return {
                fnNumber() {
                  return 1
                },
                fnBytes() {
                  return new Uint8Array([1, 2, 3])
                },
                fnNativeTypes() {
                  return {
                    Number: 1,
                    String: 'asd',
                    True: true,
                    False: false,
                    Null: null,
                    Undefined: undefined,
                    nested: { object: true },
                    array: [1, null, false]
                  }
                }
              }
            }
          }
        })

        opts.eval(`
          module.exports.onStart = async function () {
            const t = require('test')
            console.log(typeof t.fnNumber)
            console.log(await t.fnNumber('test'))
            console.log(['test'])
            console.log(await t.fnNativeTypes())
            console.log(new Uint8Array([3,3,3]))
            console.log(await t.fnBytes(new Uint8Array([1,2,3])))
          }
        `)

        await opts.onStart()
        // Flush the asynchronous console bridge before assertions/teardown.
        await new Promise((resolve) => setTimeout(resolve, 20))
      })

      expect(logs).toEqual([
        'function',
        1,
        ['test'],
        {
          False: false,
          Null: null,
          True: true,
          nested: {
            object: true
          },
          Number: 1,
          String: 'asd',
          array: [1, null, false]
        },
        new Uint8Array([3, 3, 3]),
        new Uint8Array([1, 2, 3])
      ])
    })

    it('should let the scene await host promises in order', async () => {
      const logs: any[] = []
      let wasCalledWithValue: any = -999
      await withIsolatedVm(async (opts) => {
        opts.provide({
          log(...args) {
            logs.push(...args)
          },
          error(...args) {
            logs.push(...args)
          },
          require(moduleName) {
            if (moduleName === 'test') {
              return {
                async promise(arg: any) {
                  wasCalledWithValue = arg
                  return Promise.resolve(1)
                }
              }
            }
          }
        })

        opts.eval(`
          const t = require('test');
          module.exports.onStart = async function() {
            const r = t.promise(123)
            console.log(r instanceof Promise ? 'its a promise' : 'ah re')
            await Promise.resolve(123)
            console.log('awaiting promises work')
            console.log(await r)
            console.log('end')
          }
        `)

        await opts.onStart()
        // Flush the asynchronous console bridge before assertions/teardown.
        await new Promise((resolve) => setTimeout(resolve, 20))
      })

      expect(wasCalledWithValue).toEqual(123)
      expect(logs).toEqual(['its a promise', 'awaiting promises work', 1, 'end'])
    })
  })

  describe('when running onStart and onUpdate turns', () => {
    let logs: any[]

    beforeEach(() => {
      logs = []
    })

    it('should invoke both hooks and preserve log ordering', async () => {
      await withIsolatedVm(async (opts) => {
        opts.provide({
          log(...args) {
            logs.push(...args)
          },
          error(...args) {
            logs.push(...args)
          },
          require() {
            throw 'Not implemented'
          }
        })

        opts.eval(`
          module.exports.onStart = async function () {
            console.log('onStart')
          }
          module.exports.onUpdate = async function (dt) {
            console.log('onUpdate', dt)
          }
        `)

        await opts.onStart()
        await opts.onUpdate(0)
        await opts.onUpdate(1)
        // Flush the asynchronous console bridge before assertions/teardown.
        await new Promise((resolve) => setTimeout(resolve, 20))
      })

      expect(logs).toEqual(['onStart', 'onUpdate', 0, 'onUpdate', 1])
    })

    it('should propagate an error thrown by onStart', async () => {
      await expect(
        withIsolatedVm(async (opts) => {
          opts.eval(`
            module.exports.onStart = async function () {
              throw new Error('onStart error')
            }
          `)

          await opts.onStart()
        })
      ).rejects.toThrow('onStart error')
    })

    it('should tolerate a missing (undefined) onUpdate without throwing', async () => {
      await withIsolatedVm(async (opts) => {
        opts.provide({
          log() {},
          error() {},
          require() {
            return {}
          }
        })

        opts.eval(`module.exports.onUpdate = undefined`)

        await expect(opts.onUpdate(1)).resolves.toBeUndefined()
      })
    })

    it('should propagate errors from both hooks and still preserve pre-error logs', async () => {
      await withIsolatedVm(async (opts) => {
        opts.provide({
          log(...args) {
            logs.push(...args)
          },
          error(...args) {
            logs.push(...args)
          },
          require() {
            throw 'Not implemented'
          }
        })

        opts.eval(`
          module.exports.onStart = async function () {
            console.log('onStart')
            throw new Error('onStartFailed')
          }
          module.exports.onUpdate = async function (dt) {
            console.log('onUpdate', dt)
            await Promise.resolve(1)
            throw new Error('onUpdateFailed')
          }
        `)

        await expect(opts.onStart()).rejects.toThrow('onStartFailed')
        await expect(opts.onUpdate(0)).rejects.toThrow('onUpdateFailed')
        // Flush the asynchronous console bridge before assertions/teardown.
        await new Promise((resolve) => setTimeout(resolve, 20))
      })

      expect(logs).toEqual(['onStart', 'onUpdate', 0])
    })

    it('should tolerate a scene that only defines onUpdate', async () => {
      await withIsolatedVm(async (opts) => {
        opts.provide({
          log(...args) {
            logs.push(...args)
          },
          error(...args) {
            logs.push(...args)
          },
          require(_moduleName) {
            return {}
          }
        })

        opts.eval(`
          module.exports.onUpdate = async function() {
          }
        `)

        await expect(opts.onUpdate(0.0)).resolves.toBeUndefined()
      })
    })
  })

  describe('when the scene uses setImmediate', () => {
    let logs: any[]

    beforeEach(() => {
      logs = []
    })

    it('should resolve a promise wired to setImmediate', async () => {
      await withIsolatedVm(async (opts) => {
        opts.provide({
          log(...args) {
            logs.push(...args)
          },
          error() {
            throw 'Not implemented'
          },
          require() {
            throw 'Not implemented'
          }
        })

        opts.eval(`
          module.exports.onUpdate = async function () {
            console.log('onUpdate')
            await new Promise(setImmediate)
            console.log('onUpdateEnd')
          }
        `)

        await opts.onUpdate(1)
        // Flush the asynchronous console bridge before assertions/teardown.
        await new Promise((resolve) => setTimeout(resolve, 20))
      })

      expect(logs).toEqual(['onUpdate', 'onUpdateEnd'])
    })

    it('should tolerate a setImmediate callback that throws', async () => {
      await withIsolatedVm(async (opts) => {
        opts.provide({
          log(...args) {
            logs.push(...args)
          },
          error() {
            throw 'Not implemented'
          },
          require() {
            throw 'Not implemented'
          }
        })

        opts.eval(`
          module.exports.onStart = async function () {
            console.log('onStart')
            setImmediate(() => { throw new Error('Error from setImmediate, this error is expected') })
            console.log('onStartEnd')
          }
          module.exports.onUpdate = async function () {}
        `)

        await opts.onStart()
        // Let the drain tick run the throwing callback; it must not wedge the loop.
        await opts.onUpdate(0)
        await new Promise((resolve) => setTimeout(resolve, 30))
      })

      expect(logs).toEqual(['onStart', 'onStartEnd'])
    })
  })
})
