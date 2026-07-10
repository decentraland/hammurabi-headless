/**
 * Error logger for per-frame catch blocks: logs at most once per interval so a
 * failure recurring at tick rate (30-60Hz) can't flood stdout, and always
 * prints the stack when available. One instance per isolated unit (system,
 * render loop) — sharing one across units would let a noisy unit's throttle
 * window suppress another unit's unrelated, rarer error.
 */
export function createRateLimitedErrorLogger(intervalMs = 1000) {
  let lastLogAt = 0
  return (message: string, error: any) => {
    const now = Date.now()
    if (now - lastLogAt > intervalMs) {
      lastLogAt = now
      console.error(message, error?.stack || error)
    }
  }
}

export function createLogger(namespace: string) {
  let enabled = true
  const prefix = `[${namespace}]`
  return {
    get enabled() {
      return enabled
    },
    set enabled(value: boolean) {
      enabled = value
    },
    log(...args: any[]) {
      if (enabled)
        console.log(prefix, ...args)
    },
    error(...args: any[]) {
      console.error(prefix, ...args)
    },
  }
}