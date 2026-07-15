import { resolveFile, resolveFileAbsolute } from '../../../../src/lib/decentraland/scene/content-server-entity'

// A deployer-controlled content hash is concatenated into the fetch URL as a path
// segment. A hash containing `/`, `..`, `?`, `@` etc. would let WHATWG URL
// normalization traverse to an arbitrary path on the realm origin (path-traversal /
// same-origin SSRF). resolveFile must only return alphanumeric CID hashes.
describe('resolveFile content-hash validation', () => {
  const entity = (content: Array<{ file: string; hash: string }>) => ({ content })

  describe('when the content mapping is a valid CID', () => {
    it('should resolve CIDv0 and CIDv1 hashes', () => {
      const cidv0 = 'QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR'
      const cidv1 = 'bafkreiarbcbm6zj6wo2c4irwcbflgla5o7daer2v3i2j5ee3rwzocsyuke'
      expect(resolveFile(entity([{ file: 'a.glb', hash: cidv0 }]), 'a.glb')).toBe(cidv0)
      expect(resolveFile(entity([{ file: 'b.png', hash: cidv1 }]), 'b.png')).toBe(cidv1)
    })
  })

  describe('when the content hash contains traversal or URL-injection characters', () => {
    it('should reject it (treated as file-not-found) so it never reaches the fetch URL', () => {
      for (const hash of [
        '../../../../etc/passwd',
        '..\\..\\admin',
        'abc/def',
        'a?x=1',
        '@evil.com/x',
        'a#frag',
        'http://169.254.169.254/'
      ]) {
        expect(resolveFile(entity([{ file: 'evil', hash }]), 'evil')).toBeNull()
      }
    })
  })

  describe('resolveFileAbsolute', () => {
    it('should build baseUrl + hash for a valid hash and return null for a malicious one', () => {
      const scene: any = { baseUrl: 'https://peer.decentraland.org/content/contents/', entity: entity([
        { file: 'ok.glb', hash: 'QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR' },
        { file: 'evil', hash: '../../../etc/passwd' }
      ]) }
      expect(resolveFileAbsolute(scene, 'ok.glb')).toBe('https://peer.decentraland.org/content/contents/QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR')
      expect(resolveFileAbsolute(scene, 'evil')).toBeNull()
    })
  })
})
