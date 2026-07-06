import { PlayerEntityManager, EntityUtils } from '../../../../src/lib/decentraland/communications/player-entity-manager'

describe('PlayerEntityManager remote entity allocation', () => {
  describe('when two peers are connected at the same time', () => {
    it('gives them distinct entity numbers (no collision)', () => {
      const m = new PlayerEntityManager()

      const a = m.allocateEntityForPlayer('0xA')!
      const b = m.allocateEntityForPlayer('0xB')!

      const [numA, verA] = EntityUtils.fromEntityId(a)
      const [numB, verB] = EntityUtils.fromEntityId(b)

      expect(numA).toBe(32)
      expect(verA).toBe(0)
      // Must NOT reuse number 32 (with a bumped version) while peer A is live.
      expect(numB).toBe(33)
      expect(verB).toBe(0)
      expect(a).not.toBe(b)
    })
  })

  describe('when a peer leaves and a new one joins', () => {
    it('reuses the vacated slot number with a bumped version', () => {
      const m = new PlayerEntityManager()

      const a = m.allocateEntityForPlayer('0xA')!
      const [numA] = EntityUtils.fromEntityId(a)
      m.freeEntityForPlayer('0xA')

      const c = m.allocateEntityForPlayer('0xC')!
      const [numC, verC] = EntityUtils.fromEntityId(c)

      expect(numC).toBe(numA) // reused the freed slot number
      expect(verC).toBe(1) // version bumped so stale references don't alias
    })
  })

  describe('when the same address allocates twice', () => {
    it('returns the same entity', () => {
      const m = new PlayerEntityManager()
      const first = m.allocateEntityForPlayer('0xA')
      const second = m.allocateEntityForPlayer('0xA')
      expect(second).toBe(first)
    })
  })

  describe('when all remote slots are occupied', () => {
    it('returns null instead of colliding onto a live entity', () => {
      const m = new PlayerEntityManager()

      // 32..255 inclusive = 224 remote slots.
      for (let i = 0; i < 224; i++) {
        expect(m.allocateEntityForPlayer(`0x${i}`)).not.toBeNull()
      }

      expect(m.allocateEntityForPlayer('0xoverflow')).toBeNull()
    })
  })
})
