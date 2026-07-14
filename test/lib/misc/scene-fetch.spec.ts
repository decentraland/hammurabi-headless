import http from 'http'
import { AddressInfo } from 'net'
import { createSceneFetch } from '../../../src/lib/misc/scene-fetch'

// The global `fetch` the scene runtime exposes (ADR-133). The SSRF guard blocks
// loopback, so the success/redirect paths inject a permissive guard (recording
// its calls to prove it still runs per hop); the block path uses the real guard.
describe('when a scene uses the global fetch', () => {
  let server: http.Server
  let baseUrl: string
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
  let guardCalls: string[]
  let sceneFetch: ReturnType<typeof createSceneFetch>

  beforeEach(async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ hello: 'world' }))
    }
    server = http.createServer((req, res) => handler(req, res))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${port}`
    guardCalls = []
    sceneFetch = createSceneFetch({
      assertPublicUrl: async (url: string) => {
        guardCalls.push(url)
      }
    })
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  describe('and the request succeeds', () => {
    let response: Awaited<ReturnType<typeof sceneFetch>>

    beforeEach(async () => {
      response = await sceneFetch(`${baseUrl}/data`)
    })

    it('should expose ok and status', () => {
      expect(response.ok).toBe(true)
      expect(response.status).toBe(200)
    })

    it('should parse the JSON body', async () => {
      expect(await response.json()).toEqual({ hello: 'world' })
    })

    it('should expose the raw text body', async () => {
      expect(await response.text()).toBe(JSON.stringify({ hello: 'world' }))
    })

    it('should expose headers with a case-insensitive get', () => {
      expect(response.headers.get('Content-Type')).toBe('application/json')
    })

    it('should report header presence via a case-insensitive has', () => {
      expect(response.headers.has('content-type')).toBe(true)
      expect(response.headers.has('x-absent')).toBe(false)
    })

    it('should not expose a callback-based forEach that cannot cross the VM boundary', () => {
      expect((response.headers as { forEach?: unknown }).forEach).toBeUndefined()
    })

    it('should run the SSRF guard on the request URL', () => {
      expect(guardCalls).toEqual([`${baseUrl}/data`])
    })
  })

  describe('and the server returns a 5xx', () => {
    let requestCount: number

    beforeEach(() => {
      requestCount = 0
      handler = (_req, res) => {
        requestCount++
        res.writeHead(500)
        res.end('boom')
      }
    })

    it('should return the error response without retrying', async () => {
      const response = await sceneFetch(`${baseUrl}/flaky`)

      expect(response.status).toBe(500)
      expect(response.ok).toBe(false)
      // Exactly one request: standard fetch does not retry, and a POST must never
      // be silently re-sent on a 5xx.
      expect(requestCount).toBe(1)
    })
  })

  describe('and the URL targets a non-public host', () => {
    beforeEach(() => {
      sceneFetch = createSceneFetch()
    })

    it('should reject before connecting', async () => {
      await expect(sceneFetch('http://127.0.0.1:1/admin')).rejects.toThrow(/Blocked scene request/)
    })
  })

  describe('and the url is not a string', () => {
    it('should reject', async () => {
      await expect(sceneFetch(42 as unknown as string)).rejects.toThrow(/must be a string/)
    })
  })

  describe('and the server redirects to another public path', () => {
    beforeEach(() => {
      handler = (req, res) => {
        if (req.url === '/from') {
          res.writeHead(302, { Location: `${baseUrl}/to` })
          res.end()
        } else {
          res.writeHead(200)
          res.end('final')
        }
      }
    })

    it('should follow the redirect and re-run the guard on every hop', async () => {
      const response = await sceneFetch(`${baseUrl}/from`)

      expect(await response.text()).toBe('final')
      expect(guardCalls).toEqual([`${baseUrl}/from`, `${baseUrl}/to`])
    })
  })

  describe('and a redirect points at a host the guard blocks', () => {
    beforeEach(() => {
      handler = (_req, res) => {
        res.writeHead(302, { Location: `${baseUrl}/blocked` })
        res.end()
      }
      sceneFetch = createSceneFetch({
        assertPublicUrl: async (url: string) => {
          if (url.includes('/blocked')) throw new Error('Blocked scene request: redirect target')
        }
      })
    })

    it('should reject on the blocked hop', async () => {
      await expect(sceneFetch(`${baseUrl}/start`)).rejects.toThrow(/Blocked scene request/)
    })
  })

  describe('and the response body exceeds the cap', () => {
    beforeEach(() => {
      sceneFetch = createSceneFetch({ assertPublicUrl: async () => undefined, maxBodyBytes: 1024 })
      handler = (_req, res) => {
        res.writeHead(200)
        res.end(Buffer.alloc(4096, 'a'))
      }
    })

    it('should reject once the body passes the cap', async () => {
      await expect(sceneFetch(`${baseUrl}/big`)).rejects.toThrow(/exceeds/)
    })
  })

  describe('and the request is a POST with headers and a body', () => {
    let captured: { method?: string; contentType?: string; body: string }

    beforeEach(() => {
      captured = { body: '' }
      handler = (req, res) => {
        captured.method = req.method
        captured.contentType = req.headers['content-type']
        const chunks: Buffer[] = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => {
          captured.body = Buffer.concat(chunks).toString()
          res.writeHead(200)
          res.end('ok')
        })
      }
    })

    it('should forward the method, headers, and body', async () => {
      await sceneFetch(`${baseUrl}/hook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hi' })
      })

      expect(captured).toEqual({
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify({ content: 'hi' })
      })
    })
  })

  describe('and the caller only forwards string header values', () => {
    let captured: { str?: string; num?: string }

    beforeEach(() => {
      captured = {}
      handler = (req, res) => {
        captured.str = req.headers['x-str'] as string | undefined
        captured.num = req.headers['x-num'] as string | undefined
        res.writeHead(200)
        res.end('ok')
      }
    })

    it('should drop non-string header values', async () => {
      await sceneFetch(`${baseUrl}/h`, {
        headers: { 'X-Str': 'kept', 'X-Num': 5 as unknown as string }
      })

      expect(captured).toEqual({ str: 'kept', num: undefined })
    })
  })

  describe('and the response is a redirect with redirect set to manual', () => {
    beforeEach(() => {
      handler = (_req, res) => {
        res.writeHead(302, { Location: `${baseUrl}/elsewhere` })
        res.end()
      }
    })

    it('should return the redirect response without following it', async () => {
      const response = await sceneFetch(`${baseUrl}/from`, { redirect: 'manual' })

      expect(response.status).toBe(302)
      expect(response.redirected).toBe(false)
      expect(response.headers.get('location')).toBe(`${baseUrl}/elsewhere`)
    })
  })

  describe('and the response is a redirect with redirect set to error', () => {
    beforeEach(() => {
      handler = (_req, res) => {
        res.writeHead(302, { Location: `${baseUrl}/elsewhere` })
        res.end()
      }
    })

    it('should reject', async () => {
      await expect(sceneFetch(`${baseUrl}/from`, { redirect: 'error' })).rejects.toThrow(/unexpected redirect/)
    })
  })

  describe('and a redirect crosses to a different origin', () => {
    let serverB: http.Server
    let baseUrlB: string
    let secretSeenByB: string | undefined

    beforeEach(async () => {
      secretSeenByB = undefined
      serverB = http.createServer((req, res) => {
        secretSeenByB = req.headers['x-secret'] as string | undefined
        res.writeHead(200)
        res.end('B')
      })
      await new Promise<void>((resolve) => serverB.listen(0, '127.0.0.1', resolve))
      const { port } = serverB.address() as AddressInfo
      baseUrlB = `http://127.0.0.1:${port}`
      handler = (_req, res) => {
        res.writeHead(302, { Location: `${baseUrlB}/dest` })
        res.end()
      }
    })

    afterEach(async () => {
      await new Promise<void>((resolve) => serverB.close(() => resolve()))
    })

    it('should not forward scene headers across the origin boundary', async () => {
      await sceneFetch(`${baseUrl}/start`, { headers: { 'x-secret': 'do-not-leak' } })

      expect(secretSeenByB).toBeUndefined()
    })
  })

  describe('and more requests than the concurrency cap are in flight', () => {
    let cappedFetch: ReturnType<typeof createSceneFetch>
    let releaseGuard: () => void
    let inflight: Promise<unknown>[]

    beforeEach(() => {
      // A guard that hangs keeps requests in flight (inFlight incremented) without
      // touching the network, so the cap can be exercised deterministically.
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      releaseGuard = release
      cappedFetch = createSceneFetch({ maxConcurrent: 2, assertPublicUrl: () => gate })
      inflight = [cappedFetch(`${baseUrl}/a`), cappedFetch(`${baseUrl}/b`)]
    })

    afterEach(async () => {
      // Release the held requests so they settle against the server (default 200)
      // and leave no dangling promises/sockets.
      releaseGuard()
      await Promise.allSettled(inflight)
    })

    it('should reject requests beyond the cap', async () => {
      await expect(cappedFetch(`${baseUrl}/c`)).rejects.toThrow(/too many concurrent/)
    })
  })

  describe('and a POST is redirected with a 302', () => {
    let secondHop: { method?: string; contentType?: string; body: string }

    beforeEach(() => {
      secondHop = { body: '' }
      handler = (req, res) => {
        if (req.url === '/submit') {
          res.writeHead(302, { Location: `${baseUrl}/done` })
          res.end()
          return
        }
        secondHop.method = req.method
        secondHop.contentType = req.headers['content-type']
        const chunks: Buffer[] = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => {
          secondHop.body = Buffer.concat(chunks).toString()
          res.writeHead(200)
          res.end('ok')
        })
      }
    })

    it('should follow it as a bodyless GET (dropping the body and content headers)', async () => {
      await sceneFetch(`${baseUrl}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ a: 1 })
      })

      expect(secondHop).toEqual({ method: 'GET', contentType: undefined, body: '' })
    })
  })

  describe('and a POST is redirected with a 307', () => {
    let secondHop: { method?: string; body: string }

    beforeEach(() => {
      secondHop = { body: '' }
      handler = (req, res) => {
        if (req.url === '/submit') {
          res.writeHead(307, { Location: `${baseUrl}/done` })
          res.end()
          return
        }
        secondHop.method = req.method
        const chunks: Buffer[] = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => {
          secondHop.body = Buffer.concat(chunks).toString()
          res.writeHead(200)
          res.end('ok')
        })
      }
    })

    it('should preserve the method and body', async () => {
      await sceneFetch(`${baseUrl}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ a: 1 })
      })

      expect(secondHop).toEqual({ method: 'POST', body: JSON.stringify({ a: 1 }) })
    })
  })

  describe('and the caller iterates the response headers', () => {
    let response: Awaited<ReturnType<typeof sceneFetch>>

    beforeEach(async () => {
      handler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Custom': 'v' })
        res.end('{}')
      }
      response = await sceneFetch(`${baseUrl}/h`)
    })

    it('should expose entries() as reconstructable key/value pairs', () => {
      expect(Object.fromEntries(response.headers.entries())).toMatchObject({
        'content-type': 'application/json',
        'x-custom': 'v'
      })
    })

    it('should expose keys() and values()', () => {
      expect(response.headers.keys()).toEqual(expect.arrayContaining(['content-type', 'x-custom']))
      expect(response.headers.values()).toEqual(expect.arrayContaining(['application/json', 'v']))
    })
  })

  describe('and the response is binary', () => {
    beforeEach(() => {
      handler = (_req, res) => {
        res.writeHead(200)
        res.end(Buffer.from([0, 1, 2, 253, 254, 255]))
      }
    })

    it('should expose the body as raw bytes', async () => {
      const response = await sceneFetch(`${baseUrl}/bin`)
      const bytes = await response.bytes()

      expect(bytes).toBeInstanceOf(Uint8Array)
      expect(Array.from(bytes)).toEqual([0, 1, 2, 253, 254, 255])
    })
  })

  describe('and a lowercase-method POST is redirected with a 302', () => {
    let secondHop: { method?: string; body: string }

    beforeEach(() => {
      secondHop = { body: '' }
      handler = (req, res) => {
        if (req.url === '/submit') {
          res.writeHead(302, { Location: `${baseUrl}/done` })
          res.end()
          return
        }
        secondHop.method = req.method
        const chunks: Buffer[] = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => {
          secondHop.body = Buffer.concat(chunks).toString()
          res.writeHead(200)
          res.end('ok')
        })
      }
    })

    it('should still convert to a bodyless GET (case-insensitive method check)', async () => {
      await sceneFetch(`${baseUrl}/submit`, {
        method: 'post',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ a: 1 })
      })

      expect(secondHop).toEqual({ method: 'GET', body: '' })
    })
  })
})
