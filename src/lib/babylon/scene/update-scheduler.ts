import { PrecisionDate, Scene, Vector3 } from "@babylonjs/core";
import { SceneContext } from "./scene-context";

// SceneTickSystem adds hooks to the babylon engine to start processing the updates from the workers
export function createSceneTickSystem(scene: Scene, getScenes: () => Iterable<SceneContext>, quotaMs: number) {
  function getSortedScenes() {
    const scenes = getScenes()
    const cameraPosition = scene.activeCamera?.position || Vector3.Zero()
    const scenesWithDistance = Array.from(scenes).map(
      scene => ({
        scene,
        distance:
          (scene.currentTick == 0 || scene.isGlobalScene) ? 0
            : scene.distanceToPoint(cameraPosition)
      })
    )

    return scenesWithDistance.sort((a, b) => a.distance - b.distance)
  }

  return {
    // this function runs the initial part of the tick defined in ADR-148,
    // before sending GPU commands
    update() {
      const sortedScenes = getSortedScenes()
      const start = PrecisionDate.Now
      const hasQuota = () => (PrecisionDate.Now - start) < quotaMs

      for (const { scene } of sortedScenes) {
        try {
          // if the processing quota has been exceeded for this frame we will skip it for now.
          if (!scene.update(hasQuota)) return
        } catch (err: any) {
          // A malformed/hostile CRDT payload can throw out of the parser. Contain
          // it to this scene's tick instead of crashing the shared render loop
          // (which would take down every scene in the worker).
          console.error(`Scene update failed for ${scene.entityId}: ${err?.message ?? err}`)
        }
      }
    },
    // this function runs the final part of the tick defined in ADR-148.
    // ideally in parallel with GPU commands or while we wait for their completion
    lateUpdate() {
      for (const scene of getScenes()) {
        try {
          scene.lateUpdate()
        } catch (err: any) {
          // As with update(): contain a throw (e.g. from serializing a hostile
          // CRDT payload) to this scene instead of crashing the shared render
          // loop for every scene in the worker.
          console.error(`Scene lateUpdate failed for ${scene.entityId}: ${err?.message ?? err}`)
        }
      }
    }
  }
}