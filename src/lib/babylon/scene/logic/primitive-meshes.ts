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
 *
 * Module-private now that every primitive is built here: exporting it would invite
 * a call site to hand-roll a MeshBuilder call again, which is how the collider and
 * the mesh it stands in for drift apart on the parameters this constant does NOT
 * cover (tessellation, segments, side orientation).
 */
const PRIMITIVE_UNIT_SIZE = 1

/**
 * Radius of the unit sphere every SphereMesh builds, matching the client's
 * `PrimitivesSize.SPHERE_RADIUS = 0.5f`. Exported so the analytic raycast path can
 * describe the same sphere the tessellated mesh approximates — the two must agree
 * or a scene gets different hits depending on which path ran.
 */
export const PRIMITIVE_SPHERE_RADIUS = PRIMITIVE_UNIT_SIZE / 2

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
 * Latitude steps per sphere. Pinned for the same reason as CYLINDER_TESSELLATION —
 * a Babylon default silently changing would move every sphere collider — but
 * chosen on different grounds, because there is nothing to match: the reference
 * client's sphere collider is an ANALYTIC `UnityEngine.SphereCollider`, exact at
 * every angle, so no polygon count reproduces it. The choice is purely
 * accuracy-versus-cost, and the sphere is by far the most expensive primitive
 * collider we build.
 *
 * Babylon's `segments` counts LATITUDE steps; the equator is drawn as a
 * `2 * (segments + 2)`-gon, which is the polygon whose chord error a grazing ray
 * actually sees. Measured (diameter 1, Babylon 6.4.1):
 *
 *   segments  8 -> 20-gon equator,   400 tris, 1.231% chord error
 *   segments 16 -> 36-gon equator,  1296 tris, 0.381% chord error
 *   segments 24 -> 52-gon equator,  2704 tris, 0.182% chord error
 *   segments 32 -> 68-gon equator,  4624 tris, 0.107% chord error   (Babylon default)
 *
 * 16 buys 3.6x fewer triangles than Babylon's implicit default for an error of
 * 0.38% of the radius — inside the 0.86% this codebase tolerated for cylinders
 * before they were pinned to 50, and under 2mm on a unit-diameter sphere. The
 * error has a known sign: an inscribed polyhedron is always *inside* the true
 * sphere, so a grazing ray misses marginally earlier here than against the
 * reference client's exact collider, bounded by that 0.38%.
 */
const SPHERE_SEGMENTS = 16

/**
 * Clamps a scene-supplied radius to a finite, bounded, non-negative value.
 *
 * `radiusTop`/`radiusBottom` arrive from an untrusted scene as protobuf floats, so
 * Infinity, NaN, negatives and 3.4e38 all reach MeshBuilder. None of them throw —
 * they build a mesh that passes every downstream check and is silently dead:
 * `radiusTop = Infinity` produces, at this module's tessellation, vertex data
 * carrying 104 NaN and 202 Infinity floats and an extendSize of
 * [Infinity, 0.5, Infinity], yet the mesh still gets `isPickable`,
 * `checkCollisions` and a `floorMeshes` slot while `ray.intersectsMesh` can NEVER
 * hit it — a collider the scene believes in and no raycast ever finds. A 3.4e38
 * radius is the mirror image: a collider hittable from a million metres away, which
 * no other client agrees with. NaN happens to survive today only because Babylon's
 * cylinderBuilder treats a falsy diameter as 1; that is an accident of a `||`
 * default, not a guarantee, and must not be relied on.
 *
 * Not finite -> the protocol default (there is no sane reading of Infinity/NaN);
 * above the ceiling -> the ceiling;
 * negative -> its ABSOLUTE VALUE.
 *
 * The abs is the load-bearing part. Clamping a negative radius to 0 — which this
 * used to do — reintroduced the exact failure the rest of this function exists to
 * prevent: measured at tessellation 50, a 0 radius still leaves a ring of radius
 * 5e-6, a five-micron surface a ray only finds within 5e-6 of the axis (hit at
 * x=5e-6, miss at x=1e-5) while the mesh keeps isPickable, checkCollisions and its
 * floorMeshes slot. The reference client does not clamp at all: it hands the raw
 * negative to the mesh builder, which builds a full radius-1 cylinder for -1.
 *
 * Abs reproduces that, and not approximately. Negating a radius rotates the ring by
 * 180 degrees, and CYLINDER_TESSELLATION is even, so the 50-gon maps onto itself:
 * measured, the raw-negative and abs builds carry the same 102 distinct vertex
 * positions and the same triangle set with winding preserved. (The raw position
 * ARRAY is a rotated permutation of those values, so a naive per-index diff reports
 * a difference the surface does not have. At an odd tessellation the two surfaces
 * genuinely would differ — the argument depends on 50 being even.) Winding is not
 * inverted either: a rotation preserves orientation, and the side normals point
 * outward in both builds.
 *
 * Caveat for MIXED signs (radiusTop -1, radiusBottom 0.5): the reference builds a
 * self-intersecting hourglass — measured, half the side triangles twist across the
 * axis. That is not a shape worth reproducing on a collider, so abs is the closest
 * sane one rather than an exact match.
 */
function clampRadius(radius: number | undefined, field: 'radiusTop' | 'radiusBottom'): number {
  const requested = radius ?? CYLINDER_DEFAULT_RADIUS

  const clamped = Number.isFinite(requested)
    ? Math.min(Math.abs(requested), limits.maxPrimitiveRadiusMeters)
    : CYLINDER_DEFAULT_RADIUS

  // NaN !== NaN, so the non-finite substitution reports here too. Throttled by
  // limitLogger: a scene can PUT a hostile MeshCollider every frame.
  if (clamped !== requested) {
    limitLogger.hit('maxPrimitiveRadiusMeters', `cylinder ${field}=${requested}`)
  }

  return clamped
}

// Every primitive MeshRenderer and MeshCollider shape is built here, by exactly one
// function per shape, because the two components must never disagree about geometry:
// a collider whose shape differs from the mesh it stands in for resolves raycasts and
// pointer picks at coordinates no client agrees with. Sharing only PRIMITIVE_UNIT_SIZE
// was not enough — it says nothing about `segments`, `tessellation` or
// `sideOrientation`, which are the parameters most likely to be tuned later and the
// ones that actually set where a ray lands.
//
// `name` is a parameter rather than a constant because setColliderMask keys off a
// `_collider` suffix (it attaches the collider material and registers the mesh as a
// floor candidate), so collider callers pass a `..._collider` name and renderer
// callers do not.

/** Builds a unit cube for a BoxMesh, shared by MeshRenderer and MeshCollider. */
export function createBoxMesh(scene: BABYLON.Scene, name: string): BABYLON.Mesh {
  return BABYLON.MeshBuilder.CreateBox(name, { size: PRIMITIVE_UNIT_SIZE, updatable: false }, scene)
}

/** Builds a diameter-1 sphere for a SphereMesh, shared by MeshRenderer and MeshCollider. */
export function createSphereMesh(scene: BABYLON.Scene, name: string): BABYLON.Mesh {
  return BABYLON.MeshBuilder.CreateSphere(
    name,
    { diameter: PRIMITIVE_UNIT_SIZE, segments: SPHERE_SEGMENTS, updatable: false },
    scene
  )
}

/**
 * Builds a 1x1 quad for a PlaneMesh, shared by MeshRenderer and MeshCollider.
 *
 * The two callers deliberately disagree, which is why both flags are explicit
 * parameters instead of one shared default:
 *
 * - `doubleSided`: the RENDERER passes true (a PlaneMesh is visible from both sides
 *   and the protocol's UV map carries 16 values — "2D * 1 face * 2 sides * 4
 *   vertices"). The COLLIDER passes false and is still hit from behind, because
 *   nothing about a collider is culled by side: Babylon's ray/triangle test does not
 *   backface-cull at all, and the collision engine's back-face skip is unreachable
 *   (see mesh-collider-component). DOUBLESIDE there would only double the geometry —
 *   8 vertices / 4 triangles instead of 4 / 2 — for no behavioural gain.
 * - `updatable`: only the renderer overwrites UVs after the build, from the
 *   scene-supplied `uvs` field.
 *
 * (The reference client approximates the collider with a 0.01-deep box because
 * Unity's BoxCollider cannot be flat; Babylon picks and collides against a genuine
 * plane, so no thickness fudge is needed.)
 */
/**
 * Depth of the plane COLLIDER, matching the reference client's
 * `PrimitivesSize.PLANE_SIZE = (1, 1, 0.01f)`.
 *
 * The client cannot express a flat collider at all — a Unity `BoxCollider` has no
 * zero-thickness form — so it approximates a PlaneMesh with a 1cm-deep box. This
 * server previously built a true zero-thickness quad, which is arguably a better
 * model of "a 2D rectangle" but put the collision surface up to 5mm away from
 * where the client puts it, in both directions.
 *
 * Matched rather than improved on: this is an authoritative server, so the value
 * of agreeing with what every player's client computes outweighs being 5mm more
 * faithful to the protocol's prose. The RENDERER plane stays a true quad — it is
 * drawn, not collided with, and the client draws a quad too.
 */
const PLANE_COLLIDER_DEPTH = 0.01

/**
 * Builds the collider box for a PlaneMesh: a 1x1 quad with the client's 1cm of
 * depth. See PLANE_COLLIDER_DEPTH for why this is a box and not a quad.
 */
export function createPlaneColliderMesh(scene: BABYLON.Scene, name: string): BABYLON.Mesh {
  return BABYLON.MeshBuilder.CreateBox(
    name,
    {
      width: PRIMITIVE_UNIT_SIZE,
      height: PRIMITIVE_UNIT_SIZE,
      depth: PLANE_COLLIDER_DEPTH,
      updatable: false
    },
    scene
  )
}

export function createPlaneMesh(
  scene: BABYLON.Scene,
  name: string,
  { doubleSided, updatable }: { doubleSided: boolean; updatable: boolean }
): BABYLON.Mesh {
  return BABYLON.MeshBuilder.CreatePlane(
    name,
    {
      width: PRIMITIVE_UNIT_SIZE,
      height: PRIMITIVE_UNIT_SIZE,
      sideOrientation: doubleSided ? BABYLON.Mesh.DOUBLESIDE : BABYLON.Mesh.DEFAULTSIDE,
      updatable
    },
    scene
  )
}

/**
 * Builds a truncated-cone mesh for a CylinderMesh, shared by MeshRenderer and
 * MeshCollider.
 *
 * Unlike the box/sphere/plane primitives this one CANNOT be a memoized template
 * cloned per entity: `radiusTop`/`radiusBottom` are part of the component value,
 * so two entities with different radii need different vertex data. Cloning a
 * single template would silently give every cylinder the first one's shape.
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
