import { readCommsListenerConfig } from '../../../../src/lib/decentraland/communications/config'

describe('readCommsListenerConfig', () => {
  it('applies the .zone defaults when nothing is set', () => {
    expect(readCommsListenerConfig({})).toEqual({
      envProtocol: undefined,
      host: 'pulse-server.decentraland.zone',
      port: 7777,
      realm: 'main',
      debug: false
    })
  })

  it('reads host/realm/protocol overrides verbatim', () => {
    const cfg = readCommsListenerConfig({
      HAMMURABI_COMMS_PROTOCOL: 'pulse',
      PULSE_HOST: 'localhost',
      PULSE_REALM: 'my-realm'
    })
    expect(cfg.envProtocol).toBe('pulse')
    expect(cfg.host).toBe('localhost')
    expect(cfg.realm).toBe('my-realm')
  })

  it('accepts an in-range port', () => {
    expect(readCommsListenerConfig({ PULSE_PORT: '9000' }).port).toBe(9000)
  })

  it.each(['0', '65536', '-1', 'abc', '77.5', ''])('falls back to 7777 on invalid PULSE_PORT %p', (value) => {
    expect(readCommsListenerConfig({ PULSE_PORT: value }).port).toBe(7777)
  })

  it('treats any non-empty PULSE_DEBUG as enabled and empty/unset as disabled', () => {
    expect(readCommsListenerConfig({ PULSE_DEBUG: '1' }).debug).toBe(true)
    expect(readCommsListenerConfig({ PULSE_DEBUG: 'true' }).debug).toBe(true)
    expect(readCommsListenerConfig({ PULSE_DEBUG: '' }).debug).toBe(false)
    expect(readCommsListenerConfig({}).debug).toBe(false)
  })
})
