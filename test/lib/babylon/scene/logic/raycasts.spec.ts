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

  beforeAll(() => {
    engine = new BABYLON.NullEngine()
    scene = new BABYLON.Scene(engine)
    // Real meshes in front of the origin; the fake rootNode repeats one of them so
    // ray.intersectsMeshes runs against real geometry (fake objects would throw).
    // Built at the same tessellation the collider components pin, so the triangle
    // costs here are the ones a real scene produces: box 12, sphere 1296, plane 2.
    box = BABYLON.MeshBuilder.CreateBox('collider', {}, scene)
    box.position.set(0, 0, 50)
    sphere = BABYLON.MeshBuilder.CreateSphere('sphere_collider', { diameter: 1, segments: 16 }, scene)
    sphere.position.set(0, 0, 50)
    plane = BABYLON.MeshBuilder.CreatePlane('plane_collider', { width: 1, height: 1 }, scene)
    plane.position.set(0, 0, 50)
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

  it('processes only as many raycasts as the 50k budget allows and leaves the rest pending', () => {
    // 30k meshes per raycast against a 50k budget: raycast #1 spends 30k (20k
    // left), #2 spends another 30k (budget goes negative), #3+ hit the guard and
    // stay pending for a later frame.
    const meshes = new Array(30_000).fill(box)
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
    // 1000 spheres = 1.296M triangles, so ONE raycast exhausts the 600k triangle
    // budget outright, while 1000 meshes is 2% of the 50k mesh budget.
    const spheres = new Array(1000).fill(sphere)
    const pending = new Set<number>([1, 2, 3])
    const processed: number[] = []

    processRaycasts(makeFakeScene(pending, spheres, undefined, (id) => processed.push(id)))

    expect(processed).toEqual([1])
    // The rest stay pending rather than being dropped, same as the mesh-budget path.
    expect(Array.from(pending).sort()).toEqual([2, 3])
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
