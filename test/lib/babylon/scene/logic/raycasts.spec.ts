import * as BABYLON from '@babylonjs/core'
import { Ray, Vector3, Matrix } from '@babylonjs/core'
import { RaycastQueryType } from '@dcl/protocol/out-js/decentraland/sdk/components/raycast.gen'
import { processRaycasts } from '../../../../../src/lib/babylon/scene/logic/raycasts'
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
    sphereOffAxis = BABYLON.MeshBuilder.CreateSphere('far_collider', { diameter: 1, segments: 16 }, scene)
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

  it('processes only as many raycasts as the 50k budget allows and leaves the rest pending', () => {
    // 30k meshes per raycast against a 50k budget: raycast #1 spends 30k (20k
    // left), #2 spends another 30k (budget goes negative), #3+ hit the guard and
    // stay pending for a later frame.
    // PLANES (2 triangles each), so 30k meshes is 60k triangles and the triangle
    // ceiling stays far out of the way — this test is about the MESH ceiling, and
    // with boxes the triangle ceiling would bind first and mask it.
    const meshes = new Array(30_000).fill(plane)
    const pending = new Set<number>([1, 2, 3, 4, 5])
    const processed: number[] = []

    processRaycasts(makeFakeScene(pending, meshes, undefined, (id) => processed.push(id)))

    // Exactly two raycasts fit in the budget this frame...
    expect(processed).toEqual([1, 2])
    // ...and the remaining one-shot raycasts are left pending (not silently dropped).
    expect(Array.from(pending).sort()).toEqual([3, 4, 5])
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
    // 100 planes = 200 triangles total; neither ceiling should bite, so every
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
