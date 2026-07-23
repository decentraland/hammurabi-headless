import {
  PermanentStartupError,
  isPermanentStartupError,
  PERMANENT_STARTUP_ERROR_CODE
} from '../../../src/lib/misc/startup-errors'

describe('PermanentStartupError', () => {
  describe('when constructed with a message', () => {
    let error: PermanentStartupError

    beforeEach(() => {
      error = new PermanentStartupError('Scene "bafkrei" not found in world "x.dcl.eth"')
    })

    it('should carry the stable machine-readable code', () => {
      expect(error.code).toBe(PERMANENT_STARTUP_ERROR_CODE)
    })

    it('should preserve the human-readable message', () => {
      expect(error.message).toBe('Scene "bafkrei" not found in world "x.dcl.eth"')
    })

    it('should set the name explicitly (a string literal that survives minification)', () => {
      expect(error.name).toBe('PermanentStartupError')
    })
  })
})

describe('isPermanentStartupError', () => {
  let error: unknown

  describe('when given a PermanentStartupError instance', () => {
    beforeEach(() => {
      error = new PermanentStartupError('No scenes found in world x.dcl.eth')
    })

    it('should classify it as permanent', () => {
      expect(isPermanentStartupError(error)).toBe(true)
    })
  })

  describe('when given an error-shaped value carrying the code from another bundle copy', () => {
    beforeEach(() => {
      // Simulates a consumer holding a different copy of this module than the
      // (minified) worker bundle that threw: same code string, foreign class.
      error = Object.assign(new Error('No scenes found in world x.dcl.eth'), {
        code: PERMANENT_STARTUP_ERROR_CODE
      })
    })

    it('should classify it as permanent', () => {
      expect(isPermanentStartupError(error)).toBe(true)
    })
  })

  describe('when given a plain Error with a permanent-looking message but no code', () => {
    beforeEach(() => {
      error = new Error('Scene "bafkrei" not found in world "x.dcl.eth"')
    })

    it('should classify it as transient', () => {
      expect(isPermanentStartupError(error)).toBe(false)
    })
  })

  describe('when given an error with a different code', () => {
    beforeEach(() => {
      error = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    })

    it('should classify it as transient', () => {
      expect(isPermanentStartupError(error)).toBe(false)
    })
  })

  describe('when given a non-error value', () => {
    beforeEach(() => {
      error = 'ERR_PERMANENT_STARTUP'
    })

    it('should classify it as transient', () => {
      expect(isPermanentStartupError(error)).toBe(false)
    })
  })

  describe('when given null', () => {
    beforeEach(() => {
      error = null
    })

    it('should classify it as transient', () => {
      expect(isPermanentStartupError(error)).toBe(false)
    })
  })
})
