import { robustFetch, readBodyCapped, drainResponse, DEFAULT_MAX_BODY_BYTES } from './network'
import { assertPublicSceneUrl } from './ssrf'

// Max redirects the global `fetch` will follow. Each hop is re-checked by the
// SSRF guard, mirroring `~system/SignedFetch`, so a public host can't 3xx a
// scene request onto a private address the guard would otherwise have blocked.
const MAX_FETCH_REDIRECTS = 5

// Cap concurrent in-flight requests per scene. Each request holds a host socket +
// DNS lookup (libuv threadpool) + a VM deferred, none of which the VM heap ceiling
// bounds, so an ungated `fetch()` loop could exhaust host FDs/memory and amplify
// outbound traffic. Mirrors MAX_OPEN_SOCKETS for WebSocket. Generous for real scenes.
const DEFAULT_MAX_CONCURRENT_FETCHES = 32

/**
 * Subset of the WHATWG `RequestInit` a scene may pass. Values arrive already
 * dumped from the VM (plain JSON), so this is intentionally permissive and
 * everything is treated defensively.
 */
export type SceneFetchInit = {
  method?: string
  headers?: Record<string, unknown>
  body?: string
  redirect?: 'follow' | 'manual' | 'error'
}

/**
 * A Headers-like handle exposing the read methods scene libraries actually use.
 * Only value-returning methods are exposed: a callback-taking `forEach`/iterator
 * can't work across the VM boundary (a VM function passed as an argument is dumped
 * to a non-callable value), so it is deliberately omitted rather than shipped broken.
 */
export type SceneResponseHeaders = {
  get(name: string): string | null
  has(name: string): boolean
}

/**
 * The `Response`-shaped object handed to scene code. `json`/`text` are async to
 * match the WHATWG API (libraries do `await res.json()`); the body is read once
 * on the host and both methods return from that single read.
 */
export type SceneResponse = {
  ok: boolean
  status: number
  statusText: string
  url: string
  redirected: boolean
  headers: SceneResponseHeaders
  json(): Promise<unknown>
  text(): Promise<string>
}

export type SceneFetchDeps = {
  // Injectable so tests can exercise the success/redirect paths against a
  // localhost server (which the real guard blocks). Defaults to the real guard;
  // production never overrides it.
  assertPublicUrl?: (url: string) => Promise<void>
  maxBodyBytes?: number
  maxConcurrent?: number
}

/** Copy only string-valued headers; a scene may hand us junk after the VM dump. */
function normalizeHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers || typeof headers !== 'object') return out
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

// Request headers that describe a body; dropped when a redirect nulls the body.
const BODY_HEADERS = new Set(['content-type', 'content-length', 'content-encoding', 'content-language'])

function stripBodyHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!BODY_HEADERS.has(key.toLowerCase())) out[key] = value
  }
  return out
}

function buildHeaders(source: Headers): SceneResponseHeaders {
  // Snapshot into a lowercased map so lookups are case-insensitive (as Headers
  // is) and don't retain the underlying Response.
  const map = new Map<string, string>()
  source.forEach((value, key) => map.set(key.toLowerCase(), value))
  return {
    get: (name: string) => map.get(String(name).toLowerCase()) ?? null,
    has: (name: string) => map.has(String(name).toLowerCase())
  }
}

/**
 * Build the unprivileged global `fetch` exposed to scene code (ADR-133). Unlike
 * `~system/SignedFetch` it attaches no identity — it is a plain fetch libraries
 * (PostHog, discord webhooks, …) expect on the global. It is bounded exactly like
 * signed fetch: the SSRF guard runs on every redirect hop (so a redirect can't
 * reach a private host), cross-origin redirects drop scene-supplied headers, the
 * hop count is capped, and the response body is size-capped.
 */
export function createSceneFetch(deps: SceneFetchDeps = {}) {
  const assertPublicUrl = deps.assertPublicUrl ?? assertPublicSceneUrl
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const maxConcurrent = deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_FETCHES
  // In-flight counter for the per-scene concurrency cap; decremented when a request
  // settles (see the sceneFetch wrapper at the end).
  let inFlight = 0

  async function doFetch(url: unknown, init: SceneFetchInit = {}): Promise<SceneResponse> {
    if (typeof url !== 'string') {
      throw new Error('fetch: url must be a string')
    }

    // Mutable across hops: a 301/302/303 redirect can rewrite the method to GET
    // and drop the body per the Fetch spec (see the follow branch below).
    let method = typeof init?.method === 'string' ? init.method : 'GET'
    let headers = normalizeHeaders(init?.headers)
    let body = init?.body
    const redirectMode = init?.redirect ?? 'follow'
    const originalOrigin = new URL(url).origin

    let currentUrl = url
    let redirected = false

    for (let hop = 0; ; hop++) {
      await assertPublicUrl(currentUrl)

      // Only forward scene-supplied headers while on the original origin; on a
      // cross-origin redirect drop them, as browsers strip Authorization etc.,
      // so a redirect can't leak a scene header to a third-party host.
      const sameOrigin = new URL(currentUrl).origin === originalOrigin

      const response = await robustFetch(
        currentUrl,
        {
          method,
          headers: sameOrigin ? headers : {},
          body,
          redirect: 'manual'
        },
        // Single attempt: match standard `fetch` (no auto-retry) and, crucially,
        // never silently re-send a side-effecting POST (e.g. a webhook) on a 5xx.
        // robustFetch still applies its per-attempt timeout.
        { label: 'sceneFetch', retries: 1 }
      )

      const isRedirect = response.status >= 300 && response.status < 400
      const location = response.headers.get('location')

      if (isRedirect && location && redirectMode === 'follow') {
        // Release the redirect response's socket — we never read its body.
        await drainResponse(response)
        if (hop >= MAX_FETCH_REDIRECTS) {
          throw new Error('fetch: too many redirects')
        }
        // Fetch spec: a 301/302 on a POST, or a 303 on any non-GET/HEAD method,
        // becomes a bodyless GET (drop the body and its content-* headers); 307/308
        // preserve the method and body.
        if (
          ((response.status === 301 || response.status === 302) && method === 'POST') ||
          (response.status === 303 && method !== 'GET' && method !== 'HEAD')
        ) {
          method = 'GET'
          body = undefined
          headers = stripBodyHeaders(headers)
        }
        currentUrl = new URL(location, currentUrl).toString()
        redirected = true
        continue
      }

      if (isRedirect && location && redirectMode === 'error') {
        await drainResponse(response)
        throw new Error('fetch: unexpected redirect')
      }

      const headersHandle = buildHeaders(response.headers)
      // Read the (capped) body once; json()/text() serve from this string.
      const bodyText = await readBodyCapped(response, maxBodyBytes)

      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        url: currentUrl,
        redirected,
        headers: headersHandle,
        async text() {
          return bodyText
        },
        async json() {
          return JSON.parse(bodyText)
        }
      }
    }
  }

  return function sceneFetch(url: unknown, init: SceneFetchInit = {}): Promise<SceneResponse> {
    if (typeof url !== 'string') {
      return Promise.reject(new Error('fetch: url must be a string'))
    }
    // Reject rather than queue: bounds a hostile `fetch()` loop to `maxConcurrent`
    // concurrent host requests, matching the WebSocket socket cap's fail-fast policy.
    if (inFlight >= maxConcurrent) {
      return Promise.reject(new Error('fetch: too many concurrent requests'))
    }
    inFlight++
    return doFetch(url, init).finally(() => {
      inFlight--
    })
  }
}
