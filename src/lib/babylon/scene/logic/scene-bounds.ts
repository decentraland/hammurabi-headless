import * as BABYLON from '@babylonjs/core'
import type { SceneContext } from '../scene-context'
import { isAvatarCapsule } from './avatar-colliders'
import { getColliderLayers } from './colliders'

/**
 * Disables collider meshes that have left the scene's own parcels, matching the
 * reference client's `CheckColliderBoundsSystem`.
 *
 * Nothing enforced this before. A scene could place a collider over a NEIGHBOUR's
 * parcel and this server would honour it in raycasts and in avatar movement, while
 * every player's client disabled it — so on an authoritative server one scene could
 * block movement or absorb pointer events on land it does not own. That is a
 * griefing vector, not just a parity difference.
 *
 * The test matches the client's exactly:
 *
 *   `auxiliaryBounds.max.y <= sceneGeometry.Height && CircumscribedPlanes.Contains(bounds)`
 *
 * so FULL containment in XZ, a CEILING on Y, and deliberately no floor — a collider
 * below ground level is fine on both sides.
 *
 * AVATAR capsules are exempt. They are not scene-authored geometry, the client does
 * not bounds-check them either (its check covers primitive and glTF SDK colliders),
 * and a player who walks a step outside a scene's parcels should not stop being
 * raycastable.
 *
 * COST, measured per frame: 0.397ms at 1000 colliders, 6.402ms at 10_000, and
 * 50.55ms at the 50_000 mesh ceiling — superlinear, and 2.4x an earlier figure of
 * 20.9ms quoted here. A scene with NO colliders at all still pays the walk: 2.633ms
 * at 50_000 plain entities. This is a KNOWN limitation rather than a bound, and it
 * is the largest unbounded per-frame cost left in the interaction path.
 *
 * Deliberately left un-throttled for now, because the obvious fixes are each wrong
 * in a way worth stating: skipping unmoved colliders via the world matrix's
 * `updateFlag` does not work (the render pass recomputes an active mesh's matrix
 * every frame, so the flag always changes, and a DISABLED mesh's matrix is
 * recomputed on read for the same reason), and capping the number of CHECKS per
 * frame does not bound the subtree WALK, which is a large share of the total on its
 * own. The real fix is a round-robin cursor over a cached collider list, invalidated
 * on add/remove — the same shape as the raycast rotation cursor — and it MUST still
 * refresh each visited mesh's world matrix, or it reintroduces the one-way latch
 * described below. Filed rather than rushed: getting the invalidation wrong would
 * leave a collider unchecked, which is exactly the hole this closes.
 *
 * ORDERING, load-bearing: this runs from `SceneContext.updateInteractionSystems`,
 * which `lateUpdate` calls BEFORE `processRaycasts`. It used to hang off
 * `updateStaticEntities`, which runs after — so every raycast in a frame resolved
 * against the previous frame's enabled-state and a scene alternating a collider in
 * and out of its parcels had the out-of-bounds position honoured on about half of
 * all frames, which is the griefing vector this module exists to close.
 */
/** Slack added to each parcel plane, from the client's `EXTEND_AMOUNT`. */
const PLANE_SLACK_METERS = 0.05

/** Cap on the collider-bounds shrink, from the client's `BOUNDS_OFFSET_EPSILON`. */
const BOUNDS_SHRINK_METERS = 0.3

export function enforceColliderBounds(context: SceneContext): void {
  const bounds = context.boundingBox
  if (!bounds) return

  const minX = bounds.minimumWorld.x
  const maxX = bounds.maximumWorld.x
  const minZ = bounds.minimumWorld.z
  const maxZ = bounds.maximumWorld.z
  const maxY = bounds.maximumWorld.y

  for (const mesh of collectColliders(context.rootNode)) {
    // REFRESH before reading. `getBoundingInfo()` re-derives minimumWorld/maximumWorld
    // from the CACHED world matrix, and `_evaluateActiveMeshes` skips a mesh that is
    // `!isEnabled()` — so once this disabled a collider, nothing ever recomputed its
    // matrix again and the disable was a ONE-WAY LATCH. A moving platform that swung
    // over a neighbour's parcel, or any collider created out of bounds and then
    // positioned, stayed dead for the life of the process.
    //
    // The same staleness let the check be BYPASSED: while a scene is frustum-culled
    // its root is disabled, so a collider moved out of bounds during that window was
    // measured at its old position and stayed enabled — reopening the very griefing
    // vector this closes, since `pickMeshesForMask` uses `isEnabled(false)` and
    // `meshesForMask` then refreshes the matrix for the raycast itself.
    //
    // This is the same sweep `meshesForMask` performs for the raycast candidates.
    mesh.computeWorldMatrix(false)

    const colliderBounds = mesh.getBoundingInfo().boundingBox
    const low = colliderBounds.minimumWorld
    const high = colliderBounds.maximumWorld

    // TOLERANCES, both mirroring the client. Without them a collider that merely
    // TOUCHES its parcel edge is disabled by float error: measured, an ordinary
    // parcel-filling 16x16 floor was disabled at 2 of 5 plain yaw rotations by an
    // overhang of 1.8e-15 m. Babylon world matrices are Float32Array, so the sign of
    // that error is not predictable and the result flickers frame to frame — exactly
    // what the client's epsilon exists to prevent (`EXTEND_AMOUNT`'s comment reads
    // "to prevent on-boundary flickering (float accuracy)").
    //
    //   ParcelMathHelper.CreateSceneGeometry: EXTEND_AMOUNT = 0.05 on each plane
    //   SceneCircumscribedPlanes.Contains:    bounds.Expand(-min(size/2, 0.3))
    //
    // `Expand` is symmetric, so the client's shrink is half its argument per side.
    const shrink = Math.min((high.x - low.x) / 2, (high.z - low.z) / 2, BOUNDS_SHRINK_METERS) / 2
    const inside =
      high.y <= maxY &&
      low.x + shrink >= minX - PLANE_SLACK_METERS &&
      high.x - shrink <= maxX + PLANE_SLACK_METERS &&
      low.z + shrink >= minZ - PLANE_SLACK_METERS &&
      high.z - shrink <= maxZ + PLANE_SLACK_METERS

    // `isEnabled(false)` reads the mesh's OWN flag, ignoring ancestors: the scene
    // root is disabled wholesale by frustum culling, and treating that as "this
    // collider is out of bounds" would make every collider in a culled scene
    // permanently disabled the moment the camera looked away.
    if (mesh.isEnabled(false) !== inside) {
      mesh.setEnabled(inside)
    }
  }
}

/**
 * Every collider mesh under `root`, regardless of layer.
 *
 * Iterative and allocation-light for the same reasons as `pickMeshesForMask` — see
 * the note there about `_getDescendants` overflowing the stack at depth ~6000 and
 * `getChildren()` allocating per node.
 */
function collectColliders(root: BABYLON.Node): BABYLON.AbstractMesh[] {
  const found: BABYLON.AbstractMesh[] = []
  const stack: BABYLON.Node[] = [root]

  while (stack.length) {
    const node = stack.pop()!

    if (node !== root && node instanceof BABYLON.AbstractMesh && getColliderLayers(node) !== 0 && !isAvatarCapsule(node)) {
      found.push(node)
    }

    const internalChildren = (node as unknown as { _children?: BABYLON.Node[] | null })._children
    const children = internalChildren === undefined ? node.getChildren(undefined, true) : internalChildren
    if (!children || !children.length) continue
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i])
  }

  return found
}
