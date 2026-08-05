import * as BABYLON from '@babylonjs/core'
import { Quaternion, Ray, Vector3 } from '@babylonjs/core'
import { Scene } from '@dcl/schemas'
import { ColliderLayer } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen'
import { RaycastQueryType } from '@dcl/protocol/out-js/decentraland/sdk/components/raycast.gen'
import { meshColliderComponent } from '../../../../../src/lib/decentraland/sdk-components/mesh-collider-component'
import { transformComponent } from '../../../../../src/lib/decentraland/sdk-components/transform-component'
import {
  raycastComponent,
  raycastResultComponent
} from '../../../../../src/lib/decentraland/sdk-components/raycast-component'
import { processRaycasts } from '../../../../../src/lib/babylon/scene/logic/raycasts'
import {
  createSphereMesh,
  PRIMITIVE_SPHERE_RADIUS
} from '../../../../../src/lib/babylon/scene/logic/primitive-meshes'
import {
  intersectAnalyticSphere,
  setAnalyticSphere
} from '../../../../../src/lib/babylon/scene/logic/analytic-colliders'
import { Entity } from '../../../../../src/lib/decentraland/types'
import { CrdtBuilder, testWithEngine } from '../../babylon-test-helper'

// A SphereMesh collider is 1296 triangles only because this server tessellates it.
// The reference client does not — `SetupSphereCollider` assigns a Unity
// `SphereCollider`, a PhysX primitive with a closed-form test — so the analytic
// surface is what every player's client resolves against and the tessellated hull
// is the approximation.
//
// Both things that buys, measured against the sphere the collider component builds:
//
//   CORRECTNESS. The hull is INSCRIBED, so a tessellated hit lands INSIDE the true
//   surface: 1.9mm off for a ray through the middle, 4.4mm near the silhouette.
//   Small, but it is error in the direction of "the server thinks you hit deeper
//   than your client does", and it is free to remove.
//
//   SPEED. 2000 spheres on one ray: 74.03ms tessellated against 3.02ms analytic.
//
// SPHERES ONLY. A box collider is 12 triangles and a cylinder 200, so the payoff is
// concentrated almost entirely here, while every extra shape adds its own local
// space handling and normal derivation to get wrong.

/** Distance along +Z from the origin to a sphere at `centre`, offset `x` off-axis. */
function trueDistanceToSphere(centreZ: number, offsetX: number, radius: number): number {
  return centreZ - Math.sqrt(radius * radius - offsetX * offsetX)
}

describe('analytic sphere colliders', () => {
  let engine: BABYLON.NullEngine
  let scene: BABYLON.Scene
  let sphere: BABYLON.Mesh

  beforeEach(() => {
    engine = new BABYLON.NullEngine()
    scene = new BABYLON.Scene(engine)
    sphere = createSphereMesh(scene, 'sphere_collider')
    sphere.position.set(0, 0, 10)
    sphere.computeWorldMatrix(true)
    setAnalyticSphere(sphere, PRIMITIVE_SPHERE_RADIUS)
  })

  afterEach(() => {
    scene.dispose()
    engine.dispose()
  })

  const rayFrom = (offsetX: number, length = 999) =>
    new Ray(new Vector3(offsetX, 0, 0), new Vector3(0, 0, 1), length)

  describe('when a ray crosses a sphere off-centre', () => {
    let result: BABYLON.Nullable<BABYLON.PickingInfo>

    beforeEach(() => {
      result = intersectAnalyticSphere(rayFrom(0.45), sphere)
    })

    it('should report a hit', () => {
      expect(result?.hit).toBe(true)
    })

    // The whole point: EXACT, where the tessellated path is 4.4mm deep here. A
    // precision of 9 decimals cannot be met by any triangle hull.
    it('should report the exact closed-form distance, not the inscribed hull', () => {
      expect(result!.distance).toBeCloseTo(trueDistanceToSphere(10, 0.45, PRIMITIVE_SPHERE_RADIUS), 9)
    })

    // Babylon's getNormal() interpolates vertex normals using faceId/bu/bv, which an
    // analytic hit never produces — left to it the normal would be garbage rather
    // than merely faceted, so AnalyticPickingInfo overrides it.
    it('should report the exact outward surface normal', () => {
      const normal = result!.getNormal()!
      const expected = result!.pickedPoint!.subtract(new Vector3(0, 0, 10)).normalize()
      expect([normal.x, normal.y, normal.z].map((n) => Math.round(n * 1e6) / 1e6)).toEqual(
        [expected.x, expected.y, expected.z].map((n) => Math.round(n * 1e6) / 1e6)
      )
    })

    it('should point back at the mesh it hit', () => {
      expect(result!.pickedMesh === sphere).toBe(true)
    })
  })

  describe('when a ray misses the sphere entirely', () => {
    it('should report no hit rather than a spurious one', () => {
      expect(intersectAnalyticSphere(rayFrom(0.6), sphere)).toBeNull()
    })
  })

  describe('when the sphere is beyond the requested range', () => {
    // ray.length carries the scene's maxDistance, so the analytic path has to honour
    // it exactly as `intersectsTriangle` does — otherwise wiring maxDistance up
    // would silently stop working for spheres.
    it('should report no hit', () => {
      expect(intersectAnalyticSphere(rayFrom(0, 5), sphere)).toBeNull()
    })
  })

  describe('when the ray starts inside the sphere', () => {
    let result: BABYLON.Nullable<BABYLON.PickingInfo>

    beforeEach(() => {
      // Origin at the sphere's centre, so the near root is behind the ray.
      result = intersectAnalyticSphere(new Ray(new Vector3(0, 0, 10), new Vector3(0, 0, 1), 999), sphere)
    })

    it('should report the exit point rather than a negative distance', () => {
      expect(result!.distance).toBeCloseTo(PRIMITIVE_SPHERE_RADIUS, 9)
    })
  })

  describe('when the entity scales the sphere uniformly', () => {
    let result: BABYLON.Nullable<BABYLON.PickingInfo>

    beforeEach(() => {
      sphere.scaling.setAll(4)
      sphere.computeWorldMatrix(true)
      result = intersectAnalyticSphere(rayFrom(0), sphere)
    })

    // Radius 0.5 * 4 = 2, so the near surface is 2m in front of the centre.
    it('should scale the radius with the entity', () => {
      expect(result!.distance).toBeCloseTo(8, 9)
    })
  })

  describe('when the entity scales the sphere unevenly', () => {
    beforeEach(() => {
      sphere.scaling.set(1, 3, 1)
      sphere.computeWorldMatrix(true)
    })

    // An unevenly scaled sphere is an ELLIPSOID and the quadratic is the wrong
    // equation for one. Returning null hands it back to the triangle path, which
    // handles it correctly — reporting a confidently wrong hit position would be far
    // worse than paying for 1296 triangles.
    it('should decline to solve it, so the caller falls back to the mesh', () => {
      expect(intersectAnalyticSphere(rayFrom(0), sphere)).toBeNull()
    })

    it('should still be hittable through the tessellated path', () => {
      expect(rayFrom(0).intersectsMesh(sphere, false).hit).toBe(true)
    })
  })

  describe('when the mesh was never tagged as a sphere', () => {
    let untagged: BABYLON.Mesh

    beforeEach(() => {
      untagged = BABYLON.MeshBuilder.CreateBox('box_collider', { size: 1 }, scene)
      untagged.position.set(0, 0, 10)
      untagged.computeWorldMatrix(true)
    })

    // Only the collider component tags spheres. Anything else — glTF meshes, boxes,
    // cylinders, avatar capsules — must take the triangle path untouched.
    it('should decline it rather than treating any mesh as a sphere', () => {
      expect(intersectAnalyticSphere(rayFrom(0), untagged)).toBeNull()
    })
  })

  // The tag is applied per collider, NOT to the memoized template, because
  // `Mesh.clone()` copies Babylon's own fields and not arbitrary symbols. If that
  // ever changed to tagging the template, every cloned collider would silently fall
  // back to the triangle path and only the performance would tell you.
  describe('when a tagged sphere is cloned', () => {
    it('should NOT carry the tag to the clone, which is why the component re-tags', () => {
      expect(intersectAnalyticSphere(rayFrom(0), sphere.clone('copy_collider'))).toBeNull()
    })
  })
})

// The block above proves `intersectAnalyticSphere` is correct in isolation. It does
// NOT prove the analytic path is REACHED: verified by mutation, both "the collider
// component never tags its spheres" and "processRaycasts ignores the analytic
// result" left every test above green while the feature was entirely dead.
//
// PRECISION is what distinguishes the two paths end to end. Through the tessellated
// hull an off-axis hit lands ~4.4mm deep (9.786429 against a true 9.782055); the
// analytic answer is exact. Asserting to 4 decimals cannot be satisfied by the
// triangle path.
const OFF_AXIS = 0.45
const SPHERE_CENTRE_Z = 10

testWithEngine(
  'analytic spheres, end to end through processRaycasts',
  {
    baseUrl: '/',
    entity: { content: [], metadata: {} as Scene, type: 'scene' },
    urn: 'analytic-integration'
  },
  ($) => {
    let timestamp = 0
    let raycastEntity: Entity
    let colliderEntity: Entity

    const transform = (position: Vector3) => ({
      position,
      rotation: Quaternion.Identity(),
      scale: new Vector3(1, 1, 1),
      parent: 0 as Entity
    })

    beforeEach(async () => {
      $.startEngine()
      colliderEntity = 800 as Entity
      raycastEntity = 801 as Entity

      await $.ctx.crdtSendToRenderer({
        data: new CrdtBuilder()
          .put(transformComponent, colliderEntity, ++timestamp, transform(new Vector3(0, 0, SPHERE_CENTRE_Z)))
          .put(meshColliderComponent, colliderEntity, ++timestamp, {
            collisionMask: ColliderLayer.CL_PHYSICS,
            mesh: { $case: 'sphere', sphere: {} }
          } as any)
          .put(transformComponent, raycastEntity, ++timestamp, transform(new Vector3(OFF_AXIS, 0, 0)))
          .put(raycastComponent, raycastEntity, ++timestamp, {
            timestamp: 1,
            maxDistance: 100,
            queryType: RaycastQueryType.RQT_HIT_FIRST,
            continuous: false,
            collisionMask: ColliderLayer.CL_PHYSICS,
            direction: { $case: 'globalDirection', globalDirection: new Vector3(0, 0, 1) }
          } as any)
          .finish()
      })
      processRaycasts($.ctx)
    })

    describe('when a scene raycasts a sphere collider off-centre', () => {
      it('should hit it', () => {
        const result = $.ctx.components[raycastResultComponent.componentId].getOrNull(raycastEntity) as any
        expect(result.hits).toHaveLength(1)
      })

      it('should report the exact sphere distance, which the tessellated hull cannot', () => {
        const result = $.ctx.components[raycastResultComponent.componentId].getOrNull(raycastEntity) as any
        expect(result.hits[0].length).toBeCloseTo(
          trueDistanceToSphere(SPHERE_CENTRE_Z, OFF_AXIS, PRIMITIVE_SPHERE_RADIUS),
          4
        )
      })
    })
  }
)
