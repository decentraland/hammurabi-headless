// MUST stay the first import: checks the Node version at import time and exits
// with a clear message before anything transitively requires isolated-vm. This
// entry is also the worker bundle, so supervisors (sdk-multiplayer-server) get
// the same fail-fast on a mismatched Node.
import './lib/misc/node-version-check'

// Export the main functions for programmatic use
export { main, resetEngine, EngineOptions } from './lib/engine-main'

// Export other useful types if needed
export type { CurrentRealm } from './lib/decentraland/state'