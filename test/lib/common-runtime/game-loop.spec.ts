import { createRpcClient, createRpcServer } from '@dcl/rpc'
import { MemoryTransport } from '@dcl/rpc/dist/transports/Memory'
import { defaultUpdateLoop, isTransportClosedError } from '../../../src/lib/common-runtime/game-loop'
import { RuntimeAbstraction } from '../../../src/lib/common-runtime/types'

describe('isTransportClosedError', () => {
  describe('when given the rejection @dcl/rpc produces on transport close', () => {
    let hostSideError: Error
    let marshalledError: { message: string; stack: string }

    beforeEach(() => {
      // Host-side shape: the dispatcher rejects in-flight calls with this Error.
      hostSideError = new Error('RPC Transport closed')
      // VM round-trip shape: nativeToVmType marshals an Error's own properties
      // (message, stack) into a plain object, and that is what reaches the
      // update loop when the rejection bubbled through scene code.
      marshalledError = { message: 'RPC Transport closed', stack: 'Error: RPC Transport closed' }
    })

    it('should match the host-side Error instance', () => {
      expect(isTransportClosedError(hostSideError)).toBe(true)
    })

    it('should match the marshalled plain-object shape', () => {
      expect(isTransportClosedError(marshalledError)).toBe(true)
    })
  })

  describe('when given unrelated errors', () => {
    let sceneError: Error

    beforeEach(() => {
      sceneError = new TypeError('cannot read properties of undefined')
    })

    it('should not match a genuine scene error', () => {
      expect(isTransportClosedError(sceneError)).toBe(false)
    })

    it('should not match null, undefined or primitives', () => {
      expect(isTransportClosedError(null)).toBe(false)
      expect(isTransportClosedError(undefined)).toBe(false)
      expect(isTransportClosedError('some string')).toBe(false)
      expect(isTransportClosedError(42)).toBe(false)
    })
  })

  // Contract test: the predicate matches @dcl/rpc's REAL rejection, so a
  // dependency bump that changes the message fails here instead of silently
  // degrading shutdown classification (spurious hot-reload errors would return).
  describe('when a real @dcl/rpc transport closes with a request in flight', () => {
    let inFlight: Promise<unknown>
    let memoryTransport: ReturnType<typeof MemoryTransport>

    beforeEach(async () => {
      memoryTransport = MemoryTransport()
      const rpcServer = createRpcServer<unknown>({})
      rpcServer.setHandler(async (port) => {
        port.registerModule('Test', async () => ({
          never: async () => new Promise<Uint8Array>(() => {})
        }))
      })
      const clientPromise = createRpcClient(memoryTransport.client)
      rpcServer.attachTransport(memoryTransport.server, {})
      const client = await clientPromise
      const port = await client.createPort('contract-test')
      const mod = (await port.loadModule('Test')) as { never(payload: Uint8Array): Promise<unknown> }
      inFlight = mod.never(new Uint8Array())
    })

    it('should reject with an error our classifier recognizes as a shutdown', async () => {
      memoryTransport.client.close()
      const rejection = await inFlight.then(
        () => {
          throw new Error('expected the in-flight request to reject')
        },
        (err) => err
      )
      expect(isTransportClosedError(rejection)).toBe(true)
    })
  })
})

describe('defaultUpdateLoop', () => {
  let consoleErrorSpy: jest.SpyInstance

  function makeRuntime(overrides: Partial<RuntimeAbstraction>): RuntimeAbstraction {
    return {
      onStart: jest.fn().mockResolvedValue(undefined),
      onUpdate: jest.fn().mockResolvedValue(undefined),
      isRunning: jest.fn().mockReturnValue(false),
      ...overrides
    }
  }

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  describe('when the scene throws while still running', () => {
    let runtime: RuntimeAbstraction

    beforeEach(() => {
      runtime = makeRuntime({
        onUpdate: jest.fn().mockRejectedValue(new TypeError('scene boom')),
        isRunning: jest.fn().mockReturnValue(true)
      })
    })

    it('should rethrow the scene error', async () => {
      await expect(defaultUpdateLoop(runtime)).rejects.toThrow('scene boom')
    })
  })

  describe('when the port closed and the error is the transport-closed rejection', () => {
    let runtime: RuntimeAbstraction

    beforeEach(() => {
      runtime = makeRuntime({
        onUpdate: jest.fn().mockRejectedValue(new Error('RPC Transport closed')),
        isRunning: jest.fn().mockReturnValue(false)
      })
    })

    it('should treat it as a clean shutdown without logging', async () => {
      await expect(defaultUpdateLoop(runtime)).resolves.toBeUndefined()
      expect(consoleErrorSpy).not.toHaveBeenCalled()
    })
  })

  describe('when the port closed but the error is a genuine scene failure', () => {
    let runtime: RuntimeAbstraction
    let sceneError: TypeError

    beforeEach(() => {
      sceneError = new TypeError('scene boom during reload')
      runtime = makeRuntime({
        onUpdate: jest.fn().mockRejectedValue(sceneError),
        isRunning: jest.fn().mockReturnValue(false)
      })
    })

    it('should not fail the (already dead) runtime', async () => {
      await expect(defaultUpdateLoop(runtime)).resolves.toBeUndefined()
    })

    it('should log the error instead of losing it', async () => {
      await defaultUpdateLoop(runtime)
      expect(consoleErrorSpy).toHaveBeenCalledWith('Scene error during shutdown:', sceneError)
    })
  })

  describe('when the scene stops running after the first frames', () => {
    let runtime: RuntimeAbstraction
    let updates: number[]

    beforeEach(() => {
      updates = []
      let frames = 0
      runtime = makeRuntime({
        onUpdate: jest.fn().mockImplementation(async (dt: number) => {
          updates.push(dt)
        }),
        isRunning: jest.fn().mockImplementation(() => frames++ < 2)
      })
    })

    it('should run the ADR-133 zero-dt first update and exit cleanly', async () => {
      await expect(defaultUpdateLoop(runtime)).resolves.toBeUndefined()
      expect(runtime.onStart).toHaveBeenCalledTimes(1)
      expect(updates[0]).toBe(0)
    })
  })
})
