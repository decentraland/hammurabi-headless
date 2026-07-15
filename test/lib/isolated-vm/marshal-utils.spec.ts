import { coerceMaybeU8Array } from '../../../src/lib/common-runtime/marshal-utils'

describe('coerceMaybeU8Array', () => {
  describe('when given a Uint8Array', () => {
    it('should return it unchanged', () => {
      const u = new Uint8Array([1, 2, 3])
      expect(coerceMaybeU8Array(u)).toBe(u)
    })
  })

  describe('when given a plain object of byte values (the documented fallback)', () => {
    it('should coerce it into a Uint8Array', () => {
      expect(coerceMaybeU8Array({ 0: 1, 1: 2, 2: 3 } as any)).toEqual(new Uint8Array([1, 2, 3]))
    })
  })

  describe('when given null or a non-object', () => {
    it('should return an empty Uint8Array instead of throwing', () => {
      expect(coerceMaybeU8Array(null as any)).toEqual(new Uint8Array(0))
      expect(coerceMaybeU8Array(undefined as any)).toEqual(new Uint8Array(0))
    })
  })
})
