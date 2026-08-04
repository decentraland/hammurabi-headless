import { AbstractMesh, Ray, Vector3, VertexBuffer } from '@babylonjs/core'
import { Scene } from '@dcl/schemas'
import { ColliderLayer, PBMeshCollider } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen'
import { meshColliderComponent } from '../../../../src/lib/decentraland/sdk-components/mesh-collider-component'
import { floorMeshes } from '../../../../src/lib/babylon/scene/logic/colliders'
import { Entity } from '../../../../src/lib/decentraland/types'
import { limits } from '../../../../src/lib/misc/limits'
import { CrdtBuilder, testWithEngine } from '../babylon-test-helper'

// Every MeshCollider shape used to clone the same 1x1x1 box, so a sphere,
// cylinder or plane collider silently occupied a cube's volume — raycasts and
// pointer picks reported hits no client agrees with. These tests pin the shape
// actually built for each `mesh` oneof case.
//
// Assertions are deliberately GEOMETRIC rather than name-based: `name` is just the
// literal passed to clone(), so `sphere -> baseColliderBox(scene).clone('sphere_collider')`
// satisfies every name assertion while shipping a cube. Vertex data does not lie.
// For the same reason the `_collider` suffix is checked through its CONSEQUENCE —
// membership in floorMeshes, which setColliderMask only grants to a name ending in
// `_collider` — rather than by comparing the string that was passed to clone().
// That membership is asserted as `floorMeshes.includes(mesh)`, NOT
// `expect(floorMeshes).toContain(mesh)`: on failure the latter pretty-prints the
// whole array, and every element is a Babylon mesh whose object graph reaches the
// entire scene — measured, that OOMs the jest worker at 4GB instead of printing a
// diff, so the one run that matters is the one you cannot read.
//
// The rule is NOT specific to `toContain`. Every matcher hands its received (and
// expected) value to pretty-format on failure, so `toBe`, `toEqual`, `toBeNull` and
// `toBeUndefined` are the same hazard the moment the value could be a mesh, an
// entity or an object holding one — a mesh reaches its parent, the scene, every
// other mesh in it and back, and this file ends with ~53 of them.
//
// Measured, by making an unset `mesh` oneof fall through to a box (the historical
// bug this spec exists to catch) and running the file three ways:
//   `toBeNull()` on the collider + `toEqual()` on the live component entry
//       -> FATAL ERROR: JavaScript heap out of memory at 117s, exit code null, NO
//          test names and no JSON report. The run looks like a crash rather than a
//          failure, and the mutant reads as SURVIVING because jest never wrote a
//          result.
//   `toBeNull()` alone            -> 72s to report one failure.
//   boolean + projected (current) -> 2.8s, three named failures, ~2KB each.
//
// So nothing that can hold a Babylon object is passed to a matcher directly. It is
// compared as a BOOLEAN or a SCALAR (`expect(colliderOf(entity) === null).toBe(true)`,
// `expect(mesh.parent === entity).toBe(true)`) or projected onto plain data first.
// Numbers, booleans, strings and arrays of numbers are safe and stay as they are.
// A failure that cannot be read is not a test.

// Babylon's unit box: 4 vertices per face x 6 faces, the count a cloned box
// template would carry into any other shape.
const BOX_TEMPLATE_VERTEX_COUNT = 24

/** Half the diagonal of a unit cube: where every one of its 24 vertices sits. */
const UNIT_CUBE_VERTEX_DISTANCE = Math.sqrt(0.75)

/**
 * Largest distance from the Y axis among the vertices of one end cap of a
 * cylinder. Bounding boxes are driven by the WIDER end, so they cannot tell
 * radiusTop from radiusBottom (nor a swap of the two); this reads the ring the
 * scene actually asked for. Cap centres sit on the axis, so `max` — not `min` —
 * is the ring radius.
 */
function endCapRadius(mesh: AbstractMesh, end: 'top' | 'bottom'): number {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!
  let radius = 0
  for (let i = 0; i < positions.length; i += 3) {
    const y = positions[i + 1]
    if (end === 'top' ? y > 0.4 : y < -0.4) {
      radius = Math.max(radius, Math.hypot(positions[i], positions[i + 2]))
    }
  }
  return radius
}

/**
 * Radial segments the cylinder is actually built from, read as `2pi / smallest
 * angular step around the top ring`. Derived from the step rather than by counting
 * vertices or distinct angles because Babylon duplicates the seam vertex and adds a
 * cap fan on top of the side ring — both inflate any raw count, while the step
 * between neighbouring vertices is exactly the quantity that sets the chord error.
 */
function ringSegmentCount(mesh: AbstractMesh): number {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!
  const angles: number[] = []
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 1] > 0.4 && Math.hypot(positions[i], positions[i + 2]) > 1e-4) {
      angles.push((Math.atan2(positions[i + 2], positions[i]) + 2 * Math.PI) % (2 * Math.PI))
    }
  }
  angles.sort((a, b) => a - b)
  let step = 2 * Math.PI
  for (let i = 1; i < angles.length; i++) {
    const gap = angles[i] - angles[i - 1]
    // Coincident vertices (cap rim over side ring, seam duplicate) give a ~0 gap.
    if (gap > 1e-6) step = Math.min(step, gap)
  }
  return Math.round((2 * Math.PI) / step)
}

/**
 * Side triangles that twist across the axis: those carrying both a top-ring and a
 * bottom-ring vertex whose radial directions oppose each other.
 *
 * This is the only reading here that is not sign-blind, and it is what tells a
 * frustum from an hourglass. `endCapRadius` measures with `Math.hypot`, so a ring
 * built at -1 reads exactly like one built at +1; so do the bounding box, the
 * vertex count and the segment count. Handing a raw negative radius to the mesh
 * builder mirrors that ring 180 degrees, and every side quad then crosses the axis:
 * measured for `{radiusTop: -1, radiusBottom: 0.5}`, 200 twisted side triangles
 * against 0 once the magnitude is taken. Without this, dropping the `Math.abs` in
 * clampRadius changes nothing any other assertion in this file can see.
 */
function twistedSideTriangleCount(mesh: AbstractMesh): number {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!
  const indices = mesh.getIndices()!
  let twisted = 0
  for (let i = 0; i < indices.length; i += 3) {
    const corners = [indices[i], indices[i + 1], indices[i + 2]].map((index) => ({
      x: positions[index * 3],
      y: positions[index * 3 + 1],
      z: positions[index * 3 + 2]
    }))
    const top = corners.filter((corner) => corner.y > 0.4)
    const bottom = corners.filter((corner) => corner.y < -0.4)
    // A cap fan sits entirely on one ring, so it cannot twist.
    if (top.length === 0 || bottom.length === 0) continue
    if (top.some((t) => bottom.some((b) => t.x * b.x + t.z * b.z < 0))) twisted++
  }
  return twisted
}

/**
 * Sides of the polygon a sphere's equator is drawn as. Babylon's `segments` option
 * counts LATITUDE steps, not longitude ones — the equator carries
 * `2 * (segments + 2)` sides — and it is the equator polygon, not `segments`, whose
 * chord error a grazing ray actually sees. Read from vertex data for the same reason
 * as ringSegmentCount: the option is not observable, the geometry is.
 */
function equatorSegmentCount(mesh: AbstractMesh): number {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!
  const angles = new Set<number>()
  for (let i = 0; i < positions.length; i += 3) {
    if (Math.abs(positions[i + 1]) < 1e-6) {
      // Rounded so the seam's duplicated vertex collapses onto its twin.
      angles.add(Math.round((((Math.atan2(positions[i + 2], positions[i]) + 2 * Math.PI) % (2 * Math.PI)) * 1e6)))
    }
  }
  return angles.size
}

/** Distance from the mesh origin of the vertex nearest to / farthest from it. */
function vertexDistanceRange(mesh: AbstractMesh): [number, number] {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!
  let min = Number.POSITIVE_INFINITY
  let max = 0
  for (let i = 0; i < positions.length; i += 3) {
    const distance = Math.hypot(positions[i], positions[i + 1], positions[i + 2])
    min = Math.min(min, distance)
    max = Math.max(max, distance)
  }
  return [min, max]
}

function everyVertexIsFinite(mesh: AbstractMesh): boolean {
  return Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!).every((value) => Number.isFinite(value))
}

/** Fires an axial ray at the mesh centre from `distance` metres away on Z. */
function isHitFromZ(mesh: AbstractMesh, distance: number): boolean {
  mesh.computeWorldMatrix(true)
  const centre = mesh.getBoundingInfo().boundingBox.centerWorld
  const origin = new Vector3(centre.x, centre.y, centre.z + distance)
  const direction = new Vector3(0, 0, -Math.sign(distance))
  return new Ray(origin, direction, Math.abs(distance) * 2).intersectsMesh(mesh).hit
}

/**
 * Fires a downward ray through (x, 0) from well above the mesh. Reads the surface a
 * raycast can actually reach, which is the property a radius clamp exists to keep —
 * a mesh can have the right bounding box and still be unhittable.
 */
function isHitFromAbove(mesh: AbstractMesh, x: number): boolean {
  mesh.computeWorldMatrix(true)
  return new Ray(new Vector3(x, 5, 0), new Vector3(0, -1, 0), 10).intersectsMesh(mesh).hit
}

testWithEngine(
  'mesh collider component',
  {
    baseUrl: '/',
    entity: { content: [], metadata: {} as Scene, type: 'scene' },
    urn: 'mesh-collider-spec'
  },
  ($) => {
    // One SceneContext is shared by the whole file, and its CRDT state outlives each
    // test: a repeated timestamp is rejected as outdated and a deleted entity id is
    // tombstoned forever. So both counters only ever move forward — every test gets a
    // fresh entity and a strictly newer timestamp.
    let timestamp = 0
    let nextEntityId = 700

    // The drift logger (createRateLimitedErrorLogger) keeps MODULE-level state with a
    // 1s window, and the whole file runs inside one. So a test that has to observe a
    // drift log — or to prove the ABSENCE of one — must run at an instant the
    // throttle has not already consumed, otherwise it reads suppression as silence.
    // Measured: without this, making the default arm log unconditionally still passed
    // the unset-oneof describe, because the two tests declared before it had already
    // spent the window.
    //
    // The counter is shared by every describe that pins the clock: each pin must be
    // strictly LATER than the last, and two independent counters would eventually jump
    // one describe backwards, re-arming the throttle for the other.
    let clockSkewMs = 0
    function pinClockPastTheDriftLogWindow(): jest.SpyInstance {
      clockSkewMs += 3_600_000
      const realNow = Date.now()
      return jest.spyOn(Date, 'now').mockReturnValue(realNow + clockSkewMs)
    }

    beforeEach(() => {
      $.startEngine()
    })

    async function putCollider(entity: Entity, value: PBMeshCollider): Promise<void> {
      await $.ctx.crdtSendToRenderer({
        data: new CrdtBuilder().put(meshColliderComponent, entity, ++timestamp, value).finish()
      })
    }

    async function deleteCollider(entity: Entity): Promise<void> {
      await $.ctx.crdtSendToRenderer({
        data: new CrdtBuilder().delete(meshColliderComponent, entity, ++timestamp).finish()
      })
    }

    async function deleteEntity(entity: Entity): Promise<void> {
      await $.ctx.crdtSendToRenderer({ data: new CrdtBuilder().deleteEntity(entity).finish() })
    }

    function colliderOf(entity: Entity): AbstractMesh | null {
      return $.ctx.entities.get(entity)!.appliedComponents.meshCollider!.collider
    }

    describe('when a scene puts a MeshCollider with a box shape', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = nextEntityId++ as Entity
        await putCollider(entity, { mesh: { $case: 'box', box: {} } })
      })

      it('should register the collider as a floor candidate, which only a _collider name earns', () => {
        expect(floorMeshes.includes(colliderOf(entity)!)).toBe(true)
      })

      it('should build a unit cube spanning half a metre from the entity origin on every axis', () => {
        expect(colliderOf(entity)!.getBoundingInfo().boundingBox.extendSize.asArray()).toEqual([0.5, 0.5, 0.5])
      })

      // extendSize cannot tell a cube from a sphere — a diameter-1 sphere is
      // [0.5,0.5,0.5] too. A cube puts every vertex on a corner, all at the same
      // sqrt(0.75) from the centre, so this discriminates the two exactly.
      it('should place every vertex on a cube corner rather than on a sphere surface', () => {
        const [nearest, farthest] = vertexDistanceRange(colliderOf(entity)!)
        expect([nearest, farthest]).toEqual([
          expect.closeTo(UNIT_CUBE_VERTEX_DISTANCE, 5),
          expect.closeTo(UNIT_CUBE_VERTEX_DISTANCE, 5)
        ])
      })

      it('should carry the 24 vertices of a box template rather than a tessellated surface', () => {
        expect(colliderOf(entity)!.getTotalVertices()).toBe(BOX_TEMPLATE_VERTEX_COUNT)
      })

      // The template is built disabled and clone() inherits that, so the applier has
      // to re-enable. collisionCoordinator gates on mesh.isEnabled(), while
      // Ray.intersectsMesh does not — forgetting this leaves every cloned collider
      // pickable but walk-through, silently killing the whole CL_PHYSICS half.
      // Asserted once and only here: box, sphere and plane clones are re-enabled by
      // the same single `collider.setEnabled(true)`, so a sphere and a plane copy of
      // this test cannot fail without this one failing too.
      it('should enable the clone so the avatar collides with it instead of walking through', () => {
        expect(colliderOf(entity)!.isEnabled()).toBe(true)
      })

      // Colliders live under the entity, which lives under the scene rootNode.
      // pickMeshesForMask only walks getChildMeshes(), so an unparented collider is
      // invisible to every raycast the scene makes.
      it('should attach the collider to the entity so raycasts traversing the entity can find it', () => {
        expect(colliderOf(entity)!.parent === $.ctx.entities.get(entity)).toBe(true)
      })
    })

    describe('when a scene puts a MeshCollider with a sphere shape', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = nextEntityId++ as Entity
        await putCollider(entity, { mesh: { $case: 'sphere', sphere: {} } })
      })

      it('should register the collider as a floor candidate, which only a _collider name earns', () => {
        expect(floorMeshes.includes(colliderOf(entity)!)).toBe(true)
      })

      it('should build a diameter-1 sphere that fits the unit box, matching the reference SPHERE_RADIUS 0.5', () => {
        expect(colliderOf(entity)!.getBoundingInfo().boundingBox.extendSize.asArray()).toEqual([0.5, 0.5, 0.5])
      })

      // extendSize alone cannot tell a sphere from a cube — both are [0.5,0.5,0.5].
      it('should tessellate a curved surface instead of cloning the 24-vertex box template', () => {
        expect(colliderOf(entity)!.getTotalVertices()).toBeGreaterThan(BOX_TEMPLATE_VERTEX_COUNT)
      })

      // A cube's corners sit 0.866 from its centre; a sphere's vertices all sit at
      // exactly its radius. This is what makes a pointer ray grazing the corner of
      // the volume miss, as it does on every other client.
      it('should place every vertex on the sphere surface rather than at cube corners', () => {
        const [nearest, farthest] = vertexDistanceRange(colliderOf(entity)!)
        expect([nearest, farthest]).toEqual([expect.closeTo(0.5, 5), expect.closeTo(0.5, 5)])
      })

      // Segments are pinned (16, i.e. a 36-gon equator) rather than left to Babylon's
      // implicit 32 because the sphere is the most expensive primitive collider and
      // the reference client's is analytic, so no count "matches" it: 36 sides cost
      // 1296 triangles against 4624 for a 0.38%-of-radius chord error against 0.11%.
      // Left implicit, a Babylon default change would move every sphere collider.
      it('should draw its equator as the pinned 36-gon rather than Babylon default segments', () => {
        expect(equatorSegmentCount(colliderOf(entity)!)).toBe(36)
      })

      it('should attach the collider to the entity so raycasts traversing the entity can find it', () => {
        expect(colliderOf(entity)!.parent === $.ctx.entities.get(entity)).toBe(true)
      })
    })

    describe('when a scene puts a MeshCollider with a plane shape', () => {
      let entity: Entity
      let hitFromFront: boolean
      let hitFromBehind: boolean

      beforeEach(async () => {
        entity = nextEntityId++ as Entity
        await putCollider(entity, { mesh: { $case: 'plane', plane: {} } })
        hitFromFront = isHitFromZ(colliderOf(entity)!, -5)
        hitFromBehind = isHitFromZ(colliderOf(entity)!, 5)
      })

      it('should register the collider as a floor candidate, which only a _collider name earns', () => {
        expect(floorMeshes.includes(colliderOf(entity)!)).toBe(true)
      })

      it('should build a 1x1 quad with no depth instead of a cube', () => {
        expect(colliderOf(entity)!.getBoundingInfo().boundingBox.extendSize.asArray()).toEqual([0.5, 0.5, 0])
      })

      it('should be hit by a ray arriving at its front face', () => {
        expect(hitFromFront).toBe(true)
      })

      // Babylon's ray/triangle test does not backface-cull at all, and the collision
      // engine's back-face skip needs `!subMesh.getMaterial()`, which never holds
      // (getMaterial falls back to scene.defaultMaterial). So a single-sided quad
      // already answers from both sides and Mesh.DOUBLESIDE would only double the
      // geometry.
      it('should be hit by a ray arriving from behind even though the quad is single sided', () => {
        expect(hitFromBehind).toBe(true)
      })

      it('should keep the cheaper single-sided geometry of 4 vertices', () => {
        expect(colliderOf(entity)!.getTotalVertices()).toBe(4)
      })

      it('should attach the collider to the entity so raycasts traversing the entity can find it', () => {
        expect(colliderOf(entity)!.parent === $.ctx.entities.get(entity)).toBe(true)
      })
    })

    describe('when a scene puts a MeshCollider with a cylinder shape', () => {
      describe('and the radii are omitted', () => {
        let entity: Entity

        beforeEach(async () => {
          entity = nextEntityId++ as Entity
          await putCollider(entity, { mesh: { $case: 'cylinder', cylinder: {} } })
        })

        it('should register the collider as a floor candidate, which only a _collider name earns', () => {
          expect(floorMeshes.includes(colliderOf(entity)!)).toBe(true)
        })

        // A missing radius means 0.5 per the protocol, not 0: `?? 0` collapses the
        // end into a cone tip, which the bounding box of a wider other end hides.
        it('should default the top radius to 0.5', () => {
          expect(endCapRadius(colliderOf(entity)!, 'top')).toBeCloseTo(0.5, 5)
        })

        it('should default the bottom radius to 0.5', () => {
          expect(endCapRadius(colliderOf(entity)!, 'bottom')).toBeCloseTo(0.5, 5)
        })

        it('should build it one metre tall so it fits the unit box the Transform scales', () => {
          expect(colliderOf(entity)!.getBoundingInfo().boundingBox.extendSize.y).toBeCloseTo(0.5, 5)
        })

        // The reference client uses 50 (CylinderVariantsFactory.VERTICES_NUM); Babylon
        // defaults to 24. A coarser polygon is not cosmetic on a collider: its chord
        // error is 0.86% of the radius against 0.20%, so a ray grazing the silhouette
        // resolves a different hit point — or a different hit — from the real client.
        it('should tessellate the ring with the reference client segment count', () => {
          expect(ringSegmentCount(colliderOf(entity)!)).toBe(50)
        })

        // The cylinder is the one shape built fresh instead of cloned with a parent,
        // so it is the one that can end up outside rootNode: losing this line makes
        // every scene raycast silently stop hitting cylinders.
        it('should attach the collider to the entity so raycasts traversing the entity can find it', () => {
          expect(colliderOf(entity)!.parent === $.ctx.entities.get(entity)).toBe(true)
        })
      })

      describe('and the radii differ from each other', () => {
        let entity: Entity

        beforeEach(async () => {
          entity = nextEntityId++ as Entity
          await putCollider(entity, {
            mesh: { $case: 'cylinder', cylinder: { radiusTop: 2, radiusBottom: 0.5 } }
          })
        })

        it('should build the top ring at the requested top radius', () => {
          expect(endCapRadius(colliderOf(entity)!, 'top')).toBeCloseTo(2, 5)
        })

        it('should build the bottom ring at the requested bottom radius rather than reusing the top one', () => {
          expect(endCapRadius(colliderOf(entity)!, 'bottom')).toBeCloseTo(0.5, 5)
        })
      })

      describe('and only the bottom radius is given', () => {
        let entity: Entity

        beforeEach(async () => {
          entity = nextEntityId++ as Entity
          await putCollider(entity, {
            mesh: { $case: 'cylinder', cylinder: { radiusBottom: 3 } }
          })
        })

        it('should keep the omitted top radius at its 0.5 default', () => {
          expect(endCapRadius(colliderOf(entity)!, 'top')).toBeCloseTo(0.5, 5)
        })

        it('should build the bottom ring at the requested radius', () => {
          expect(endCapRadius(colliderOf(entity)!, 'bottom')).toBeCloseTo(3, 5)
        })
      })

      // Radii are untrusted protobuf floats. Unguarded, Infinity builds a mesh full
      // of NaN/Infinity vertices that still gets isPickable, checkCollisions and a
      // floorMeshes slot but can never be hit — a collider the scene believes in and
      // no raycast ever finds.
      describe('and the top radius is not a finite number', () => {
        let entity: Entity

        beforeEach(async () => {
          entity = nextEntityId++ as Entity
          await putCollider(entity, {
            mesh: { $case: 'cylinder', cylinder: { radiusTop: Number.POSITIVE_INFINITY, radiusBottom: 1 } }
          })
        })

        it('should replace it with the 0.5 default rather than build an unhittable mesh', () => {
          expect(endCapRadius(colliderOf(entity)!, 'top')).toBeCloseTo(0.5, 5)
        })

        it('should leave the finite bottom radius untouched', () => {
          expect(endCapRadius(colliderOf(entity)!, 'bottom')).toBeCloseTo(1, 5)
        })

        it('should produce vertex data a raycast can intersect', () => {
          expect(everyVertexIsFinite(colliderOf(entity)!)).toBe(true)
        })
      })

      describe('and a radius is NaN', () => {
        let entity: Entity

        beforeEach(async () => {
          entity = nextEntityId++ as Entity
          await putCollider(entity, {
            mesh: { $case: 'cylinder', cylinder: { radiusTop: Number.NaN, radiusBottom: 1 } }
          })
        })

        // NaN is only accidentally survivable today (Babylon's builder treats a falsy
        // diameter as 1), which is an implementation detail, not a contract. Kept
        // alongside the Infinity case rather than folded into it: NaN is the input a
        // guard is most likely to route somewhere else (`isFinite` narrowed to an
        // infinity test, or NaN sent to 0), and a 0 here is the five-micron ring the
        // whole clamp exists to prevent — which the Infinity case cannot see.
        it('should replace it with the 0.5 default instead of relying on the builder', () => {
          expect(endCapRadius(colliderOf(entity)!, 'top')).toBeCloseTo(0.5, 5)
        })
      })

      // A negative radius used to be clamped to 0, which reintroduced the very
      // failure the clamp exists to stop: Babylon widens a zero cap to a 5e-6 ring,
      // so the scene got a five-micron surface holding isPickable, checkCollisions
      // and a floorMeshes slot that no raycast could find. The reference client does
      // not clamp; it builds a full radius-3 cone for -3, and taking the absolute
      // value reproduces that exactly (negating a radius rotates the ring 180
      // degrees and the 50-gon is even, so it maps onto itself).
      describe('and a radius is negative', () => {
        let entity: Entity

        beforeEach(async () => {
          entity = nextEntityId++ as Entity
          await putCollider(entity, {
            mesh: { $case: 'cylinder', cylinder: { radiusTop: -3, radiusBottom: 1 } }
          })
        })

        it('should build the ring at its absolute value, as the reference client does', () => {
          expect(endCapRadius(colliderOf(entity)!, 'top')).toBeCloseTo(3, 5)
        })

        // The consequence, not the coordinate: clamped to 0 this ray missed by six
        // orders of magnitude while every downstream check still passed.
        it('should be hit by a raycast out at the radius the scene asked for', () => {
          expect(isHitFromAbove(colliderOf(entity)!, 2.5)).toBe(true)
        })
      })

      // The one place taking the absolute value deliberately does NOT reproduce the
      // reference client: fed one negative and one positive radius it builds a
      // self-intersecting hourglass (half its side triangles twist across the axis).
      // A collider is not worth reproducing that faithfully, so both ends are read as
      // their magnitudes and the result is an ordinary frustum.
      describe('and the two radii have opposite signs', () => {
        let entity: Entity

        beforeEach(async () => {
          entity = nextEntityId++ as Entity
          await putCollider(entity, {
            mesh: { $case: 'cylinder', cylinder: { radiusTop: -1, radiusBottom: 0.5 } }
          })
        })

        it('should build the negative end at its magnitude', () => {
          expect(endCapRadius(colliderOf(entity)!, 'top')).toBeCloseTo(1, 5)
        })

        it('should build the positive end unchanged, giving a plain frustum', () => {
          expect(endCapRadius(colliderOf(entity)!, 'bottom')).toBeCloseTo(0.5, 5)
        })

        // The two assertions above cannot see the hourglass at all: both read radii
        // through Math.hypot, and the mirrored ring has the same magnitudes. This is
        // the assertion that makes the `Math.abs` load-bearing — measured, the raw
        // negative builds 200 twisted side triangles here while every other reading in
        // this file, including the tessellation and the bounding box, is unchanged.
        it('should build a frustum rather than the self-intersecting hourglass the raw signs give', () => {
          expect(twistedSideTriangleCount(colliderOf(entity)!)).toBe(0)
        })
      })

      // The one configuration where the docblock's "abs reproduces the reference
      // surface exactly" claim actually holds: negating BOTH radii rotates the whole
      // side surface 180 degrees, and the 50-gon is even, so it maps onto itself —
      // same magnitudes, no twist. Untested, "identical surface" was asserted nowhere.
      describe('and both radii are negative', () => {
        let entity: Entity

        beforeEach(async () => {
          entity = nextEntityId++ as Entity
          await putCollider(entity, {
            mesh: { $case: 'cylinder', cylinder: { radiusTop: -2, radiusBottom: -1 } }
          })
        })

        it('should build the top ring at its magnitude', () => {
          expect(endCapRadius(colliderOf(entity)!, 'top')).toBeCloseTo(2, 5)
        })

        it('should build the bottom ring at its magnitude', () => {
          expect(endCapRadius(colliderOf(entity)!, 'bottom')).toBeCloseTo(1, 5)
        })

        it('should leave the side surface untwisted, as negating both ends together does', () => {
          expect(twistedSideTriangleCount(colliderOf(entity)!)).toBe(0)
        })
      })

      describe('and a radius is far beyond any plausible primitive', () => {
        let entity: Entity

        beforeEach(async () => {
          entity = nextEntityId++ as Entity
          await putCollider(entity, {
            mesh: { $case: 'cylinder', cylinder: { radiusTop: 1e30, radiusBottom: 0.5 } }
          })
        })

        // Unbounded, a single component builds a collider hittable from a million
        // metres away — every other client disagrees about what that ray hit.
        it('should clamp it to the configured primitive radius ceiling', () => {
          expect(endCapRadius(colliderOf(entity)!, 'top')).toBeCloseTo(limits.maxPrimitiveRadiusMeters, 5)
        })
      })

      // Every hostile-radius case above puts the hostile value in radiusTop and a
      // benign one in radiusBottom, so the two builder arguments are not equally
      // covered: measured, `diameterBottom: (radiusBottom ?? 0.5) * 2` — the bottom
      // radius skipping clampRadius outright — passed the whole file. The scene
      // controls both fields, so both are guarded and both are read here.
      describe('and the bottom radius is not a finite number', () => {
        let entity: Entity

        beforeEach(async () => {
          entity = nextEntityId++ as Entity
          await putCollider(entity, {
            mesh: { $case: 'cylinder', cylinder: { radiusTop: 1, radiusBottom: Number.POSITIVE_INFINITY } }
          })
        })

        it('should replace it with the 0.5 default rather than build an unhittable mesh', () => {
          expect(endCapRadius(colliderOf(entity)!, 'bottom')).toBeCloseTo(0.5, 5)
        })

        it('should produce vertex data a raycast can intersect', () => {
          expect(everyVertexIsFinite(colliderOf(entity)!)).toBe(true)
        })
      })

      describe('and the bottom radius is negative and far beyond any plausible primitive', () => {
        let entity: Entity

        beforeEach(async () => {
          entity = nextEntityId++ as Entity
          await putCollider(entity, {
            mesh: { $case: 'cylinder', cylinder: { radiusTop: 1, radiusBottom: -1e30 } }
          })
        })

        // One value exercising both halves of the bottom guard: the magnitude is
        // taken, then the ceiling applies to it.
        it('should clamp its magnitude to the configured primitive radius ceiling', () => {
          expect(endCapRadius(colliderOf(entity)!, 'bottom')).toBeCloseTo(limits.maxPrimitiveRadiusMeters, 5)
        })

        // The mirror of "should leave the finite bottom radius untouched": a hostile
        // value in one field must not rewrite the other.
        it('should leave the finite top radius untouched', () => {
          expect(endCapRadius(colliderOf(entity)!, 'top')).toBeCloseTo(1, 5)
        })
      })

      describe('and the scene replaces it with another cylinder of different radii', () => {
        let entity: Entity
        let originalCollider: AbstractMesh

        beforeEach(async () => {
          entity = nextEntityId++ as Entity
          await putCollider(entity, {
            mesh: { $case: 'cylinder', cylinder: { radiusTop: 2, radiusBottom: 0.5 } }
          })
          originalCollider = colliderOf(entity)!
          await putCollider(entity, {
            mesh: { $case: 'cylinder', cylinder: { radiusTop: 0.25, radiusBottom: 1 } }
          })
        })

        it('should dispose the cylinder it replaced', () => {
          expect(originalCollider.isDisposed()).toBe(true)
        })

        // Cylinders cannot be cloned from a shared template: the geometry is part of
        // the component value, so a replace must rebuild it.
        it('should rebuild the top ring from the new radius', () => {
          expect(endCapRadius(colliderOf(entity)!, 'top')).toBeCloseTo(0.25, 5)
        })

        it('should rebuild the bottom ring from the new radius', () => {
          expect(endCapRadius(colliderOf(entity)!, 'bottom')).toBeCloseTo(1, 5)
        })
      })
    })

    describe('when a scene puts a MeshCollider carrying no shape at all', () => {
      let entity: Entity
      let errorSpy: jest.SpyInstance
      let nowSpy: jest.SpyInstance
      // Projected onto plain data in the setup, not asserted as the live entry: on
      // failure `collider` holds a mesh, and pretty-format walks it into the scene
      // graph (see the note at the top of this file). `collider === null` keeps the
      // null-versus-undefined distinction the entry depends on.
      let appliedEntry: { colliderIsNull: boolean; info: PBMeshCollider | undefined }

      beforeEach(async () => {
        entity = nextEntityId++ as Entity
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
        await putCollider(entity, { collisionMask: ColliderLayer.CL_POINTER })
        // Re-applied at an instant the drift logger's throttle has not consumed, so
        // the silence asserted below is the applier's and not the rate limiter's. The
        // spy covers the PUT above as well, so a log from either path is caught.
        nowSpy = pinClockPastTheDriftLogWindow()
        meshColliderComponent.applyChanges(
          $.ctx.entities.get(entity)!,
          $.ctx.components[meshColliderComponent.componentId]
        )
        const entry = $.ctx.entities.get(entity)!.appliedComponents.meshCollider
        appliedEntry = { colliderIsNull: entry?.collider === null, info: entry?.info }
      })

      afterEach(() => {
        errorSpy.mockRestore()
        nowSpy.mockRestore()
      })

      // Matches the reference client, which returns early on MeshOneofCase.None.
      // Falling through to a box fabricated an invisible collider no client had.
      it('should not build any collider mesh', () => {
        expect(colliderOf(entity) === null).toBe(true)
      })

      // The stored `info` is the value itself, not a placeholder: `info: {}` would
      // satisfy a truthiness check while losing the collisionMask the entry exists
      // to remember.
      it('should record the component value verbatim so a later delete has an entry to clear', () => {
        expect(appliedEntry).toEqual({
          colliderIsNull: true,
          info: { collisionMask: ColliderLayer.CL_POINTER }
        })
      })

      // The drift log exists for an UNKNOWN $case. An unset oneof is the ordinary
      // "no collider" case and reaches the same default arm, so a guard that stops
      // distinguishing them turns every colliderless entity into an operator-facing
      // protocol-drift error at the scene's PUT rate.
      it('should not report protocol drift for a shape the scene legitimately left unset', () => {
        expect(errorSpy).not.toHaveBeenCalled()
      })
    })

    describe('when the component carries a mesh shape this build does not implement', () => {
      let entity: Entity
      let errorSpy: jest.SpyInstance
      let getOrNullSpy: jest.SpyInstance
      let nowSpy: jest.SpyInstance

      beforeEach(async () => {
        entity = nextEntityId++ as Entity
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
        // @dcl/protocol is resolved at USER-INSTALL time, so the decoder can emit a
        // `$case` this build predates. No real PUT can produce one here — the
        // installed decoder only knows today's shapes — so the value is injected at
        // the storage the applier reads.
        const storage = $.ctx.components[meshColliderComponent.componentId]
        await putCollider(entity, { mesh: { $case: 'box', box: {} } })
        getOrNullSpy = jest
          .spyOn(storage, 'getOrNull')
          .mockReturnValue({ mesh: { $case: 'hyperboloid' } } as unknown as PBMeshCollider)
        // Each test here needs its own un-consumed throttle window, otherwise only the
        // first could ever observe a log line.
        nowSpy = pinClockPastTheDriftLogWindow()
        meshColliderComponent.applyChanges($.ctx.entities.get(entity)!, storage)
      })

      // Restores exactly the three spies this describe installs. NOT
      // jest.restoreAllMocks(): testWithEngine installs four spies of its own in a
      // beforeAll (updateStaticEntities, crdtSendToRenderer, getElapsedTime, update),
      // and restoreAllMocks strips those too — with no beforeAll left to reinstall
      // them, every test declared after this one would run against a different
      // SceneContext than the ones before it.
      afterEach(() => {
        errorSpy.mockRestore()
        getOrNullSpy.mockRestore()
        nowSpy.mockRestore()
      })

      it('should not build a collider for a shape it cannot represent', () => {
        expect(colliderOf(entity) === null).toBe(true)
      })

      // Silence is correct for an UNSET oneof, but an unknown case means protocol
      // drift: the entity is colliderless while the scene believes otherwise.
      it('should report the unsupported shape so the drift is visible to an operator', () => {
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('hyperboloid'), undefined)
      })

      describe('and the same drift is applied again inside the logger rate-limit window', () => {
        beforeEach(() => {
          // Date.now is still pinned by the outer beforeEach, so this second apply
          // lands at the same instant as the first — inside the 1s window.
          meshColliderComponent.applyChanges(
            $.ctx.entities.get(entity)!,
            $.ctx.components[meshColliderComponent.componentId]
          )
        })

        // The drift log is rate limited because it fires once per ACCEPTED PUT: a
        // scene re-PUTting an unknown shape every frame would otherwise flood
        // stdout at the render rate. Every other test in this describe exists to
        // work around that throttle, so it needs one test that asserts it.
        it('should log the drift only once so a per-frame PUT cannot flood stdout', () => {
          expect(errorSpy).toHaveBeenCalledTimes(1)
        })
      })
    })

    describe('when a scene deletes the MeshCollider component', () => {
      let entity: Entity
      let originalCollider: AbstractMesh

      beforeEach(async () => {
        entity = nextEntityId++ as Entity
        await putCollider(entity, { mesh: { $case: 'box', box: {} } })
        originalCollider = colliderOf(entity)!
        await deleteCollider(entity)
      })

      // A collider surviving its component keeps blocking rays and stays in
      // floorMeshes forever.
      it('should dispose the collider mesh', () => {
        expect(originalCollider.isDisposed()).toBe(true)
      })

      // Disposal is what has to REMOVE it: addFloorMesh registers a one-shot
      // onDisposeObservable for exactly this, and without that hook the list grows a
      // dead mesh per deleted collider, which every avatar-grounding raycast then
      // walks forever. Read as a boolean for the same reason as the membership
      // assertions above.
      it('should drop the disposed collider from the floor candidates', () => {
        expect(floorMeshes.includes(originalCollider)).toBe(false)
      })

      it('should clear the applied component so no stale reference to the disposed mesh remains', () => {
        expect($.ctx.entities.get(entity)!.appliedComponents.meshCollider === undefined).toBe(true)
      })
    })

    describe('when a scene deletes the entity holding a MeshCollider', () => {
      let entity: Entity
      let originalCollider: AbstractMesh

      beforeEach(async () => {
        entity = nextEntityId++ as Entity
        await putCollider(entity, { mesh: { $case: 'cylinder', cylinder: { radiusBottom: 2 } } })
        originalCollider = colliderOf(entity)!
        await deleteEntity(entity)
      })

      it('should dispose the collider along with the entity', () => {
        expect(originalCollider.isDisposed()).toBe(true)
      })

      it('should drop the entity from the scene', () => {
        expect($.ctx.entities.has(entity)).toBe(false)
      })
    })

    describe('when a scene replaces a box collider with a sphere collider', () => {
      let entity: Entity
      let originalCollider: AbstractMesh

      beforeEach(async () => {
        entity = nextEntityId++ as Entity
        await putCollider(entity, { mesh: { $case: 'box', box: {} } })
        originalCollider = colliderOf(entity)!
        await putCollider(entity, { mesh: { $case: 'sphere', sphere: {} } })
      })

      it('should dispose the box that the sphere replaced', () => {
        expect(originalCollider.isDisposed()).toBe(true)
      })

      it('should attach a sphere in its place rather than keep the cube volume', () => {
        expect(colliderOf(entity)!.getTotalVertices()).toBeGreaterThan(BOX_TEMPLATE_VERTEX_COUNT)
      })
    })

    describe('when a scene puts a shaped MeshCollider without a collision mask', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = nextEntityId++ as Entity
        await putCollider(entity, { mesh: { $case: 'sphere', sphere: {} } })
      })

      it('should make the collider pickable so pointer rays hit it', () => {
        expect(colliderOf(entity)!.isPickable).toBe(true)
      })

      it('should enable physics collisions on it', () => {
        expect(colliderOf(entity)!.checkCollisions).toBe(true)
      })
    })

    describe('when a scene puts a shaped MeshCollider with the CL_NONE collision mask', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = nextEntityId++ as Entity
        await putCollider(entity, { mesh: { $case: 'box', box: {} }, collisionMask: ColliderLayer.CL_NONE })
      })

      // CL_NONE is 0, so `mask ?? DEFAULT` must not treat it as "unset" and hand the
      // entity the default POINTER|PHYSICS mask the scene explicitly opted out of.
      it('should leave the collider unpickable by pointer rays', () => {
        expect(colliderOf(entity)!.isPickable).toBe(false)
      })

      it('should leave physics collisions disabled on it', () => {
        expect(colliderOf(entity)!.checkCollisions).toBe(false)
      })
    })

    // The two describes above only ever apply SYMMETRIC masks — both layers or
    // neither — which every wiring of the two bits satisfies: measured, swapping the
    // CL_PHYSICS and CL_POINTER bits in setColliderMask, or setting isPickable for
    // any non-zero mask, passed the whole file. The single-layer masks are the ones
    // that pin which bit drives which flag, and they are also the ones a scene uses
    // to make a trigger volume that pointer rays see but the avatar walks through.
    describe('when a scene puts a shaped MeshCollider with only the CL_POINTER collision mask', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = nextEntityId++ as Entity
        await putCollider(entity, { mesh: { $case: 'box', box: {} }, collisionMask: ColliderLayer.CL_POINTER })
      })

      it('should make the collider pickable so pointer rays hit it', () => {
        expect(colliderOf(entity)!.isPickable).toBe(true)
      })

      it('should leave physics collisions disabled so the avatar walks through it', () => {
        expect(colliderOf(entity)!.checkCollisions).toBe(false)
      })
    })

    describe('when a scene puts a shaped MeshCollider with only the CL_PHYSICS collision mask', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = nextEntityId++ as Entity
        await putCollider(entity, { mesh: { $case: 'box', box: {} }, collisionMask: ColliderLayer.CL_PHYSICS })
      })

      it('should enable physics collisions so the avatar cannot walk through it', () => {
        expect(colliderOf(entity)!.checkCollisions).toBe(true)
      })

      it('should leave the collider unpickable so pointer rays pass through it', () => {
        expect(colliderOf(entity)!.isPickable).toBe(false)
      })
    })
  }
)
