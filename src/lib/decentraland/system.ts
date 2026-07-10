import { Scene } from "@babylonjs/core"

export type DecentralandSystem = {
  update?(): void
  lateUpdate?(): void
}

// Each system runs isolated: Babylon's Observable.notifyObservers has no
// try/catch, so a throw from one system would otherwise skip every later
// system this frame and propagate into the render loop. The log rate limit is
// PER SYSTEM so a system failing every frame doesn't flood the console at tick
// rate — and doesn't mask another system's unrelated (rarer) error either.
function runIsolated(system: DecentralandSystem, method: 'update' | 'lateUpdate', errorLogState: { at: number }) {
  try {
    system[method]?.()
  } catch (error: any) {
    const now = Date.now()
    if (now - errorLogState.at > 1000) {
      errorLogState.at = now
      console.error(`Error in system ${method} (skipped this frame):`, error?.stack || error)
    }
  }
}

export function addSystems(scene: Scene, ...systems: DecentralandSystem[]) {
  const errorLogStates = systems.map(() => ({ at: 0 }))
  scene.onBeforeAnimationsObservable.add(() => {
    systems.forEach(($, i) => runIsolated($, 'update', errorLogStates[i]))
  })
  scene.onAfterDrawPhaseObservable.add(() => {
    systems.forEach(($, i) => runIsolated($, 'lateUpdate', errorLogStates[i]))
  })
}
