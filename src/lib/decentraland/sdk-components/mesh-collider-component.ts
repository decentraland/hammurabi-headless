import { declareComponentUsingProtobufJs } from "./pb-based-component-helper";
import { ColliderLayer, PBMeshCollider } from "@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen";
import { ComponentType } from "../crdt-internal/components";
import { Mesh, MeshBuilder, Scene } from '@babylonjs/core';
import { setColliderMask } from "../../babylon/scene/logic/colliders";
import { createCylinderMesh, PRIMITIVE_UNIT_SIZE } from "../../babylon/scene/logic/primitive-meshes";
import { memoize } from "../../misc/memoize";
import { createRateLimitedErrorLogger } from "../../misc/logger";
import type { BabylonEntity } from "../../babylon/scene/BabylonEntity";

// Unit-sized templates, cloned per entity so every collider of a given shape
// shares one geometry instead of building fresh vertex buffers per PUT (same
// pattern as mesh-renderer-component's baseBox).
//
// Every name ends in `_collider`: setColliderMask keys off that suffix to attach
// the collider material and register the mesh as a floor candidate.
const baseColliderBox = memoize((scene: Scene) => {
  // Sizes stated rather than inherited from Babylon's defaults: the unit size is a
  // protocol fact (the shape "contains the Entity" and is scaled by its Transform),
  // and a Babylon default silently changing would move every collider.
  const ret = MeshBuilder.CreateBox('base-box_collider', { size: PRIMITIVE_UNIT_SIZE, updatable: false }, scene)
  ret.setEnabled(false)
  return ret
})

const baseColliderSphere = memoize((scene: Scene) => {
  // Diameter 1 — the reference client's SPHERE_RADIUS 0.5.
  const ret = MeshBuilder.CreateSphere(
    'base-sphere_collider',
    { diameter: PRIMITIVE_UNIT_SIZE, updatable: false },
    scene
  )
  ret.setEnabled(false)
  return ret
})

const baseColliderPlane = memoize((scene: Scene) => {
  // A real quad, matching the protocol's "2D rectangle described by the Entity's
  // Transform" and the geometry mesh-renderer-component builds for a PlaneMesh.
  //
  // SINGLE-sided on purpose, and it is still hit from behind: Babylon's
  // ray/triangle test does not backface-cull, and the collision engine culls back
  // faces only for meshes with no material (`Collisions/collider.js`:
  // `if (!hasMaterial && !trianglePlane.isFrontFacingTo(...)) return`) while
  // setColliderMask assigns colliderMaterial to every `_collider` mesh. Nothing
  // renders a collider, so Mesh.DOUBLESIDE would only double the vertex count
  // (8 vertices / 4 triangles instead of 4 / 2) for no behavioural gain.
  //
  // (The reference client approximates this with a 0.01-deep box because Unity's
  // BoxCollider cannot be flat; Babylon picks and collides against a genuine
  // plane, so no thickness fudge is needed.)
  const ret = MeshBuilder.CreatePlane(
    'base-plane_collider',
    {
      width: PRIMITIVE_UNIT_SIZE,
      height: PRIMITIVE_UNIT_SIZE,
      updatable: false
    },
    scene
  )
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
