import { selectCommsProtocol } from '../../../../src/lib/decentraland/communications/protocol-selection'

// Livekit is the default everywhere; pulse is an explicit opt-in via HAMMURABI_COMMS_PROTOCOL.
// The env var must beat an orchestrator-minted comms adapter: sdk-multiplayer-server ALWAYS
// passes PROCESS_COMMS_ADAPTER, so pulse would otherwise be unreachable in orchestrated spawns.

describe('selectCommsProtocol precedence', () => {
  it('defaults to livekit when nothing is configured', () => {
    expect(selectCommsProtocol({ commsAdapter: undefined, envProtocol: undefined })).toEqual({
      protocol: 'livekit',
      ignoredAdapter: false
    })
  })

  it('uses the orchestrator-minted adapter through the livekit fast path by default', () => {
    expect(selectCommsProtocol({ commsAdapter: 'livekit:wss://comms.example', envProtocol: undefined })).toEqual({
      protocol: 'livekit',
      ignoredAdapter: false
    })
  })

  it('opts into pulse via HAMMURABI_COMMS_PROTOCOL=pulse', () => {
    expect(selectCommsProtocol({ commsAdapter: undefined, envProtocol: 'pulse' })).toEqual({
      protocol: 'pulse',
      ignoredAdapter: false
    })
  })

  it('lets the explicit env var beat a handed-in comms adapter (and flags the ignored adapter)', () => {
    expect(selectCommsProtocol({ commsAdapter: 'livekit:wss://comms.example', envProtocol: 'pulse' })).toEqual({
      protocol: 'pulse',
      ignoredAdapter: true
    })
  })

  it('treats an explicit livekit env value as livekit', () => {
    expect(selectCommsProtocol({ commsAdapter: 'livekit:wss://comms.example', envProtocol: 'livekit' })).toEqual({
      protocol: 'livekit',
      ignoredAdapter: false
    })
  })

  it('falls back to livekit on an unrecognized env value', () => {
    expect(selectCommsProtocol({ commsAdapter: undefined, envProtocol: 'carrier-pigeon' })).toEqual({
      protocol: 'livekit',
      ignoredAdapter: false
    })
  })
})
