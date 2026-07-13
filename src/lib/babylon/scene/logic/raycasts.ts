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

/**
 * The processRaycasts function iterates over a copy of the pendingRaycastOperations
 * and for each it does
 * 1. It performs the final ray transformations based on the final positions of the entities
 * 2. Filters the meshes to perform the raycast
 * 3. Updates the RaycastResult component with the result of the query
 * 4. If necessary, removes the raycast from pendingRaycastOperations
 */
const DEFAULT_RAYCAST_MASK = ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS
const EMPTY_PICKING_RESULTS: BABYLON.PickingInfo[] = []

export function processRaycasts(scene: SceneContext) {
  // Nothing pending: avoid the Array.from allocation (this runs every lateUpdate,
  // with NO quota, so it must be cheap when idle).
  if (scene.pendingRaycastOperations.size === 0) return

  const RaycastResult = scene.components[raycastResultComponent.componentId]
  const Raycast = scene.components[raycastComponent.componentId]

  // Cache the filtered mesh list per collision mask for THIS pass. Masks repeat
  // across rays (grounding sensors / line-of-sight share one) and the scene's
  // collider set can't change mid-pass, so this turns an O(rays × meshes) subtree
  // walk into O(distinct-masks × meshes).
  const meshesByMask = new Map<number, BABYLON.AbstractMesh[]>()

  // clone the set into an array to mutate the set while iterating
  const iter = Array.from(scene.pendingRaycastOperations)
  for (const entityId of iter) {
    const raycast = Raycast.getOrNull(entityId)

    if (raycast) {
      const entity = scene.getEntityOrNull(entityId)
      if (entity && entity.appliedComponents.raycast) {
        const ray = computeRayDirection(scene, raycast, entity.appliedComponents.raycast.ray, entity)

        // Honor maxDistance: Babylon's intersect tests clip to ray.length, so a
        // short proximity ray would otherwise report hits up to the default reach.
        // Set it UNCONDITIONALLY (the Ray is reused across frames per entity, so a
        // previous frame's maxDistance would linger if we only set it when > 0);
        // fall back to the 999 default the Ray is created with when unset.
        ray.length = Number.isFinite(raycast.maxDistance) && raycast.maxDistance > 0 ? raycast.maxDistance : 999

        let results = EMPTY_PICKING_RESULTS
        // RQT_NONE: the protocol says do not perform the raycast, only emit an
        // empty result — skip the mesh collection and intersection entirely.
        if (raycast.queryType !== RaycastQueryType.RQT_NONE) {
          const mask = raycast.collisionMask ?? DEFAULT_RAYCAST_MASK
          let meshes = meshesByMask.get(mask)
          if (!meshes) {
            meshes = Array.from(pickMeshesForMask(scene.rootNode, mask))
            meshesByMask.set(mask, meshes)
          }
          results = ray.intersectsMeshes(meshes, false)
        }

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
    // Normalize: transforming by the world matrix bakes the entity's scale into
    // the direction magnitude (the global* branches below already normalize).
    ray.direction.normalize()
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
    ray.direction.normalize()
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
    // Clone: ray.direction is a reused mutable vector (raycast-component keeps one
    // Ray per entity across frames), so storing the live reference into the LWW
    // result would let a later raycast mutate already-stored hit bytes.
    direction: ray.direction.clone(),
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

