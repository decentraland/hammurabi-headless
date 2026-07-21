import { getUnsupportedNodeMessage, SUPPORTED_NODE_MAJORS } from '../../../src/lib/misc/node-version-check'

describe('SUPPORTED_NODE_MAJORS', () => {
  it('should be 22 and 24 (the Node majors with shipped isolated-vm prebuilds, ABIs 127/137)', () => {
    expect(SUPPORTED_NODE_MAJORS).toEqual([22, 24])
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

  describe('when running on a Node 22 release', () => {
    beforeEach(() => {
      nodeVersion = '22.17.1'
    })

    it('should accept it (no message)', () => {
      expect(getUnsupportedNodeMessage(nodeVersion)).toBeNull()
    })
  })

  describe('when running on Node 23 (between the supported majors, no prebuild)', () => {
    beforeEach(() => {
      nodeVersion = '23.6.0'
    })

    it('should reject it with the message naming both supported majors', () => {
      expect(getUnsupportedNodeMessage(nodeVersion)).toContain('requires Node 22 or 24')
    })
  })

  describe('when running on a newer Node major without prebuilds', () => {
    beforeEach(() => {
      nodeVersion = '26.5.0'
    })

    it('should return an actionable message naming both versions', () => {
      const message = getUnsupportedNodeMessage(nodeVersion)
      expect(message).toContain('requires Node 22 or 24')
      expect(message).toContain('v26.5.0')
    })
  })

  describe('when running on an older Node major', () => {
    beforeEach(() => {
      nodeVersion = '20.14.0'
    })

    it('should reject it with the message', () => {
      expect(getUnsupportedNodeMessage(nodeVersion)).toContain('requires Node 22 or 24')
    })
  })

  describe('when the version string is unparsable', () => {
    beforeEach(() => {
      nodeVersion = 'not-a-version'
    })

    it('should fail closed and return the message', () => {
      expect(getUnsupportedNodeMessage(nodeVersion)).toContain('requires Node 22 or 24')
    })
  })
})
