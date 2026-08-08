import { limitLogger } from './limit-logger'

/**
 * What this worker can say about its own resource use, for a supervisor to record.
 *
 * A headless worker runs one scene per process, and until now everything it knew about that
 * scene's cost — how much CPU the sandbox actually burned, how close its isolate was to the
 * memory ceiling, which of the ~60 configured limits it kept hitting — existed only as throttled
 * log lines, if at all. This module is the read side of that: cheap, allocation-free counters
 * that a parent process can sample on an interval.
 *
 * Two rules make the numbers trustworthy:
 *
 * 1. **Every counter here is CUMULATIVE and `getRuntimeStats()` has no side effects.** A sampler
 *    subtracts the previous reading to get an interval. A getter that reset what it reported
 *    would give two callers different answers and make a missed call an invisible data loss.
 * 2. **Gauges are marked as such.** Heap figures are instantaneous readings, not totals, and are
 *    documented so nobody diffs them.
 *
 * The exception is `frames.p99Ms`, which is neither: a percentile cannot be diffed, so it is
 * reported over a bounded rolling window of the most recent frames.
 */

/**
 * The subset of `ivm.Isolate` these stats need.
 *
 * Structural on purpose: this module is imported by the package's entry point, and requiring the
 * `isolated-vm` NATIVE addon just to read a counter would drag it into every consumer — including
 * ones that never run a scene.
 */
export interface IsolateStatsSource {
  readonly cpuTime: bigint
  readonly isDisposed: boolean
  getHeapStatisticsSync(): { used_heap_size: number; heap_size_limit: number }
}

/** Frames kept for the rolling p99. About four seconds at 60fps — long enough to be a distribution, short enough to react. */
const FRAME_WINDOW = 256

/** Nanoseconds per millisecond: `Isolate.cpuTime` is a bigint in ns. */
const NS_PER_MS = 1_000_000n

export interface RuntimeStats {
  /** Instantaneous isolate readings, absent when no scene isolate is currently live. */
  isolate?: {
    /** CUMULATIVE CPU time the scene sandbox has consumed, in ms. */
    cpuMs: number
    /** GAUGE: heap in use by the scene sandbox right now. */
    heapUsedBytes: number
    /** GAUGE: the sandbox's heap ceiling (`HAMMURABI_ISOLATE_MEMORY_LIMIT_MB`). */
    heapLimitBytes: number
  }
  frames?: {
    /** CUMULATIVE count of scene-processing passes. */
    count: number
    /** p99 of the most recent {@link FRAME_WINDOW} passes, in ms. Not cumulative; do not diff. */
    p99Ms: number
    /** CUMULATIVE count of passes that ran out of their per-frame budget. */
    quotaOverruns: number
  }
  /** CUMULATIVE hits per limit name, sparse — only limits actually reached appear. */
  limitHits?: Record<string, number>
}

// Module state. One scene per process, so a module-level singleton is the correct scope — the
// same reasoning that makes `limitLogger` a singleton.
let activeIsolate: IsolateStatsSource | undefined
const frameTimes = new Float64Array(FRAME_WINDOW)
let frameWrites = 0
let frameCount = 0
let quotaOverruns = 0

/**
 * Register the live scene isolate so its CPU and heap can be read.
 *
 * Called by `withIsolatedVm` for the isolate it owns. Safe to call again: a hot reload creates a
 * replacement before the old one has finished tearing down, and the newest registration wins.
 */
export function registerIsolate(isolate: IsolateStatsSource): void {
  activeIsolate = isolate
}

/**
 * Forget an isolate. Ignores a stale caller, so a slow teardown cannot unregister the replacement
 * that has already taken its place.
 */
export function unregisterIsolate(isolate: IsolateStatsSource): void {
  if (activeIsolate === isolate) {
    activeIsolate = undefined
  }
}

/**
 * Record one scene-processing pass.
 *
 * @param durationMs - how long the pass took.
 * @param exceededQuota - whether it ran out of its per-frame budget and left scenes unprocessed.
 */
export function recordFrame(durationMs: number, exceededQuota: boolean): void {
  frameTimes[frameWrites % FRAME_WINDOW] = durationMs
  frameWrites++
  frameCount++
  if (exceededQuota) {
    quotaOverruns++
  }
}

/** @returns the p99 over the frames recorded so far, or 0 when none have been. */
function framesP99(): number {
  const filled = Math.min(frameWrites, FRAME_WINDOW)
  if (filled === 0) {
    return 0
  }
  // Copied and sorted rather than kept sorted: this runs once per sample (seconds apart), while
  // the write path runs every frame and must stay a single array store.
  //
  // Kept as a Float64Array through the copy AND the sort. `TypedArray.prototype.sort` is numeric
  // by default, where `Array.prototype.sort` is lexicographic unless handed a comparator — so
  // this is both faster (no boxing into a JS array) and immune to that footgun.
  const window = frameTimes.slice(0, filled).sort()
  return window[Math.min(filled - 1, Math.ceil(filled * 0.99) - 1)]
}

/**
 * Read this worker's resource counters.
 *
 * Pure: calling it twice in a row returns the same figures. Never throws — a disposed isolate or
 * a failed heap read costs its section of the report, not the whole thing, because the caller is
 * a supervisor that would otherwise lose the Node-level metrics too.
 *
 * @returns the stats available right now; sections are omitted rather than zero-filled when the
 *   underlying source is not there, so "not measurable" stays distinct from "measured zero".
 */
export function getRuntimeStats(): RuntimeStats {
  const stats: RuntimeStats = {}

  const isolate = activeIsolate
  if (isolate && !isolate.isDisposed) {
    try {
      const heap = isolate.getHeapStatisticsSync()
      stats.isolate = {
        cpuMs: Number(isolate.cpuTime / NS_PER_MS),
        heapUsedBytes: heap.used_heap_size,
        heapLimitBytes: heap.heap_size_limit
      }
    } catch {
      // The isolate was disposed between the check and the read (a scene that hit its async-turn
      // deadline disposes from another turn). Report the rest.
    }
  }

  if (frameCount > 0) {
    stats.frames = { count: frameCount, p99Ms: framesP99(), quotaOverruns }
  }

  const limitHits = limitLogger.totals()
  if (Object.keys(limitHits).length > 0) {
    stats.limitHits = limitHits
  }

  return stats
}

/** Discard all counters. For tests, and for a `resetEngine()` that starts a fresh session. */
export function resetRuntimeStats(): void {
  activeIsolate = undefined
  frameTimes.fill(0)
  frameWrites = 0
  frameCount = 0
  quotaOverruns = 0
}
