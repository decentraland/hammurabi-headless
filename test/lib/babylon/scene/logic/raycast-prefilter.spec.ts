import * as BABYLON from '@babylonjs/core'
import { AbstractMesh, Ray, Vector3, Matrix } from '@babylonjs/core'
import { ColliderLayer } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen'
import { RaycastQueryType } from '@dcl/protocol/out-js/decentraland/sdk/components/raycast.gen'
import { processRaycasts } from '../../../../../src/lib/babylon/scene/logic/raycasts'
import { setColliderMask } from '../../../../../src/lib/babylon/scene/logic/colliders'
import { limits } from '../../../../../src/lib/misc/limits'
import {
  raycastComponent,
  raycastResultComponent
} from '../../../../../src/lib/decentraland/sdk-components/raycast-component'
import { createSphereMesh, createBoxMesh } from '../../../../../src/lib/babylon/scene/logic/primitive-meshes'

// Two optimisations changed HOW the raycast reaches its answer, so the answer
// itself needs pinning against the path they replaced:
//
//  - the AABB prefilter is a length-aware slab test rather than
//    `ray.intersectsBoxMinMax`, which ignores `ray.length` entirely;
//  - RQT_HIT_FIRST visits candidates in increasing box-entry order and stops once
//    the best hit is nearer than the next box can start.
//
// Both are only sound if they never change the reported hit. This is a
// DIFFERENTIAL test: the same random arrangements are answered by processRaycasts
// and by the unoptimised `ray.intersectsMeshes(everything)` baseline, and the two
// must agree exactly. A speedup that quietly resolves a different collider is a
// correctness bug wearing a benchmark's clothes.
//
// Seeded rather than Math.random: a differential failure has to be reproducible
// from the test name alone, and a flaky arrangement would be untriageable.

const MASK = ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS

/** Deterministic LCG (Numerical Recipes constants). */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

describe('raycast prefilter and early-out', () => {
  let engine: BABYLON.NullEngine
  let scene: BABYLON.Scene

  beforeEach(() => {
    engine = new BABYLON.NullEngine()
    scene = new BABYLON.Scene(engine)
  })

  afterEach(() => {
    scene.dispose()
    engine.dispose()
  })

  function fakeScene(meshes: AbstractMesh[], queryType: RaycastQueryType, maxDistance: number, onResult: (r: any) => void) {
    const raycast = {
      queryType,
      continuous: false,
      timestamp: 0,
      collisionMask: MASK,
      direction: undefined,
      originOffset: undefined,
      maxDistance
    }
    return {
      currentTick: 0,
      entityId: 'prefilter-spec',
      rootNode: { position: Vector3.Zero(), getChildren: () => meshes },
      raycastRotationCursor: 0,
      pendingRaycastOperations: new Set([1]),
      components: {
        [raycastComponent.componentId]: { getOrNull: () => raycast },
        [raycastResultComponent.componentId]: { createOrReplace: (_id: number, value: any) => onResult(value) }
      },
      getEntityOrNull: (id: number) => ({
        entityId: id,
        appliedComponents: { raycast: { ray: new Ray(Vector3.Zero(), Vector3.Forward(), 999) } },
        getWorldMatrix: () => Matrix.Identity()
      })
    } as any
  }

  /** What the code did before the early-out: test everything, take the closest. */
  function baselineNearest(meshes: AbstractMesh[], maxDistance: number): string | undefined {
    const ray = new Ray(Vector3.Zero(), new Vector3(0, 0, 1), maxDistance || 999)
    const hits = ray.intersectsMeshes(meshes, false)
    let best: BABYLON.PickingInfo | undefined
    for (const hit of hits) if (!best || hit.distance < best.distance) best = hit
    return best?.pickedMesh?.name
  }

  describe('when many colliders are scattered around a ray', () => {
    let arrangements: Array<{ meshes: AbstractMesh[]; maxDistance: number }>

    beforeEach(() => {
      arrangements = []
      const random = seededRandom(0x5eed)
      // 25 arrangements: mixed shapes, some on the ray and some off it, some
      // straddling the requested range so the length bound genuinely bites.
      for (let a = 0; a < 25; a++) {
        const meshes: AbstractMesh[] = []
        for (let i = 0; i < 12; i++) {
          const mesh =
            random() < 0.5
              ? createSphereMesh(scene, `s_${a}_${i}_collider`)
              : createBoxMesh(scene, `b_${a}_${i}_collider`)
          // Half sit within ~0.4 of the +Z axis (so the ray can hit them), half
          // are pushed well off it.
          const offAxis = random() < 0.5
          mesh.position.set(
            offAxis ? 5 + random() * 20 : (random() - 0.5) * 0.8,
            offAxis ? 5 + random() * 20 : (random() - 0.5) * 0.8,
            random() * 60
          )
          mesh.computeWorldMatrix(true)
          setColliderMask(mesh, MASK)
          meshes.push(mesh)
        }
        arrangements.push({ meshes, maxDistance: a % 3 === 0 ? 0 : 5 + random() * 40 })
      }
    })

    it('should report exactly the collider the unoptimised path reports, for every arrangement', () => {
      const disagreements: string[] = []

      for (const { meshes, maxDistance } of arrangements) {
        let optimised: any
        processRaycasts(fakeScene(meshes, RaycastQueryType.RQT_HIT_FIRST, maxDistance, (r) => (optimised = r)))
        const expected = baselineNearest(meshes, maxDistance)
        const actual = optimised?.hits?.[0]?.meshName
        if (expected !== actual) {
          disagreements.push(`maxDistance=${maxDistance.toFixed(1)}: baseline=${expected ?? 'none'} optimised=${actual ?? 'none'}`)
        }
      }

      expect(disagreements).toEqual([])
    })

    it('should report the same hit DISTANCE as the unoptimised path', () => {
      const disagreements: string[] = []

      for (const { meshes, maxDistance } of arrangements) {
        let optimised: any
        processRaycasts(fakeScene(meshes, RaycastQueryType.RQT_HIT_FIRST, maxDistance, (r) => (optimised = r)))
        const ray = new Ray(Vector3.Zero(), new Vector3(0, 0, 1), maxDistance || 999)
        const hits = ray.intersectsMeshes(meshes, false)
        let best: BABYLON.PickingInfo | undefined
        for (const hit of hits) if (!best || hit.distance < best.distance) best = hit

        const actual = optimised?.hits?.[0]?.length
        if (best === undefined) {
          if (actual !== undefined) disagreements.push(`expected no hit, got length ${actual}`)
        } else if (actual === undefined || Math.abs(actual - best.distance) > 1e-6) {
          disagreements.push(`expected ${best.distance}, got ${actual}`)
        }
      }

      expect(disagreements).toEqual([])
    })
  })

  // The exact edge the early-out's correctness rests on, and the one the random
  // arrangements above CANNOT reach: a collider whose BOX is entered first but
  // whose SURFACE is hit later than a collider behind it. That only happens when
  // box entry and surface hit come apart, which needs a grazing angle — with
  // same-sized primitives struck near their centres the two orders coincide, so
  // the differential test passes even against an early-out that stops one
  // candidate too soon. Verified: an off-by-one break survives every random
  // arrangement and dies here.
  //
  //   grazing sphere, centre (0.3, 0, 10):  box entered at 9.5, surface hit ~9.6
  //   head-on sphere, centre (0, 0, 10.05): box entered at 9.55, surface hit 9.55
  //
  // Entry order puts the grazing sphere first, so a break-on-first-hit reports it
  // — but the head-on sphere behind it is genuinely nearer.
  describe('when the first collider by box entry is not the first by actual hit', () => {
    let reported: string | undefined
    let grazing: AbstractMesh
    let headOn: AbstractMesh

    beforeEach(() => {
      grazing = createSphereMesh(scene, 'grazing_collider')
      grazing.position.set(0.3, 0, 10)
      grazing.computeWorldMatrix(true)
      setColliderMask(grazing, MASK)

      headOn = createSphereMesh(scene, 'head_on_collider')
      headOn.position.set(0, 0, 10.05)
      headOn.computeWorldMatrix(true)
      setColliderMask(headOn, MASK)

      let result: any
      processRaycasts(fakeScene([grazing, headOn], RaycastQueryType.RQT_HIT_FIRST, 0, (r) => (result = r)))
      reported = result?.hits?.[0]?.meshName
    })

    // Guards the fixture: if a future tessellation change made the grazing sphere
    // miss, or made it the nearer hit, the case above would stop being adversarial
    // and the test would pass without testing anything.
    it('should have an arrangement where box-entry order really does disagree with hit order', () => {
      const ray = new Ray(Vector3.Zero(), new Vector3(0, 0, 1), 999)
      const grazingHit = ray.intersectsMesh(grazing, false)
      const headOnHit = ray.intersectsMesh(headOn, false)

      expect([grazingHit.hit, headOnHit.hit, headOnHit.distance < grazingHit.distance]).toEqual([true, true, true])
    })

    it('should report the genuinely nearest collider, not the first one it tested', () => {
      expect(reported).toBe('head_on_collider')
    })
  })

  // The early-out must not touch RQT_QUERY_ALL, which needs every crossing.
  describe('when an RQT_QUERY_ALL ray crosses several colliders', () => {
    let hits: any[]

    beforeEach(() => {
      const meshes: AbstractMesh[] = []
      for (let i = 0; i < 5; i++) {
        const mesh = createBoxMesh(scene, `q_${i}_collider`)
        mesh.position.set(0, 0, 10 + i * 5)
        mesh.computeWorldMatrix(true)
        setColliderMask(mesh, MASK)
        meshes.push(mesh)
      }
      let result: any
      processRaycasts(fakeScene(meshes, RaycastQueryType.RQT_QUERY_ALL, 0, (r) => (result = r)))
      hits = result.hits
    })

    it('should still report every crossing rather than stopping at the nearest', () => {
      expect(hits).toHaveLength(5)
    })
  })

  describe('when the requested range stops short of every collider', () => {
    let hits: any[]
    let processedSecond: boolean

    beforeEach(() => {
      const meshes: AbstractMesh[] = []
      // 200 spheres starting at z=100, far beyond the 5-metre range below.
      for (let i = 0; i < 200; i++) {
        const mesh = createSphereMesh(scene, `f_${i}_collider`)
        mesh.position.set(0, 0, 100 + i * 2)
        mesh.computeWorldMatrix(true)
        setColliderMask(mesh, MASK)
        meshes.push(mesh)
      }

      // 200 spheres is 259_200 triangles. With the ceiling left at its default
      // (600_000) but the BUDGET shared across two raycasts, a length-ignoring
      // prefilter charges the first raycast 259_200 and the second is deferred;
      // a length-aware one charges ~0 and both run in the same frame. That is an
      // observable difference — unlike the hit list, which is empty either way.
      const scene2 = fakeScene(meshes, RaycastQueryType.RQT_HIT_FIRST, 5, (r) => (hits = r.hits))
      scene2.pendingRaycastOperations = new Set([1, 2])
      const restore = limits.maxRaycastTrianglesPerFrame
      limits.maxRaycastTrianglesPerFrame = 300_000 // room for one charged raycast, not two
      try {
        const seen: number[] = []
        scene2.components[raycastResultComponent.componentId] = {
          createOrReplace: (id: number, value: any) => {
            seen.push(id)
            hits = value.hits
          }
        }
        processRaycasts(scene2)
        processedSecond = seen.length === 2
      } finally {
        limits.maxRaycastTrianglesPerFrame = restore
      }
    })

    it('should report no hit, since every collider is past the requested range', () => {
      expect(hits).toEqual([])
    })

    // The assertion that the range actually saved the work. Charged for the
    // out-of-range spheres, the first raycast would eat 259_200 of the 300_000
    // budget and the second would be deferred to the next frame.
    it('should leave the frame enough budget for a second raycast', () => {
      expect(processedSecond).toBe(true)
    })
  })
})
