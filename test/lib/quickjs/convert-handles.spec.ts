import { coerceMaybeU8Array } from '../../../src/lib/quick-js/convert-handles'

describe('coerceMaybeU8Array', () => {
  describe('when given a Uint8Array', () => {
    it('returns it unchanged', () => {
      const u = new Uint8Array([1, 2, 3])
      expect(coerceMaybeU8Array(u)).toBe(u)
    })
  })

  describe('when given a plain object of byte values (the documented fallback)', () => {
    it('coerces it into a Uint8Array', () => {
      expect(coerceMaybeU8Array({ 0: 1, 1: 2, 2: 3 } as any)).toEqual(new Uint8Array([1, 2, 3]))
    })
  })

  describe('when given null or a non-object', () => {
    it('returns an empty Uint8Array instead of throwing', () => {
      expect(coerceMaybeU8Array(null as any)).toEqual(new Uint8Array(0))
      expect(coerceMaybeU8Array(undefined as any)).toEqual(new Uint8Array(0))
    })
  })

  describe('when given a non-dense object', () => {
    it('returns empty for a sparse object (a real Uint8Array always serializes dense)', () => {
      // Rejecting (rather than zero-filling) prevents a tiny sparse object from
      // forcing a large allocation, e.g. { 0: 0, 16777215: 0 }.
      expect(coerceMaybeU8Array({ 0: 1, 2: 3 } as any)).toEqual(new Uint8Array(0))
    })

    it('returns empty when a non-index key is present', () => {
      expect(coerceMaybeU8Array({ 0: 1, 1: 2, foo: 3 } as any)).toEqual(new Uint8Array(0))
    })
  })

  describe('when given a dense object with keys in any order', () => {
    it('reconstructs the bytes by numeric index', () => {
      expect(coerceMaybeU8Array({ 2: 3, 0: 1, 1: 2 } as any)).toEqual(new Uint8Array([1, 2, 3]))
    })
  })
})
