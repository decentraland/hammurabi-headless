import { createOfflineTransport } from '../../../../src/lib/decentraland/communications/transports/offline'
import { CommsTransportWrapper } from '../../../../src/lib/decentraland/communications/CommsTransportWrapper'
import { RoomConnectionStatus } from '../../../../src/lib/decentraland/communications/CommsTransportWrapper'

describe('createOfflineTransport', () => {
  describe('when wrapped in the comms transport wrapper (the local-preview offline fallback)', () => {
    let wrapper: CommsTransportWrapper

    beforeEach(() => {
      wrapper = new CommsTransportWrapper(createOfflineTransport(), 'b64-scene-urn')
    })

    it('should connect without error and reach the CONNECTED state', async () => {
      await wrapper.connect()

      expect(wrapper.state).toBe(RoomConnectionStatus.CONNECTED)
    })

    it('should drop outbound scene messages without throwing', async () => {
      await wrapper.connect()

      await expect(
        wrapper.sendParcelSceneMessage({ sceneId: 'b64-scene-urn', data: new Uint8Array([1]) } as never, [])
      ).resolves.toBeUndefined()
    })

    it('should report a disconnected offline room to realm info consumers', () => {
      expect(wrapper.getRoomInfo()).toEqual({ roomName: 'offline', isConnected: false })
    })

    it('should disconnect cleanly', async () => {
      await wrapper.connect()

      await expect(wrapper.disconnect()).resolves.not.toThrow()
    })
  })
})
