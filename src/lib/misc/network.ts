import { sleep } from './promises'
import { createLogger } from './logger'
import { limits } from './limits'

const logger = createLogger('🌐 net')

const DEFAULT_TIMEOUT_MS = limits.fetchTimeoutMs // HAMMURABI_FETCH_TIMEOUT_MS
const DEFAULT_RETRIES = limits.fetchRetries // HAMMURABI_FETCH_RETRIES

export type RobustFetchOptions = { timeoutMs?: number; retries?: number; label?: string }

/**
 * Release a fetch Response body that will NOT be read.
 *
 * Node's global `fetch` (undici) keeps the underlying socket checked out of the
 * keep-alive pool until the body is consumed or cancelled. Any path that obtains
 * a Response and discards it without reading (a retry, a `!res.ok` early return)
 * therefore leaks a socket until GC. Call this before dropping such a response.
 */
export async function drainResponse(res: {
  bodyUsed: boolean
  body?: { cancel(): Promise<void> } | null
}): Promise<void> {
  if (!res.bodyUsed) {
    await res.body?.cancel().catch(() => undefined)
  }
}

function backoffMs(attempt: number) {
  return Math.min(250 * 2 ** (attempt - 1), 2000)
}

// Default body ceiling for responses whose URL is user- or scene-influenceable
// (signed fetches, realm /about). Far above any legitimate API response; the
// per-attempt timeout bounds time, not volume, so a hostile endpoint on a fast
// link could otherwise stream unbounded bytes into host memory.
export const DEFAULT_MAX_BODY_BYTES = limits.maxBodyBytes // HAMMURABI_MAX_BODY_BYTES

/**
 * Reads a Response body as text, enforcing a byte ceiling.
 *
 * The cap is enforced twice: on the declared Content-Length (cheap rejection
 * before reading) and again on the streamed bytes, because chunked responses
 * can omit or lie about the header. The decode matches the fetch spec's UTF-8
 * decode by stripping a leading BOM — `Buffer.toString('utf-8')` keeps U+FEFF,
 * which broke JSON.parse on BOM-prefixed bodies that `response.json()` used to
 * accept (common from Windows/.NET backends).
 */
export async function readBodyCappedBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await drainResponse(response)
    throw new Error(`response body exceeds ${maxBytes} bytes`)
  }

  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        throw new Error(`response body exceeds ${maxBytes} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    // Release the socket if the cap aborted the read mid-stream (no-op after a
    // complete drain).
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks)
}

export async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  const text = (await readBodyCappedBytes(response, maxBytes)).toString('utf-8')
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

// fetch with a per-attempt timeout, retry-with-backoff on network errors and
// 5xx/429 (2 attempts by default), and a single log line per failure naming the
// url, duration and cause. When every attempt fails it logs a final "gave up"
// line (surfaced to the parent) before throwing, so callers that swallow the
// error still leave a trace. A hung connect fails in `timeoutMs` instead of
// blocking forever.
// Note: retries re-send init.body as-is — fine for string bodies (all current
// callers), but a one-shot ReadableStream body could not be replayed.
export async function robustFetch(url: string, init: RequestInit = {}, opts: RobustFetchOptions = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = opts.retries ?? DEFAULT_RETRIES
  const label = opts.label ?? 'fetch'

  let lastError: unknown
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    const caller = init.signal
    if (caller) {
      if (caller.aborted) controller.abort()
      else caller.addEventListener('abort', onAbort, { once: true })
    }
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
    const t0 = Date.now()
    try {
      const res = await fetch(url, { ...init, signal: controller.signal })
      if ((res.status >= 500 || res.status === 429) && attempt < retries) {
        logger.error(`${label} ${res.status} ${url} (attempt ${attempt}/${retries}) — retrying`)
        // Release the discarded response so undici returns the socket to the pool
        // instead of pinning it until GC across every retry.
        await drainResponse(res)
        await sleep(backoffMs(attempt))
        continue
      }
      return res
    } catch (err) {
      // the caller cancelled (not our timeout) — propagate, don't retry
      if (caller?.aborted) throw err
      lastError = err
      const e = err as { cause?: { code?: string }; code?: string; name?: string; message?: string }
      const cause = e?.cause?.code || e?.code || e?.name || e?.message || 'unknown'
      logger.error(`${label} FAILED in ${Date.now() - t0}ms (attempt ${attempt}/${retries}): ${url} — ${cause}`)
      if (attempt < retries) await sleep(backoffMs(attempt))
    } finally {
      clearTimeout(timer)
      if (caller) caller.removeEventListener('abort', onAbort)
    }
  }
  logger.error(`${label} gave up after ${retries} attempt(s): ${url}`)
  throw lastError
}
