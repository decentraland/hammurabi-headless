import { Scene } from '@dcl/schemas'
import { pickWorldSpawnpoint } from '../../../src/lib/decentraland/scene/spawn-points'

// Regression: untrusted scene metadata (base parcel, spawn-point position) must
// never produce a non-finite spawn position (which would become a NaN teleport).
describe('pickWorldSpawnpoint', () => {
  describe('when a spawn-point position component is a non-finite array', () => {
    let scene: Scene

    beforeEach(() => {
      scene = {
        scene: { base: '0,0', parcels: ['0,0'] },
        spawnPoints: [{ name: 'sp', default: true, position: { x: [NaN], y: [Infinity, 0], z: 0 } } ]
      } as unknown as Scene
    })

    it('should produce a finite spawn position', () => {
      const result = pickWorldSpawnpoint(scene)

      expect(Number.isFinite(result.position.x)).toBe(true)
      expect(Number.isFinite(result.position.y)).toBe(true)
      expect(Number.isFinite(result.position.z)).toBe(true)
    })
  })

  describe('when the base parcel is malformed', () => {
    let scene: Scene

    beforeEach(() => {
      scene = { scene: { base: 'garbage' }, spawnPoints: [] } as unknown as Scene
    })

    it('should fall back to a finite position', () => {
      const result = pickWorldSpawnpoint(scene)

      expect(Number.isFinite(result.position.x)).toBe(true)
      expect(Number.isFinite(result.position.y)).toBe(true)
      expect(Number.isFinite(result.position.z)).toBe(true)
    })
  })

  describe('when a spawn point omits its position entirely', () => {
    let scene: Scene

    beforeEach(() => {
      scene = {
        scene: { base: '0,0' },
        spawnPoints: [{ name: 'sp', default: true } as any]
      } as unknown as Scene
    })

    it('should not throw and should return a finite position', () => {
      const result = pickWorldSpawnpoint(scene)

      expect(Number.isFinite(result.position.x)).toBe(true)
      expect(Number.isFinite(result.position.y)).toBe(true)
      expect(Number.isFinite(result.position.z)).toBe(true)
    })
  })
})
