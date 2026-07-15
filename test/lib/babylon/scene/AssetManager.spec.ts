import * as BABYLON from '@babylonjs/core'
import http from 'http'
import { AddressInfo } from 'net'
import { AssetManager } from '../../../../src/lib/babylon/scene/AssetManager'

// readFile is scene-reachable (~system/Runtime.readFile) and returns the body to
// untrusted scene code. It must NOT auto-follow a redirect: a compromised/malicious
// content server could otherwise 3xx-bounce the request from this worker's network
// position onto a private/metadata host and relay the response back to the scene.
describe('AssetManager.readFile', () => {
  let engine: BABYLON.NullEngine
  let scene: BABYLON.Scene

  beforeAll(() => {
    engine = new BABYLON.NullEngine()
    scene = new BABYLON.Scene(engine)
  })

  afterAll(() => {
    scene.dispose()
    engine.dispose()
  })

  const HASH = 'QmValidHash123' // alphanumeric CID: passes the content-hash validator

  function makeManager(baseUrl: string) {
    const loadableScene: any = {
      urn: 'urn:test',
      baseUrl,
      entity: { content: [{ file: 'data.bin', hash: HASH }] }
    }
    return new AssetManager(loadableScene, scene)
  }

  it('refuses to follow a redirect from the content server (SSRF guard)', async () => {
    let redirectTargetHit = false
    const server = http.createServer((req, res) => {
      if (req.url === `/${HASH}`) {
        // Bounce toward an "internal" resource on the same server; if readFile
        // auto-followed, the second request would set the flag below.
        res.writeHead(302, { location: '/secret-internal' })
        res.end()
      } else {
        redirectTargetHit = true
        res.writeHead(200)
        res.end('secret')
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const { port } = server.address() as AddressInfo

    const mgr = makeManager(`http://127.0.0.1:${port}/`)
    await expect(mgr.readFile('data.bin')).rejects.toThrow(/redirect/i)
    expect(redirectTargetHit).toBe(false)

    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('reads the body when the content server responds 200', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.from([1, 2, 3, 4]))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const { port } = server.address() as AddressInfo

    const mgr = makeManager(`http://127.0.0.1:${port}/`)
    const { content, hash } = await mgr.readFile('data.bin')
    expect(Array.from(content)).toEqual([1, 2, 3, 4])
    expect(hash).toBe(HASH)

    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})
