import { Scene } from "@babylonjs/core"
import { createRateLimitedErrorLogger } from "../misc/logger"

export type DecentralandSystem = {
  update?(): void
  lateUpdate?(): void
}

// Each system runs isolated: Babylon's Observable.notifyObservers has no
// try/catch, so a throw from one system would otherwise skip every later
// system this frame and propagate into the render loop.
function runIsolated(
  system: DecentralandSystem,
  method: 'update' | 'lateUpdate',
  logError: ReturnType<typeof createRateLimitedErrorLogger>
) {
  try {
    system[method]?.()
  } catch (error: any) {
    logError(`Error in system ${method} (skipped this frame):`, error)
  }
}

export function addSystems(scene: Scene, ...systems: DecentralandSystem[]) {
  // One rate-limited logger PER SYSTEM so a system failing every frame can't
  // suppress another system's unrelated error.
  const errorLoggers = systems.map(() => createRateLimitedErrorLogger())
  scene.onBeforeAnimationsObservable.add(() => {
    systems.forEach(($, i) => runIsolated($, 'update', errorLoggers[i]))
  })
  scene.onAfterDrawPhaseObservable.add(() => {
    systems.forEach(($, i) => runIsolated($, 'lateUpdate', errorLoggers[i]))
  })
}
