// NOTE: this project's jest transformer (esbuild) does not hoist `jest.mock`
// above imports, so we register the mock first and then `require` the modules
// under test. Type-only imports are erased by esbuild and are safe to keep.

// Mock DNS so the hostname-resolution branch is deterministic and offline.
jest.mock('dns/promises', () => ({ lookup: jest.fn() }))

const { lookup } = require('dns/promises')
const { assertPublicSceneUrl } = require('../../../src/lib/misc/ssrf')
const lookupMock = lookup as jest.Mock

describe('assertPublicSceneUrl', () => {
  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when the URL uses a non-http(s) protocol', () => {
    it('should reject a file:// URL', async () => {
      await expect(assertPublicSceneUrl('file:///etc/passwd')).rejects.toThrow(/protocol/i)
    })

    it('should reject an ftp:// URL', async () => {
      await expect(assertPublicSceneUrl('ftp://example.com/x')).rejects.toThrow(/protocol/i)
    })
  })

  describe('when the URL is malformed', () => {
    it('should reject it', async () => {
      await expect(assertPublicSceneUrl('not a url')).rejects.toThrow(/invalid url/i)
    })
  })

  describe('when the host is the cloud metadata address', () => {
    it('should reject it', async () => {
      await expect(assertPublicSceneUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/non-public/i)
    })
  })

  describe('when the host is a loopback address or name', () => {
    it('should reject 127.0.0.1', async () => {
      await expect(assertPublicSceneUrl('http://127.0.0.1:8080/admin')).rejects.toThrow(/non-public/i)
    })

    it('should reject localhost', async () => {
      await expect(assertPublicSceneUrl('http://localhost/admin')).rejects.toThrow(/non-public/i)
    })

    it('should reject the IPv6 loopback', async () => {
      await expect(assertPublicSceneUrl('http://[::1]/admin')).rejects.toThrow(/non-public/i)
    })
  })

  describe('when the host is a private-range IP literal', () => {
    it('should reject 10.0.0.0/8', async () => {
      await expect(assertPublicSceneUrl('http://10.0.0.5/')).rejects.toThrow(/non-public/i)
    })

    it('should reject 192.168.0.0/16', async () => {
      await expect(assertPublicSceneUrl('http://192.168.1.1/')).rejects.toThrow(/non-public/i)
    })

    it('should reject 172.16.0.0/12', async () => {
      await expect(assertPublicSceneUrl('http://172.16.0.1/')).rejects.toThrow(/non-public/i)
    })
  })

  describe('when the host is an IPv4-mapped IPv6 literal (URL-normalized to hex)', () => {
    // new URL() normalizes ::ffff:169.254.169.254 to ::ffff:a9fe:a9fe, which a
    // naive dotted-only check misses — this is the SSRF bypass these guard.
    it('should reject the cloud metadata address in mapped form', async () => {
      await expect(assertPublicSceneUrl('http://[::ffff:169.254.169.254]/latest/meta-data/')).rejects.toThrow(
        /non-public/i
      )
    })

    it('should reject mapped loopback', async () => {
      await expect(assertPublicSceneUrl('http://[::ffff:127.0.0.1]/admin')).rejects.toThrow(/non-public/i)
    })

    it('should reject mapped private ranges', async () => {
      await expect(assertPublicSceneUrl('http://[::ffff:10.0.0.1]/')).rejects.toThrow(/non-public/i)
      await expect(assertPublicSceneUrl('http://[::ffff:192.168.1.1]/')).rejects.toThrow(/non-public/i)
    })

    it('should not perform a DNS lookup for an IP literal', async () => {
      await expect(assertPublicSceneUrl('http://[::ffff:169.254.169.254]/')).rejects.toThrow(/non-public/i)
      expect(lookupMock).not.toHaveBeenCalled()
    })
  })

  describe('when the host is an IPv6 form that embeds an IPv4 address', () => {
    // NAT64 (64:ff9b::/96), 6to4 (2002::/16), and the deprecated IPv4-compatible
    // (::/96) prefixes each carry an IPv4 inside the literal; new URL() normalizes
    // them to hex, so they bypassed the earlier ::ffff:-only check.
    it('should reject NAT64 wrapping loopback / metadata', async () => {
      await expect(assertPublicSceneUrl('http://[64:ff9b::7f00:1]/')).rejects.toThrow(/non-public/i)
      await expect(assertPublicSceneUrl('http://[64:ff9b::a9fe:a9fe]/latest/meta-data/')).rejects.toThrow(/non-public/i)
    })

    it('should reject 6to4 wrapping loopback', async () => {
      await expect(assertPublicSceneUrl('http://[2002:7f00:1::]/')).rejects.toThrow(/non-public/i)
    })

    it('should reject the IPv4-compatible form wrapping loopback', async () => {
      await expect(assertPublicSceneUrl('http://[::7f00:1]/')).rejects.toThrow(/non-public/i)
    })

    it('should still allow these prefixes when they embed a PUBLIC IPv4', async () => {
      // 8.8.8.8 embedded via 6to4 and NAT64 is a real public destination.
      await expect(assertPublicSceneUrl('http://[2002:0808:0808::]/')).resolves.toBeUndefined()
      await expect(assertPublicSceneUrl('http://[64:ff9b::0808:0808]/')).resolves.toBeUndefined()
      expect(lookupMock).not.toHaveBeenCalled()
    })
  })

  describe('when the host is a public IP literal', () => {
    it('should allow it without a DNS lookup', async () => {
      await expect(assertPublicSceneUrl('https://8.8.8.8/path')).resolves.toBeUndefined()
      expect(lookupMock).not.toHaveBeenCalled()
    })

    it('should allow a genuine public IPv6 address', async () => {
      await expect(assertPublicSceneUrl('https://[2606:4700:4700::1111]/')).resolves.toBeUndefined()
      expect(lookupMock).not.toHaveBeenCalled()
    })
  })

  describe('when the host is a public hostname', () => {
    describe('and it resolves to a public address', () => {
      beforeEach(() => {
        lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
      })

      it('should allow it', async () => {
        await expect(assertPublicSceneUrl('https://peer.decentraland.org/content')).resolves.toBeUndefined()
      })
    })

    describe('and it resolves to a private address (DNS pointing inward)', () => {
      beforeEach(() => {
        lookupMock.mockResolvedValue([{ address: '10.1.2.3', family: 4 }])
      })

      it('should reject it', async () => {
        await expect(assertPublicSceneUrl('https://sneaky.example.com/x')).rejects.toThrow(/non-public/i)
      })

      it('should not disclose the resolved private address to the caller', async () => {
        const error = await assertPublicSceneUrl('https://sneaky.example.com/x').catch((err) => err as Error)

        expect(error.message).toMatch(/non-public/i)
        expect(error.message).not.toContain('10.1.2.3')
      })
    })
  })
})
