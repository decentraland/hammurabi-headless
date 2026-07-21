// NOTE: no Node-version preflight here. This file is the public package export
// (`"."` → dist/index.js) and a library import must never process.exit the
// embedding process. The preflight runs in the true PROCESS entrypoints only:
// cli.ts and worker-entry.ts (the worker bundle).

// Export the main functions for programmatic use
export { main, resetEngine, EngineOptions } from './lib/engine-main'

// Export other useful types if needed
export type { CurrentRealm } from './lib/decentraland/state'