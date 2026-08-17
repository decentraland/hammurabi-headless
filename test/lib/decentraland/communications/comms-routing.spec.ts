import { resolveRouting, isPulseEnabled, ALL_LISTENERS } from '../../../../src/lib/decentraland/communications/comms-routing'

describe('isPulseEnabled', () => {
  it('is true only for the exact "pulse" opt-in', () => {
    expect(isPulseEnabled('pulse')).toBe(true)
    expect(isPulseEnabled('livekit')).toBe(false)
    expect(isPulseEnabled('carrier-pigeon')).toBe(false)
    expect(isPulseEnabled(undefined)).toBe(false)
  })
})

describe('resolveRouting', () => {
  it('routes everything to LiveKit and connects only LiveKit when Pulse is off', () => {
    const plan = resolveRouting(false)
    for (const listener of ALL_LISTENERS) {
      expect(plan.owners[listener]).toBe('livekit')
    }
    expect([...plan.connectionSet]).toEqual(['livekit'])
  })

  it('routes position to Pulse and the rest to LiveKit, connecting both, when Pulse is on', () => {
    const plan = resolveRouting(true)
    expect(plan.owners.position).toBe('pulse')
    expect(plan.owners.presence).toBe('livekit')
    expect(plan.owners.profile).toBe('livekit')
    expect(plan.owners.chat).toBe('livekit')
    expect(plan.owners.sceneBus).toBe('livekit')
    expect(plan.owners.voice).toBe('livekit')
    expect(plan.connectionSet).toEqual(new Set(['livekit', 'pulse']))
  })
})
