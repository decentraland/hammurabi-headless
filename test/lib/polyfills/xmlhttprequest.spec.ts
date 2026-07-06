import * as http from 'http'
import { setupXMLHttpRequestPolyfill } from '../../../src/lib/polyfills/xmlhttprequest'

// The XHR polyfill feeds Babylon's NATIVE glTF parser (outside the sandbox), so a
// non-2xx / un-followed-redirect body must be surfaced as an error rather than
// handed to the parser as if it were a valid asset. Tested against a real
// localhost server — fully self-contained, no external service.

describe('XMLHttpRequest polyfill status handling', () => {
  let server: http.Server
  let baseUrl: string

  beforeAll((done) => {
    setupXMLHttpRequestPolyfill()
    server = http.createServer((req, res) => {
      switch (req.url) {
        case '/ok':
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('hello')
          break
        case '/notfound':
          res.writeHead(404, { 'content-type': 'text/plain' })
          res.end('<html>not found</html>')
          break
        case '/redirect':
          res.writeHead(302, { location: `${baseUrl}/ok` })
          res.end()
          break
        default:
          res.writeHead(500)
          res.end('err')
      }
    })
    server.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as any).port}`
      done()
    })
  })

  afterAll((done) => {
    // keep-alive agents inside the polyfill hold sockets open; force them closed.
    server.closeAllConnections?.()
    server.close(() => done())
  })

  function get(path: string): Promise<{ ok: boolean; status: number; text: string }> {
    return new Promise((resolve) => {
      const xhr = new (globalThis as any).XMLHttpRequest()
      xhr.open('GET', `${baseUrl}${path}`)
      xhr.onload = () => resolve({ ok: true, status: xhr.status, text: xhr.responseText })
      xhr.onerror = () => resolve({ ok: false, status: xhr.status, text: xhr.responseText })
      xhr.send()
    })
  }

  it('delivers a 200 response body via onload', async () => {
    const r = await get('/ok')
    expect(r.ok).toBe(true)
    expect(r.status).toBe(200)
    expect(r.text).toBe('hello')
  })

  it('treats a 404 as an error and does not deliver the body to the parser', async () => {
    const r = await get('/notfound')
    expect(r.ok).toBe(false)
    // the error body must NOT be surfaced as a loaded asset
    expect(r.text).not.toContain('not found')
  })

  it('treats an un-followed 3xx redirect as an error', async () => {
    const r = await get('/redirect')
    expect(r.ok).toBe(false)
  })
})
