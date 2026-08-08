// NOTE: no Node-version preflight here. This file is the public package export
// (`"."` → dist/index.js) and a library import must never process.exit the
// embedding process. The preflight runs in the true PROCESS entrypoints only:
// cli.ts and worker-entry.ts (the worker bundle).

// Export the main functions for programmatic use
export { main, resetEngine, EngineOptions } from './lib/engine-main'

// Resource counters a supervisor can sample on an interval: the scene isolate's CPU and heap,
// frame-processing timings, and which of the configured limits the scene has been hitting. Read
// with `getRuntimeStats()`; every counter is cumulative and the call has no side effects, so a
// sampler subtracts its previous reading to get an interval. Exported from the package root (and
// therefore from the worker bundle) because the supervisor that samples it is the process that
// forked the worker.
export { getRuntimeStats, resetRuntimeStats, RuntimeStats } from './lib/misc/runtime-stats'

// Typed startup-failure classification, so supervisors embedding the worker
// (require('@dcl/hammurabi-server/worker')) can tell permanent failures from
// transient ones without matching on error message text.
export {
  PermanentStartupError,
  isPermanentStartupError,
  PERMANENT_STARTUP_ERROR_CODE
} from './lib/misc/startup-errors'

// Export other useful types if needed
export type { CurrentRealm } from './lib/decentraland/state'