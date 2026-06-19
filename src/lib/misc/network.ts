import { sleep } from './promises'
import { createLogger } from './logger'

const logger = createLogger('🌐 net')

const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_RETRIES = 2

export type RobustFetchOptions = { timeoutMs?: number; retries?: number; label?: string }

function backoffMs(attempt: number) {
  return Math.min(250 * 2 ** (attempt - 1), 2000)
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
