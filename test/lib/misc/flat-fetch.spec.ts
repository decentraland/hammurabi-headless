import http from 'http'
import { AddressInfo } from 'net'
import { flatFetch } from '../../../src/lib/misc/flat-fetch'

// Regression coverage for the SignedFetch response-size cap: the URL of a
// signedFetch is scene-controlled, so without a cap a scene could point it at
// a fast endpoint streaming an unbounded body and exhaust host memory.
describe('flatFetch response body cap', () => {
  let server: http.Server
  let baseUrl: string
  let requestHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void

  beforeEach(async () => {
    server = http.createServer((req, res) => requestHandler(req, res))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  describe('when the response declares a Content-Length over the cap', () => {
    beforeEach(() => {
      requestHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Length': String(50 * 1024 * 1024) })
        res.write('x')
        // never finishes — the client must reject on the header alone
      }
    })

    it('should reject before reading the body', async () => {
      await expect(flatFetch(`${baseUrl}/huge`)).rejects.toThrow(/exceeds/)
    }, 15_000)
  })

  describe('when a chunked response streams past the cap without a Content-Length', () => {
    beforeEach(() => {
      requestHandler = (_req, res) => {
        res.writeHead(200) // chunked: no Content-Length to check up front
        const chunk = Buffer.alloc(1024 * 1024, 'a')
        // 12 MB total, over the 10 MB cap
        for (let i = 0; i < 12; i++) res.write(chunk)
        res.end()
      }
    })

    it('should reject once the streamed bytes exceed the cap', async () => {
      await expect(flatFetch(`${baseUrl}/stream`)).rejects.toThrow(/exceeds/)
    }, 15_000)
  })

  describe('when the response is under the cap', () => {
    beforeEach(() => {
      requestHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      }
    })

    it('should return the parsed body', async () => {
      const response = await flatFetch(`${baseUrl}/small`, { responseBodyType: 'json' })

      expect(response.json).toEqual({ ok: true })
    })
  })

  describe('when the response body is prefixed with a UTF-8 BOM', () => {
    beforeEach(() => {
      requestHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        // Windows/.NET backends commonly emit EF BB BF before the JSON. The
        // fetch-spec decode used by response.json() strips it; the capped
        // reader must too, or previously-working endpoints throw SyntaxError.
        res.end(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ ok: true }))]))
      }
    })

    it('should strip the BOM and parse the JSON body', async () => {
      const response = await flatFetch(`${baseUrl}/bom`, { responseBodyType: 'json' })

      expect(response.json).toEqual({ ok: true })
    })

    it('should strip the BOM from a text body', async () => {
      const response = await flatFetch(`${baseUrl}/bom`, { responseBodyType: 'text' })

      expect(response.text).toEqual(JSON.stringify({ ok: true }))
    })
  })
})
