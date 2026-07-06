import { connectAdapter } from '../../../src/lib/decentraland/communications/connect-adapter'
import { ExplorerIdentity } from '../../../src/lib/decentraland/identity/types'

// A stub identity — these tests assert that the authoritative-signing adapters
// were removed, so no real signing must ever occur.
const identity = {
  address: '0xstub',
  isGuest: true,
  authChain: [] as any,
  signer: async () => 'sig'
} as ExplorerIdentity

describe('connectAdapter protocol support', () => {
  describe('when the adapter protocol is ws-room', () => {
    it('should be rejected because the challenge-signing transport was removed', async () => {
      await expect(connectAdapter('ws-room:wss://example/room', identity, 'scene')).rejects.toThrow(/protocol=ws-room/)
    })
  })

  describe('when the adapter protocol is signed-login', () => {
    it('should be rejected because the authoritative signed-login handshake was removed', async () => {
      await expect(connectAdapter('signed-login:https://example/login', identity, 'scene')).rejects.toThrow(
        /protocol=signed-login/
      )
    })
  })

  describe('when the adapter protocol is livekit', () => {
    it('should produce an adapter carrying the connection string with no signing', async () => {
      const adapter = await connectAdapter('livekit:wss://host/path?access_token=JWT', identity, 'scene-1')
      const transports = await adapter.desiredTransports.deref()
      expect(transports[0].url).toBe('livekit:wss://host/path?access_token=JWT')
    })
  })

  describe('when the adapter protocol is offline', () => {
    it('should produce a stub adapter', async () => {
      const adapter = await connectAdapter('offline:offline', identity, 'scene-1')
      const transports = await adapter.desiredTransports.deref()
      expect(transports).toHaveLength(1)
    })
  })
})
