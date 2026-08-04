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
 * RESIDUAL (deliberate): this bounds raycasts against EACH OTHER, not a single
 * raycast. The budget is tested before a raycast runs, never during, because a
 * partially-tested mesh set would resolve the wrong nearest hit — a silently
 * wrong answer is worse than a slow one. One raycast is therefore still bounded
 * only by the scene's total collider triangles, i.e. by `maxLiveEntities`.
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
  // Triangle count per mask, memoized beside the mesh list it is derived from so
  // the sum is walked once per mask per frame rather than once per raycast.
  const trianglesByMask = new Map<number, number>()
  const trianglesForMask = (mask: number, meshes: BABYLON.AbstractMesh[]): number => {
    let triangles = trianglesByMask.get(mask)
    if (triangles === undefined) {
      triangles = 0
      for (const mesh of meshes) triangles += mesh.getTotalIndices() / 3
      trianglesByMask.set(mask, triangles)
    }
    return triangles
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
        intersectionBudget -= intersectableMeshes.length
        triangleBudget -= trianglesForMask(mask, intersectableMeshes)

        // then perform the actual raycast
        const results = ray.intersectsMeshes(intersectableMeshes, false)

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

