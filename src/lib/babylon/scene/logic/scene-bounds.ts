import * as BABYLON from '@babylonjs/core'
import type { SceneContext } from '../scene-context'
import { isAvatarCapsule } from './avatar-colliders'
import { colliderMembershipVersion, getColliderLayers } from './colliders'
import { limits } from '../../../misc/limits'
import { limitLogger } from '../../../misc/limit-logger'

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
 * COST. This used to be the largest UNBOUNDED per-frame cost in the interaction path:
 * a full subtree walk plus a world-matrix refresh and a bounds read for every collider,
 * every frame, with no visit budget, depth cap, result cap or cursor — measured at
 * 2.60ms per frame over 10_000 colliders and 18.72ms over 50_000 (an earlier note here
 * quoted 6.4ms and 50.55ms for a deeper arrangement; either way it is linear in a
 * quantity the scene chooses). The scene owns the entity tree, so it set the price.
 *
 * Now bounded in the two places the cost actually lives, measured at 21% walk / 79%
 * per-collider work at 50_000:
 *
 *   - the WALK is cached and rebuilt only when collider MEMBERSHIP changes
 *     (`colliderMembershipVersion`), so a scene that merely MOVES colliders — the
 *     ordinary case, and the one this check exists for — never walks again;
 *   - the per-collider work is spent through a ROUND-ROBIN CURSOR bounded by
 *     `maxColliderBoundsChecksPerFrame`, the same shape as the raycast rotation cursor.
 *
 * Two rejected alternatives, each wrong in a way worth stating. Skipping unmoved
 * colliders via the world matrix's `updateFlag` does not work: the render pass
 * recomputes an active mesh's matrix every frame so the flag always changes, and a
 * DISABLED mesh's matrix is recomputed on read for the same reason. Capping the CHECKS
 * alone does not bound the walk, which is why the cache had to come with the cursor
 * rather than instead of it.
 *
 * WHAT THE CURSOR COSTS, stated plainly: a collider moved out of bounds stays live
 * until its slot comes up, i.e. up to `ceil(colliders / budget)` frames. At the default
 * (8192) every scene below that many colliders is checked in full every frame and
 * nothing changes; a scene at the 50_000 ceiling is fully covered every 7 frames, about
 * 0.23s at 30fps. That is a deferral of a griefing defence, so it is LOGGED — unlike
 * the raycast budget, which merely makes the scene's own query late.
 *
 * FAIRNESS is tracked by IDENTITY, not by an index, and that distinction is the whole
 * design. A scene decides where its new colliders land in the walk order and can bump
 * the membership version every frame, so both obvious cursors fail against it — measured,
 * each disabling 0 of 3 out-of-bounds colliders over three frames:
 *
 *   - an index reset to 0 on rebuild re-checks the same prefix forever;
 *   - an index resuming after the last mesh checked chases the newly appended tail,
 *     because the insertion lands exactly where the cursor is pointing.
 *
 * So a ROUND is "every live collider checked once", stamped onto the meshes themselves so
 * it survives the rebuild. An already-stamped mesh is skipped WITHOUT spending budget, so
 * inserting ahead of the scan delays nothing; the round ends only when the scan has
 * covered the list.
 *
 * RESIDUAL, stated rather than hidden: a newly created collider must itself be checked —
 * it could have been created out of bounds — so it spends budget like any other. A scene
 * creating colliders FASTER than `maxColliderBoundsChecksPerFrame` per frame therefore
 * spends the whole allowance on its new geometry and delays the re-check of what is
 * already there. The default (8192/frame, i.e. 245_000/s at 30fps) is far above any
 * creation rate the CRDT path can sustain against `maxLiveEntities`, and the knob is
 * there for an operator who wants more headroom.
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

/**
 * One scene's cached collider list and where the cursor left off.
 *
 * A `WeakMap` keyed on the context so a disposed scene's list is collectable without
 * `SceneContext` having to know this module exists.
 */
type BoundsWalkState = {
  /** `colliderMembershipVersion()` the list was built at. */
  version: number
  colliders: BABYLON.AbstractMesh[]
  /** How far into `colliders` this ROUND has scanned. */
  scan: number
  /**
   * Token identifying the current round, stamped onto each mesh as it is checked.
   *
   * This — not the scan index — is what makes the sweep fair, because indices move
   * under a rebuild and the scene decides where its new colliders land in the walk.
   *
   * A stamp rather than a `Set` of checked meshes, for three reasons: it is O(1) with no
   * structure to grow, it cannot retain a disposed mesh past the round that saw it, and
   * it measured ~29% cheaper (a Set's has+add over 50_000 meshes is 5.76ms against
   * 4.36ms for all the matrix and bounds work those same meshes need).
   *
   * Drawn from a process-wide counter so two scenes' rounds can never collide on a value,
   * even though a mesh only ever belongs to one scene's list.
   */
  round: number
}

const boundsCheckedRoundSymbol = Symbol('boundsCheckedRound')
let nextBoundsRound = 0

const boundsWalkStates = new WeakMap<SceneContext, BoundsWalkState>()

export function enforceColliderBounds(context: SceneContext): void {
  const bounds = context.boundingBox
  if (!bounds) return

  const minX = bounds.minimumWorld.x
  const maxX = bounds.maximumWorld.x
  const minZ = bounds.minimumWorld.z
  const maxZ = bounds.maximumWorld.z
  const maxY = bounds.maximumWorld.y

  const state = colliderList(context)
  const colliders = state.colliders
  if (!colliders.length) return

  const budget = Math.min(colliders.length, limits.maxColliderBoundsChecksPerFrame)
  if (budget < colliders.length) {
    // Logged because this DEFERS a griefing defence — out-of-parcel geometry stays live
    // for up to ceil(colliders/budget) frames — rather than merely delaying work the
    // scene asked for. An operator seeing this can raise the knob.
    limitLogger.hit('maxColliderBoundsChecksPerFrame', `${colliders.length} colliders checked ${budget} per frame`)
  }

  let spent = 0
  let wrapped = false

  while (spent < budget) {
    if (state.scan >= colliders.length) {
      // ROUND COMPLETE: every live collider has been checked once. Start the next one.
      // At most one wrap per frame, so a budget larger than the list cannot check the
      // same collider twice in a frame.
      if (wrapped) break
      wrapped = true
      state.round = ++nextBoundsRound
      state.scan = 0
    }

    const mesh = colliders[state.scan++]
    // Already done this round — skipped WITHOUT spending budget, which is the whole
    // point: a mesh the scene inserts ahead of the scan delays nothing, because the
    // round is not over until every mesh has been checked, not until an index reaches
    // the end of a list the scene can extend.
    if ((mesh as any)[boundsCheckedRoundSymbol] === state.round) continue
    ;(mesh as any)[boundsCheckedRoundSymbol] = state.round
    spent++

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
 * This scene's collider list, rebuilt only when collider membership has changed.
 *
 * The cache rests entirely on `colliderMembershipVersion()` covering every way a mesh
 * can join or leave the set — see the note there. It is deliberately global rather than
 * per-scene: another scene's collider churn costs this one a rebuild it did not need,
 * which is a wasted walk, where a missed change would be an unchecked collider.
 */
function colliderList(context: SceneContext): BoundsWalkState {
  const version = colliderMembershipVersion()
  const previous = boundsWalkStates.get(context)
  if (previous && previous.version === version) return previous

  // The ROUND survives the rebuild — both halves of it, and for different reasons.
  //
  // The round token carries over because it is what fairness rests on: start a new round
  // here and a scene creating one throwaway collider per frame restarts it every frame, so
  // only the first `budget` entries are ever examined and everything past them is
  // permanently unchecked. The stamps live on the meshes, so they survive the rebuild.
  //
  // `scan` carries over too, even though the indices under it have moved. It is only a
  // hint about where unchecked entries are likely to start; the stamps decide what is
  // actually done, so a shifted index costs at most a skipped pass over entries that
  // will be picked up next round.
  //
  // That makes it a COST property, and no behavioural test can pin it: resetting it to 0
  // here checks exactly the same meshes, because everything before the first unstamped
  // entry is skipped for free either way. What it would cost is that skip — a scan from
  // the head of the list on every rebuild, i.e. O(colliders) per frame for a scene that
  // creates or destroys one collider per frame, which is the shape this cache exists to
  // remove. Verified by mutation: the reset survives the suite.
  const state: BoundsWalkState = {
    version,
    colliders: collectColliders(context.rootNode),
    scan: previous?.scan ?? 0,
    round: previous?.round ?? ++nextBoundsRound
  }
  boundsWalkStates.set(context, state)
  return state
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
