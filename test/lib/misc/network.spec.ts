import { readBodyCapped, robustFetch } from '../../../src/lib/misc/network'

describe('robustFetch', () => {
  const realFetch = globalThis.fetch
  let calls: number

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
    calls = 0
    globalThis.fetch = ((url: any, init?: any) => {
      calls++
      return impl(url, init)
    }) as typeof fetch
  }

  function res(status: number): Response {
    return new Response('ok', { status })
  }

  it('returns the response on the first success without retrying', async () => {
    mockFetch(async () => res(200))
    const r = await robustFetch('https://example.test/a', {}, { retries: 3 })
    expect(r.status).toBe(200)
    expect(calls).toBe(1)
  })

  it('retries on network error then succeeds', async () => {
    mockFetch(async () => {
      if (calls === 1) throw new Error('ECONNRESET')
      return res(200)
    })
    const r = await robustFetch('https://example.test/b', {}, { retries: 3 })
    expect(r.status).toBe(200)
    expect(calls).toBe(2)
  })

  it('retries on 5xx and returns the last response when retries are exhausted', async () => {
    mockFetch(async () => res(503))
    const r = await robustFetch('https://example.test/c', {}, { retries: 2 })
    expect(r.status).toBe(503)
    expect(calls).toBe(2)
  })

  it('releases the discarded response body when retrying a 5xx (no undici socket leak)', async () => {
    const seen: Response[] = []
    mockFetch(async () => {
      const r = calls <= 1 ? res(503) : res(200)
      seen.push(r)
      return r
    })

    const r = await robustFetch('https://example.test/h', {}, { retries: 2 })

    expect(r.status).toBe(200)
    // the first (discarded, 503) response body must have been consumed/cancelled
    expect(seen[0].status).toBe(503)
    expect(seen[0].bodyUsed).toBe(true)
  })

  it('does NOT retry a 4xx (returns immediately)', async () => {
    mockFetch(async () => res(404))
    const r = await robustFetch('https://example.test/d', {}, { retries: 3 })
    expect(r.status).toBe(404)
    expect(calls).toBe(1)
  })

  it('times out a hung request and retries', async () => {
    mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          // never resolves on its own — only the timeout abort settles it
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const r = robustFetch('https://example.test/e', {}, { retries: 2, timeoutMs: 50 }).catch((e) => e)
    const result = await r
    expect(result).toBeInstanceOf(Error)
    expect(calls).toBe(2)
  })

  it('defaults to 2 attempts then throws on a persistent network error', async () => {
    mockFetch(async () => {
      throw new Error('ECONNREFUSED')
    })
    const result = await robustFetch('https://example.test/g').catch((e) => e)
    expect(result).toBeInstanceOf(Error)
    expect(calls).toBe(2)
  })

  it('does not retry when the caller aborts', async () => {
    const controller = new AbortController()
    mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const p = robustFetch('https://example.test/f', { signal: controller.signal }, { retries: 3 }).catch((e) => e)
    controller.abort()
    await p
    expect(calls).toBe(1)
  })
})

// A caller holding a Response cannot abort it — robustFetch unbridges the caller's signal in
// the same `finally` that returns it — and cannot cancel the stream either, because the read
// locks it. So a body that stalls mid-stream is bounded only by this deadline, and only the
// reader can release the socket and the chunks it has accumulated.
describe('readBodyCapped with a time budget', () => {
  let cancelled: boolean
  let response: Response

  beforeEach(() => {
    cancelled = false
    response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([123, 125])) // "{}" — then stalls forever
        },
        cancel() {
          cancelled = true
        }
      })
    )
  })

  describe('when the body stalls part-way through', () => {
    let error: Error

    beforeEach(async () => {
      error = await readBodyCapped(response, 1024, { timeoutMs: 30 }).catch((e) => e)
    })

    it('should reject rather than wait on the stream forever', () => {
      expect(error).toBeInstanceOf(Error)
    })

    it('should name the timeout so the failure is diagnosable', () => {
      expect(error.message).toMatch(/timed out/)
    })

    it('should cancel the reader, releasing the socket and the buffered chunks', () => {
      expect(cancelled).toBe(true)
    })
  })

  describe('when no budget is given', () => {
    it('should still read a complete body to the end', async () => {
      const complete = new Response('{"ok":true}')

      await expect(readBodyCapped(complete, 1024)).resolves.toBe('{"ok":true}')
    })
  })

  describe('when the body completes inside the budget', () => {
    it('should return it rather than time out', async () => {
      const complete = new Response('{"ok":true}')

      await expect(readBodyCapped(complete, 1024, { timeoutMs: 5_000 })).resolves.toBe('{"ok":true}')
    })
  })
})
