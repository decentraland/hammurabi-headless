import { AbstractMesh, Node, Scene } from '@babylonjs/core'
import { GridMaterial } from '@babylonjs/materials'
import { memoize } from '../../../misc/memoize'
import { ColliderLayer } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen'
import { BabylonEntity } from '../BabylonEntity'
import { bitIntersectsAndContainsAny } from '../../../misc/bit-operations'
import { limits } from '../../../misc/limits'
import { limitLogger } from '../../../misc/limit-logger'

export const floorMeshes: AbstractMesh[] = []

const colliderSymbol = Symbol('isCollider')

export const colliderMaterial = memoize((scene: Scene) => {
  const m = new GridMaterial('collider-material', scene)
  m.opacity = 0
  m.sideOrientation = 0
  m.disableColorWrite = true
  m.disableDepthWrite = true
  m.mainColor.set(0, 0, 0)
  m.lineColor.set(0, 1, 0)
  m.zOffset = -1
  m.fogEnabled = false
  m.depthFunction = 2
  m.gridRatio = .1
  m.freeze()

  return m
})


export function setColliderMask(mesh: AbstractMesh, layers: number) {
  (mesh as any)[colliderSymbol] = layers

  if (mesh.name.endsWith('_collider')) {
    mesh.material = colliderMaterial(mesh.getScene())
    addFloorMesh(mesh)
  }

  mesh.checkCollisions = (layers & ColliderLayer.CL_PHYSICS) != 0
  mesh.isPickable = (layers & ColliderLayer.CL_POINTER) != 0
}

export function addFloorMesh(mesh: AbstractMesh) {
  // add only when NOT already present (the previous inverted check meant no
  // collider mesh was ever added — only the ambient ground reached the list)
  const ix = floorMeshes.indexOf(mesh)
  if (ix === -1) {
    floorMeshes.push(mesh)
    // Registered on first add only: setColliderMask runs on EVERY accepted
    // GltfContainer PUT, and an unconditional addOnce there grew each mesh's
    // observer array by one closure per PUT for the mesh's lifetime.
    mesh.onDisposeObservable.addOnce(() => {
      const i = floorMeshes.indexOf(mesh)
      if (i != -1) {
        floorMeshes.splice(i, 1)
      }
    })
  }
}

export function getColliderLayers(mesh: AbstractMesh): number {
  return (mesh as any)[colliderSymbol] || 0
}

/**
 * Returns the collider meshes under `entity` whose layers intersect `mask`.
 *
 * Walks the subtree ITERATIVELY with an explicit stack, rather than through
 * Babylon's `getChildMeshes`. That helper delegates to `Node._getDescendants`
 * (node.js:487), which recurses once per level: measured against this Babylon
 * build, a parent chain is fine at depth 5000 and throws
 * `RangeError: Maximum call stack size exceeded` at 6000. Depth is entirely
 * scene-controlled — `Transform.parent` accepts any entity — and the entity cap
 * defaults to 100_000, twenty times what it takes. The throw lands in
 * `processRaycasts`, which `update-scheduler.ts` catches per scene, so it does
 * not crash the shared render loop; it does silently kill that scene's raycasts
 * on every frame while logging unthrottled. An explicit stack cannot overflow
 * regardless of depth.
 *
 * `maxColliderTreeDepth` then bounds the WORK rather than the stack. Nodes below
 * it are skipped and the drop is reported once per throttle window.
 */
export function pickMeshesForMask(entity: BabylonEntity, mask: number): Iterable<AbstractMesh> {
  if (!mask) return []

  const maxDepth = limits.maxColliderTreeDepth // HAMMURABI_MAX_COLLIDER_TREE_DEPTH
  const results: AbstractMesh[] = []
  // Pre-order depth-first, matching `_getDescendants`' ordering exactly: the
  // raycast budget iterates this list in order and charges a prefix of it, so a
  // different order would silently change which raycasts a frame can afford.
  const stack: Array<{ node: Node; depth: number }> = [{ node: entity, depth: 0 }]
  let truncated = false

  while (stack.length) {
    const { node, depth } = stack.pop()!

    // The root is the entity itself, never one of its own descendants.
    if (node !== entity && node instanceof AbstractMesh && bitIntersectsAndContainsAny(getColliderLayers(node), mask)) {
      results.push(node)
    }

    // `getChildren(_, true)` is NOT recursive — it delegates to `_getDescendants`
    // with directDescendantsOnly, which skips the recursive arm. Called once per
    // node, so the walk allocates one small array per node where Babylon's
    // recursive version allocates one in total; that is the price of the
    // unbounded depth, and it is paid once per mask per frame thanks to the
    // caller's memoization.
    const children = node.getChildren(undefined, true)
    if (!children.length) continue

    if (depth >= maxDepth) {
      truncated = true
      continue
    }

    // Pushed in reverse so the leftmost child is popped — and so visited — first.
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i], depth: depth + 1 })
    }
  }

  if (truncated) {
    limitLogger.hit('maxColliderTreeDepth', `collider subtree deeper than ${maxDepth} levels`)
  }

  return results
}