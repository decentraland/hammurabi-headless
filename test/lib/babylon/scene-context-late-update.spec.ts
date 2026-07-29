import { Quaternion, Vector3 } from '@babylonjs/core'
import { Scene } from '@dcl/schemas'
import { ReadWriteByteBuffer } from '../../../src/lib/decentraland/ByteBuffer'
import { ByteBuffer } from '../../../src/lib/decentraland/ByteBuffer/types'
import { DeleteEntity, PutComponentOperation } from '../../../src/lib/decentraland/crdt-wire-protocol'
import { transformComponent } from '../../../src/lib/decentraland/sdk-components/transform-component'
import { StaticEntities } from '../../../src/lib/babylon/scene/logic/static-entities'
import { Entity } from '../../../src/lib/decentraland/types'
import { testWithEngine } from './babylon-test-helper'

// Regression: lateUpdate had no exception safety. A component serializer CAN throw
// on untrusted data (PBAvatarEquippedData.encode iterates a peer-announced
// `wearables`), the throw is swallowed by the per-scene try/catch in the tick
// system, and the buffer resets + the frame-future resolution sat in the success
// path — so the scene's crdtSendToRenderer never returned (hanging its turn until
// the async-turn watchdog disposed the isolate) and both shared buffers kept their
// residue, re-delivering and re-ingesting stale messages every frame.
testWithEngine(
  'lateUpdate is exception safe',
  {
    baseUrl: '/',
    entity: { content: [], metadata: {} as Scene, type: 'scene' },
    urn: '123',
    enableStaticEntities: false
  },
  ($) => {
    beforeEach(() => $.startEngine())

    describe('when a component fails to dump its CRDT updates', () => {
      let pendingMessage: Uint8Array
      let dumpCrdtUpdates: jest.SpyInstance
      let consoleError: jest.SpyInstance

      beforeEach(() => {
        const componentData = new ReadWriteByteBuffer()
        transformComponent.serialize(
          { parent: 0, position: Vector3.Zero(), scale: Vector3.One(), rotation: Quaternion.Identity() },
          componentData
        )
        PutComponentOperation.write(
          {
            entityId: StaticEntities.CameraEntity,
            componentId: transformComponent.componentId,
            timestamp: 1,
            data: componentData.toBinary()
          },
          $.ctx.outgoingMessagesBuffer
        )
        pendingMessage = $.ctx.outgoingMessagesBuffer.toCopiedBinary()

        dumpCrdtUpdates = jest
          .spyOn($.ctx.components[transformComponent.componentId], 'dumpCrdtUpdates')
          .mockImplementation(() => {
            throw new TypeError('message.wearableUrns is not iterable')
          })
        consoleError = jest.spyOn(console, 'error').mockImplementation(() => void 0)
      })

      afterEach(() => {
        dumpCrdtUpdates.mockRestore()
        consoleError.mockRestore()
      })

      it('should resolve the pending frame future instead of leaving the scene turn hanging', async () => {
        await expect($.ctx.crdtSendToRenderer({ data: Uint8Array.of() })).resolves.toEqual({ data: [pendingMessage] })
      })

      it('should reset the outgoing messages buffer', async () => {
        await $.ctx.crdtSendToRenderer({ data: Uint8Array.of() })

        expect($.ctx.outgoingMessagesBuffer.currentWriteOffset()).toEqual(0)
      })

      it('should not re-deliver the residue of the failed frame on the next frame', async () => {
        await $.ctx.crdtSendToRenderer({ data: Uint8Array.of() })

        await expect($.ctx.crdtSendToRenderer({ data: Uint8Array.of() })).resolves.toEqual({ data: [] })
      })
    })

    describe('when a subscription throws after writing part of its updates', () => {
      const subscribedEntity = 40 as Entity
      let expectedBatch: Uint8Array
      let getUpdates: jest.Mock
      let consoleError: jest.SpyInstance

      beforeEach(() => {
        const expected = new ReadWriteByteBuffer()
        DeleteEntity.write({ entityId: subscribedEntity }, expected)
        expectedBatch = expected.toCopiedBinary()

        getUpdates = jest.fn((writer: ByteBuffer) => {
          DeleteEntity.write({ entityId: subscribedEntity }, writer)
          throw new TypeError('message.wearableUrns is not iterable')
        })
        $.ctx.subscriptions.push({ range: [32, 256], getUpdates, dispose: jest.fn() })
        consoleError = jest.spyOn(console, 'error').mockImplementation(() => void 0)
      })

      afterEach(() => {
        $.ctx.subscriptions.length = 0
        consoleError.mockRestore()
      })

      it('should reset the subscriptions buffer so the partial batch is not replayed', async () => {
        await $.ctx.crdtSendToRenderer({ data: Uint8Array.of() })

        expect($.ctx.subscriptionsBuffer.currentWriteOffset()).toEqual(0)
      })

      it('should still deliver the messages written before the throw', async () => {
        await expect($.ctx.crdtSendToRenderer({ data: Uint8Array.of() })).resolves.toEqual({ data: [expectedBatch] })
      })
    })
  }
)

// Regression: lateUpdate resolves EVERY pending future with the SAME array
// instance, and crdtGetState used to `unshift` main.crdt into it — so a concurrent
// crdtSendToRenderer received main.crdt prepended to its own response.
testWithEngine(
  'crdtGetState does not mutate the array shared by concurrent responses',
  {
    baseUrl: '/',
    entity: { content: [], metadata: {} as Scene, type: 'scene' },
    urn: '123',
    enableStaticEntities: false
  },
  ($) => {
    beforeEach(() => $.startEngine())

    describe('when crdtGetState and crdtSendToRenderer await the same frame', () => {
      let mainCrdt: Uint8Array

      beforeEach(() => {
        const buf = new ReadWriteByteBuffer()
        DeleteEntity.write({ entityId: 600 as Entity }, buf)
        mainCrdt = buf.toCopiedBinary()
        $.ctx.mainCrdt = mainCrdt
      })

      afterEach(() => {
        $.ctx.mainCrdt = Uint8Array.of()
      })

      it('should not prepend main.crdt to the crdtSendToRenderer response', async () => {
        const [, sendResult] = await Promise.all([
          $.ctx.crdtGetState(),
          $.ctx.crdtSendToRenderer({ data: Uint8Array.of() })
        ])

        expect(sendResult.data).toEqual([])
      })

      it('should prepend main.crdt to its own response', async () => {
        const [stateResult] = await Promise.all([
          $.ctx.crdtGetState(),
          $.ctx.crdtSendToRenderer({ data: Uint8Array.of() })
        ])

        expect(stateResult.data).toEqual([mainCrdt])
      })
    })
  }
)
