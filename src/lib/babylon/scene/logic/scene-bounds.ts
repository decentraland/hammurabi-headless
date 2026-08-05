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
 * COST, measured per frame: 0.192ms at 1000 colliders, 1.255ms at 10_000, and
 * 20.942ms at the 50_000 mesh ceiling. The first two are fine; the last is not, and
 * is a KNOWN limitation rather than a bound — a scene sitting at the entity cap
 * pays it every frame whether or not anything moved.
 *
 * Deliberately left un-throttled for now, because the obvious fixes are each wrong
 * in a way worth stating: skipping unmoved colliders via the world matrix's
 * `updateFlag` does not work (the render pass recomputes an active mesh's matrix
 * every frame, so the flag always changes, and a DISABLED mesh's matrix is
 * recomputed on read for the same reason), and capping the number of CHECKS per
 * frame does not bound the subtree WALK, which is 4.2ms of the 20.9ms on its own.
 * The real fix is a round-robin cursor over a cached collider list, invalidated on
 * add/remove — the same shape as the raycast rotation cursor. Filed rather than
 * rushed: getting the invalidation wrong would leave a collider unchecked, which is
 * exactly the hole this closes.
 */
export function enforceColliderBounds(context: SceneContext): void {
  const bounds = context.boundingBox
  if (!bounds) return

  const minX = bounds.minimumWorld.x
  const maxX = bounds.maximumWorld.x
  const minZ = bounds.minimumWorld.z
  const maxZ = bounds.maximumWorld.z
  const maxY = bounds.maximumWorld.y

  for (const mesh of collectColliders(context.rootNode)) {
    const colliderBounds = mesh.getBoundingInfo().boundingBox
    const low = colliderBounds.minimumWorld
    const high = colliderBounds.maximumWorld

    const inside =
      high.y <= maxY && low.x >= minX && high.x <= maxX && low.z >= minZ && high.z <= maxZ

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
