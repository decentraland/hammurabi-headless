import { json } from '../../../src/lib/misc/json'

// Regression: json() must enforce the same body ceiling as the /about path, so a
// hostile/compromised realm can't stream an unbounded response into host memory
// via the content-server (/entities/active) path.
describe('json', () => {
  const realFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function mockFetchOnce(resp: any) {
    globalThis.fetch = (async () => resp) as typeof fetch
  }

  describe('when the response Content-Length exceeds the body cap', () => {
    beforeEach(() => {
      mockFetchOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(20 * 1024 * 1024) : null) },
        bodyUsed: false,
        body: { cancel: async () => undefined }
      })
    })

    it('should reject with a clear "exceeds" error instead of buffering it', async () => {
      await expect(json('https://realm.test/entities/active')).rejects.toThrow(/exceeds/i)
    })
  })

  describe('when the response is small and ok', () => {
    beforeEach(() => {
      mockFetchOnce(new Response(JSON.stringify([{ id: 'e1' }]), { status: 200 }))
    })

    it('should parse and return the body', async () => {
      const result = await json<Array<{ id: string }>>('https://realm.test/entities/active')

      expect(result).toEqual([{ id: 'e1' }])
    })
  })

  describe('when the response is not ok', () => {
    beforeEach(() => {
      mockFetchOnce(new Response('boom', { status: 500, statusText: 'Server Error' }))
    })

    it('should throw an error including the status', async () => {
      // attempts=1 so robustFetch doesn't retry the 5xx (which would re-read the
      // single mocked Response body and add backoff delay).
      await expect(json('https://realm.test/entities/active', {}, 1)).rejects.toThrow(/500/)
    })
  })
})
