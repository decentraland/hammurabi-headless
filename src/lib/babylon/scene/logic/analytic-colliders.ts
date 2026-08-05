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
 * Measured two ways, because the two numbers get quoted interchangeably and mean
 * different things: 2000 spheres all lying on one ray cost 95.7ms through
 * `intersectsMeshes` against 0.77ms analytic (125x) for the intersection ALONE,
 * while a full `processRaycasts` over the same scene went 74.03ms -> 3.02ms (24x).
 * The 24x is the honest end-to-end figure; the prefilter, the world-matrix sweep and
 * the result build are all still there.
 *
 * Note the AABB prefilter becomes a PESSIMISATION for the intersection microbenchmark
 * (0.77ms without it against 2.80ms with), because `getBoundingInfo()` costs more than
 * the closed-form solve; it is kept because it still gates the glTF triangle-mesh
 * colliders that share the loop.
 *
 * SPHERES ONLY, deliberately. A box collider is 12 triangles and a cylinder 200,
 * so the payoff is concentrated almost entirely in the sphere, while each extra
 * shape adds its own local-space transform and normal derivation to get wrong.
 */

/** Radius of the sphere this mesh really is, in its own local space. */
const analyticSphereSymbol = Symbol('analyticSphereRadius')

/**
 * Returned by `resolveAnalyticSphere` for a mesh that cannot be solved in closed
 * form. Distinguishable from every real answer because a world radius is
 * `localRadius * Math.abs(scale)` with a non-zero scale, hence strictly positive.
 */
export const NOT_ANALYTIC = -1

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
 * The world-space radius `mesh` can be intersected with in closed form, or
 * `NOT_ANALYTIC` when it cannot be.
 *
 * Split out from the intersection for the RAYCAST BUDGET's sake, and that split is
 * load-bearing in both directions.
 *
 * Billing an analytic sphere its 1296 tessellated triangles made a raycast crossing
 * ~463 of them exceed the whole per-frame triangle ceiling and be answered with an
 * EMPTY result — permanently, for a continuous raycast — when its real cost is under a
 * millisecond. A refusal is not a deferral, so that scene never recovered.
 *
 * But billing the floor for merely being TAGGED was worse. `intersectAnalyticSphere`
 * bails on non-uniform scale (an ellipsoid is not this equation) and the caller then
 * walks all 1296 triangles, so `scale: (1, 2, 1)` on a SphereMesh collider — a
 * one-line, scene-controlled change — was billed 12 for work costing 1296, a 108x
 * undercount. Measured: 2000 non-uniform spheres on one ray took 95.1ms in a single
 * `processRaycasts` while charging 24_000 of the 600_000 budget, and at the ceilings
 * 50_000 of them bill exactly the budget and all run in one ~2.4s frame with both
 * ceilings reporting themselves satisfied. Before the analytic path existed they were
 * billed 1296 each and refused instantly, so the optimisation had opened the very hole
 * this file's cost note describes for un-indexed glTF meshes.
 *
 * So the cost decision has to be the SAME decision the intersection will make, taken
 * before any triangle work runs. This function is that decision; the budget bills the
 * floor only when the answer is a real radius, and the intersection is handed that
 * radius so the check is not paid for twice.
 */
export function resolveAnalyticSphere(mesh: BABYLON.AbstractMesh): number {
  const localRadius = getAnalyticSphereRadius(mesh)
  if (localRadius === undefined) return NOT_ANALYTIC

  const world = mesh.getWorldMatrix()
  world.decompose(tmpScale, undefined, tmpCentre)

  // NON-FINITE FIRST, and on ALL THREE scale components rather than just x.
  // `transform-component.ts` reads position/rotation/scale as raw readFloat32 with no
  // finiteness validation, so a scene can send NaN in any of them.
  //
  // The ordering matters because `Math.abs(NaN - NaN) > tol` is FALSE, so a NaN sails
  // through the uniform-scale check below. Checking only `x` left exactly that hole
  // open one axis over: with `scale: (1, NaN, 1)` the x component is finite and
  // non-zero, the centre is finite, and the uniform test evaluates
  // `Math.abs(1 - NaN) > tol` and `Math.abs(NaN - 1) > tol` — both false — so the
  // mesh was accepted and reported a PHANTOM HIT (measured: analytic
  // `{hit: true, distance: 9.5}` where `ray.intersectsMesh(...).hit === false`),
  // serialized into the scene's CRDT every frame. `pickClosest` even lets a NaN
  // distance win. The triangle path cleanly misses the same mesh.
  if (!Number.isFinite(tmpScale.x) || !Number.isFinite(tmpScale.y) || !Number.isFinite(tmpScale.z)) {
    return NOT_ANALYTIC
  }
  if (!Number.isFinite(tmpCentre.x) || !Number.isFinite(tmpCentre.y) || !Number.isFinite(tmpCentre.z)) {
    return NOT_ANALYTIC
  }

  const scale = tmpScale.x

  // Radius 0 is rejected too: a zero-scaled sphere otherwise reports a hit for any ray
  // aimed exactly at its centre, where the triangle path has no geometry to hit.
  if (scale === 0) return NOT_ANALYTIC

  // Falls back on NON-UNIFORM scale. A sphere scaled unevenly is an ellipsoid, and the
  // quadratic in `intersectAnalyticSphere` is not the right equation for one; getting a
  // wrong hit position quietly is far worse than paying for 1296 triangles. Uniform
  // scale is the overwhelmingly common case (a scene scaling a ball scales it evenly).
  const tolerance = UNIFORM_SCALE_TOLERANCE * Math.max(1, Math.abs(scale))
  if (Math.abs(tmpScale.x - tmpScale.y) > tolerance || Math.abs(tmpScale.y - tmpScale.z) > tolerance) {
    return NOT_ANALYTIC
  }

  return localRadius * Math.abs(scale)
}

/**
 * Intersects `ray` with a mesh previously marked by `setAnalyticSphere`, or returns
 * null when this mesh is not an analytic sphere or cannot be treated as one — the
 * caller must then fall back to the triangle path.
 *
 * `worldRadius` defaults to resolving the mesh here, which is what the specs use.
 * `processRaycasts` passes the value it already resolved for billing, so the shared
 * decision is made exactly once per candidate per raycast.
 *
 * The returned `PickingInfo` reports an ANALYTIC normal. Babylon's own `getNormal()`
 * interpolates the vertex normals of whichever triangle it thinks was hit, using
 * `faceId`/`bu`/`bv` that an analytic hit does not have — left to it, the normal would
 * be garbage rather than merely faceted.
 */
export function intersectAnalyticSphere(
  ray: BABYLON.Ray,
  mesh: BABYLON.AbstractMesh,
  worldRadius: number = resolveAnalyticSphere(mesh)
): BABYLON.Nullable<BABYLON.PickingInfo> {
  if (worldRadius === NOT_ANALYTIC) return null

  // Just the translation, not another `decompose`: the centre of a sphere centred on
  // its own local origin IS its world matrix's translation, and `resolveAnalyticSphere`
  // already established that it is finite.
  mesh.getWorldMatrix().getTranslationToRef(tmpCentre)

  // |origin + t*direction - centre|^2 = radius^2, with a unit direction so the
  // quadratic's leading coefficient is 1. computeRayDirection normalizes every
  // branch, and `ray.length` is measured in those same units.
  ray.origin.subtractToRef(tmpCentre, tmpToOrigin)
  const b = Vector3.Dot(tmpToOrigin, ray.direction)
  const c = tmpToOrigin.lengthSquared() - worldRadius * worldRadius
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
