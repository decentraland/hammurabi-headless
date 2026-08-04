import * as BABYLON from "@babylonjs/core";
import { Ray, Vector3 } from "@babylonjs/core";
import { RaycastHit } from "@dcl/protocol/out-js/decentraland/sdk/components/common/raycast_hit.gen";
import { PBRaycast, RaycastQueryType } from "@dcl/protocol/out-js/decentraland/sdk/components/raycast.gen";
import { PBRaycastResult } from "@dcl/protocol/out-js/decentraland/sdk/components/raycast_result.gen";
import { raycastComponent, raycastResultComponent } from "../../../decentraland/sdk-components/raycast-component";
import { SceneContext } from "../scene-context";
import { globalCoordinatesToSceneCoordinates, sceneCoordinatesToBabylonGlobalCoordinates } from "../coordinates";
import { BabylonEntity } from "../BabylonEntity";
import { pickMeshesForMask } from "./colliders";
import { ColliderLayer } from "@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen";
import { limits } from "../../../misc/limits";
import { limitLogger } from "../../../misc/limit-logger";

const DEFAULT_RAYCAST_MASK = ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS
// Per-frame ceiling on total ray↔mesh intersection tests across ALL of a scene's
// raycasts. processRaycasts runs in lateUpdate(), which has NO frame quota, and the
// cost is O(pending raycasts × collider meshes) — both bounded only by the 100k
// entity cap. Untrusted component data (many `continuous:true` raycasts, and/or a
// GLB with tens of thousands of collider meshes) would otherwise stall the shared
// host render loop for hundreds of ms to seconds per frame. When the budget is
// exhausted the remaining raycasts are left pending and processed on later frames
// (continuous ones re-run anyway; one-shot ones simply resolve a frame or two later).
// Read from `limits` per call rather than hoisted into a module constant. Both
// ceilings are operator knobs, and a test that needs them tuned apart would
// otherwise have to `jest.resetModules()` + re-`require` this module to rebind
// them — which silently loads a SECOND copy of @babylonjs/core AND of
// `logic/colliders`, whose module-scope `Symbol('isCollider')` then no longer
// matches the one every already-tagged mesh carries. Verified: `getColliderLayers`
// returns 0 across that boundary, so the real `pickMeshesForMask` predicate would
// reject every candidate and a test asserting "no hits" would pass for entirely
// the wrong reason. Reading the field here lets a test assign `limits.<knob>` and
// restore it, with no module duplication. The per-call cost is two property reads
// per frame.
/**
 * Companion ceiling counted in TRIANGLES, not meshes.
 *
 * The mesh budget above assumes every mesh costs about the same, which was true
 * while every primitive MeshCollider was a box: 12 triangles. It is not true now
 * that each `mesh` oneof builds its real shape — measured, at the tessellation
 * this server pins: box 12, plane 2, cylinder 200, sphere 1296. Babylon rejects a
 * mesh whose bounding box the ray misses before touching a triangle, so the cost
 * only materializes when the ray actually enters the box — but a scene chooses
 * where its colliders go, so that is an arrangement it can guarantee.
 *
 * Measured for one full mesh budget with every bounding box entered: boxes
 * ~100ms, cylinders ~390ms, spheres (at Babylon's old default 32 segments,
 * 4624 triangles) ~8.6s. The mesh budget alone therefore bounded a frame to
 * ~100ms for the shape it was tuned against and ~8.6s for one it was not.
 *
 * Charged ALONGSIDE the mesh budget rather than replacing it, and with its own
 * knob: `HAMMURABI_MAX_RAYCAST_INTERSECTIONS_PER_FRAME` keeps its meaning and its
 * default, so an operator who already tuned it is not silently retuned by an
 * upgrade. Whichever ceiling is reached first stops the frame.
 *
 * Bounds a SINGLE raycast as well as raycasts against each other. Each one's cost
 * is measured (after the bounding-box prefilter) before any triangle work runs, so
 * `intersectsMeshes` is never entered with a set that could outrun the ceiling:
 *   - costs more than a whole frame's budget -> cannot fit on ANY frame, so it is
 *     answered with an empty result and logged, never left pending forever;
 *   - costs more than what is LEFT of this frame -> deferred whole to the next
 *     frame, never truncated (a partial mesh set resolves the wrong NEAREST hit
 *     and would look authoritative).
 */

/**
 * Minimum triangle cost billed for any candidate mesh — the triangle count of the
 * box collider the ceiling above was calibrated against. Deliberately not a knob:
 * it is not a policy choice but a property of how that default was derived
 * (50_000 boxes x 12 triangles), so the two must move together or not at all.
 */
const TRIANGLE_COST_FLOOR = 12

/**
 * How many triangles `Ray.intersectsMesh` will really test for this candidate.
 *
 * `getTotalIndices() / 3` is right only for INDEXED geometry. A glTF primitive is
 * allowed to omit `indices`, and the Babylon glTF 2.0 loader answers that with
 * `babylonMesh.isUnIndexed = true` (glTFLoader `_loadVertexDataAsync`) and no index
 * buffer at all — so `getTotalIndices()` is 0 and the mesh used to be billed the
 * 12-triangle floor no matter how large it is.
 *
 * That is not a mesh Babylon skips. `SubMesh.intersects` branches on exactly this
 * shape — `if (!indices.length && this._mesh._unIndexed) return
 * this._intersectUnIndexedTriangles(...)` — and that loop walks
 * `verticesStart .. verticesStart + verticesCount` in steps of 3, i.e. it tests
 * `vertices / 3` real triangles and reports a real hit. Measured against an indexed
 * mesh of the same triangle count, per ray test: 20k triangles 1.32ms un-indexed vs
 * 0.97ms indexed; 100k triangles 5.68ms vs 5.00ms. So the un-indexed mesh costs what
 * its VERTICES say and the two forms agree once charged that way.
 *
 * The cost is sustained, not a one-time spike. `_generatePointsArray` (O(vertices))
 * runs first, but it caches into `Geometry._positions` and only a POSITION-kind
 * `setVerticesData`/`updateVerticesData` or `bakeTransformIntoVertices` invalidates
 * it — none of which any scene-reachable path in this server performs (the sole
 * geometry mutation in `src/` is a UV update on a freshly built MeshRenderer plane,
 * and clone / createInstance / applyToMesh all keep the shared cache warm). What
 * repeats every frame is the triangle loop.
 *
 * Left uncharged, this defeated both ceilings at once: 50_000 un-indexed colliders
 * (the whole mesh ceiling) bill 50_000 x 12 = 600_000, exactly the triangle ceiling,
 * so they all run in ONE frame — measured at 4.1ms per 100k-triangle mesh, ~205s of
 * stall for a raycast charged 0.1% of the budget.
 *
 * They are charged, NOT excluded from the candidate set. They can and do hit, so
 * dropping them would silently break every scene that ships a collider authored
 * without an index buffer; the cost bound is available by billing them correctly.
 *
 * Keyed on `getTotalIndices() === 0` rather than on Babylon's private `_unIndexed`
 * so it fails CLOSED — a renamed internal cannot quietly restore the 12-triangle
 * undercount. The only thing that costs is over-charging a no-index mesh whose
 * `_unIndexed` is false (never triangle-tested), which this server cannot produce
 * (the loader sets the flag whenever it omits indices) and which still pays an
 * O(vertices) `_generatePointsArray` on its first ray test anyway.
 */
function candidateTriangleCost(mesh: BABYLON.AbstractMesh): number {
  const totalIndices = mesh.getTotalIndices()
  const triangles = totalIndices > 0 ? totalIndices / 3 : mesh.getTotalVertices() / 3
  return Math.max(triangles, TRIANGLE_COST_FLOOR)
}

/**
 * The processRaycasts function iterates over a copy of the pendingRaycastOperations
 * and for each it does
 * 1. It performs the final ray transformations based on the final positions of the entities
 * 2. Filters the meshes to perform the raycast
 * 3. Updates the RaycastResult component with the result of the query
 * 4. If necessary, removes the raycast from pendingRaycastOperations
 */
export function processRaycasts(scene: SceneContext) {
  const RaycastResult = scene.components[raycastResultComponent.componentId]
  const Raycast = scene.components[raycastComponent.componentId]

  // Collect the intersectable meshes once per collision mask per frame instead of
  // re-walking the whole scene subtree for every raycast.
  const meshesByMask = new Map<number, BABYLON.AbstractMesh[]>()
  const meshesForMask = (mask: number): BABYLON.AbstractMesh[] => {
    let meshes = meshesByMask.get(mask)
    if (!meshes) {
      meshes = Array.from(pickMeshesForMask(scene.rootNode, mask))
      // Refresh world matrices ONCE per mask per frame, before anything reads
      // `minimumWorld`/`maximumWorld` off these meshes.
      //
      // Load-bearing for correctness, not tidiness. `computeWorldMatrix` only
      // marks the bounds dirty; `getBoundingInfo()` re-derives them from the
      // CACHED world matrix. So a mesh whose matrix the render pass did not
      // recompute this frame reports the box it had when it was last evaluated.
      // That is not hypothetical: `_evaluateActiveMeshes` skips anything
      // `!isEnabled()` or `isBlocked`, `scene-culling.ts` disables the whole
      // scene root when it leaves the frustum, AssetManager marks glTF meshes
      // blocked in exactly that case — and `pickMeshesForMask` keeps offering
      // them as raycast candidates regardless. Meanwhile `computeRayDirection`
      // reads a FRESH matrix for the ray's own entity, so the ray moves and the
      // colliders do not: a collider moved into the ray's path answers a false
      // miss. The path this prefilter replaced never hit this, because
      // `Ray.intersectsMesh` calls `getWorldMatrix()` per mesh and tests in
      // LOCAL space.
      //
      // `computeWorldMatrix(false)` over `getWorldMatrix()`, but only marginally,
      // and NOT for the reason a previous version of this comment gave. Both gate
      // on the render id (`transformNode.js:871`, `node.js:330`); `(false)`
      // additionally recomputes when the node's own `_isDirty` is set. That is a
      // strict superset at the same cost, so it is the better default — but it is
      // not what makes the sweep work. The sweep works because a mesh
      // `_evaluateActiveMeshes` SKIPPED never had its render id bumped, so either
      // call recomputes it; substituting `getWorldMatrix()` keeps the stale-bounds
      // spec green. Not `(true)` either — forcing the whole parent chain costs
      // ~122ns against ~16ns, and the case it would additionally cover (a mesh
      // evaluated this frame whose PARENT moved afterwards) is self-healing:
      // measured with the root left enabled, the hit resolves correctly even with
      // this sweep deleted entirely.
      //
      // Centralized here rather than in the per-raycast prefilter loop because
      // this runs once per mask per frame while that loop runs once per raycast:
      // measured at 5000 meshes and 50 raycasts, 9.45ms here versus 16.71ms
      // there.
      for (const mesh of meshes) mesh.computeWorldMatrix(false)
      meshesByMask.set(mask, meshes)
    }
    return meshes
  }
  const maxIntersectionsPerFrame = limits.maxRaycastIntersectionsPerFrame // HAMMURABI_MAX_RAYCAST_INTERSECTIONS_PER_FRAME
  const maxTrianglesPerFrame = limits.maxRaycastTrianglesPerFrame // HAMMURABI_MAX_RAYCAST_TRIANGLES_PER_FRAME
  let intersectionBudget = maxIntersectionsPerFrame
  let triangleBudget = maxTrianglesPerFrame

  // clone the set into an array to mutate the set while iterating
  const iter = Array.from(scene.pendingRaycastOperations)
  for (const entityId of iter) {
    // Stop once this frame's intersection budget is spent; the still-pending
    // raycasts run on subsequent frames (leaving them in the set is correct — a
    // one-shot raycast is only removed below after it actually ran).
    if (intersectionBudget <= 0 || triangleBudget <= 0) break

    const raycast = Raycast.getOrNull(entityId)

    if (raycast) {
      const entity = scene.getEntityOrNull(entityId)
      if (entity && entity.appliedComponents.raycast) {
        const ray = computeRayDirection(scene, raycast, entity.appliedComponents.raycast.ray, entity)

        // get a list of all possible meshes to project this ray to
        const mask = raycast.collisionMask ?? DEFAULT_RAYCAST_MASK
        const intersectableMeshes = meshesForMask(mask)

        // The MESH ceiling pays for the bounding-box scan below: one cheap
        // ray↔box test per candidate, whether or not it survives. Enforced
        // per-raycast BEFORE that scan, exactly as the triangle ceiling is
        // enforced before the triangle work — the scan is O(candidates) and a
        // scene of CHEAP colliders sails past the triangle ceiling while blowing
        // this one. The scan itself is not new: `intersectsMeshes` always tested
        // every mesh's bounds one by one, so the cost predates the prefilter;
        // what is new is that it is measured before it is paid.
        //
        // Written as one exclusive chain so EVERY path falls through to the
        // cleanup at the bottom of the loop, which removes one-shots and keeps
        // `continuous` ones. The over-budget branches used to `continue` past
        // that cleanup after deleting the entry themselves, which silently
        // retired a continuous raycast after a single empty result: nothing
        // re-arms it except the scene re-PUTting the component, so it stayed
        // dead even once the collider set dropped back under budget.
        if (intersectableMeshes.length > maxIntersectionsPerFrame) {
          // Charged even though no scan runs. A retained continuous raycast
          // arrives here again next frame, and getting here is not free —
          // `meshesForMask` walked the whole subtree and swept every world
          // matrix for this mask. Uncharged, an over-ceiling continuous raycast
          // repeats that walk every frame forever, once per DISTINCT mask
          // (~4ms per mask per frame at 50k colliders): exactly the cost this
          // ceiling exists to bound.
          intersectionBudget -= intersectableMeshes.length
          limitLogger.hit(
            'maxRaycastIntersectionsPerFrame',
            `scene ${scene.entityId}: one raycast spans ${intersectableMeshes.length} colliders`
          )
          RaycastResult.createOrReplace(
            entity.entityId,
            raycastResultFromRay(scene, ray, [], raycast.queryType, raycast.timestamp || 0)
          )
        } else if (intersectableMeshes.length > intersectionBudget) {
          // Fits in a frame, just not in what is left of this one — defer it
          // whole rather than truncating its candidate set.
          break
        } else {
          intersectionBudget -= intersectableMeshes.length

          // Bounding-box prefilter, charged separately from the triangle work it
          // gates. Babylon does an equivalent early-out inside intersectsMeshes,
          // so this changes no result — it makes the cost VISIBLE before it is
          // paid. Measured: 3000 spheres take 246ms when the ray enters every box
          // and 14ms when it enters none, so charging every candidate's triangles
          // bills a scene ~17x its real cost and throttles raycasts that were
          // nearly free.
          //
          // Tested in WORLD space against `minimumWorld`/`maximumWorld`. Do NOT
          // reach for `mesh.intersects(ray, …, onlyBoundingInfo)` here: that path
          // compares a ray against the mesh's LOCAL bounding volume, and
          // `Ray.intersectsMesh` is what transforms the ray into local space
          // before calling it. Handing it a world-space ray silently admits every
          // mesh whose local bounds contain the scene origin — i.e. every
          // primitive collider — so the filter passes everything and quietly does
          // nothing. The world AABB encloses the oriented box Babylon tests, so a
          // CURRENT one is conservative: it can over-admit a grazing mesh, never
          // wrongly reject. A STALE one rejects freely in both directions, which
          // is why meshesForMask refreshes every matrix before this runs.
          const candidates: BABYLON.AbstractMesh[] = []
          let candidateTriangles = 0
          for (const mesh of intersectableMeshes) {
            const boundingBox = mesh.getBoundingInfo().boundingBox
            if (ray.intersectsBoxMinMax(boundingBox.minimumWorld, boundingBox.maximumWorld)) {
              candidates.push(mesh)
              candidateTriangles += candidateTriangleCost(mesh)
            }
          }

          if (candidateTriangles > maxTrianglesPerFrame) {
            // Cannot fit on ANY frame, so answer explicitly rather than deferring
            // it forever: an empty result plus a throttled log. Bounded AND
            // observable — unlike testing a PARTIAL mesh set, which would resolve
            // the wrong NEAREST hit and look authoritative. The mesh ceiling
            // above already charged the scan that got us here, so a retained
            // continuous raycast cannot repeat it for free.
            limitLogger.hit(
              'maxRaycastTrianglesPerFrame',
              `scene ${scene.entityId}: one raycast spans ${candidateTriangles} triangles`
            )
            RaycastResult.createOrReplace(
              entity.entityId,
              raycastResultFromRay(scene, ray, [], raycast.queryType, raycast.timestamp || 0)
            )
          } else if (candidateTriangles > triangleBudget) {
            break
          } else {
            triangleBudget -= candidateTriangles

            // then perform the actual raycast, against the prefiltered set
            const results = ray.intersectsMeshes(candidates, false)

            const raycastResult = raycastResultFromRay(scene, ray, results, raycast.queryType, raycast.timestamp || 0)

            // send the result back to the scene
            RaycastResult.createOrReplace(entity.entityId, raycastResult)
          }
        }
      }
    }

    // lastly remove the raycast from the list if necessary
    const shouldRaycastBeDeletedFromPendingList = !raycast?.continuous
    if (shouldRaycastBeDeletedFromPendingList) {
      scene.pendingRaycastOperations.delete(entityId)
    }
  }
}

export function raycastResultFromRay(scene: SceneContext, ray: Ray, results: BABYLON.PickingInfo[], queryType: RaycastQueryType, timestamp: number) {
  // start preparing the result
  const raycastResult: PBRaycastResult = {
    direction: Vector3.Normalize(ray.direction),
    globalOrigin: globalCoordinatesToSceneCoordinates(scene, ray.origin),
    timestamp,
    hits: [],
    tickNumber: scene.currentTick
  }

  if (queryType === RaycastQueryType.RQT_HIT_FIRST && results.length) {
    raycastResult.hits = [pickingToRaycastHit(scene, pickClosest(results)!, ray)]
  } else if (queryType === RaycastQueryType.RQT_QUERY_ALL && results.length) {
    raycastResult.hits = results.map(_ => pickingToRaycastHit(scene, _, ray))
  }

  return raycastResult
}

/**
 * Pick closest selects the closest point of an array. By .distance field
 */
function pickClosest<T extends { distance: number }>(elems: T[]): T | undefined {
  let closest: T | undefined = undefined

  for (let it of elems) {
    if (!closest || it.distance < closest.distance) {
      closest = it
    }
  }

  return closest
}

/**
 * Compute ray direction calculates the "global coordinates" ray to perform
 * the raycast operation.
 */
function computeRayDirection(scene: SceneContext, raycast: PBRaycast, ray: Ray, entity: BabylonEntity) {
  const originOffset = raycast.originOffset ?? Vector3.Zero()

  const globalOrigin = Vector3.TransformCoordinatesToRef(
    new Vector3(originOffset.x, originOffset.y, originOffset.z),
    entity.getWorldMatrix(),
    ray.origin
  );

  // and then calculate the global direction, relative to the
  if (!raycast.direction) {
    // the default value if direction is missing is a local-space forward vector
    Vector3.TransformNormalToRef(Vector3.Forward(), entity.getWorldMatrix(), ray.direction);
  } else if (raycast.direction?.$case === 'localDirection') {
    // then localDirection, is used to detect collisions in a path
    // i.e. Vector3.Forward(), it takes into consideration the rotation of
    // the entity to perform the raycast in local coordinates

    Vector3.TransformNormalToRef(
      new Vector3(
        raycast.direction.localDirection.x ?? 0,
        raycast.direction.localDirection.y ?? 0,
        raycast.direction.localDirection.z ?? 1
      ),
      entity.getWorldMatrix(),
      ray.direction
    );
  } else if (raycast.direction?.$case === 'globalDirection') {
    ray.direction.set(
      raycast.direction?.globalDirection.x,
      raycast.direction?.globalDirection.y,
      raycast.direction?.globalDirection.z
    ).normalize()
  } else if (raycast.direction?.$case == 'globalTarget') {
    const sceneTarget = new Vector3(
      raycast.direction.globalTarget.x,
      raycast.direction.globalTarget.y,
      raycast.direction.globalTarget.z
    )
    const globalTarget = sceneCoordinatesToBabylonGlobalCoordinates(scene, sceneTarget)

    // scene one is to make it easy to point towards a pin-pointed element
    // in global space, like a fixed tower
    ray.direction.set(
      globalTarget.x - globalOrigin.x,
      globalTarget.y - globalOrigin.y,
      globalTarget.z - globalOrigin.z,
    ).normalize()
  } else if (raycast.direction?.$case == 'targetEntity') {
    const targetEntity = scene.getEntityOrNull(raycast.direction.targetEntity)
    const sceneTarget = targetEntity ? targetEntity.absolutePosition : Vector3.Zero()
    const globalTarget = sceneCoordinatesToBabylonGlobalCoordinates(scene, sceneTarget)

    // scene one is to make it easy to point towards a pin-pointed element
    // in global space, like a fixed tower
    ray.direction.set(
      globalTarget.x - globalOrigin.x,
      globalTarget.y - globalOrigin.y,
      globalTarget.z - globalOrigin.z,
    ).normalize()
  }

  return ray
}

/**
 * Converts a result of a raycast (PickingInfo) into a RaycastHit of the Decentraland Protocol
 */
export function pickingToRaycastHit(scene: SceneContext, pickingInfo: BABYLON.PickingInfo, ray: BABYLON.Ray): RaycastHit {
  return {
    normalHit: pickingInfo.getNormal(true) || undefined,
    direction: ray.direction,
    globalOrigin: globalCoordinatesToSceneCoordinates(scene, ray.origin),
    length: pickingInfo.distance,
    position: globalCoordinatesToSceneCoordinates(scene, pickingInfo.pickedPoint!),
    entityId: getParentEntityId(pickingInfo.pickedMesh),
    meshName: pickingInfo.pickedMesh?.name
  }
}

// iterates the parents of the mesh until the a BabylonEntity is reached, it returns its .entityId
function getParentEntityId(node: BABYLON.Nullable<BABYLON.AbstractMesh>): number | undefined {
  let parent: BabylonEntity | BABYLON.Nullable<BABYLON.AbstractMesh> | null = node
  while (parent = parent?.parent as any) {
    if (parent instanceof BabylonEntity) return parent.entityId
  }
  return undefined
}

