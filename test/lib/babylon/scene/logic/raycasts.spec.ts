import * as BABYLON from '@babylonjs/core'
import { Ray, Vector3, Matrix } from '@babylonjs/core'
import { RaycastQueryType } from '@dcl/protocol/out-js/decentraland/sdk/components/raycast.gen'
import { processRaycasts } from '../../../../../src/lib/babylon/scene/logic/raycasts'
import { limits } from '../../../../../src/lib/misc/limits'
import { raycastComponent, raycastResultComponent } from '../../../../../src/lib/decentraland/sdk-components/raycast-component'

// processRaycasts discovers the meshes to test against via
// pickMeshesForMask(scene.rootNode, mask), which calls rootNode.getChildMeshes.
// A fake rootNode whose getChildMeshes returns a controllably-large array lets us
// exhaust the per-frame intersection budget with a single real mesh repeated,
// without building tens of thousands of distinct meshes (and without mocking the
// real pickMeshesForMask, so its per-mask memoization is exercised for real).
describe('when a scene queues raycasts whose total intersection cost exceeds the per-frame budget', () => {
  let engine: BABYLON.NullEngine
  let scene: BABYLON.Scene
  let box: BABYLON.Mesh
  let sphere: BABYLON.Mesh
  let plane: BABYLON.Mesh
  let sphereOffAxis: BABYLON.Mesh
  let nearCollider: BABYLON.Mesh
  let farCollider: BABYLON.Mesh

  beforeAll(() => {
    engine = new BABYLON.NullEngine()
    scene = new BABYLON.Scene(engine)
    // Real meshes in front of the origin; the fake rootNode repeats one of them so
    // ray.intersectsMeshes runs against real geometry (fake objects would throw).
    // Built at the same tessellation the collider components pin, so the triangle
    // costs here are the ones a real scene produces: box 12, sphere 1296, plane 2.
    box = BABYLON.MeshBuilder.CreateBox('collider', {}, scene)
    box.position.set(0, 0, 50)
    box.computeWorldMatrix(true)
    sphere = BABYLON.MeshBuilder.CreateSphere('sphere_collider', { diameter: 1, segments: 16 }, scene)
    sphere.position.set(0, 0, 50)
    sphere.computeWorldMatrix(true)
    plane = BABYLON.MeshBuilder.CreatePlane('plane_collider', { width: 1, height: 1 }, scene)
    plane.position.set(0, 0, 50)
    plane.computeWorldMatrix(true)
    // Far off the ray's path: its bounding box is never entered, so it must cost
    // the triangle budget nothing however many times it is repeated.
    // Two boxes on the ray at different distances, for the nearest-hit tests.
    nearCollider = BABYLON.MeshBuilder.CreateBox('near_collider', { size: 1 }, scene)
    nearCollider.position.set(0, 0, 20)
    nearCollider.computeWorldMatrix(true)
    farCollider = BABYLON.MeshBuilder.CreateBox('far_collider', { size: 1 }, scene)
    farCollider.position.set(0, 0, 80)
    farCollider.computeWorldMatrix(true)
    sphereOffAxis = BABYLON.MeshBuilder.CreateSphere('far_offaxis_collider', { diameter: 1, segments: 16 }, scene)
    sphereOffAxis.position.set(5000, 0, 50)
    sphereOffAxis.computeWorldMatrix(true)
  })

  afterAll(() => {
    scene.dispose()
    engine.dispose()
  })

  function makeFakeScene(pending: Set<number>, meshes: BABYLON.AbstractMesh[], mask: number | undefined, onResult: (id: number) => void) {
    const raycastValue = {
      queryType: RaycastQueryType.RQT_HIT_FIRST,
      continuous: false, // one-shot: only removed from the set after it actually runs
      timestamp: 0,
      collisionMask: mask,
      direction: undefined,
      originOffset: undefined
    }
    // getChildMeshes(descendants, predicate) — ignore the predicate and return the
    // full array; the collider-layer filtering is not what this test exercises.
    const rootNode = { position: Vector3.Zero(), getChildMeshes: () => meshes }
    return {
      currentTick: 0,
      rootNode,
      pendingRaycastOperations: pending,
      components: {
        [raycastComponent.componentId]: { getOrNull: () => raycastValue },
        [raycastResultComponent.componentId]: { createOrReplace: (id: number) => onResult(id) }
      },
      getEntityOrNull: (id: number) => ({
        entityId: id,
        appliedComponents: { raycast: { ray: new Ray(Vector3.Zero(), Vector3.Forward(), 999) } },
        getWorldMatrix: () => Matrix.Identity()
      })
    } as any
  }

  // Same fake scene, but hands the RaycastResult VALUE to the callback rather than
  // just the entity id, so a test can assert what the scene was actually told.
  function makeFakeSceneCapturing(
    pending: Set<number>,
    meshes: BABYLON.AbstractMesh[],
    mask: number | undefined,
    onResult: (result: any) => void
  ) {
    const scene = makeFakeScene(pending, meshes, mask, () => undefined)
    scene.entityId = 'scene-under-test'
    scene.components[raycastResultComponent.componentId] = {
      createOrReplace: (_id: number, value: any) => onResult(value)
    }
    return scene
  }

  // At DEFAULT knobs the two ceilings coincide for cheap shapes: every candidate is
  // billed at least TRIANGLE_COST_FLOOR (12) triangles, and the triangle default is
  // exactly 50_000 x 12, so N > 50_000 trips both at once. The mesh ceiling is only
  // separately observable when an operator tunes them apart — which they can, the
  // knobs are independent — so these two cases re-import the module with a generous
  // triangle ceiling to isolate it. `limits` is a singleton read at import, hence
  // `limits` is a plain object read once at import, so a test can override a field
  // and put it back — no module reload needed.
  describe('when the triangle ceiling is tuned far above the mesh ceiling', () => {
    let restore: number

    beforeEach(() => {
      // Assign the knob directly. This used to `jest.resetModules()` + re-`require`
      // the module, which also loaded a second @babylonjs/core and a second
      // `logic/colliders` whose fresh `Symbol('isCollider')` makes
      // `getColliderLayers` return 0 for every already-tagged mesh — so a test
      // using the REAL mask predicate would see zero candidates and its "no hits"
      // assertion would pass for the wrong reason. processRaycasts reads `limits`
      // per call, so this is enough.
      restore = limits.maxRaycastTrianglesPerFrame
      limits.maxRaycastTrianglesPerFrame = 100_000_000
    })

    afterEach(() => {
      limits.maxRaycastTrianglesPerFrame = restore
    })

    it('should defer a raycast that does not fit the remaining mesh ceiling', () => {
      const meshes = new Array(30_000).fill(plane)
      const pending = new Set<number>([1, 2, 3])
      const processed: number[] = []

      processRaycasts(makeFakeScene(pending, meshes, undefined, (id) => processed.push(id)))

      // 30k spends the budget down to 20k; the second needs 30k, so it waits.
      expect(processed).toEqual([1])
    })

    it('should charge the mesh budget for a raycast it refused, so the frame stays bounded', () => {
      // #1 is past the ceiling and skips its scan — but getting there already walked
      // the subtree and swept every world matrix for its mask. Uncharged, a scene
      // could queue many of those and repeat that work every frame for free.
      const processed: number[] = []
      const pending = new Set<number>([1, 2])

      processRaycasts(
        makeFakeSceneWithPerEntityMeshes(
          pending,
          { 1: { meshes: new Array(60_000).fill(plane) }, 2: { meshes: [plane] } },
          (id) => processed.push(id)
        )
      )

      // #1 answers (empty) and spends the budget; #2 finds none left.
      expect(processed).toEqual([1])
    })

    it('should keep a CONTINUOUS raycast pending after refusing it on the mesh ceiling', () => {
      const pending = new Set<number>([1])

      processRaycasts(
        makeFakeSceneWithPerEntityMeshes(
          pending,
          { 1: { meshes: new Array(60_000).fill(plane), continuous: true } },
          () => undefined
        )
      )

      // Removing it here retired it permanently: nothing re-arms a continuous
      // raycast except the scene re-PUTting the component.
      expect(Array.from(pending)).toEqual([1])
    })

    it('should answer a raycast past the whole mesh ceiling with an empty result', () => {
      const meshes = new Array(60_000).fill(plane)
      const pending = new Set<number>([1])
      const results: any[] = []

      processRaycasts(makeFakeSceneCapturing(pending, meshes, undefined, (r) => results.push(r)))

      expect(results[0]?.hits).toEqual([])
      expect(Array.from(pending)).toEqual([])
    })
  })

  // Mirror image of the block above: raise the MESH ceiling so only the triangle
  // ceiling can bind, which is the only way to observe the per-candidate cost FLOOR.
  // Without it a plane bills its 2 real triangles and 60k planes look like 120k
  // triangles — a fifth of the budget — when they in fact cost about what 60k boxes
  // cost, because `Ray.intersectsMesh` pays a fixed per-mesh price (matrix invert,
  // ray transform, PickingInfo, _generatePointsArray) before any triangle is touched.
  describe('when the mesh ceiling is tuned far above the triangle ceiling', () => {
    let restore: number

    beforeEach(() => {
      restore = limits.maxRaycastIntersectionsPerFrame
      limits.maxRaycastIntersectionsPerFrame = 10_000_000
    })

    afterEach(() => {
      limits.maxRaycastIntersectionsPerFrame = restore
    })

    it('should bill a cheap collider at the box floor rather than its two triangles', () => {
      // 60k planes: 720k at the floor (over the 600k ceiling), but only 120k if each
      // is billed its real triangle count — in which case this raycast would run and
      // report a hit instead of being refused.
      const meshes = new Array(60_000).fill(plane)
      const pending = new Set<number>([1])
      const results: any[] = []

      processRaycasts(makeFakeSceneCapturing(pending, meshes, undefined, (r) => results.push(r)))

      expect(results[0]?.hits).toEqual([])
    })
  })

  // glTF lets a primitive omit `indices`; Babylon's glTF 2.0 loader answers that with
  // `babylonMesh.isUnIndexed = true` and no index buffer, so `getTotalIndices()` is 0
  // while the geometry is whole. Such a mesh IS ray-tested — `SubMesh.intersects`
  // routes `!indices.length && _mesh._unIndexed` to `_intersectUnIndexedTriangles`,
  // which walks `verticesStart .. verticesStart + verticesCount` in steps of 3 — so
  // costing it off its index count bills the 12-triangle floor for a mesh that tests
  // `vertices / 3` triangles on EVERY ray, and 50k of them (the whole mesh ceiling)
  // came to exactly the triangle ceiling and ran in a single frame.
  describe('and a candidate collider is authored without an index buffer', () => {
    // 300 copies x 2001 triangles = 600_300, just past the 600_000 triangle ceiling,
    // while 300 candidates is 0.6% of the 50k mesh ceiling — so only the triangle
    // ceiling can be what refuses the raycast below. Billed off `getTotalIndices()`
    // the same set is 300 x 12 = 3_600, and the raycast runs and hits instead.
    const UNINDEXED_TRIANGLES = 2_001
    const UNINDEXED_COPIES = 300
    let unindexedCollider: BABYLON.Mesh

    beforeEach(() => {
      // Built the way the glTF loader builds an index-less primitive: `isUnIndexed`
      // set, positions applied through a Geometry, no index buffer. Every triangle
      // spans the ray's path so none of them is prefiltered away.
      unindexedCollider = new BABYLON.Mesh('unindexed_collider', scene)
      unindexedCollider.isUnIndexed = true
      const positions = new Float32Array(UNINDEXED_TRIANGLES * 9)
      for (let t = 0; t < UNINDEXED_TRIANGLES; t++) {
        const o = t * 9
        positions[o + 0] = -2; positions[o + 1] = -2; positions[o + 2] = 50
        positions[o + 3] = 2; positions[o + 4] = -2; positions[o + 5] = 50
        positions[o + 6] = 0; positions[o + 7] = 2; positions[o + 8] = 50
      }
      const geometry = new BABYLON.Geometry('unindexed_collider_geometry', scene)
      geometry.setVerticesData(BABYLON.VertexBuffer.PositionKind, positions, false)
      geometry.applyToMesh(unindexedCollider)
      unindexedCollider.computeWorldMatrix(true)
    })

    afterEach(() => {
      unindexedCollider.dispose()
    })

    it('should report a hit against it rather than dropping it from the candidate set', () => {
      const pending = new Set<number>([1])
      const results: any[] = []

      processRaycasts(makeFakeSceneCapturing(pending, [unindexedCollider], undefined, (r) => results.push(r)))

      // Naming the mesh is what distinguishes "the un-indexed collider was tested and
      // hit" from "something produced a result": excluding un-indexed meshes as
      // uncostable would answer this raycast with an empty hit list.
      expect(results[0]?.hits.map((hit: any) => hit.meshName)).toEqual(['unindexed_collider'])
    })

    it('should cost it from its vertices, refusing a raycast its index count would have let through', () => {
      const meshes = new Array(UNINDEXED_COPIES).fill(unindexedCollider)
      const pending = new Set<number>([1])
      const results: any[] = []

      processRaycasts(makeFakeSceneCapturing(pending, meshes, undefined, (r) => results.push(r)))

      expect(results[0]?.hits).toEqual([])
    })

    it('should keep a CONTINUOUS over-ceiling raycast pending so it can recover', () => {
      const meshes = new Array(UNINDEXED_COPIES).fill(unindexedCollider)
      const pending = new Set<number>([1])
      const fakeScene = makeFakeSceneCapturing(pending, meshes, undefined, () => undefined)
      fakeScene.components[raycastComponent.componentId].getOrNull().continuous = true

      processRaycasts(fakeScene)

      // Over-budget is not a death sentence for a continuous raycast: the collider
      // set can shrink later, and nothing re-arms it except the scene re-PUTting the
      // component, which a scene has no reason to do. Dropping it here retired it
      // permanently after one empty result.
      expect(Array.from(pending)).toEqual([1])
    })

    it('should still remove a ONE-SHOT over-ceiling raycast', () => {
      const meshes = new Array(UNINDEXED_COPIES).fill(unindexedCollider)
      const pending = new Set<number>([1])
      const fakeScene = makeFakeSceneCapturing(pending, meshes, undefined, () => undefined)

      processRaycasts(fakeScene)

      // A one-shot is answered once and retired, over budget or not.
      expect(Array.from(pending)).toEqual([])
    })
  })

  // Per-entity candidate lists. The shared fake above hands every raycast the same
  // meshes, which cannot express "raycast 1 is over the ceiling and raycast 2 is
  // cheap" — the case needed to observe whether an over-ceiling raycast CHARGED the
  // budget it skipped.
  function makeFakeSceneWithPerEntityMeshes(
    pending: Set<number>,
    byEntity: Record<number, { meshes: BABYLON.AbstractMesh[]; continuous?: boolean }>,
    onResult: (id: number) => void
  ) {
    // A distinct mask per entity so meshesForMask cannot share one memoized list.
    const maskFor = (id: number) => id
    return {
      currentTick: 0,
      entityId: 'per-entity',
      rootNode: {
        position: Vector3.Zero(),
        // pickMeshesForMask filters by collider layer; the fake ignores the predicate
        // and answers from the mask it was given.
        getChildMeshes: (_d: boolean, predicate: any) => {
          const probe = { __mask: 0 } as any
          void predicate
          void probe
          return currentMeshes
        }
      },
      pendingRaycastOperations: pending,
      components: {
        [raycastComponent.componentId]: {
          getOrNull: (id: number) => {
            currentMeshes = byEntity[id]?.meshes ?? []
            return {
              queryType: RaycastQueryType.RQT_HIT_FIRST,
              continuous: byEntity[id]?.continuous ?? false,
              timestamp: 0,
              collisionMask: maskFor(id),
              direction: undefined,
              originOffset: undefined
            }
          }
        },
        [raycastResultComponent.componentId]: { createOrReplace: (id: number) => onResult(id) }
      },
      getEntityOrNull: (id: number) => ({
        entityId: id,
        appliedComponents: { raycast: { ray: new Ray(Vector3.Zero(), Vector3.Forward(), 999) } },
        getWorldMatrix: () => Matrix.Identity()
      })
    } as any
  }
  let currentMeshes: BABYLON.AbstractMesh[] = []

  // NOTE: there are deliberately no default-knob tests for the MESH ceiling here.
  // One used to sit beside this and was deleted: it claimed 30k planes are 60k
  // triangles, but every candidate is billed at least TRIANGLE_COST_FLOOR (12), so
  // it was 360k and tripped the TRIANGLE guards while being named for the mesh one.
  //
  // The test below is NOT in that category, despite the same arithmetic caveat
  // (60k planes bill 720k, over both ceilings). Removing the mesh guard makes an
  // over-ceiling raycast defer forever instead of answering, which it detects —
  // verified by mutation. Which ceiling REFUSED is still ambiguous here, so the
  // knob-separated coverage below is what pins the mesh ceiling specifically.
  it('answers a raycast over the whole mesh ceiling with an empty result', () => {
    const meshes = new Array(60_000).fill(plane)
    const pending = new Set<number>([1])
    const results: any[] = []

    processRaycasts(makeFakeSceneCapturing(pending, meshes, undefined, (r) => results.push(r)))

    expect(Array.from(pending)).toEqual([])
    expect(results[0]?.hits).toEqual([])
  })

  // The mesh ceiling assumes every mesh costs about the same, which held while every
  // primitive collider was a 12-triangle box. A sphere collider is 1296 triangles, so
  // a mesh count far INSIDE the 50k mesh budget can still be orders of magnitude more
  // triangle work than that budget was tuned for. The triangle ceiling is what bounds
  // it; without it these raycasts all run in one frame.
  it('stops on the triangle budget while the mesh budget still has room', () => {
    // 400 spheres = 518_400 triangles: one raycast fits inside the 600k triangle
    // budget, two do not — so the ceiling binds BETWEEN raycasts (the deferral
    // path, not the over-budget path below). 400 meshes is under 1% of the 50k
    // mesh budget, so only the triangle ceiling can be what stops this.
    const spheres = new Array(400).fill(sphere)
    const pending = new Set<number>([1, 2, 3])
    const processed: number[] = []

    processRaycasts(makeFakeScene(pending, spheres, undefined, (id) => processed.push(id)))

    expect(processed).toEqual([1])
    // The rest stay pending rather than being dropped, same as the mesh-budget path.
    expect(Array.from(pending).sort()).toEqual([2, 3])
  })

  // A raycast whose own candidate set outruns a whole frame's budget can never fit
  // on any frame. Leaving it pending would starve it forever while the scene keeps
  // re-queueing it, and truncating its mesh set would resolve the wrong nearest hit
  // while looking authoritative — so it is answered explicitly and dropped.
  it('answers an over-budget raycast with an empty result instead of stalling or starving it', () => {
    // 600 spheres on the ray = 777_600 triangles, past the 600k frame budget.
    const spheres = new Array(600).fill(sphere)
    const pending = new Set<number>([1])
    const results: any[] = []

    processRaycasts(makeFakeSceneCapturing(pending, spheres, undefined, (r) => results.push(r)))

    // It ran to a decision this frame rather than being deferred...
    expect(Array.from(pending)).toEqual([])
    // ...and reported no hits rather than a hit computed from a partial set.
    expect(results[0]?.hits).toEqual([])
  })

  // The prefilter is what keeps the budget proportional to work actually done:
  // Babylon rejects a mesh whose bounding box the ray misses before touching a
  // triangle, so charging every candidate's triangles would bill a scene for
  // colliders its ray never approaches.
  // Every other test in this file resolves at most ONE hit, so the whole result
  // envelope is unexercised: RQT_QUERY_ALL never runs, and pickClosest cannot be
  // told apart from "take the first" or "take the last". Two colliders at different
  // distances, fed FAR-FIRST so ordering is not accidentally satisfied by input
  // order, is what separates them.
  describe('when two colliders lie on the ray at different distances', () => {
    let farFirst: BABYLON.AbstractMesh[]

    beforeEach(() => {
      farFirst = [farCollider, nearCollider]
    })

    it('should report only the nearest hit for RQT_HIT_FIRST', () => {
      const results: any[] = []
      processRaycasts(makeFakeSceneCapturing(new Set<number>([1]), farFirst, undefined, (r) => results.push(r)))

      expect(results[0].hits.map((hit: any) => hit.meshName)).toEqual(['near_collider'])
    })

    it('should report every hit for RQT_QUERY_ALL', () => {
      const results: any[] = []
      const fake = makeFakeSceneCapturing(new Set<number>([1]), farFirst, undefined, (r) => results.push(r))
      fake.components[raycastComponent.componentId].getOrNull().queryType = RaycastQueryType.RQT_QUERY_ALL

      processRaycasts(fake)

      expect(results[0].hits.map((hit: any) => hit.meshName).sort()).toEqual(['far_collider', 'near_collider'])
    })

    // NOTE for anyone mutation-testing this file: replacing `pickClosest(results)`
    // with `results[0]` is an EQUIVALENT mutant, not a gap. Babylon's
    // `intersectsMeshes` ends with `results.sort(this._comparePickingInfo)`, so the
    // nearest hit is always index 0 whatever order the candidates were fed in
    // (verified: input [far, near] returns [near@19.5, far@79.5]). `pickClosest`
    // is defensive, and no input can distinguish the two.
    it('should report the nearest hit distance, not the first tested', () => {
      const results: any[] = []
      processRaycasts(makeFakeSceneCapturing(new Set<number>([1]), farFirst, undefined, (r) => results.push(r)))

      // near_collider sits at z=20 with a 0.5 half-extent.
      expect(results[0].hits[0].length).toBeCloseTo(19.5, 1)
    })
  })

  it('does not charge triangles for colliders the ray never approaches', () => {
    // 2000 spheres parked off the ray's path (2.59M triangles, four times the whole
    // frame budget) plus ONE on the path. Asserting a real HIT is what makes this
    // test able to fail: charging every candidate rather than the bounding-box
    // survivors would push this raycast over the frame budget, and it would then be
    // answered with an EMPTY result — which a test that only checked "it produced a
    // result" cannot tell apart from success.
    const meshes = [...new Array(2000).fill(sphereOffAxis), sphere]
    const pending = new Set<number>([1])
    const results: any[] = []

    processRaycasts(makeFakeSceneCapturing(pending, meshes, undefined, (r) => results.push(r)))

    expect(results[0]?.hits?.length).toBe(1)
  })

  it('leaves a cheap scene unaffected by the triangle budget', () => {
    // 100 planes bill 100 x TRIANGLE_COST_FLOOR = 1200, not their 200 real
    // triangles — the charged cost is never the raw triangle count, which is the
    // whole reason the floor exists. Either way both ceilings have room, so every
    // queued raycast resolves in the same frame.
    const planes = new Array(100).fill(plane)
    const pending = new Set<number>([1, 2, 3, 4, 5])
    const processed: number[] = []

    processRaycasts(makeFakeScene(pending, planes, undefined, (id) => processed.push(id)))

    expect(processed).toEqual([1, 2, 3, 4, 5])
  })

  it('walks the mesh list once per collision mask instead of once per raycast', () => {
    // Small mesh count so the budget is never hit; assert the (real, expensive)
    // rootNode.getChildMeshes walk happens once for the shared mask, not per raycast.
    const meshes = [box]
    const pending = new Set<number>([1, 2, 3])
    const rootNode = { position: Vector3.Zero(), getChildMeshes: jest.fn(() => meshes) }
    const raycastValue = {
      queryType: RaycastQueryType.RQT_HIT_FIRST,
      continuous: false,
      timestamp: 0,
      collisionMask: 5, // all three share one mask
      direction: undefined,
      originOffset: undefined
    }
    const fakeScene: any = {
      currentTick: 0,
      rootNode,
      pendingRaycastOperations: pending,
      components: {
        [raycastComponent.componentId]: { getOrNull: () => raycastValue },
        [raycastResultComponent.componentId]: { createOrReplace: () => void 0 }
      },
      getEntityOrNull: (id: number) => ({
        entityId: id,
        appliedComponents: { raycast: { ray: new Ray(Vector3.Zero(), Vector3.Forward(), 999) } },
        getWorldMatrix: () => Matrix.Identity()
      })
    }

    processRaycasts(fakeScene)

    expect(rootNode.getChildMeshes).toHaveBeenCalledTimes(1)
  })
})
