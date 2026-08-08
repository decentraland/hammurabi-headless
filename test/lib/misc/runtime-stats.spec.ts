import { createThrottledLimitLogger } from '../../../src/lib/misc/limit-logger'
import {
  getRuntimeStats,
  IsolateStatsSource,
  recordFrame,
  registerIsolate,
  resetRuntimeStats,
  unregisterIsolate
} from '../../../src/lib/misc/runtime-stats'

function fakeIsolate(overrides: Partial<IsolateStatsSource> = {}): IsolateStatsSource {
  return {
    cpuTime: 0n,
    isDisposed: false,
    getHeapStatisticsSync: () => ({ used_heap_size: 0, heap_size_limit: 0 }),
    ...overrides
  }
}

describe('getRuntimeStats', () => {
  afterEach(() => {
    resetRuntimeStats()
  })

  describe('when nothing has been recorded', () => {
    let stats: ReturnType<typeof getRuntimeStats>

    beforeEach(() => {
      stats = getRuntimeStats()
    })

    it('should omit every section rather than reporting zeroes', () => {
      // A supervisor has to be able to tell "no scene isolate exists" from "the isolate used no
      // CPU"; zero-filling would erase that difference.
      expect(stats).toEqual({})
    })
  })

  describe('when an isolate is registered', () => {
    let stats: ReturnType<typeof getRuntimeStats>

    beforeEach(() => {
      registerIsolate(
        fakeIsolate({
          cpuTime: 2_500_000_000n, // 2.5s in ns
          getHeapStatisticsSync: () => ({ used_heap_size: 12_000, heap_size_limit: 256_000 })
        })
      )
      stats = getRuntimeStats()
    })

    it('should report its CPU time in milliseconds and its heap as a gauge', () => {
      expect(stats.isolate).toEqual({ cpuMs: 2500, heapUsedBytes: 12_000, heapLimitBytes: 256_000 })
    })
  })

  describe('when the registered isolate has been disposed', () => {
    let stats: ReturnType<typeof getRuntimeStats>

    beforeEach(() => {
      registerIsolate(fakeIsolate({ isDisposed: true }))
      stats = getRuntimeStats()
    })

    it('should not report it', () => {
      expect(stats.isolate).toBeUndefined()
    })
  })

  describe('when the isolate heap read throws, as it does if disposal races the read', () => {
    let stats: ReturnType<typeof getRuntimeStats>

    beforeEach(() => {
      registerIsolate(
        fakeIsolate({
          getHeapStatisticsSync: () => {
            throw new Error('isolate is disposed')
          }
        })
      )
      recordFrame(5, false)
      stats = getRuntimeStats()
    })

    it('should omit the isolate section', () => {
      expect(stats.isolate).toBeUndefined()
    })

    it('should still report the rest, rather than losing the whole report with it', () => {
      expect(stats.frames?.count).toBe(1)
    })
  })

  describe('when an isolate is unregistered', () => {
    let stats: ReturnType<typeof getRuntimeStats>

    beforeEach(() => {
      const isolate = fakeIsolate({ cpuTime: 1_000_000n })
      registerIsolate(isolate)
      unregisterIsolate(isolate)
      stats = getRuntimeStats()
    })

    it('should stop reporting it', () => {
      expect(stats.isolate).toBeUndefined()
    })

    describe('and a replacement had been registered before the old one was torn down', () => {
      let replacementStats: ReturnType<typeof getRuntimeStats>

      beforeEach(() => {
        const stale = fakeIsolate({ cpuTime: 1_000_000n })
        const replacement = fakeIsolate({
          cpuTime: 9_000_000n,
          getHeapStatisticsSync: () => ({ used_heap_size: 7, heap_size_limit: 8 })
        })
        registerIsolate(stale)
        registerIsolate(replacement)
        // This is the hot-reload ordering: the new session starts before the old one finishes
        // disposing, so the late unregister must not blank out the live isolate.
        unregisterIsolate(stale)
        replacementStats = getRuntimeStats()
      })

      it('should keep reporting the replacement', () => {
        expect(replacementStats.isolate).toEqual({ cpuMs: 9, heapUsedBytes: 7, heapLimitBytes: 8 })
      })
    })
  })

  describe('when frames have been recorded', () => {
    let stats: ReturnType<typeof getRuntimeStats>

    beforeEach(() => {
      recordFrame(1, false)
      recordFrame(2, true)
      recordFrame(3, false)
      stats = getRuntimeStats()
    })

    it('should count every pass', () => {
      expect(stats.frames?.count).toBe(3)
    })

    it('should count only the passes that overran their quota', () => {
      expect(stats.frames?.quotaOverruns).toBe(1)
    })

    it('should report the same figures when read twice, since it is a pure read', () => {
      // Load-bearing: the sampler subtracts its previous reading, so a getter that reset what it
      // reported would make every second sample a phantom zero.
      expect(getRuntimeStats()).toEqual(getRuntimeStats())
    })
  })

  describe('when a hundred frames of increasing duration have been recorded', () => {
    let stats: ReturnType<typeof getRuntimeStats>

    beforeEach(() => {
      for (let i = 0; i < 100; i++) {
        recordFrame(i, false)
      }
      stats = getRuntimeStats()
    })

    it('should report the 99th percentile of them', () => {
      expect(stats.frames?.p99Ms).toBe(98)
    })
  })

  describe('when more frames arrive than the rolling window holds', () => {
    let slowSpell: ReturnType<typeof getRuntimeStats>
    let afterRecovery: ReturnType<typeof getRuntimeStats>

    beforeEach(() => {
      // A slow spell, then a full window's worth of fast frames. The count is cumulative; the
      // percentile is not, so once the slow frames have scrolled out they stop weighing on it.
      for (let i = 0; i < 256; i++) {
        recordFrame(100, false)
      }
      slowSpell = getRuntimeStats()

      for (let i = 0; i < 256; i++) {
        recordFrame(1, false)
      }
      afterRecovery = getRuntimeStats()
    })

    it('should have reported the slow frames while they were in the window', () => {
      expect(slowSpell.frames?.p99Ms).toBe(100)
    })

    it('should keep counting every frame cumulatively', () => {
      expect(afterRecovery.frames?.count).toBe(512)
    })

    it('should forget the frames that scrolled out of the percentile window', () => {
      expect(afterRecovery.frames?.p99Ms).toBe(1)
    })
  })

  describe('when limits have been hit more often than the log throttle emits', () => {
    let logger: ReturnType<typeof createThrottledLimitLogger>

    beforeEach(() => {
      // Throttling governs how loud a limit is in the log; a scene hammering a cap is deliberately
      // quiet there, which is exactly when the count is the only remaining evidence.
      logger = createThrottledLimitLogger({ intervalMs: 1_000_000, now: () => 0, emit: () => {} })
      logger.hit('maxConcurrentFetches')
      logger.hit('maxConcurrentFetches')
      logger.hit('maxCoercedBytes')
    })

    it('should report the full cumulative count per limit', () => {
      expect(logger.totals()).toEqual({ maxConcurrentFetches: 2, maxCoercedBytes: 1 })
    })

    it('should omit limits that have never been reached', () => {
      expect(Object.keys(logger.totals())).toEqual(['maxConcurrentFetches', 'maxCoercedBytes'])
    })
  })
})
