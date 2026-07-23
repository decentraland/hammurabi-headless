/**
 * Typed permanent startup failures.
 *
 * A supervisor that respawns crashed workers (e.g. sdk-multiplayer-server)
 * needs to tell "retrying can help" (comms hiccup, content-server 5xx) from
 * "retrying is doomed" (the target scene entity is not part of the world's
 * current deployment, the scene is SDK6). Failures of the second kind are
 * thrown as {@link PermanentStartupError} so consumers can classify them
 * without matching on message text.
 *
 * Detection is by the stable `code` string, NOT `instanceof` or class names:
 * the production worker bundle is minified with name mangling, and a consumer
 * may hold a different copy of this class than the one that threw, so a
 * string-literal property is the only signal that survives both.
 */

/** Stable machine-readable marker carried by every {@link PermanentStartupError}. */
export const PERMANENT_STARTUP_ERROR_CODE = 'ERR_PERMANENT_STARTUP'

/**
 * A startup failure that no restart with the same configuration can fix —
 * it is determined by the (immutable) target entity or the world's current
 * deployment, not by transient conditions. Supervisors should not blindly
 * respawn on it; see EXIT_CODES.CONFIG in `shutdown.ts` for the matching
 * process-level signal.
 */
export class PermanentStartupError extends Error {
  readonly code = PERMANENT_STARTUP_ERROR_CODE

  constructor(message: string) {
    super(message)
    this.name = 'PermanentStartupError'
  }
}

/**
 * Whether an unknown rejection is a permanent startup failure. Duck-typed on
 * the stable `code` so it works across bundle boundaries, minification, and
 * mixed versions of this package.
 *
 * @param error - The rejection reason to classify.
 * @returns True when no restart with the same configuration can succeed.
 */
export function isPermanentStartupError(error: unknown): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === PERMANENT_STARTUP_ERROR_CODE
}
