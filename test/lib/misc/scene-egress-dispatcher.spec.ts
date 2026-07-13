// NOTE: this project's jest transformer (esbuild) does not hoist `jest.mock`
// above imports, so we register the mock first and then `require` the module
// under test. Type-only imports are erased by esbuild and are safe to keep.

// Mock DNS so the connect-time resolution branch is deterministic and offline.
jest.mock('dns', () => ({ lookup: jest.fn() }))

const { lookup } = require('dns')
const { pinningLookup } = require('../../../src/lib/misc/scene-egress-dispatcher')
const lookupMock = lookup as jest.Mock

describe('pinningLookup (scene-egress connect-time SSRF pin)', () => {
  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when the hostname resolves entirely to public addresses', () => {
    beforeEach(() => {
      lookupMock.mockImplementation((_host: string, _opts: any, cb: any) =>
        cb(null, [{ address: '93.184.216.34', family: 4 }])
      )
    })

    it('should return the vetted addresses so undici connects only to them', (done) => {
      pinningLookup('example.com', { all: true }, (err: any, addresses: any) => {
        expect(err).toBeNull()
        expect(addresses).toEqual([{ address: '93.184.216.34', family: 4 }])
        done()
      })
    })
  })

  describe('when the hostname rebinds to a private address at connect time', () => {
    beforeEach(() => {
      // The upfront guard saw a public IP; the connect-time resolution returns a
      // private one (the DNS-rebinding attack).
      lookupMock.mockImplementation((_host: string, _opts: any, cb: any) =>
        cb(null, [{ address: '169.254.169.254', family: 4 }])
      )
    })

    it('should fail the lookup so the socket never connects to the private host', (done) => {
      pinningLookup('rebind.attacker.test', { all: true }, (err: any, addresses: any) => {
        expect(err).toBeInstanceOf(Error)
        expect(err.message).toMatch(/non-public address 169\.254\.169\.254/)
        expect(addresses).toBeUndefined()
        done()
      })
    })
  })

  describe('when any single resolved address is private', () => {
    beforeEach(() => {
      lookupMock.mockImplementation((_host: string, _opts: any, cb: any) =>
        cb(null, [
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.5', family: 4 }
        ])
      )
    })

    it('should reject the whole resolution rather than connect to a public sibling', (done) => {
      pinningLookup('mixed.attacker.test', { all: true }, (err: any) => {
        expect(err).toBeInstanceOf(Error)
        expect(err.message).toMatch(/non-public/)
        done()
      })
    })
  })

  describe('when DNS resolution itself fails', () => {
    beforeEach(() => {
      lookupMock.mockImplementation((_host: string, _opts: any, cb: any) => cb(new Error('ENOTFOUND')))
    })

    it('should propagate the DNS error', (done) => {
      pinningLookup('nope.test', { all: true }, (err: any) => {
        expect(err).toBeInstanceOf(Error)
        expect(err.message).toMatch(/ENOTFOUND/)
        done()
      })
    })
  })
})
