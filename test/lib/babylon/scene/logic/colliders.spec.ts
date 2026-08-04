import * as BABYLON from '@babylonjs/core'
import { ColliderLayer } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen'
import { pickMeshesForMask, setColliderMask } from '../../../../../src/lib/babylon/scene/logic/colliders'
import { limits } from '../../../../../src/lib/misc/limits'

// pickMeshesForMask used to delegate to Babylon's `getChildMeshes`, which walks the
// subtree through `Node._getDescendants` — one stack frame per level. Measured
// against this Babylon build, a parent chain resolves fine at depth 5000 and throws
// `RangeError: Maximum call stack size exceeded` at 6000. Depth is entirely
// scene-controlled (Transform.parent takes any entity) and the entity cap defaults
// to 100_000, so a scene has twenty times the budget it needs to trigger it.
//
// The throw surfaces inside processRaycasts, which update-scheduler.ts catches per
// scene — so it does not crash the shared render loop, it just kills that scene's
// raycasts on every frame while logging unthrottled.
//
// TWO mechanisms now stand between a scene and that: the walk is iterative, so no
// depth can overflow the stack at all, and `maxColliderTreeDepth` bounds the work.
// At default settings the CAP is what a deep scene meets first (1024 is well below
// the ~5000 the stack allows), so the raised-cap case below is what actually
// exercises the iterative walk. Both are tested because an operator can raise the
// knob, at which point only the iterative walk is holding the line.

const MASK = ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS

describe('pickMeshesForMask', () => {
  let engine: BABYLON.NullEngine
  let scene: BABYLON.Scene
  let root: BABYLON.TransformNode

  beforeEach(() => {
    engine = new BABYLON.NullEngine()
    scene = new BABYLON.Scene(engine)
    root = new BABYLON.TransformNode('root', scene)
  })

  afterEach(() => {
    scene.dispose()
    engine.dispose()
  })

  /** Chains `depth` transform nodes under root and hangs one tagged collider off the end. */
  function buildChain(depth: number): BABYLON.Mesh {
    let current: BABYLON.TransformNode = root
    for (let i = 0; i < depth; i++) {
      const link = new BABYLON.TransformNode(`link_${i}`, scene)
      link.parent = current
      current = link
    }
    const leaf = BABYLON.MeshBuilder.CreateBox('deep_collider', { size: 1 }, scene)
    leaf.parent = current
    setColliderMask(leaf, MASK)
    return leaf
  }

  describe('when the collider subtree is deeper than the configured ceiling', () => {
    let found: BABYLON.AbstractMesh[]

    beforeEach(() => {
      buildChain(limits.maxColliderTreeDepth + 50)
      found = Array.from(pickMeshesForMask(root as any, MASK))
    })

    it('should return without throwing rather than overflowing the stack', () => {
      expect(Array.isArray(found)).toBe(true)
    })

    it('should drop the colliders below the ceiling instead of walking them', () => {
      expect(found).toHaveLength(0)
    })
  })

  // The case that would RangeError under the old recursive walk. Only reachable
  // once the depth knob is raised past it, which is exactly why the knob and the
  // iterative walk are separate defences rather than one.
  describe('when the ceiling is raised past the depth at which recursion overflows', () => {
    let restore: number
    let leaf: BABYLON.Mesh
    let found: BABYLON.AbstractMesh[]

    beforeEach(() => {
      restore = limits.maxColliderTreeDepth
      limits.maxColliderTreeDepth = 20_000
      leaf = buildChain(8_000)
      found = Array.from(pickMeshesForMask(root as any, MASK))
    })

    afterEach(() => {
      limits.maxColliderTreeDepth = restore
    })

    it('should still find the collider 8000 levels down', () => {
      expect(found.map((mesh) => mesh.uniqueId)).toEqual([leaf.uniqueId])
    })
  })

  describe('when the subtree is shallow', () => {
    let matching: BABYLON.Mesh
    let wrongLayer: BABYLON.Mesh
    let untagged: BABYLON.Mesh

    beforeEach(() => {
      matching = BABYLON.MeshBuilder.CreateBox('matching_collider', { size: 1 }, scene)
      matching.parent = root
      setColliderMask(matching, ColliderLayer.CL_POINTER)

      wrongLayer = BABYLON.MeshBuilder.CreateBox('wrong_layer_collider', { size: 1 }, scene)
      wrongLayer.parent = root
      setColliderMask(wrongLayer, ColliderLayer.CL_CUSTOM1)

      // Never passed through setColliderMask, so it carries no layer tag at all.
      untagged = BABYLON.MeshBuilder.CreateBox('untagged', { size: 1 }, scene)
      untagged.parent = root
    })

    it('should return the collider whose layers intersect the mask', () => {
      expect(Array.from(pickMeshesForMask(root as any, ColliderLayer.CL_POINTER)).map((m) => m.name)).toEqual([
        'matching_collider'
      ])
    })

    it('should exclude a collider on a layer the mask does not name', () => {
      expect(
        Array.from(pickMeshesForMask(root as any, ColliderLayer.CL_POINTER)).map((m) => m.uniqueId)
      ).not.toContain(wrongLayer.uniqueId)
    })

    it('should exclude an untagged mesh', () => {
      expect(
        Array.from(pickMeshesForMask(root as any, ColliderLayer.CL_POINTER)).map((m) => m.uniqueId)
      ).not.toContain(untagged.uniqueId)
    })

    // An empty mask means "collide with nothing"; walking the subtree to discover
    // that is pure waste on every raycast that uses one.
    //
    // Asserted on the WALK, not the result: `bitIntersectsAndContainsAny(layers, 0)`
    // is false for every mesh, so deleting the short-circuit returns an empty array
    // anyway and a result-only assertion cannot tell the two apart. Verified by
    // mutation — this is the assertion that fails when the guard is removed.
    it('should short-circuit on an empty mask without walking the subtree at all', () => {
      const walk = jest.spyOn(root, 'getChildren')

      pickMeshesForMask(root as any, 0)

      expect(walk).not.toHaveBeenCalled()
      walk.mockRestore()
    })
  })

  // The raycast budget charges a PREFIX of this list, so the order it comes back in
  // decides which raycasts a frame can afford. The iterative walk has to reproduce
  // `_getDescendants`' pre-order exactly, not merely return the same set.
  describe('when the subtree branches', () => {
    let expectedOrder: string[]

    beforeEach(() => {
      // root -> a -> (a1, a2), and root -> b declared after a. Pre-order descends
      // into a's children BEFORE reaching b, which is what distinguishes it from a
      // breadth-first walk returning the same set.
      const a = BABYLON.MeshBuilder.CreateBox('a_collider', { size: 1 }, scene)
      a.parent = root
      const a1 = BABYLON.MeshBuilder.CreateBox('a1_collider', { size: 1 }, scene)
      a1.parent = a
      const a2 = BABYLON.MeshBuilder.CreateBox('a2_collider', { size: 1 }, scene)
      a2.parent = a
      const b = BABYLON.MeshBuilder.CreateBox('b_collider', { size: 1 }, scene)
      b.parent = root

      for (const mesh of [a, a1, a2, b]) setColliderMask(mesh, MASK)
      expectedOrder = ['a_collider', 'a1_collider', 'a2_collider', 'b_collider']
    })

    it('should return the meshes in pre-order depth first, matching the walk it replaced', () => {
      expect(Array.from(pickMeshesForMask(root as any, MASK)).map((mesh) => mesh.name)).toEqual(expectedOrder)
    })
  })
})
