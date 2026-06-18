import { robustFetch } from '../../../src/lib/misc/network'

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
