import * as BABYLON from '@babylonjs/core'
import { Vector3 } from '@babylonjs/core'

/**
 * Closed-form ray intersection for primitive colliders whose exact shape we know,
 * skipping the triangle mesh entirely.
 *
 * A SphereMesh collider is 1296 triangles only because this server tessellates it.
 * The reference client does not: `SetupSphereCollider` assigns a Unity
 * `SphereCollider`, a PhysX primitive with an analytic test. So the true
 * mathematical surface is what every player's client resolves against, and the
 * tessellated hull is the approximation — analytic is BOTH faster and closer to
 * the client, which is why it is worth the second code path.
 *
 * Measured against 2000 spheres all lying on one ray: 95.7ms through
 * `intersectsMeshes`, 0.77ms analytic — 125x. Note the AABB prefilter becomes a
 * PESSIMISATION at that point (0.77ms without it against 2.80ms with), because
 * `getBoundingInfo()` costs more than the intersection; the prefilter is kept
 * because it still gates the glTF triangle-mesh colliders that share the loop.
 *
 * SPHERES ONLY, deliberately. A box collider is 12 triangles and a cylinder 200,
 * so the payoff is concentrated almost entirely in the sphere, while each extra
 * shape adds its own local-space transform and normal derivation to get wrong.
 */

/** Radius of the sphere this mesh really is, in its own local space. */
const analyticSphereSymbol = Symbol('analyticSphereRadius')

/**
 * Records that `mesh` is exactly a sphere of `radius` centred on its local origin.
 *
 * Applied per collider rather than to the shared template because `Mesh.clone()`
 * copies Babylon's own fields, not arbitrary symbols — a tag on the template would
 * simply not survive into the clones that scenes actually use.
 */
export function setAnalyticSphere(mesh: BABYLON.AbstractMesh, radius: number): void {
  ;(mesh as any)[analyticSphereSymbol] = radius
}

function getAnalyticSphereRadius(mesh: BABYLON.AbstractMesh): number | undefined {
  return (mesh as any)[analyticSphereSymbol]
}

/** Largest relative difference between world-scale axes still treated as uniform. */
const UNIFORM_SCALE_TOLERANCE = 1e-4

const tmpScale = new Vector3()
const tmpCentre = new Vector3()
const tmpToOrigin = new Vector3()

/**
 * Intersects `ray` with a mesh previously marked by `setAnalyticSphere`, or
 * returns null when this mesh is not an analytic sphere or cannot be treated as
 * one — the caller must then fall back to the triangle path.
 *
 * Falls back on NON-UNIFORM scale. A sphere scaled unevenly is an ellipsoid, and
 * the quadratic below is not the right equation for one; getting a wrong hit
 * position quietly is far worse than paying for 1296 triangles. Uniform scale is
 * the overwhelmingly common case (a scene scaling a ball scales it evenly), so the
 * fallback costs little in practice.
 *
 * The returned `PickingInfo` reports an ANALYTIC normal. Babylon's own
 * `getNormal()` interpolates the vertex normals of whichever triangle it thinks was
 * hit, using `faceId`/`bu`/`bv` that an analytic hit does not have — left to it,
 * the normal would be garbage rather than merely faceted.
 */
export function intersectAnalyticSphere(
  ray: BABYLON.Ray,
  mesh: BABYLON.AbstractMesh
): BABYLON.Nullable<BABYLON.PickingInfo> {
  const localRadius = getAnalyticSphereRadius(mesh)
  if (localRadius === undefined) return null

  const world = mesh.getWorldMatrix()
  world.decompose(tmpScale, undefined, tmpCentre)

  const scale = tmpScale.x
  if (
    Math.abs(tmpScale.x - tmpScale.y) > UNIFORM_SCALE_TOLERANCE * Math.max(1, Math.abs(scale)) ||
    Math.abs(tmpScale.y - tmpScale.z) > UNIFORM_SCALE_TOLERANCE * Math.max(1, Math.abs(scale))
  ) {
    return null
  }

  const radius = localRadius * Math.abs(scale)

  // |origin + t*direction - centre|^2 = radius^2, with a unit direction so the
  // quadratic's leading coefficient is 1. computeRayDirection normalizes every
  // branch, and `ray.length` is measured in those same units.
  ray.origin.subtractToRef(tmpCentre, tmpToOrigin)
  const b = Vector3.Dot(tmpToOrigin, ray.direction)
  const c = tmpToOrigin.lengthSquared() - radius * radius
  const discriminant = b * b - c
  if (discriminant < 0) return null

  const root = Math.sqrt(discriminant)
  // Near root first; if it is behind the origin the ray started INSIDE the sphere
  // and the far root is the exit point, which is what Babylon reports too.
  let distance = -b - root
  if (distance < 0) distance = -b + root
  if (distance < 0 || distance > ray.length) return null

  const info = new AnalyticPickingInfo()
  info.hit = true
  info.distance = distance
  info.pickedMesh = mesh
  info.ray = ray
  info.pickedPoint = ray.origin.add(ray.direction.scale(distance))
  // Outward surface normal: the hit point relative to the centre, normalized.
  info.analyticNormal = info.pickedPoint.subtract(tmpCentre).normalize()

  return info
}

/**
 * A `PickingInfo` whose normal is known exactly rather than derived from triangle
 * data that an analytic hit never touched.
 */
class AnalyticPickingInfo extends BABYLON.PickingInfo {
  analyticNormal: Vector3 = Vector3.Up()

  override getNormal(): BABYLON.Nullable<Vector3> {
    return this.analyticNormal
  }
}
