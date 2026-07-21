import mitt from 'mitt'
import { CommsTransportEvents, MinimumCommunicationsTransport } from '../types'

/**
 * A transport connected to nobody. Used as the LOCAL-PREVIEW fallback when the
 * comms-gatekeeper handshake fails (no internet, service outage): the scene
 * server still boots and runs its `isServer()` code single-player instead of
 * dying at startup. Every consumer of a real transport works unchanged — sends
 * are dropped, no peer or disconnection event ever fires.
 *
 * Never used on production paths (worlds / Genesis / supervisor-minted
 * adapters), which keep failing hard so a broken authoritative server is
 * restarted rather than silently isolated.
 */
export function createOfflineTransport(): MinimumCommunicationsTransport {
  return {
    events: mitt<CommsTransportEvents>(),
    async connect() {},
    async disconnect() {},
    send() {},
    setVoicePosition() {},
    getRoomInfo: () => ({ roomName: 'offline', isConnected: false })
  }
}
