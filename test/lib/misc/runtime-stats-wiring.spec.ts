import { withIsolatedVm } from '../../../src/lib/isolated-vm/index'
import { createSceneTickSystem } from '../../../src/lib/babylon/scene/update-scheduler'
import { getRuntimeStats, resetRuntimeStats, RuntimeStats } from '../../../src/lib/misc/runtime-stats'

/**
 * Wiring coverage for `getRuntimeStats()`.
 *
 * `runtime-stats.spec.ts` proves the registry's arithmetic against fakes. This proves the other
 * half — that the real enforcement sites actually feed it — which is the part that silently rots:
 * a counter nobody increments reads exactly like a scene that never hit anything.
 */

const noop = () => {}

describe('isolate registration', () => {
  afterEach(() => {
    resetRuntimeStats()
  })

  describe('when a scene isolate is running', () => {
    let statsDuringRun: RuntimeStats

    beforeEach(async () => {
      await withIsolatedVm(async opts => {
        opts.provide({ log: noop, error: noop, require: () => ({}) })
        opts.eval('module.exports.onStart = async () => { for (let i = 0; i < 1e5; i++) {} }')
        await opts.onStart()
        statsDuringRun = getRuntimeStats()
      })
    })

    it('should report the sandbox heap it is actually using', () => {
      expect(statsDuringRun.isolate!.heapUsedBytes).toBeGreaterThan(0)
    })

    it('should report the sandbox ceiling, so a reader can tell how close it is', () => {
      expect(statsDuringRun.isolate!.heapLimitBytes).toBeGreaterThan(statsDuringRun.isolate!.heapUsedBytes)
    })

    it('should report the CPU the sandbox burned, separately from the host process', () => {
      expect(statsDuringRun.isolate!.cpuMs).toBeGreaterThanOrEqual(0)
    })
  })

  describe('when the isolate has been torn down', () => {
    let statsAfterRun: RuntimeStats

    beforeEach(async () => {
      await withIsolatedVm(async opts => {
        opts.provide({ log: noop, error: noop, require: () => ({}) })
        opts.eval('module.exports.onStart = async () => {}')
        await opts.onStart()
      })
      statsAfterRun = getRuntimeStats()
    })

    it('should stop reporting it rather than reading a disposed isolate', () => {
      expect(statsAfterRun.isolate).toBeUndefined()
    })
  })

  describe('when the isolate fails to bootstrap', () => {
    let statsAfterFailure: RuntimeStats

    beforeEach(async () => {
      await withIsolatedVm(async opts => {
        opts.provide({ log: noop, error: noop, require: () => ({}) })
        // A scene whose top-level code throws: the run still tears its isolate down.
        try {
          opts.eval('throw new Error("boom")')
        } catch {
          // the throw is the scenario, not the assertion
        }
      })
      statsAfterFailure = getRuntimeStats()
    })

    it('should not leave the isolate registered', () => {
      expect(statsAfterFailure.isolate).toBeUndefined()
    })
  })
})

describe('frame accounting', () => {
  /** A scene whose `update` reports whether it finished, standing in for a real SceneContext. */
  function fakeScene(options: { finishes: boolean }): any {
    return {
      entityId: 'bafkrei-scene',
      currentTick: 0,
      isGlobalScene: true,
      distanceToPoint: () => 0,
      update: () => options.finishes,
      lateUpdate: noop
    }
  }

  /** A Babylon scene stub: the tick system only reads the active camera's position. */
  const babylonScene: any = { activeCamera: undefined }

  afterEach(() => {
    resetRuntimeStats()
  })

  describe('when a scene-processing pass completes within its budget', () => {
    let stats: RuntimeStats

    beforeEach(() => {
      const scenes = [fakeScene({ finishes: true })]
      createSceneTickSystem(babylonScene, () => scenes, 100).update()
      stats = getRuntimeStats()
    })

    it('should count the pass', () => {
      expect(stats.frames!.count).toBe(1)
    })

    it('should not count a quota overrun', () => {
      expect(stats.frames!.quotaOverruns).toBe(0)
    })
  })

  describe('when a pass runs out of its budget with scenes left unprocessed', () => {
    let stats: RuntimeStats

    beforeEach(() => {
      // `update` returning false is how a SceneContext reports "I stopped, the frame is out of
      // budget" — the scheduler then returns early, leaving the remaining scenes for next frame.
      const scenes = [fakeScene({ finishes: false }), fakeScene({ finishes: true })]
      createSceneTickSystem(babylonScene, () => scenes, 100).update()
      stats = getRuntimeStats()
    })

    it('should count the overrun, which was previously a silent early return', () => {
      expect(stats.frames!.quotaOverruns).toBe(1)
    })

    it('should still count the pass itself', () => {
      // Recorded from a `finally`, so the early-return path — the one worth measuring — is not
      // the one that goes missing.
      expect(stats.frames!.count).toBe(1)
    })
  })

  describe('when a scene throws out of its update', () => {
    let stats: RuntimeStats

    beforeEach(() => {
      const throwing: any = {
        ...fakeScene({ finishes: true }),
        update: () => {
          throw new Error('malformed CRDT payload')
        }
      }
      createSceneTickSystem(babylonScene, () => [throwing], 100).update()
      stats = getRuntimeStats()
    })

    it('should still count the pass, since the throw is contained rather than fatal', () => {
      expect(stats.frames!.count).toBe(1)
    })
  })
})
