import { createThrottledLimitLogger, reportLimitHitChecked, DEFAULT_LIMIT_LOG_INTERVAL_MS } from '../../../src/lib/misc/limit-logger'

describe('createThrottledLimitLogger', () => {
  function harness(intervalMs = 1000) {
    let clock = 1_000_000 // arbitrary non-zero epoch
    const emitted: string[] = []
    const log = createThrottledLimitLogger({
      intervalMs,
      now: () => clock,
      emit: (m) => emitted.push(m)
    })
    return { log, emitted, advance: (ms: number) => (clock += ms) }
  }

  it('emits the first hit for a key immediately', () => {
    const { log, emitted } = harness()
    log.hit('maxConcurrentFetches')
    expect(emitted).toEqual(['maxConcurrentFetches reached'])
  })

  it('includes the detail string when provided', () => {
    const { log, emitted } = harness()
    log.hit('maxConcurrentFetches', 'https://example.com/x')
    expect(emitted).toEqual(['maxConcurrentFetches reached: https://example.com/x'])
  })

  it('suppresses hits within the interval and reports the suppressed count on the next emission', () => {
    const { log, emitted, advance } = harness(1000)
    log.hit('maxConcurrentFetches') // emits (first)
    log.hit('maxConcurrentFetches') // suppressed
    log.hit('maxConcurrentFetches') // suppressed
    expect(emitted).toHaveLength(1)

    advance(1000) // interval elapsed
    log.hit('maxConcurrentFetches') // emits, reporting the 2 suppressed
    expect(emitted).toHaveLength(2)
    expect(emitted[1]).toBe('maxConcurrentFetches reached (2 more in 1s)')
  })

  it('does not attach a suppressed-count suffix when nothing was suppressed', () => {
    const { log, emitted, advance } = harness(1000)
    log.hit('maxConcurrentFetches')
    advance(1500)
    log.hit('maxConcurrentFetches')
    expect(emitted[1]).toBe('maxConcurrentFetches reached')
  })

  it('throttles each key independently', () => {
    const { log, emitted } = harness(1000)
    log.hit('maxConcurrentFetches')
    log.hit('maxInflightHostCalls')
    log.hit('maxInboundPacketBytes')
    // Three distinct keys → three immediate emissions, none suppresses another.
    expect(emitted).toEqual([
      'maxConcurrentFetches reached',
      'maxInflightHostCalls reached',
      'maxInboundPacketBytes reached'
    ])
  })

  it('resets the suppressed counter after each emission', () => {
    const { log, emitted, advance } = harness(1000)
    log.hit('maxBodyBytes')
    log.hit('maxBodyBytes') // suppressed (1)
    advance(1000)
    log.hit('maxBodyBytes') // emits "(1 more...)"
    advance(1000)
    log.hit('maxBodyBytes') // emits with no suffix — counter was reset
    expect(emitted[emitted.length - 1]).toBe('maxBodyBytes reached')
  })

  it('collapses control characters in the detail so a crafted value cannot fake extra log lines', () => {
    const { log, emitted } = harness()
    log.hit('maxConcurrentFetches', 'line1\nline2\r\nline3 end')
    expect(emitted).toEqual(['maxConcurrentFetches reached: line1 line2 line3 end'])
  })

  it('redacts URL userinfo credentials in the detail', () => {
    const { log, emitted } = harness()
    log.hit('maxConcurrentFetches', 'https://user:secret@example.com/hook')
    expect(emitted).toEqual(['maxConcurrentFetches reached: https://***@example.com/hook'])
  })

  it('defaults to a 10s interval', () => {
    expect(DEFAULT_LIMIT_LOG_INTERVAL_MS).toBe(10_000)
  })
})

describe('reportLimitHitChecked', () => {
  function harness() {
    const emitted: string[] = []
    let clock = 1_000_000
    const log = createThrottledLimitLogger({ now: () => clock, emit: (m) => emitted.push(m) })
    return { log, emitted }
  }

  const known = new Set<string>(['maxInflightHostCalls', 'maxHostCallArgBytes'])

  it('forwards a known key to the logger', () => {
    const { log, emitted } = harness()
    reportLimitHitChecked(log, known, 'maxInflightHostCalls', 'ctx')
    expect(emitted).toEqual(['maxInflightHostCalls reached: ctx'])
  })

  it('ignores an unknown key so a spoofed key can never grow the map', () => {
    const { log, emitted } = harness()
    reportLimitHitChecked(log, known, 'not-a-real-limit', 'ctx')
    reportLimitHitChecked(log, known, 42, 'ctx')
    reportLimitHitChecked(log, known, undefined)
    expect(emitted).toEqual([])
  })

  it('drops a non-string detail rather than forwarding it', () => {
    const { log, emitted } = harness()
    reportLimitHitChecked(log, known, 'maxHostCallArgBytes', { evil: true } as unknown as string)
    expect(emitted).toEqual(['maxHostCallArgBytes reached'])
  })
})
