import * as BABYLON from '@babylonjs/core'
import { Quaternion, Ray, Vector3, Matrix } from '@babylonjs/core'
import { RaycastQueryType } from '@dcl/protocol/out-js/decentraland/sdk/components/raycast.gen'
import { processRaycasts } from '../../../../../src/lib/babylon/scene/logic/raycasts'
import { limits } from '../../../../../src/lib/misc/limits'
import { raycastComponent, raycastResultComponent } from '../../../../../src/lib/decentraland/sdk-components/raycast-component'
import { setColliderMask } from '../../../../../src/lib/babylon/scene/logic/colliders'
import { setAnalyticSphere } from '../../../../../src/lib/babylon/scene/logic/analytic-colliders'
import { PRIMITIVE_SPHERE_RADIUS } from '../../../../../src/lib/babylon/scene/logic/primitive-meshes'

// processRaycasts discovers the meshes to test against via
// pickMeshesForMask(scene.rootNode, mask), which walks the subtree from
// rootNode.getChildren. A fake rootNode whose getChildren returns a
// controllably-large array lets us exhaust the per-frame intersection budget with
// a single real mesh repeated, without building tens of thousands of distinct
// meshes (and without mocking the real pickMeshesForMask, so both its per-mask
// memoization and its real layer predicate are exercised).
//
// The repeated meshes are tagged with every collider layer so they match whatever
// collisionMask a case uses. That tagging is load-bearing now: the walk applies
// the real `bitIntersectsAndContainsAny` predicate itself, where the previous
// `getChildMeshes` stub returned its array without consulting a predicate at all
// — so an untagged mesh yields zero candidates and every "no hits" assertion here
// would pass for the wrong reason.
const ALL_COLLIDER_LAYERS = 0xffffffff
describe('when a scene queues raycasts whose total intersection cost exceeds the per-frame budget', () => {
  let engine: BABYLON.NullEngine
  let scene: BABYLON.Scene
  let box: BABYLON.Mesh
  let sphere: BABYLON.Mesh
  let plane: BABYLON.Mesh
  let sphereOffAxis: BABYLON.Mesh
  let nearCollider: BABYLON.Mesh
  let farCollider: BABYLON.Mesh
  let analyticSphere: BABYLON.Mesh

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

    // Tagged analytic, exactly as mesh-collider-component does for a SphereMesh.
    analyticSphere = BABYLON.MeshBuilder.CreateSphere('analytic_collider', { diameter: 1, segments: 16 }, scene)
    analyticSphere.position.set(0, 0, 50)
    analyticSphere.computeWorldMatrix(true)
    setAnalyticSphere(analyticSphere, PRIMITIVE_SPHERE_RADIUS)

    for (const mesh of [box, sphere, plane, sphereOffAxis, nearCollider, farCollider, analyticSphere]) {
      setColliderMask(mesh, ALL_COLLIDER_LAYERS)
    }
  })

  afterAll(() => {
    scene.dispose()
    engine.dispose()
  })

  function makeFakeScene(pending: Set<number>, meshes: BABYLON.AbstractMesh[], mask: number | undefined, onResult: (id: number) => void) {
    const raycastValue = {
      queryType: RaycastQueryType.RQT_HIT_FIRST,
      maxDistance: 999,
      continuous: false, // one-shot: only removed from the set after it actually runs
      timestamp: 0,
      collisionMask: mask,
      direction: { $case: 'globalDirection', globalDirection: new Vector3(0, 0, 1) },
      originOffset: undefined
    }
    // The walk starts here and applies the real layer predicate to each child; the
    // meshes are tagged with every layer in beforeAll so they match any mask.
    const rootNode = { position: Vector3.Zero(), getChildren: () => meshes }
    return {
      currentTick: 0,
      rootNode,
      raycastRotationCursor: 0,
      pendingRaycastOperations: pending,
      components: {
        [raycastComponent.componentId]: { getOrNull: () => raycastValue },
        [raycastResultComponent.componentId]: { createOrReplace: (id: number) => onResult(id) }
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

      // QUERY_ALL, because that is the query the AGGREGATE rule still governs. HIT_FIRST
      // now spends incrementally in box-entry order and stops as soon as the nearest hit
      // is proven, so it is deliberately not refused for the total cost of a set it never
      // has to finish. The COST MODEL under test here is charged identically either way.
      const fake = makeFakeSceneCapturing(pending, meshes, undefined, (r) => results.push(r))
      fake.components[raycastComponent.componentId].getOrNull().queryType = RaycastQueryType.RQT_QUERY_ALL
      processRaycasts(fake)

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

      // QUERY_ALL, because that is the query the AGGREGATE rule still governs. HIT_FIRST
      // now spends incrementally in box-entry order and stops as soon as the nearest hit
      // is proven, so it is deliberately not refused for the total cost of a set it never
      // has to finish. The COST MODEL under test here is charged identically either way.
      const fake = makeFakeSceneCapturing(pending, meshes, undefined, (r) => results.push(r))
      fake.components[raycastComponent.componentId].getOrNull().queryType = RaycastQueryType.RQT_QUERY_ALL
      processRaycasts(fake)

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
      setColliderMask(unindexedCollider, ALL_COLLIDER_LAYERS)
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

      // QUERY_ALL, because that is the query the AGGREGATE rule still governs. HIT_FIRST
      // now spends incrementally in box-entry order and stops as soon as the nearest hit
      // is proven, so it is deliberately not refused for the total cost of a set it never
      // has to finish. The COST MODEL under test here is charged identically either way.
      const fake = makeFakeSceneCapturing(pending, meshes, undefined, (r) => results.push(r))
      fake.components[raycastComponent.componentId].getOrNull().queryType = RaycastQueryType.RQT_QUERY_ALL
      processRaycasts(fake)

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
        // Answers with whichever mesh list the entity under test was given; the
        // real layer predicate then runs against the all-layers tag.
        getChildren: () => currentMeshes
      },
      raycastRotationCursor: 0,
      pendingRaycastOperations: pending,
      components: {
        [raycastComponent.componentId]: {
          getOrNull: (id: number) => {
            currentMeshes = byEntity[id]?.meshes ?? []
            return {
              queryType: RaycastQueryType.RQT_HIT_FIRST,
              maxDistance: 999,
              continuous: byEntity[id]?.continuous ?? false,
              timestamp: 0,
              collisionMask: maskFor(id),
              direction: { $case: 'globalDirection', globalDirection: new Vector3(0, 0, 1) },
              originOffset: undefined
            }
          }
        },
        [raycastResultComponent.componentId]: { createOrReplace: (id: number) => onResult(id) }
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
    //
    // RQT_QUERY_ALL, deliberately. Under RQT_HIT_FIRST the nearest-first early-out
    // tests one sphere and refunds the other 399, so the budget is barely touched
    // and all three raycasts fit — correct behaviour, but it measures the refund
    // rather than the ceiling. QUERY_ALL genuinely needs every candidate, so the
    // full cost is charged and the ceiling is what stops the frame.
    const spheres = new Array(400).fill(sphere)
    const pending = new Set<number>([1, 2, 3])
    const processed: number[] = []
    const fake = makeFakeScene(pending, spheres, undefined, (id) => processed.push(id))
    fake.components[raycastComponent.componentId].getOrNull().queryType = RaycastQueryType.RQT_QUERY_ALL

    processRaycasts(fake)

    expect(processed).toEqual([1])
    // The rest stay pending rather than being dropped, same as the mesh-budget path.
    expect(Array.from(pending).sort()).toEqual([2, 3])
  })

  // The other half of the same knob: what the early-out refund buys. Same 400
  // spheres, same budget, but RQT_HIT_FIRST — the nearest hit settles on the first
  // sphere tested and every remaining candidate starts further away than that hit,
  // so none of them can beat it and none is tested.
  describe('when RQT_HIT_FIRST raycasts share a frame with the triangle ceiling', () => {
    let processed: number[]
    let pending: Set<number>

    beforeEach(() => {
      processed = []
      pending = new Set<number>([1, 2, 3])
      processRaycasts(makeFakeScene(pending, new Array(400).fill(sphere), undefined, (id) => processed.push(id)))
    })

    // Charged conservatively up front (518_400 each, so only one would fit) and
    // refunded after, which is what lets the second and third run at all.
    it('should fit all three in one frame rather than billing them for untested candidates', () => {
      expect(processed).toEqual([1, 2, 3])
    })

    it('should leave nothing pending, since every one-shot actually ran', () => {
      expect(Array.from(pending)).toEqual([])
    })
  })

  // HIT_FIRST spends its triangle budget INCREMENTALLY, in box-entry order, and stops the
  // moment the nearest hit is proven. So a set whose TOTAL cost outruns a frame is not
  // refused when the answer was settled long before that total mattered — which is what
  // the aggregate check used to do, reporting nothing where the client reports the near
  // hit.
  it('answers the nearest hit even when the whole candidate set could not be afforded', () => {
    // 600 spheres on the ray = 777_600 triangles, past the 600k frame budget — but the
    // first one tested proves the answer, so only 1296 of it is ever spent.
    const spheres = new Array(600).fill(sphere)
    const pending = new Set<number>([1])
    const results: any[] = []

    processRaycasts(makeFakeSceneCapturing(pending, spheres, undefined, (r) => results.push(r)))

    expect(results[0]?.hits).toHaveLength(1)
  })

  // The other half: when proving the nearest hit genuinely cannot fit in a frame, the
  // raycast must still reach a DECISION. Deferring would starve it forever while the
  // scene keeps it queued, and reporting the candidates tested so far would look
  // authoritative while a nearer surface went untested.
  describe('when one collider alone costs more than a whole frame', () => {
    let pending: Set<number>
    let results: any[]
    let restore: number

    beforeEach(() => {
      restore = limits.maxRaycastTrianglesPerFrame
      // Below a single sphere's 1296, so the very first candidate is unaffordable and no
      // later frame can do better either.
      limits.maxRaycastTrianglesPerFrame = 100
      pending = new Set<number>([1])
      results = []
      processRaycasts(makeFakeSceneCapturing(pending, [sphere], undefined, (r) => results.push(r)))
    })

    afterEach(() => {
      limits.maxRaycastTrianglesPerFrame = restore
    })

    it('should answer it explicitly rather than deferring it forever', () => {
      expect(Array.from(pending)).toEqual([])
    })

    it('should report no hits rather than a hit from a set it could not finish', () => {
      expect(results[0]?.hits).toEqual([])
    })
  })

  // What it spends must come OFF the frame's budget, or HIT_FIRST raycasts stop sharing a
  // frame with each other and only the mesh ceiling bounds how many run.
  //
  // Uses the same entered-but-missed arrangement, because a raycast that proves its hit
  // immediately spends almost nothing and cannot demonstrate the budget at all.
  describe('when one HIT_FIRST raycast has already spent most of the frame budget', () => {
    let pending: Set<number>
    let restore: number
    let grazed: BABYLON.Mesh

    beforeEach(() => {
      restore = limits.maxRaycastTrianglesPerFrame
      // Room for two candidates (2 x 1296 = 2592) and not four.
      limits.maxRaycastTrianglesPerFrame = 4000

      grazed = BABYLON.MeshBuilder.CreateSphere('shared_budget_collider', { diameter: 1, segments: 16 }, scene)
      grazed.position.set(0.49, 0, 10)
      grazed.computeWorldMatrix(true)
      setColliderMask(grazed, ALL_COLLIDER_LAYERS)

      pending = new Set<number>([1, 2])
      const fake = makeFakeScene(pending, [grazed, grazed], undefined, () => undefined)
      fake.components[raycastComponent.componentId].getOrNull().maxDistance = 9.6
      processRaycasts(fake)
    })

    afterEach(() => {
      limits.maxRaycastTrianglesPerFrame = restore
      grazed.dispose()
    })

    it('should defer the second rather than letting both run unbudgeted', () => {
      expect(Array.from(pending)).toEqual([2])
    })
  })

  // Exhaustion is measured CUMULATIVELY against the frame ceiling, not per candidate.
  // What decides "no later frame can do better" is whether proving the hit needs more
  // than a whole frame in total — comparing one mesh instead makes an unaffordable set
  // DEFER forever, which is the starvation the aggregate rule used to prevent.
  //
  // Needs candidates that are ENTERED but MISSED, or the early-out ends the walk on the
  // first hit and nothing accumulates. A sphere offset 0.49 from the ray has its box
  // entered at 9.5 and its surface at 9.90, so a range of 9.6 admits it and then rejects
  // the hit.
  describe('when many candidates are tested without any of them proving a hit', () => {
    let pending: Set<number>
    let results: any[]
    let grazed: BABYLON.Mesh

    beforeEach(() => {
      grazed = BABYLON.MeshBuilder.CreateSphere('grazed_collider', { diameter: 1, segments: 16 }, scene)
      grazed.position.set(0.49, 0, 10)
      grazed.computeWorldMatrix(true)
      setColliderMask(grazed, ALL_COLLIDER_LAYERS)

      pending = new Set<number>([1])
      results = []
      // 600 x 1296 = 777_600, past the 600k ceiling; one alone is 1296, far under it.
      const fake = makeFakeSceneCapturing(pending, new Array(600).fill(grazed), undefined, (r) => results.push(r))
      fake.components[raycastComponent.componentId].getOrNull().maxDistance = 9.6
      processRaycasts(fake)
    })

    afterEach(() => {
      grazed.dispose()
    })

    it('should reach a decision rather than deferring forever', () => {
      expect(Array.from(pending)).toEqual([])
    })

    it('should report no hits', () => {
      expect(results[0]?.hits).toEqual([])
    })
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

  // The mesh ceiling bounds how many colliders are TESTED, not how many hits come
  // back. Measured before this cap existed: 300 colliders on one ray produced 304
  // full RaycastHit entries in a single result, re-serialized into the scene's CRDT
  // stream on every frame a continuous raycast runs.
  describe('when one RQT_QUERY_ALL raycast crosses more colliders than the hit cap allows', () => {
    let restore: number
    let results: any[]

    beforeEach(() => {
      restore = limits.maxRaycastHitsPerQuery
      limits.maxRaycastHitsPerQuery = 3
      results = []

      // Six real colliders the ray crosses, deliberately fed FAR-first so a cap
      // that kept an arbitrary prefix would keep the wrong ones.
      const crossed = [farCollider, nearCollider, farCollider, nearCollider, farCollider, nearCollider]
      const fake = makeFakeSceneCapturing(new Set<number>([1]), crossed, undefined, (r) => results.push(r))
      fake.components[raycastComponent.componentId].getOrNull().queryType = RaycastQueryType.RQT_QUERY_ALL

      processRaycasts(fake)
    })

    afterEach(() => {
      limits.maxRaycastHitsPerQuery = restore
    })

    it('should return no more hits than the cap', () => {
      expect(results[0].hits).toHaveLength(3)
    })

    // Nearest-first, not an arbitrary prefix: the hit a scene is most likely to act
    // on is the closest one, and dropping it while keeping three behind it would be
    // worse than returning nothing.
    it('should keep the nearest hits rather than whichever were tested first', () => {
      expect(results[0].hits.map((hit: any) => hit.meshName)).toEqual([
        'near_collider',
        'near_collider',
        'near_collider'
      ])
    })
  })

  // Babylon's `intersectsMeshes` ends with `results.sort(this._comparePickingInfo)`.
  // The analytic-sphere round replaced that call with a hand-rolled loop, which dropped
  // the sort — so QUERY_ALL hits arrived in scene-tree pre-order and a scene reading
  // `hits[0]` as "the nearest" silently got an arbitrary one. It also feeds the
  // nearest-first truncation, which would otherwise keep the FARTHEST hits.
  describe('when an RQT_QUERY_ALL raycast is fed candidates farthest-first', () => {
    let lengths: number[]

    beforeEach(() => {
      const results: any[] = []
      const fake = makeFakeSceneCapturing(new Set<number>([1]), [farCollider, nearCollider], undefined, (r) =>
        results.push(r)
      )
      fake.components[raycastComponent.componentId].getOrNull().queryType = RaycastQueryType.RQT_QUERY_ALL

      processRaycasts(fake)
      lengths = results[0].hits.map((hit: any) => hit.length)
    })

    it('should report the hits nearest-first regardless of candidate order', () => {
      expect(lengths).toEqual([...lengths].sort((a, b) => a - b))
    })

    it('should put the nearest collider first', () => {
      expect(lengths[0]).toBeCloseTo(19.5, 1)
    })
  })

  // An analytic sphere never touches a triangle, so billing it the tessellated 1296
  // made a raycast crossing 463+ of them exceed the whole per-frame ceiling and be
  // answered with an EMPTY result — permanently, since that branch does not defer —
  // for work measured at under 2ms. Billed at the floor, the same as a box.
  describe('when a raycast crosses far more analytic spheres than the tessellated ceiling allowed', () => {
    let results: any[]

    beforeEach(() => {
      results = []
      // 500 > 600_000/1296 = 463, the old refusal threshold.
      const spheres = new Array(500).fill(analyticSphere)
      processRaycasts(makeFakeSceneCapturing(new Set<number>([1]), spheres, undefined, (r) => results.push(r)))
    })

    it('should still report the hit rather than refusing the raycast', () => {
      expect(results[0].hits).toHaveLength(1)
    })
  })

  describe('when an RQT_QUERY_ALL raycast crosses fewer colliders than the cap', () => {
    let results: any[]

    beforeEach(() => {
      results = []
      const fake = makeFakeSceneCapturing(new Set<number>([1]), [farCollider, nearCollider], undefined, (r) =>
        results.push(r)
      )
      fake.components[raycastComponent.componentId].getOrNull().queryType = RaycastQueryType.RQT_QUERY_ALL

      processRaycasts(fake)
    })

    // The cap must not reorder or drop anything on the ordinary path — the sort only
    // runs when the cap is actually exceeded.
    it('should return every hit untouched', () => {
      expect(results[0].hits.map((hit: any) => hit.meshName).sort()).toEqual(['far_collider', 'near_collider'])
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
    // rootNode subtree walk happens once for the shared mask, not per raycast.
    const meshes = [box]
    const pending = new Set<number>([1, 2, 3])
    const rootNode = { position: Vector3.Zero(), getChildren: jest.fn(() => meshes) }
    const raycastValue = {
      queryType: RaycastQueryType.RQT_HIT_FIRST,
      maxDistance: 999,
      continuous: false,
      timestamp: 0,
      collisionMask: 5, // all three share one mask
      direction: { $case: 'globalDirection', globalDirection: new Vector3(0, 0, 1) },
      originOffset: undefined
    }
    const fakeScene: any = {
      currentTick: 0,
      rootNode,
      raycastRotationCursor: 0,
      pendingRaycastOperations: pending,
      components: {
        [raycastComponent.componentId]: { getOrNull: () => raycastValue },
        [raycastResultComponent.componentId]: { createOrReplace: () => void 0 }
      },
      getEntityOrNull: (id: number) => ({
        entityId: id,
        appliedComponents: { raycast: { ray: new Ray(Vector3.Zero(), Vector3.Forward(), 999) } },
        getWorldMatrix: () => Matrix.Identity(),
        absolutePosition: Vector3.Zero(),
        absoluteRotationQuaternion: Quaternion.Identity()
      })
    }

    processRaycasts(fakeScene)

    expect(rootNode.getChildren).toHaveBeenCalledTimes(1)
  })

  // The budget resets every frame and a Set iterates in insertion order, so a
  // head-first sweep hands the whole budget to the same prefix forever. Measured
  // before the cursor existed: three identical CONTINUOUS raycasts against a
  // budget fitting one, and raycasts 2 and 3 produced no result at all across 20
  // frames — permanently silent, not merely delayed.
  describe('when more continuous raycasts are queued than one frame can afford', () => {
    let restore: number
    let processed: number[][]

    beforeEach(() => {
      restore = limits.maxRaycastIntersectionsPerFrame
      // Each raycast costs 30_000; only one fits per frame.
      limits.maxRaycastIntersectionsPerFrame = 50_000
      processed = []

      const meshes = new Array(30_000).fill(plane)
      const pending = new Set<number>([1, 2, 3])
      const scene = makeFakeScene(pending, meshes, undefined, () => undefined)
      scene.components[raycastComponent.componentId] = {
        getOrNull: () => ({
          queryType: RaycastQueryType.RQT_HIT_FIRST,
          maxDistance: 999,
          continuous: true, // stays pending, so the same set is re-swept each frame
          timestamp: 0,
          collisionMask: undefined,
          direction: { $case: 'globalDirection', globalDirection: new Vector3(0, 0, 1) },
          originOffset: undefined
        })
      }

      for (let frame = 0; frame < 3; frame++) {
        const thisFrame: number[] = []
        scene.components[raycastResultComponent.componentId] = {
          createOrReplace: (id: number) => thisFrame.push(id)
        }
        processRaycasts(scene)
        processed.push(thisFrame)
      }
    })

    afterEach(() => {
      limits.maxRaycastIntersectionsPerFrame = restore
    })

    it('should give each queued raycast a turn instead of replaying the same prefix', () => {
      expect(processed).toEqual([[1], [2], [3]])
    })

    it('should leave every raycast still pending, since all three are continuous', () => {
      expect(processed.flat().sort()).toEqual([1, 2, 3])
    })
  })

  // A scene whose raycasts all fit in one frame must keep its old, stable
  // insertion-ordered behaviour: the cursor lands back where it started.
  describe('when every queued raycast fits within one frame', () => {
    let processed: number[][]

    beforeEach(() => {
      processed = []
      const meshes = [plane]
      const pending = new Set<number>([1, 2, 3])
      const scene = makeFakeScene(pending, meshes, undefined, () => undefined)
      scene.components[raycastComponent.componentId] = {
        getOrNull: () => ({
          queryType: RaycastQueryType.RQT_HIT_FIRST,
          maxDistance: 999,
          continuous: true,
          timestamp: 0,
          collisionMask: undefined,
          direction: { $case: 'globalDirection', globalDirection: new Vector3(0, 0, 1) },
          originOffset: undefined
        })
      }

      for (let frame = 0; frame < 2; frame++) {
        const thisFrame: number[] = []
        scene.components[raycastResultComponent.componentId] = {
          createOrReplace: (id: number) => thisFrame.push(id)
        }
        processRaycasts(scene)
        processed.push(thisFrame)
      }
    })

    it('should process them in insertion order every frame, not rotate them', () => {
      expect(processed).toEqual([
        [1, 2, 3],
        [1, 2, 3]
      ])
    })
  })
})
