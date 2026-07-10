import * as BABYLON from '@babylonjs/core'
import { Transport } from '@dcl/rpc'
import { Scene } from '@dcl/schemas'
import { SceneContext } from '../../../../src/lib/babylon/scene/scene-context'
import { unloadScene } from '../../../../src/lib/babylon/scene/load'
import { loadedScenesByEntityId } from '../../../../src/lib/decentraland/state'

// Hot-reload shutdown depends on two SceneContext.dispose() guarantees: the
// scene-owned RPC transports are closed (ends the runtime's update loop) and
// `stopped` resolves EVEN IF a teardown step throws (Babylon entity/subscription
// disposal runs real scene teardown). A dispose that skips either leaves the
// old VM running forever against a disposed scene.
describe('SceneContext dispose', () => {
  let engine: BABYLON.NullEngine
  let babylonScene: BABYLON.Scene
  let ctx: SceneContext
  let transport: Transport
  let transportClose: jest.Mock

  function makeTransport(): { transport: Transport; close: jest.Mock } {
    const close = jest.fn()
    return {
      close,
      transport: { close, on: jest.fn(), emit: jest.fn(), sendMessage: jest.fn() } as unknown as Transport
    }
  }

  beforeEach(() => {
    engine = new BABYLON.NullEngine()
    babylonScene = new BABYLON.Scene(engine)
    babylonScene.activeCamera = new BABYLON.FreeCamera('camera', BABYLON.Vector3.Zero(), babylonScene)
    ctx = new SceneContext(
      babylonScene,
      { baseUrl: '/', urn: 'test-scene', entity: { content: [], metadata: { main: 'game.js' } as Scene, type: 'scene' } },
      false,
      'test-scene'
    )
    ;({ transport, close: transportClose } = makeTransport())
  })

  afterEach(() => {
    babylonScene.dispose()
    engine.dispose()
  })

  describe('when the scene context is disposed', () => {
    beforeEach(() => {
      ctx.registerRpcTransport(transport)
      ctx.dispose()
    })

    it('should close the registered RPC transport', () => {
      expect(transportClose).toHaveBeenCalledTimes(1)
    })

    it('should resolve the stopped future', () => {
      expect(ctx.stopped.isPending).toBe(false)
    })
  })

  describe('when a subscription dispose throws during teardown', () => {
    let disposeError: unknown

    beforeEach(() => {
      ctx.registerRpcTransport(transport)
      ctx.subscriptions.push({
        dispose() {
          throw new Error('subscription boom')
        }
      } as any)
      disposeError = undefined
      try {
        ctx.dispose()
      } catch (err) {
        disposeError = err
      }
    })

    it('should surface the teardown error to the caller', () => {
      expect(disposeError).toBeInstanceOf(Error)
      expect((disposeError as Error).message).toBe('subscription boom')
    })

    it('should still close the RPC transport', () => {
      expect(transportClose).toHaveBeenCalledTimes(1)
    })

    it('should still resolve the stopped future', () => {
      expect(ctx.stopped.isPending).toBe(false)
    })
  })

  describe('when a transport close itself throws', () => {
    let consoleErrorSpy: jest.SpyInstance
    let secondTransport: Transport
    let secondClose: jest.Mock

    beforeEach(() => {
      consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
      ctx.registerRpcTransport({
        close: jest.fn(() => {
          throw new Error('close boom')
        }),
        on: jest.fn(),
        emit: jest.fn(),
        sendMessage: jest.fn()
      } as unknown as Transport)
      ;({ transport: secondTransport, close: secondClose } = makeTransport())
      ctx.registerRpcTransport(secondTransport)
      ctx.dispose()
    })

    afterEach(() => {
      consoleErrorSpy.mockRestore()
    })

    it('should still close the remaining transports and log the failure', () => {
      expect(secondClose).toHaveBeenCalledTimes(1)
      expect(consoleErrorSpy).toHaveBeenCalled()
    })
  })

  describe('when a transport is registered after the scene was disposed', () => {
    beforeEach(() => {
      ctx.dispose()
      ctx.registerRpcTransport(transport)
    })

    it('should close it on the spot instead of leaking a running runtime', () => {
      expect(transportClose).toHaveBeenCalledTimes(1)
    })
  })
})

describe('unloadScene', () => {
  let consoleErrorSpy: jest.SpyInstance

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    loadedScenesByEntityId.delete('test-unload')
    consoleErrorSpy.mockRestore()
  })

  describe('when the scene disposes cleanly', () => {
    let dispose: jest.Mock

    beforeEach(() => {
      dispose = jest.fn()
      loadedScenesByEntityId.set('test-unload', { dispose } as unknown as SceneContext)
      unloadScene('test-unload')
    })

    it('should dispose the scene and deregister it', () => {
      expect(dispose).toHaveBeenCalledTimes(1)
      expect(loadedScenesByEntityId.has('test-unload')).toBe(false)
    })
  })

  describe('when the scene dispose throws', () => {
    beforeEach(() => {
      loadedScenesByEntityId.set('test-unload', {
        dispose: jest.fn(() => {
          throw new Error('dispose boom')
        })
      } as unknown as SceneContext)
    })

    it('should not throw, log the error, and still deregister the scene so a reload can proceed', () => {
      expect(() => unloadScene('test-unload')).not.toThrow()
      expect(consoleErrorSpy).toHaveBeenCalled()
      expect(loadedScenesByEntityId.has('test-unload')).toBe(false)
    })
  })
})
