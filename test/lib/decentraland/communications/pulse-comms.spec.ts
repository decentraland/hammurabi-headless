import { sceneParcelsToPulseCoords, createPulseComms } from '../../../../src/lib/decentraland/communications/pulse-comms'
import { readCommsListenerConfig } from '../../../../src/lib/decentraland/communications/config'
import type { ExplorerIdentity } from '../../../../src/lib/decentraland/identity/types'

describe('sceneParcelsToPulseCoords', () => {
  it('maps "x,z" scene.json pointers to {x, z}, preserving negatives', () => {
    expect(sceneParcelsToPulseCoords(['23,-24', '0,0', '-5,10'])).toEqual([
      { x: 23, z: -24 },
      { x: 0, z: 0 },
      { x: -5, z: 10 }
    ])
  })

  it('returns an empty list for an empty footprint', () => {
    expect(sceneParcelsToPulseCoords([])).toEqual([])
  })
})

describe('createPulseComms', () => {
  it('builds an unconnected wrapper reporting the configured realm', () => {
    const config = readCommsListenerConfig({ HAMMURABI_PULSE_REALM: 'my-realm' })
    const identity = { authChain: [] } as unknown as ExplorerIdentity

    const wrapper = createPulseComms(config, identity, ['0,0'], 'scene-id')

    expect(wrapper.getRoomInfo()).toEqual({ roomName: 'my-realm', isConnected: false })
  })
})
