import * as BABYLON from '@babylonjs/core'

/**
 * Default radius for both ends of a CylinderMesh, per the protocol
 * (`mesh_renderer.proto` / `mesh_collider.proto`: "(default 0.5)"). An absent
 * `radiusTop`/`radiusBottom` means 0.5 — NOT 0, which is what `?? 0` or a bare
 * `radiusTop!` would produce and would collapse the cylinder into a cone.
 */
export const CYLINDER_DEFAULT_RADIUS = 0.5

/**
 * Height of every primitive along its major axis. The protocol describes each
 * primitive as the shape "that contains the Entity" — i.e. it fits the unit box
 * at the entity origin and is then scaled by the entity Transform. The reference
 * client uses the same unit sizes (`PrimitivesSize`: CUBE_SIZE 1,
 * SPHERE_RADIUS 0.5).
 */
export const PRIMITIVE_UNIT_SIZE = 1

/**
 * Builds a truncated-cone mesh for a CylinderMesh, shared by MeshRenderer and
 * MeshCollider.
 *
 * Unlike the box/sphere/plane primitives this one CANNOT be a memoized template
 * cloned per entity: `radiusTop`/`radiusBottom` are part of the component value,
 * so two entities with different radii need different vertex data. Cloning a
 * single template would silently give every cylinder the first one's shape.
 *
 * Kept here rather than duplicated at the two call sites because a collider
 * whose geometry disagrees with the mesh it stands in for is exactly the class
 * of bug this module exists to prevent: raycasts and pointer picks would report
 * hits at coordinates no client agrees with.
 */
export function createCylinderMesh(
  scene: BABYLON.Scene,
  name: string,
  radiusTop: number | undefined,
  radiusBottom: number | undefined
): BABYLON.Mesh {
  return BABYLON.MeshBuilder.CreateCylinder(
    name,
    {
      height: PRIMITIVE_UNIT_SIZE,
      // Babylon takes diameters; the protocol specifies radii.
      diameterTop: (radiusTop ?? CYLINDER_DEFAULT_RADIUS) * 2,
      diameterBottom: (radiusBottom ?? CYLINDER_DEFAULT_RADIUS) * 2,
      updatable: false
    },
    scene
  )
}
