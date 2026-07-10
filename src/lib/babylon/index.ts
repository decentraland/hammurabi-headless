import * as BABYLON from '@babylonjs/core'
import '@babylonjs/loaders/glTF/2.0/glTFLoader'
import { setupEnvironment } from './visual/ambientLights'
import { pickPointerEventsMesh } from './scene/logic/pointer-events'
import { createRateLimitedErrorLogger } from '../misc/logger'

// Renderer tick rate. Without a requestAnimationFrame global, Babylon paces the
// render loop with a hard-coded setTimeout(fn, 16) AFTER each frame finishes, so
// the rate is "at most ~60Hz, drifting down with frame cost" and there is no
// knob to lower it. A headless server draws nothing: every frame is pure CPU
// (animations, world matrices, active-mesh evaluation), so running at 30Hz
// roughly halves the steady-state cost of the whole process. The scene VM loop
// is throttled independently (game-loop.ts).
const DEFAULT_HEADLESS_FPS = 30

function installFramePacing() {
  // Clamp to [1, 60]: a tiny positive value (e.g. HAMMURABI_FPS=0.5) would
  // otherwise yield multi-second frame intervals and look like a hang; invalid
  // values (NaN/0/non-numeric) fall back to the default.
  const parsed = Number(process.env.HAMMURABI_FPS)
  const fps = parsed > 0 ? Math.min(Math.max(parsed, 1), 60) : DEFAULT_HEADLESS_FPS
  const frameIntervalMs = 1000 / fps

  // Override Babylon's static frame scheduler rather than defining a global
  // requestAnimationFrame: a RAF global could flip feature detection in
  // browser-oriented dependencies (e.g. livekit-client). Scoped to Babylon, this
  // only paces the render loop. Drift-corrected: schedule relative to the
  // previous frame START so the rate stays fixed instead of "interval + frame
  // cost". stopRenderLoop() empties the loop array, so no cancellation path is
  // needed — the last queued frame fires once and stops re-queuing.
  let lastFrameStart = 0
  BABYLON.ThinEngine.QueueNewFrame = (func: () => void): number => {
    const delay = Math.max(0, frameIntervalMs - (performance.now() - lastFrameStart))
    return setTimeout(() => {
      lastFrameStart = performance.now()
      func()
    }, delay) as unknown as number
  }
}

export async function initEngine(canvas?: HTMLCanvasElement) {
  let babylon: BABYLON.Engine | BABYLON.WebGPUEngine | BABYLON.NullEngine

    // Node.js environment - use NullEngine for headless operation
    installFramePacing()
    babylon = new BABYLON.NullEngine()

  babylon.disableManifestCheck = true
  babylon.enableOfflineSupport = true

  /**
   * This is the main scene of the engine.
   */
  const scene = new BABYLON.Scene(babylon)
  scene.clearColor = BABYLON.Color3.FromInts(31, 29, 35).toColor4(1)
  scene.collisionsEnabled = true
  scene.autoClear = false // Color buffer
  scene.autoClearDepthAndStencil = false // Depth and stencil
  scene.setRenderingAutoClearDepthStencil(0, false)
  scene.setRenderingAutoClearDepthStencil(1, true, true, false)
  scene.fogEnd = 256
  scene.fogStart = 128
  // Purely visual features cost CPU per frame (or per material sync) and produce
  // nothing on a NullEngine: keep them all off.
  scene.fogEnabled = false
  scene.particlesEnabled = false
  scene.spritesEnabled = false
  scene.lensFlaresEnabled = false
  scene.postProcessesEnabled = false
  scene.probesEnabled = false
  scene.actionManager = new BABYLON.ActionManager(scene)
  scene.blockMaterialDirtyMechanism = true
  scene.autoClear = false // Color buffer
  scene.autoClearDepthAndStencil = false // Depth and stencil, obviously
  scene.getBoundingBoxRenderer().showBackLines = true

  // setup visual parts and environment (no glow/highlight layer: it is a
  // render-only effect — nothing ever adds meshes to it headlessly, and it costs
  // RTT/post-process setup plus effect-layer bookkeeping)
  await setupEnvironment(scene)

  scene.gravity.set(0, -0.2, 0)

  // Register a render loop but don't start it immediately
  // The render loop will be started later after cameras are set up.
  // The try/catch is load-bearing: Babylon's ThinEngine._renderLoop only
  // re-queues the next frame AFTER the render functions return, so an uncaught
  // throw anywhere inside scene.render() (systems, avatar code, meshes from a
  // malformed glTF) would permanently stop the frame scheduler while the
  // process stays alive — a silent zombie. Log (rate-limited) and keep ticking.
  const logRenderError = createRateLimitedErrorLogger()
  function renderLoop() {
    try {
      if (scene.activeCamera) {
        scene.render()
      }
    } catch (error: any) {
      logRenderError('Error inside the render loop (frame skipped):', error)
    }
  }
  babylon.runRenderLoop(renderLoop)

  scene.onBeforeRenderObservable.add(() => {
    pickPointerEventsMesh(scene)
    scene.cleanCachedTextureBuffer();
  })

  // this is for debugging purposes
  Object.assign(globalThis, { scene })

  return { scene }
}



