// Export the main functions for programmatic use
export { main, resetEngine, EngineOptions } from './lib/engine-main'

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