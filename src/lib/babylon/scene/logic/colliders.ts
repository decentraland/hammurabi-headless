import { AbstractMesh, Node, Scene } from '@babylonjs/core'
import { GridMaterial } from '@babylonjs/materials'
import { memoize } from '../../../misc/memoize'
import { ColliderLayer } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen'
import { BabylonEntity } from '../BabylonEntity'
import { bitIntersectsAndContainsAny } from '../../../misc/bit-operations'
import { limits } from '../../../misc/limits'
import { limitLogger } from '../../../misc/limit-logger'

/**
 * Ground-detection candidates.
 *
 * A `Set`, not an array. Membership was tested with `indexOf` on both add and dispose,
 * which is O(n) per operation and so O(n^2) over a scene — and this stopped being
 * theoretical when every primitive collider gained a `_collider` name: on `main` only
 * the box shape reached here, now sphere, plane and cylinder do too. Measured at 50_000
 * colliders: 464ms to register them and 1955ms to dispose them, the latter inside
 * `SceneContext.dispose()`, which has no frame quota and runs on hot reload, comms loss
 * and SIGTERM. With a Set both are O(1) and the cost disappears.
 */
export const floorMeshes = new Set<AbstractMesh>()

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


/**
 * How many live colliders carry each of the 32 collider-layer bits.
 *
 * Exists so a raycast can answer "no collider anywhere uses any of these bits" WITHOUT
 * walking the scene. `processRaycasts` caches its candidate list per collision mask, and
 * the mask is scene-controlled: a scene issuing many continuous raycasts on distinct
 * masks that match nothing forced one full subtree walk per mask per frame, charged
 * nothing, because the budget is taken from the MATCHED list and that list is empty.
 * Measured at 500 raycasts over 10_000 colliders: 91.98ms/frame against 0.55ms when the
 * masks were shared.
 *
 * REFCOUNTS rather than a running OR, because a monotonic union is a bypass: 32 colliders
 * created and disposed one per bit would leave every bit set forever and the check would
 * never fire again.
 */
const layerColliderCounts = new Int32Array(32)
let layerUnionCache = 0

function applyLayerDelta(layers: number, delta: number) {
  for (let bit = 0; bit < 32; bit++) {
    if ((layers >>> bit) & 1) layerColliderCounts[bit] += delta
  }
  let union = 0
  for (let bit = 0; bit < 32; bit++) {
    if (layerColliderCounts[bit] > 0) union |= 1 << bit
  }
  layerUnionCache = union
}

/**
 * The OR of every layer bit carried by at least one LIVE collider.
 *
 * `(mask & colliderLayerUnion()) === 0` means no collider can match that mask, so the
 * walk can be skipped entirely and the result answered empty — identical output, none
 * of the work. It also canonicalizes the per-mask cache: for any collider,
 * `layers & mask === layers & (mask & union)` because every collider's layers are a
 * subset of the union, so two masks agreeing on the union bits select the same meshes
 * and must share one cache entry.
 */
/** Marks that this mesh already carries the shared collider dispose hook. */
const disposeHookSymbol = Symbol('colliderDisposeHook')

/**
 * Registers, at most once per mesh, the single teardown hook this module needs: retire
 * the mesh's layer bits from the union refcount and drop it from `floorMeshes`.
 *
 * ONE hook, not one per concern. `setColliderMask` runs on EVERY accepted PUT and
 * `addFloorMesh` is reached from it, so an unguarded `addOnce` in either grows the
 * mesh's observer array by a closure per PUT for the mesh's lifetime — the leak the
 * previous `floorMeshes` guard existed to prevent, which the union refcount would
 * otherwise have reintroduced alongside it.
 */
function registerDisposeHook(mesh: AbstractMesh) {
  if ((mesh as any)[disposeHookSymbol]) return
  ;(mesh as any)[disposeHookSymbol] = true

  mesh.onDisposeObservable.addOnce(() => {
    const last: number | undefined = (mesh as any)[colliderSymbol]
    if (last !== undefined) applyLayerDelta(last, -1)
    floorMeshes.delete(mesh)
  })
}

export function colliderLayerUnion(): number {
  return layerUnionCache
}

export function setColliderMask(mesh: AbstractMesh, layers: number) {
  // Re-masking is ordinary: setColliderMask runs on every accepted PUT. Retire the
  // previous contribution before counting the new one, and register the dispose hook
  // only on the FIRST mask so the observer list does not grow one closure per PUT.
  const previous: number | undefined = (mesh as any)[colliderSymbol]
  if (previous !== undefined) applyLayerDelta(previous, -1)
  applyLayerDelta(layers, +1)
  registerDisposeHook(mesh)

  ;(mesh as any)[colliderSymbol] = layers

  if (mesh.name.endsWith('_collider')) {
    mesh.material = colliderMaterial(mesh.getScene())
    addFloorMesh(mesh)
  }

  mesh.checkCollisions = (layers & ColliderLayer.CL_PHYSICS) != 0
  mesh.isPickable = (layers & ColliderLayer.CL_POINTER) != 0
}

export function addFloorMesh(mesh: AbstractMesh) {
  // No "already present?" guard: `Set.add` is idempotent and `registerDisposeHook` is
  // guarded by its own symbol, so an early return here is unreachable code — verified by
  // mutation, deleting it changed no test. (It was load-bearing when `floorMeshes` was an
  // ARRAY and the dispose hook was registered right here; both of those are gone. The
  // check before that was inverted, which meant no collider mesh was ever added at all
  // and only the ambient ground reached the list.)
  floorMeshes.add(mesh)
  registerDisposeHook(mesh)
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
/**
 * Work allowance for a single walk, mutated in place so a caller can spend ONE budget
 * across several walks.
 *
 * `remainingVisits` bounds BREADTH, which `maxColliderTreeDepth` does not: a scene can
 * park the entity ceiling's worth of nodes at depth 1. `maxResults` bounds what is
 * MATERIALIZED, so a caller that is going to refuse an over-ceiling set never builds it.
 */
export type ColliderWalkBudget = {
  remainingVisits: number
  maxResults: number
  /** Which allowance ran out, so the caller logs the ceiling that actually stopped it. */
  truncatedBy: 'visits' | 'results' | null
}

export function pickMeshesForMask(
  entity: BabylonEntity,
  mask: number,
  budget?: ColliderWalkBudget
): Iterable<AbstractMesh> {
  if (!mask) return []

  const maxDepth = limits.maxColliderTreeDepth // HAMMURABI_MAX_COLLIDER_TREE_DEPTH
  const results: AbstractMesh[] = []
  // Pre-order depth-first, matching `_getDescendants`' ordering exactly: the
  // raycast budget iterates this list in order and charges a prefix of it, so a
  // different order would silently change which raycasts a frame can afford.
  //
  // Two PARALLEL arrays rather than a stack of `{node, depth}`: this runs over
  // every collider in the scene, and one object literal per node measured as real
  // time at the ceiling (50_000 colliders).
  const stackNodes: Node[] = [entity]
  const stackDepths: number[] = [0]
  let truncated = false

  while (stackNodes.length) {
    // Charged per node VISITED, before any work on it. The caller is about to refuse or
    // defer anything past its allowance, so continuing to walk is pure waste — and it is
    // waste a scene controls, since both the tree and the number of distinct masks that
    // trigger a walk are scene-authored.
    if (budget) {
      if (budget.remainingVisits <= 0) {
        budget.truncatedBy = 'visits'
        break
      }
      budget.remainingVisits--
    }

    const node = stackNodes.pop()!
    const depth = stackDepths.pop()!

    // The root is the entity itself, never one of its own descendants.
    //
    // `isEnabled(false)` reads the mesh's OWN flag and ignores ancestors, which is
    // the whole distinction: `scene-bounds.ts` disables an individual collider that
    // has left the scene's parcels and it must stop being a candidate, while
    // frustum culling disables the scene ROOT and its colliders must KEEP being
    // candidates — a scene the camera is not looking at still answers raycasts.
    // Checking `isEnabled()` with its default ancestor walk would conflate the two
    // and silently kill raycasting for every culled scene.
    if (
      node !== entity &&
      node instanceof AbstractMesh &&
      node.isEnabled(false) &&
      bitIntersectsAndContainsAny(getColliderLayers(node), mask)
    ) {
      results.push(node)
      // Past what the caller can afford to intersect: it will answer empty, so there is
      // nothing to gain from collecting the rest or from sweeping their world matrices.
      if (budget && results.length > budget.maxResults) {
        budget.truncatedBy = 'results'
        break
      }
    }

    // `_children` is read directly rather than through `getChildren(_, true)`.
    // That helper allocates a fresh array per call, and this walk calls it once
    // per NODE where Babylon's recursive version allocated one array in total —
    // measured at 50_000 colliders, that alone made this walk 15.8ms against the
    // recursive 5.1ms, a 3x regression on a path that runs once per mask per
    // frame. Reading the field is allocation-free and restores parity.
    //
    // `_children` is Babylon-internal, so it is treated as possibly absent: an
    // `undefined` (rather than the documented null-or-array) means the field has
    // gone away in an upgrade, and the walk falls back to the public helper
    // instead of silently reporting that every entity has no colliders.
    const internalChildren = (node as unknown as { _children?: Node[] | null })._children
    const children = internalChildren === undefined ? node.getChildren(undefined, true) : internalChildren
    if (!children || !children.length) continue

    if (depth >= maxDepth) {
      truncated = true
      continue
    }

    // Pushed in reverse so the leftmost child is popped — and so visited — first.
    for (let i = children.length - 1; i >= 0; i--) {
      stackNodes.push(children[i])
      stackDepths.push(depth + 1)
    }
  }

  if (truncated) {
    limitLogger.hit('maxColliderTreeDepth', `collider subtree deeper than ${maxDepth} levels`)
  }

  return results
}