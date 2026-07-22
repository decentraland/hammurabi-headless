import { resolveFile, resolveFileAbsolute } from '../../../../src/lib/decentraland/scene/content-server-entity'

// A deployer-controlled content hash is concatenated into the fetch URL as a path
// segment. A hash containing `..`, `?`, `@` etc. would let WHATWG URL
// normalization traverse to an arbitrary path on the realm origin (path-traversal /
// same-origin SSRF). resolveFile must only return alphanumeric CID hashes, or —
// for sdk-commands local preview — `b64-`-prefixed standard-base64 hashes, whose
// alphabet cannot ascend paths (no dots) or escape the origin.
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

  describe('when the content mapping is an sdk-commands local-preview hash', () => {
    it('should resolve "b64-" + standard-base64 hashes, including +, / and = padding', () => {
      // Real shape: 'b64-' + base64(absoluteFilePath + '-' + machineId), standard
      // alphabet — see b64HashingFunction in @dcl/sdk-commands logic/project-files.ts.
      for (const hash of [
        'b64-L1VzZXJzL2Fsb256by9zY2VuZS9iaW4vaW5kZXguanMtbWFjaGluZS1ob3N0', // unix path
        'b64-QzpcVXNlcnNcYWxvbnpvXHNjZW5lXGJpblxpbmRleC5qcy1tYWNoaW5lLWhvc3Q=', // windows path, = padding
        'b64-YWJjK2RlZi9naGk=' // + and / from the base64 alphabet
      ]) {
        expect(resolveFile(entity([{ file: 'bin/index.js', hash }]), 'bin/index.js')).toBe(hash)
      }
    })

    it('should resolve "b64-" + base64url hashes (- and _, no padding) emitted by newer SDKs', () => {
      // see b64UrlHashingFunction in @dcl/sdk-commands logic/project-files.ts
      for (const hash of [
        'b64-fn5-fn5_', // '-' and '_' from the url-safe alphabet
        'b64-QzpcVXNlcnNcYWxvbnpvXHNjZW5lXGJpblxpbmRleC5qcy1tYWNoaW5lLWhvc3Q' // unpadded
      ]) {
        expect(resolveFile(entity([{ file: 'bin/index.js', hash }]), 'bin/index.js')).toBe(hash)
      }
    })
  })

  describe('when a "b64-" prefixed hash carries characters outside the base64 alphabet', () => {
    it('should reject it so URL-injection characters never reach the fetch URL', () => {
      for (const hash of [
        'b64-', // empty payload
        'b64-..', // dots enable ascending traversal
        'b64-a?x=1',
        'b64-a#frag',
        'b64-a@evil.com',
        'b64-%2e%2e', // percent-encoding tricks
        'b64-a\\b', // WHATWG normalizes \ to /
        'b64-a b'
      ]) {
        expect(resolveFile(entity([{ file: 'evil', hash }]), 'evil')).toBeNull()
      }
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

    it('should percent-encode a b64 hash so /, + and = survive the preview server route as one path segment', () => {
      // The sdk-commands preview server serves `/content/contents/:hash`
      // (path-to-regexp): a raw `/` in the hash would add a path segment and
      // miss the route, while the encoded form matches and is decoded back.
      const scene: any = { baseUrl: 'http://127.0.0.1:8000/content/contents/', entity: entity([
        { file: 'bin/index.js', hash: 'b64-abc+def/ghi=' }
      ]) }
      expect(resolveFileAbsolute(scene, 'bin/index.js')).toBe(
        'http://127.0.0.1:8000/content/contents/b64-abc%2Bdef%2Fghi%3D'
      )
    })
  })
})
