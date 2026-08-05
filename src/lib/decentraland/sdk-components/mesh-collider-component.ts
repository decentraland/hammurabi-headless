import { declareComponentUsingProtobufJs } from "./pb-based-component-helper";
import { ColliderLayer, PBMeshCollider } from "@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen";
import { ComponentType } from "../crdt-internal/components";
import { Mesh, Scene } from '@babylonjs/core';
import { setColliderMask } from "../../babylon/scene/logic/colliders";
import {
  createBoxMesh,
  createCylinderMesh,
  createPlaneColliderMesh,
  createSphereMesh
} from "../../babylon/scene/logic/primitive-meshes";
import { memoize } from "../../misc/memoize";
import { createRateLimitedErrorLogger } from "../../misc/logger";
import type { BabylonEntity } from "../../babylon/scene/BabylonEntity";

// Unit-sized templates, cloned per entity so every collider of a given shape
// shares one geometry instead of building fresh vertex buffers per PUT (same
// pattern as mesh-renderer-component's baseBox).
//
// The geometry itself comes from primitive-meshes, which the renderer also builds
// from: sharing PRIMITIVE_UNIT_SIZE alone left `segments` and `sideOrientation`
// free to drift between a collider and the mesh it stands in for.
//
// Every name ends in `_collider`: setColliderMask keys off that suffix to attach
// the collider material and register the mesh as a floor candidate.
//
// Templates are built DISABLED and clones inherit that (Babylon's `isEnabled()`
// walks to the parent-most flag and `clone()` copies the node's own), so every
// call site below must re-enable its clone — see createColliderMesh's caller.
const baseColliderBox = memoize((scene: Scene) => {
  const ret = createBoxMesh(scene, 'base-box_collider')
  ret.setEnabled(false)
  return ret
})

const baseColliderSphere = memoize((scene: Scene) => {
  const ret = createSphereMesh(scene, 'base-sphere_collider')
  ret.setEnabled(false)
  return ret
})

const baseColliderPlane = memoize((scene: Scene) => {
  // A 1x1 quad with the reference client's 1cm of depth
  // (`PrimitivesSize.PLANE_SIZE = (1, 1, 0.01f)`), NOT the true zero-thickness
  // quad this used to build. Unity cannot express a flat collider — a BoxCollider
  // has no zero-thickness form — so the client approximates a PlaneMesh with a
  // thin box, and an authoritative server that puts the collision surface up to
  // 5mm from where every player's client puts it is wrong in the way that matters.
  //
  // The zero-thickness quad was verified to work (Babylon's ray test is not
  // backface-culled, and `moveWithCollisions` blocks from both faces without
  // tunnelling even at dz=40) — it was a defensible reading of the protocol's "2D
  // rectangle", just not the client's. The RENDERER keeps its real quad: that one
  // is drawn rather than collided with, and the client draws a quad too.
  //
  // Costs nothing extra to raycast despite going from 2 triangles to 12: both are
  // under TRIANGLE_COST_FLOOR, so both bill 12.
  const ret = createPlaneColliderMesh(scene, 'base-plane_collider')
  ret.setEnabled(false)
  return ret
})

// Reached once per accepted PUT, so a scene sending an unsupported shape every
// frame would otherwise flood stdout.
const logUnsupportedShape = createRateLimitedErrorLogger()

/**
 * Builds the collider mesh for a MeshCollider value, or null when the component
 * carries no shape.
 *
 * Returning null for an unset `mesh` oneof matches the reference client
 * (`InstantiatePrimitiveColliderSystem`: `if (MeshCase == None) return;`).
 * This used to fall through to a box, which fabricated an invisible 1×1×1
 * collider the client never had.
 *
 * An UNKNOWN `$case` returns null too but is not silent — see the default arm.
 */
function createColliderMesh(entity: BabylonEntity, value: PBMeshCollider): Mesh | null {
  const scene = entity.getScene()

  switch (value.mesh?.$case) {
    case 'box':
      return baseColliderBox(scene).clone('box_collider', entity)
    case 'sphere':
      return baseColliderSphere(scene).clone('sphere_collider', entity)
    case 'plane':
      return baseColliderPlane(scene).clone('plane_collider', entity)
    case 'cylinder': {
      const { radiusTop, radiusBottom } = value.mesh.cylinder
      return createCylinderMesh(scene, 'cylinder_collider', radiusTop, radiusBottom)
    }
    default: {
      // Two very different situations land here and only one of them is normal.
      // An unset oneof is the legitimate "no collider" case above — silent. An
      // unknown $case means @dcl/protocol (resolved at USER-INSTALL time, so it can
      // be newer than this build) declared a shape we do not implement: the entity
      // ends up colliderless while the scene believes it has a collider, and
      // swallowing that makes protocol drift indistinguishable from a scene bug.
      // TS narrows the exhaustive union to `undefined` here; the runtime value is
      // whatever the installed decoder produced, which is exactly the point.
      const unsupportedCase = (value.mesh as { $case?: string } | undefined)?.$case
      if (unsupportedCase) {
        logUnsupportedShape(
          `MeshCollider: unsupported mesh shape "${unsupportedCase}", no collider was built for this entity.` +
            ` @dcl/protocol is likely newer than this hammurabi build.`,
          undefined
        )
      }
      return null
    }
  }
}

export const meshColliderComponent = declareComponentUsingProtobufJs(PBMeshCollider, 1019, (entity, componentStorage) => {
  // this function is called when we receive the component and a change needs to be applied to the entity
  if (componentStorage.componentType !== ComponentType.LastWriteWinElementSet) return

  const newValue = componentStorage.getOrNull(entity.entityId)
  const currentValue = entity.appliedComponents.meshCollider

  const isAddingNewValue = Boolean(!currentValue && newValue)
  const isReplacingValue = Boolean(currentValue && newValue)
  const isRemovingValue = Boolean(currentValue && !newValue)

  if (isReplacingValue || isRemovingValue) {
    if (currentValue?.collider) {
      currentValue.collider.dispose()
    }
    // Clear eagerly so a removal doesn't leave a stale reference to the
    // disposed collider (the replace path below reassigns it).
    entity.appliedComponents.meshCollider = undefined
  }

  if (isAddingNewValue || isReplacingValue) {
    const collider = createColliderMesh(entity, newValue!)

    if (collider) {
      // Load-bearing for the box/sphere/plane clones: their templates are built
      // disabled and `clone()` inherits that, so without this every one of them
      // ships disabled and `collisionCoordinator.js` (`if (mesh.isEnabled() &&
      // mesh.checkCollisions && ...)`) skips it — the avatar walks straight
      // through, and the whole CL_PHYSICS half of the component is silently dead.
      // `Ray.intersectsMesh` does NOT check isEnabled, so pointer picks keep
      // working and hide the breakage.
      collider.setEnabled(true)

      const DEFAULT_COLLIDER_LAYERS = ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER
      setColliderMask(collider, newValue?.collisionMask ?? DEFAULT_COLLIDER_LAYERS)
      // Set explicitly rather than relying on clone(name, parent): the cylinder
      // is built fresh (its geometry depends on the component value) and so has
      // no parent yet.
      collider.parent = entity
    }

    // Stored even when `collider` is null so a later DELETE_COMPONENT still sees
    // an entry to clear — mirroring how meshRenderer keeps `{ mesh: null, info }`
    // for a shape it cannot build.
    entity.appliedComponents.meshCollider = {
      collider,
      info: newValue!
    }
  }
})
