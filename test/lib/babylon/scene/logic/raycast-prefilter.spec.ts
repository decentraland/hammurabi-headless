import * as BABYLON from '@babylonjs/core'
import { AbstractMesh, Quaternion, Ray, Vector3, Matrix } from '@babylonjs/core'
import { ColliderLayer } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen'
import { RaycastQueryType } from '@dcl/protocol/out-js/decentraland/sdk/components/raycast.gen'
import { processRaycasts } from '../../../../../src/lib/babylon/scene/logic/raycasts'
import { setColliderMask } from '../../../../../src/lib/babylon/scene/logic/colliders'
import { limits } from '../../../../../src/lib/misc/limits'
import {
  raycastComponent,
  raycastResultComponent
} from '../../../../../src/lib/decentraland/sdk-components/raycast-component'
import { createSphereMesh, createBoxMesh, PRIMITIVE_SPHERE_RADIUS } from '../../../../../src/lib/babylon/scene/logic/primitive-meshes'
import { setAnalyticSphere } from '../../../../../src/lib/babylon/scene/logic/analytic-colliders'

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

  function fakeScene(
    meshes: AbstractMesh[],
    queryType: RaycastQueryType,
    maxDistance: number,
    onResult: (r: any) => void,
    globalDirection: Vector3 = new Vector3(0, 0, 1)
  ) {
    const raycast = {
      queryType,
      continuous: false,
      timestamp: 0,
      collisionMask: MASK,
      direction: { $case: 'globalDirection', globalDirection },
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
        getWorldMatrix: () => Matrix.Identity(),
        absolutePosition: Vector3.Zero(),
        absoluteRotationQuaternion: Quaternion.Identity()
      })
    } as any
  }

  /** What the code did before the early-out: test everything, take the closest. */
  function baselineNearest(meshes: AbstractMesh[], maxDistance: number): string | undefined {
    const ray = new Ray(Vector3.Zero(), new Vector3(0, 0, 1), maxDistance)
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
        arrangements.push({ meshes, maxDistance: a % 3 === 0 ? 999 : 5 + random() * 40 })
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
        const ray = new Ray(Vector3.Zero(), new Vector3(0, 0, 1), maxDistance)
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
      processRaycasts(fakeScene([grazing, headOn], RaycastQueryType.RQT_HIT_FIRST, 999, (r) => (result = r)))
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
      processRaycasts(fakeScene(meshes, RaycastQueryType.RQT_QUERY_ALL, 999, (r) => (result = r)))
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

  // Every raycast fixture in this repo fired along +Z, so the slab test's three
  // `if (near > far) swap` blocks — one per axis — had never executed once. They are
  // reached only by a NEGATIVE direction component, which is what makes the near plane
  // divide to a larger value than the far one, and a ray pointing down -X, -Y or -Z is
  // completely ordinary scene code.
  //
  // Without the swap the axis it applies to yields `tmin > tmax` and `rayBoxEntry`
  // returns -1, so the collider is not even a candidate: every negative-direction
  // raycast in the scene silently reports nothing.
  //
  // One case per axis, because a single diagonal ray would pass with two of the three
  // blocks broken.
  describe.each([
    ['-X', new Vector3(-1, 0, 0), new Vector3(-5, 0, 0), new Vector3(5, 0, 0)],
    ['-Y', new Vector3(0, -1, 0), new Vector3(0, -5, 0), new Vector3(0, 5, 0)],
    ['-Z', new Vector3(0, 0, -1), new Vector3(0, 0, -5), new Vector3(0, 0, 5)]
  ])('when the ray travels along %s', (_axis, direction, ahead, behind) => {
    let hits: any[]
    let behindHits: any[]

    beforeEach(() => {
      const inFront = createBoxMesh(scene, 'ahead_collider')
      inFront.position.copyFrom(ahead)
      inFront.computeWorldMatrix(true)
      setColliderMask(inFront, MASK)

      hits = []
      processRaycasts(fakeScene([inFront], RaycastQueryType.RQT_HIT_FIRST, 50, (r) => (hits = r.hits), direction))

      // Control: the same collider on the OPPOSITE side must stay unreachable, so a
      // swap that merely admits everything cannot pass either.
      const back = createBoxMesh(scene, 'behind_collider')
      back.position.copyFrom(behind)
      back.computeWorldMatrix(true)
      setColliderMask(back, MASK)

      behindHits = []
      processRaycasts(
        fakeScene([back], RaycastQueryType.RQT_HIT_FIRST, 50, (r) => (behindHits = r.hits), direction)
      )
    })

    it('should hit a collider that lies along it', () => {
      expect(hits).toHaveLength(1)
    })

    it('should report the distance to its near face', () => {
      expect(hits[0].length).toBeCloseTo(4.5, 5)
    })

    it('should not hit a collider behind the origin', () => {
      expect(behindHits).toHaveLength(0)
    })
  })

  // The triangle budget exempts a candidate that will be solved in CLOSED FORM, and
  // for a while it granted that exemption for merely being TAGGED as a sphere. But
  // `intersectAnalyticSphere` bails on non-uniform scale — an ellipsoid is not that
  // equation — and the caller then walks all 1296 triangles, so `scale: (1, 2, 1)` on a
  // SphereMesh collider was billed 12 for work costing 1296. A 108x undercount reachable
  // from one line of scene code; at the ceilings, 50_000 of them bill exactly the budget
  // and all run in a single ~2.4s frame with both ceilings reporting themselves happy.
  //
  // Observable through the budget: a ceiling of 100 triangles admits a correctly-billed
  // uniform sphere (12) and refuses a correctly-billed non-uniform one (1296).
  describe('when a sphere collider is scaled non-uniformly, so it cannot be solved analytically', () => {
    let uniformHits: any[]
    let nonUniformHits: any[]

    beforeEach(() => {
      const restore = limits.maxRaycastTrianglesPerFrame
      limits.maxRaycastTrianglesPerFrame = 100

      try {
        const answer = (scaling: Vector3): any[] => {
          const sphere = createSphereMesh(scene, 'ball_collider')
          sphere.position.set(0, 0, 5)
          sphere.scaling.copyFrom(scaling)
          sphere.computeWorldMatrix(true)
          setColliderMask(sphere, MASK)
          setAnalyticSphere(sphere, PRIMITIVE_SPHERE_RADIUS)

          let hits: any[] = []
          processRaycasts(fakeScene([sphere], RaycastQueryType.RQT_HIT_FIRST, 50, (r) => (hits = r.hits)))
          sphere.dispose()
          return hits
        }

        uniformHits = answer(new Vector3(1, 1, 1))
        nonUniformHits = answer(new Vector3(1, 2, 1))
      } finally {
        limits.maxRaycastTrianglesPerFrame = restore
      }
    })

    it('should still answer the uniform sphere, which really is billed twelve', () => {
      expect(uniformHits).toHaveLength(1)
    })

    it('should refuse the non-uniform one, because it is billed the triangles it will walk', () => {
      expect(nonUniformHits).toHaveLength(0)
    })
  })

  // Every comparison against NaN is false, so a NaN AABB never assigned into
  // tmin/tmax and `rayBoxEntry` returned 0 — "the ray origin is already inside this
  // box" — for a box that does not exist. It admitted 300/300 unreachable colliders in
  // one measurement, defeating the maxDistance prefilter and letting one cheap
  // arrangement make every ray in the scene maximally expensive. Transforms are raw
  // readFloat32 with no finiteness validation, so a scene can send this.
  //
  // Observable through the budget again: the box alone is billed 12 and fits in a
  // ceiling of 100, but admitting the unreachable sphere adds 1296 and the whole
  // raycast is refused.
  describe('when a collider carries a NaN transform', () => {
    let hits: any[]

    beforeEach(() => {
      const restore = limits.maxRaycastTrianglesPerFrame
      limits.maxRaycastTrianglesPerFrame = 100

      try {
        const box = createBoxMesh(scene, 'real_collider')
        box.position.set(0, 0, 5)
        box.computeWorldMatrix(true)
        setColliderMask(box, MASK)

        const ghost = createSphereMesh(scene, 'ghost_collider')
        ghost.position.set(NaN, NaN, NaN)
        ghost.computeWorldMatrix(true)
        setColliderMask(ghost, MASK)

        hits = []
        processRaycasts(fakeScene([box, ghost], RaycastQueryType.RQT_HIT_FIRST, 50, (r) => (hits = r.hits)))
      } finally {
        limits.maxRaycastTrianglesPerFrame = restore
      }
    })

    it('should not admit it as a candidate, so the real collider is still answered', () => {
      expect(hits).toHaveLength(1)
    })
  })
})
