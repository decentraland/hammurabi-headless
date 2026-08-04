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
const MAX_RAYCAST_INTERSECTIONS_PER_FRAME = limits.maxRaycastIntersectionsPerFrame // HAMMURABI_MAX_RAYCAST_INTERSECTIONS_PER_FRAME
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
const MAX_RAYCAST_TRIANGLES_PER_FRAME = limits.maxRaycastTrianglesPerFrame // HAMMURABI_MAX_RAYCAST_TRIANGLES_PER_FRAME

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
      meshesByMask.set(mask, meshes)
    }
    return meshes
  }
  let intersectionBudget = MAX_RAYCAST_INTERSECTIONS_PER_FRAME
  let triangleBudget = MAX_RAYCAST_TRIANGLES_PER_FRAME

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
        // ray↔box test per candidate, whether or not it survives.
        intersectionBudget -= intersectableMeshes.length

        // Bounding-box prefilter, charged separately from the triangle work it
        // gates. Babylon does an equivalent early-out inside intersectsMeshes, so
        // this changes no result — it makes the cost VISIBLE before it is paid.
        // Measured: 3000 spheres take 246ms when the ray enters every box and
        // 14ms when it enters none, so charging every candidate's triangles bills
        // a scene ~17x its real cost and throttles raycasts that were nearly free.
        //
        // Tested in WORLD space against `minimumWorld`/`maximumWorld`. Do NOT
        // reach for `mesh.intersects(ray, …, onlyBoundingInfo)` here: that path
        // compares a ray against the mesh's LOCAL bounding volume, and
        // `Ray.intersectsMesh` is what transforms the ray into local space before
        // calling it. Handing it a world-space ray silently admits every mesh
        // whose local bounds contain the scene origin — i.e. every primitive
        // collider — so the filter passes everything and quietly does nothing.
        // The world AABB encloses the oriented box Babylon tests, so this is
        // conservative: it can over-admit a grazing mesh, never wrongly reject.
        const candidates: BABYLON.AbstractMesh[] = []
        let candidateTriangles = 0
        for (const mesh of intersectableMeshes) {
          const boundingBox = mesh.getBoundingInfo().boundingBox
          if (ray.intersectsBoxMinMax(boundingBox.minimumWorld, boundingBox.maximumWorld)) {
            candidates.push(mesh)
            candidateTriangles += mesh.getTotalIndices() / 3
          }
        }

        // A raycast whose OWN cost exceeds a whole frame's budget can never fit,
        // on this frame or any later one. Deferring it would starve it forever
        // while a scene keeps re-queueing it, so answer explicitly instead: an
        // empty result, plus a throttled log so an operator sees which scene is
        // doing it. Wrong-but-bounded and observable beats a frame that stalls
        // for seconds — and unlike testing a PARTIAL mesh set (which would
        // resolve the wrong NEAREST hit and look authoritative) the emptiness is
        // legible to whoever reads the log.
        if (candidateTriangles > MAX_RAYCAST_TRIANGLES_PER_FRAME) {
          limitLogger.hit(
            'maxRaycastTrianglesPerFrame',
            `scene ${scene.entityId}: one raycast spans ${candidateTriangles} triangles`
          )
          RaycastResult.createOrReplace(
            entity.entityId,
            raycastResultFromRay(scene, ray, [], raycast.queryType, raycast.timestamp || 0)
          )
          scene.pendingRaycastOperations.delete(entityId)
          continue
        }

        // It fits in a frame, just maybe not in what is left of THIS one. Leave
        // it pending and let it run whole on the next frame rather than
        // truncating it.
        if (candidateTriangles > triangleBudget) break

        triangleBudget -= candidateTriangles

        // then perform the actual raycast, against the prefiltered set
        const results = ray.intersectsMeshes(candidates, false)

        const raycastResult = raycastResultFromRay(scene, ray, results, raycast.queryType, raycast.timestamp || 0)

        // send the result back to the scene
        RaycastResult.createOrReplace(entity.entityId, raycastResult)
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

