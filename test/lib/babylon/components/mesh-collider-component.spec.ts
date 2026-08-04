import { AbstractMesh, Ray, Vector3, VertexBuffer } from '@babylonjs/core'
import { Scene } from '@dcl/schemas'
import { ColliderLayer, PBMeshCollider } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen'
import { meshColliderComponent } from '../../../../src/lib/decentraland/sdk-components/mesh-collider-component'
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

// Babylon's unit box: 4 vertices per face x 6 faces, the count a cloned box
// template would carry into any other shape.
const BOX_TEMPLATE_VERTEX_COUNT = 24

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

      it('should build a collider named box_collider so setColliderMask treats it as a collider', () => {
        expect(colliderOf(entity)!.name).toBe('box_collider')
      })

      it('should build a unit cube spanning half a metre from the entity origin on every axis', () => {
        expect(colliderOf(entity)!.getBoundingInfo().boundingBox.extendSize.asArray()).toEqual([0.5, 0.5, 0.5])
      })

      // Colliders live under the entity, which lives under the scene rootNode.
      // pickMeshesForMask only walks getChildMeshes(), so an unparented collider is
      // invisible to every raycast the scene makes.
      it('should attach the collider to the entity so raycasts traversing the entity can find it', () => {
        expect(colliderOf(entity)!.parent).toBe($.ctx.entities.get(entity))
      })
    })

    describe('when a scene puts a MeshCollider with a sphere shape', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = nextEntityId++ as Entity
        await putCollider(entity, { mesh: { $case: 'sphere', sphere: {} } })
      })

      it('should build a collider named sphere_collider so setColliderMask treats it as a collider', () => {
        expect(colliderOf(entity)!.name).toBe('sphere_collider')
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

      it('should build a collider named plane_collider so setColliderMask treats it as a collider', () => {
        expect(colliderOf(entity)!.name).toBe('plane_collider')
      })

      it('should build a 1x1 quad with no depth instead of a cube', () => {
        expect(colliderOf(entity)!.getBoundingInfo().boundingBox.extendSize.asArray()).toEqual([0.5, 0.5, 0])
      })

      it('should be hit by a ray arriving at its front face', () => {
        expect(hitFromFront).toBe(true)
      })

      // Babylon's ray/triangle test does not backface-cull, and the collision engine
      // culls back faces only for meshes without a material — setColliderMask gives
      // every `_collider` mesh the collider material. So a single-sided quad already
      // collides from both sides and Mesh.DOUBLESIDE would only double the geometry.
      it('should be hit by a ray arriving from behind even though the quad is single sided', () => {
        expect(hitFromBehind).toBe(true)
      })

      it('should keep the cheaper single-sided geometry of 4 vertices', () => {
        expect(colliderOf(entity)!.getTotalVertices()).toBe(4)
      })
    })

    describe('when a scene puts a MeshCollider with a cylinder shape', () => {
      describe('and the radii are omitted', () => {
        let entity: Entity

        beforeEach(async () => {
          entity = nextEntityId++ as Entity
          await putCollider(entity, { mesh: { $case: 'cylinder', cylinder: {} } })
        })

        it('should build a collider named cylinder_collider so setColliderMask treats it as a collider', () => {
          expect(colliderOf(entity)!.name).toBe('cylinder_collider')
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
          expect(colliderOf(entity)!.parent).toBe($.ctx.entities.get(entity))
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
        // diameter as 1), which is an implementation detail, not a contract.
        it('should replace it with the 0.5 default instead of relying on the builder', () => {
          expect(endCapRadius(colliderOf(entity)!, 'top')).toBeCloseTo(0.5, 5)
        })

        it('should leave the finite bottom radius untouched', () => {
          expect(endCapRadius(colliderOf(entity)!, 'bottom')).toBeCloseTo(1, 5)
        })
      })

      describe('and a radius is negative', () => {
        let entity: Entity

        beforeEach(async () => {
          entity = nextEntityId++ as Entity
          await putCollider(entity, {
            mesh: { $case: 'cylinder', cylinder: { radiusTop: -3, radiusBottom: 1 } }
          })
        })

        // Clamped to 0 (a cone tip) so the winding stays consistent; Babylon widens a
        // zero cap to a 1e-5 diameter of its own, hence the tolerance.
        it('should collapse it to a cone tip instead of inverting the winding', () => {
          expect(endCapRadius(colliderOf(entity)!, 'top')).toBeLessThan(0.001)
        })

        it('should leave the valid bottom radius untouched', () => {
          expect(endCapRadius(colliderOf(entity)!, 'bottom')).toBeCloseTo(1, 5)
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

      beforeEach(async () => {
        entity = nextEntityId++ as Entity
        await putCollider(entity, { collisionMask: ColliderLayer.CL_POINTER })
      })

      // Matches the reference client, which returns early on MeshOneofCase.None.
      // Falling through to a box fabricated an invisible collider no client had.
      it('should not build any collider mesh', () => {
        expect(colliderOf(entity)).toBeNull()
      })

      it('should still record the component so a later delete has an entry to clear', () => {
        expect($.ctx.entities.get(entity)!.appliedComponents.meshCollider).toBeTruthy()
      })
    })

    describe('when the component carries a mesh shape this build does not implement', () => {
      let entity: Entity
      let errorSpy: jest.SpyInstance
      // The rate-limited logger keeps MODULE-level state with a 1s window, so every
      // test here shares one throttle. Each moves the clock further forward than the
      // last, otherwise only the first test could ever observe a log line.
      let clockSkewMs = 0

      beforeEach(async () => {
        entity = nextEntityId++ as Entity
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
        // @dcl/protocol is resolved at USER-INSTALL time, so the decoder can emit a
        // `$case` this build predates. No real PUT can produce one here — the
        // installed decoder only knows today's shapes — so the value is injected at
        // the storage the applier reads.
        const storage = $.ctx.components[meshColliderComponent.componentId]
        await putCollider(entity, { mesh: { $case: 'box', box: {} } })
        jest
          .spyOn(storage, 'getOrNull')
          .mockReturnValue({ mesh: { $case: 'hyperboloid' } } as unknown as PBMeshCollider)
        clockSkewMs += 3_600_000
        const realNow = Date.now()
        jest.spyOn(Date, 'now').mockReturnValue(realNow + clockSkewMs)
        meshColliderComponent.applyChanges($.ctx.entities.get(entity)!, storage)
      })

      afterEach(() => {
        jest.restoreAllMocks()
      })

      it('should not build a collider for a shape it cannot represent', () => {
        expect(colliderOf(entity)).toBeNull()
      })

      // Silence is correct for an UNSET oneof, but an unknown case means protocol
      // drift: the entity is colliderless while the scene believes otherwise.
      it('should report the unsupported shape so the drift is visible to an operator', () => {
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('hyperboloid'), undefined)
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

      it('should clear the applied component so no stale reference to the disposed mesh remains', () => {
        expect($.ctx.entities.get(entity)!.appliedComponents.meshCollider).toBeUndefined()
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
  }
)
