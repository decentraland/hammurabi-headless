import { getUnsupportedNodeMessage, REQUIRED_NODE_MAJOR } from '../../../src/lib/misc/node-version-check'

describe('REQUIRED_NODE_MAJOR', () => {
  it('should be 24 (the Node major with shipped isolated-vm prebuilds)', () => {
    expect(REQUIRED_NODE_MAJOR).toBe(24)
  })
})

describe('getUnsupportedNodeMessage', () => {
  let nodeVersion: string

  describe('when running on a Node 24 release', () => {
    beforeEach(() => {
      nodeVersion = '24.16.0'
    })

    it('should accept it (no message)', () => {
      expect(getUnsupportedNodeMessage(nodeVersion)).toBeNull()
    })
  })

  describe('when running on a newer Node major without prebuilds', () => {
    beforeEach(() => {
      nodeVersion = '26.5.0'
    })

    it('should return an actionable message naming both versions', () => {
      const message = getUnsupportedNodeMessage(nodeVersion)
      expect(message).toContain('requires Node 24')
      expect(message).toContain('v26.5.0')
    })
  })

  describe('when running on an older Node major', () => {
    beforeEach(() => {
      nodeVersion = '22.17.1'
    })

    it('should reject it with the message', () => {
      expect(getUnsupportedNodeMessage(nodeVersion)).toContain('requires Node 24')
    })
  })

  describe('when the version string is unparsable', () => {
    beforeEach(() => {
      nodeVersion = 'not-a-version'
    })

    it('should fail closed and return the message', () => {
      expect(getUnsupportedNodeMessage(nodeVersion)).toContain('requires Node 24')
    })
  })
})
