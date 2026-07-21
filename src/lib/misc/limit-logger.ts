import { createLogger } from './logger'
import { Limits } from './limits'

/**
 * Operator-facing, THROTTLED logging for resource/DoS limit hits.
 *
 * Every cap in {@link Limits} is enforced fail-fast (reject / drop / truncate /
 * dispose) and, historically, silently — so an operator had no signal that a
 * scene or a remote peer was hammering a ceiling. This reports those hits, but a
 * naive `logger.error` per hit would itself be an amplification vector: a scene
 * calling `fetch()` in a tight loop trips the concurrency cap thousands of times
 * per frame, turning our own log into a disk/IO DoS. So emission is throttled to
 * at most once per interval PER KEY; intervening hits are counted and reported
 * ("N more") on the next emission.
 *
 * The throttle key is restricted to {@link Limits} field names on purpose: the
 * per-key state map must stay bounded. Keying by a scene-controlled identifier
 * (peer address, url, scene id) would let a flood of distinct values grow the map
 * without bound — a second DoS. Such context belongs in the free-form `detail`
 * string, which is logged but never used as a map key.
 */
export type LimitKey = keyof Limits

/** How often, per key, a limit-hit is actually emitted. Not a resource cap, so it is deliberately not an env knob. */
export const DEFAULT_LIMIT_LOG_INTERVAL_MS = 10_000

/** `detail` is often scene/peer-controlled (a url, a header); truncate so one log line can't be an amplifier. */
export const MAX_DETAIL_LEN = 200

// detail is scene/peer-controlled: collapse ASCII control chars (incl. CR/LF) so a
// crafted value cannot fake extra log lines, and redact URL userinfo so a
// credential-bearing URL (https://user:pass@host/...) is not persisted into
// operator logs.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g
const URL_USERINFO = /(:\/\/)[^/\s@]+@/g

export interface ThrottledLimitLoggerOptions {
  /** Minimum gap between emissions for the same key. Defaults to {@link DEFAULT_LIMIT_LOG_INTERVAL_MS}. */
  intervalMs?: number
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number
  /** Injectable sink (tests). Defaults to the shared `🚧 limit` logger. */
  emit?: (message: string) => void
}

export interface ThrottledLimitLogger {
  /**
   * Record one limit-hit for `key`. Emits at most once per `intervalMs` per key;
   * hits in between are counted and surfaced on the next emission. `detail` is a
   * short context string (a url, an observed size, a peer id) that is logged but
   * is NOT part of the throttle key.
   */
  hit(key: LimitKey, detail?: string): void
}

export function createThrottledLimitLogger(options: ThrottledLimitLoggerOptions = {}): ThrottledLimitLogger {
  const intervalMs = options.intervalMs ?? DEFAULT_LIMIT_LOG_INTERVAL_MS
  const now = options.now ?? Date.now
  const logger = createLogger('🚧 limit')
  const emit = options.emit ?? ((message: string) => logger.error(message))
  // key -> throttle state. Bounded by the fixed set of Limits field names.
  const state = new Map<LimitKey, { lastLogAt: number; suppressed: number }>()

  return {
    hit(key: LimitKey, detail?: string): void {
      const t = now()
      let s = state.get(key)
      if (!s) {
        // NEGATIVE_INFINITY so the very first hit always clears the interval and emits.
        s = { lastLogAt: Number.NEGATIVE_INFINITY, suppressed: 0 }
        state.set(key, s)
      }
      if (t - s.lastLogAt >= intervalMs) {
        const windowSec = s.lastLogAt === Number.NEGATIVE_INFINITY ? null : Math.round((t - s.lastLogAt) / 1000)
        const suffix = s.suppressed > 0 ? ` (${s.suppressed} more in ${windowSec ?? '?'}s)` : ''
        let shownDetail = detail
        if (shownDetail) {
          // Sanitize BEFORE truncating so the cut cannot re-expose a stripped char.
          shownDetail = shownDetail.replace(CONTROL_CHARS, ' ').replace(URL_USERINFO, '$1***@')
          if (shownDetail.length > MAX_DETAIL_LEN) shownDetail = shownDetail.slice(0, MAX_DETAIL_LEN) + '…'
        }
        emit(`${key} reached${shownDetail ? `: ${shownDetail}` : ''}${suffix}`)
        s.lastLogAt = t
        s.suppressed = 0
      } else {
        s.suppressed++
      }
    }
  }
}

/** Process-wide throttled limit logger (one scene per process, so one instance is correct). */
export const limitLogger: ThrottledLimitLogger = createThrottledLimitLogger()

/**
 * Runtime-validating entry point for limit-hits whose key crosses a trust
 * boundary (e.g. reported from inside the isolate). Ignores any key that is not a
 * real {@link Limits} field so a bad/spoofed key can never grow the throttle map.
 * `knownKeys` is the set of valid field names (pass `Object.keys(limits)`).
 */
export function reportLimitHitChecked(
  logger: ThrottledLimitLogger,
  knownKeys: ReadonlySet<string>,
  key: unknown,
  detail?: string
): void {
  if (typeof key !== 'string' || !knownKeys.has(key)) return
  logger.hit(key as LimitKey, typeof detail === 'string' ? detail : undefined)
}
