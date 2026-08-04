import * as BABYLON from '@babylonjs/core'
import { limits } from '../../../misc/limits'
import { limitLogger } from '../../../misc/limit-logger'

/**
 * Default radius for both ends of a CylinderMesh, per the protocol
 * (`mesh_renderer.proto` / `mesh_collider.proto`: "(default 0.5)"). An absent
 * `radiusTop`/`radiusBottom` means 0.5 — NOT 0, which is what `?? 0` or a bare
 * `radiusTop!` would produce and would collapse the cylinder into a cone.
 *
 * Deliberately module-private: it is the fallback for a value this module owns,
 * and a second copy of "the default radius" living at a call site is how the two
 * drift apart.
 */
const CYLINDER_DEFAULT_RADIUS = 0.5

/**
 * Extent of every primitive along each axis it occupies: the box's edge, the
 * sphere's diameter, the cylinder's height, and the plane's width AND height.
 * The protocol describes each primitive as the shape "that contains the Entity" —
 * i.e. it fits the unit box at the entity origin and is then scaled by the entity
 * Transform. The reference client uses the same unit sizes (`PrimitivesSize`:
 * CUBE_SIZE 1, SPHERE_RADIUS 0.5, CYLINDER_HEIGHT 1, PLANE_SIZE 1x1).
 */
export const PRIMITIVE_UNIT_SIZE = 1

/**
 * Radial segments per cylinder, matching the reference client's
 * `CylinderVariantsFactory.VERTICES_NUM = 50`. Babylon's default is 24, which is
 * not a cosmetic difference on a headless authoritative server: the chord error of
 * a 24-gon is 0.86% of the radius against 0.20% for a 50-gon, so a raycast that
 * grazes a cylinder resolves its hit point (and, near the silhouette, hit-or-miss)
 * differently from the client that asked. Same tessellation, same answer.
 */
const CYLINDER_TESSELLATION = 50

/**
 * Clamps a scene-supplied radius to a finite, non-negative, bounded value.
 *
 * `radiusTop`/`radiusBottom` arrive from an untrusted scene as protobuf floats, so
 * Infinity, NaN, negatives and 3.4e38 all reach MeshBuilder. None of them throw —
 * they build a mesh that passes every downstream check and is silently dead:
 * `radiusTop = Infinity` produces vertex data carrying 52 NaN and 98 Infinity
 * floats and an extendSize of [Infinity, 0.5, Infinity], yet the mesh still gets
 * `isPickable`, `checkCollisions` and a `floorMeshes` slot while
 * `ray.intersectsMesh` can NEVER hit it — a collider the scene believes in and no
 * raycast ever finds. Negative radii invert the winding, and a 3.4e38 radius makes
 * a collider hittable from a million metres away. NaN happens to survive today only
 * because Babylon's cylinderBuilder treats a falsy diameter as 1; that is an
 * accident of a `||` default, not a guarantee, and must not be relied on.
 *
 * Not finite -> the protocol default (there is no sane reading of Infinity/NaN);
 * negative -> 0 (a cone tip, the nearest valid shape, with correct winding);
 * above the ceiling -> the ceiling.
 */
function clampRadius(radius: number | undefined, field: 'radiusTop' | 'radiusBottom'): number {
  const requested = radius ?? CYLINDER_DEFAULT_RADIUS

  const clamped = Number.isFinite(requested)
    ? Math.min(Math.max(requested, 0), limits.maxPrimitiveRadiusMeters)
    : CYLINDER_DEFAULT_RADIUS

  // NaN !== NaN, so the non-finite substitution reports here too. Throttled by
  // limitLogger: a scene can PUT a hostile MeshCollider every frame.
  if (clamped !== requested) {
    limitLogger.hit('maxPrimitiveRadiusMeters', `cylinder ${field}=${requested}`)
  }

  return clamped
}

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
      diameterTop: clampRadius(radiusTop, 'radiusTop') * 2,
      diameterBottom: clampRadius(radiusBottom, 'radiusBottom') * 2,
      tessellation: CYLINDER_TESSELLATION,
      updatable: false
    },
    scene
  )
}
