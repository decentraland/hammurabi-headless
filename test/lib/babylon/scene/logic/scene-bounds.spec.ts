import { Quaternion, TransformNode, Vector3 } from '@babylonjs/core'
import { Scene } from '@dcl/schemas'
import { ColliderLayer } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen'
import { meshColliderComponent } from '../../../../../src/lib/decentraland/sdk-components/mesh-collider-component'
import { transformComponent } from '../../../../../src/lib/decentraland/sdk-components/transform-component'
import { enforceColliderBounds } from '../../../../../src/lib/babylon/scene/logic/scene-bounds'
import { updateAvatarColliders } from '../../../../../src/lib/babylon/scene/logic/avatar-colliders'
import { pickMeshesForMask } from '../../../../../src/lib/babylon/scene/logic/colliders'
import { PLAYER_CAPSULE_HALF_HEIGHT, StaticEntities } from '../../../../../src/lib/babylon/scene/logic/static-entities'
import { playerEntityAtom } from '../../../../../src/lib/decentraland/state'
import { Entity } from '../../../../../src/lib/decentraland/types'
import { CrdtBuilder, testWithEngine } from '../../babylon-test-helper'

// Nothing enforced scene bounds here. A scene could put a collider over a
// NEIGHBOUR's parcel and this server honoured it in raycasts and in avatar
// movement, while every player's client disabled it — so on an authoritative
// server one scene could block movement or absorb pointer events on land it does
// not own. A griefing vector, not just a parity difference.
//
// Matches the client's `CheckColliderBoundsSystem`:
//   `bounds.max.y <= sceneGeometry.Height && CircumscribedPlanes.Contains(bounds)`
// — full containment in XZ, a CEILING on Y, and deliberately no floor.

const MASK = ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS

testWithEngine(
  'scene collider bounds',
  {
    baseUrl: '/',
    // A single parcel at 1,1 spans world x,z in [16, 32). One parcel makes the
    // height log2(1+1)*20 = 20.
    entity: {
      content: [],
      metadata: { scene: { base: '1,1', parcels: ['1,1'] } } as unknown as Scene,
      type: 'scene'
    },
    urn: 'scene-bounds'
  },
  ($) => {
    let timestamp = 0
    let nextEntityId = 700

    /** Puts a unit box collider at a SCENE-LOCAL position and enforces bounds. */
    async function putColliderAt(position: Vector3): Promise<Entity> {
      const entity = nextEntityId++ as Entity
      await $.ctx.crdtSendToRenderer({
        data: new CrdtBuilder()
          .put(transformComponent, entity, ++timestamp, {
            position,
            rotation: Quaternion.Identity(),
            scale: new Vector3(1, 1, 1),
            parent: 0 as Entity
          })
          .put(meshColliderComponent, entity, ++timestamp, {
            collisionMask: MASK,
            mesh: { $case: 'box', box: {} }
          } as any)
          .finish()
      })
      enforceColliderBounds($.ctx)
      return entity
    }

    const colliderOf = (entity: Entity) => $.ctx.entities.get(entity)!.appliedComponents.meshCollider!.collider!
    const isCandidate = (entity: Entity) =>
      Array.from(pickMeshesForMask($.ctx.rootNode, MASK)).includes(colliderOf(entity))

    beforeEach(() => {
      $.startEngine()
    })

    describe('when a collider sits well inside the scene parcel', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = await putColliderAt(new Vector3(8, 1, 8))
      })

      it('should stay enabled', () => {
        expect(colliderOf(entity).isEnabled(false)).toBe(true)
      })

      it('should still be offered to raycasts', () => {
        expect(isCandidate(entity)).toBe(true)
      })
    })

    describe('when a collider is pushed onto a neighbouring parcel', () => {
      let entity: Entity

      beforeEach(async () => {
        // Scene-local x=40 is world x=56, a parcel and a half past this scene's
        // eastern edge at world x=32.
        entity = await putColliderAt(new Vector3(40, 1, 8))
      })

      it('should be disabled, as the client disables it', () => {
        expect(colliderOf(entity).isEnabled(false)).toBe(false)
      })

      // The point of the whole exercise: an out-of-bounds collider must stop
      // answering raycasts, or a scene can absorb pointer events on land it does
      // not own.
      it('should stop being a raycast candidate', () => {
        expect(isCandidate(entity)).toBe(false)
      })
    })

    // A parcel-FILLING floor is the ordinary case, and without the client's tolerances
    // it was disabled by float error: measured, a 16x16 box at plain yaw rotations was
    // disabled at 2 of 5 angles by an overhang of 1.8e-15 m. Babylon world matrices are
    // Float32Array so the sign is unpredictable, which makes it flicker frame to frame
    // — exactly what the client's EXTEND_AMOUNT comment ("to prevent on-boundary
    // flickering (float accuracy)") exists to stop. On an authoritative server the
    // consequence is players falling through a floor that every client keeps.
    describe('when a collider exactly fills its parcel', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = nextEntityId++ as Entity
        await $.ctx.crdtSendToRenderer({
          data: new CrdtBuilder()
            .put(transformComponent, entity, ++timestamp, {
              position: new Vector3(8, 1, 8),
              rotation: Quaternion.Identity(),
              // A 16x16 unit box scaled to span the whole parcel, flush with all four
              // edges — so any intolerance at all disables it.
              scale: new Vector3(16, 1, 16),
              parent: 0 as Entity
            })
            .put(meshColliderComponent, entity, ++timestamp, {
              collisionMask: MASK,
              mesh: { $case: 'box', box: {} }
            } as any)
            .finish()
        })
        enforceColliderBounds($.ctx)
      })

      it('should stay enabled rather than being killed by float error at the edge', () => {
        expect(colliderOf(entity).isEnabled(false)).toBe(true)
      })
    })

    // The two client tolerances cover different magnitudes, and only the pair is
    // parity. The 0.05m plane slack absorbs float error at a flush edge (the case
    // above); the bounds shrink — min(size/2, 0.3)/2 per side, so 0.15m for anything
    // 1.2m or wider — absorbs a real overhang. A collider hanging over by 0.1m is
    // inside the client's ~0.2m total and outside the slack alone, so this is the case
    // that distinguishes them.
    describe('when a wide collider overhangs by less than the client tolerates', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = nextEntityId++ as Entity
        await $.ctx.crdtSendToRenderer({
          data: new CrdtBuilder()
            .put(transformComponent, entity, ++timestamp, {
              // 16 wide, centred 0.1m past the parcel centre, so its east face sits
              // 0.1m beyond the edge.
              position: new Vector3(8.1, 1, 8),
              rotation: Quaternion.Identity(),
              scale: new Vector3(16, 1, 16),
              parent: 0 as Entity
            })
            .put(meshColliderComponent, entity, ++timestamp, {
              collisionMask: MASK,
              mesh: { $case: 'box', box: {} }
            } as any)
            .finish()
        })
        enforceColliderBounds($.ctx)
      })

      it('should stay enabled, matching the client rather than being stricter', () => {
        expect(colliderOf(entity).isEnabled(false)).toBe(true)
      })
    })

    // ...and this is the case that pins the SLACK specifically, which nothing did:
    // setting PLANE_SLACK_METERS to 0 left every other bounds case green, because the
    // shrink alone absorbed them.
    //
    // The shrink is min(sizeX/2, sizeZ/2, 0.3)/2 of the COLLIDER's own size, so a tiny
    // collider gets a tiny shrink: at 0.02 across it is 0.005, and an overhang of 0.03
    // is inside the 0.05 plane slack but well outside the shrink. Only the pair keeps
    // it enabled.
    describe('when a very small collider overhangs by more than its own shrink', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = nextEntityId++ as Entity
        await $.ctx.crdtSendToRenderer({
          data: new CrdtBuilder()
            .put(transformComponent, entity, ++timestamp, {
              // Scene-local x=16.02 is world x=32.02: a 0.02-wide box centred there
              // reaches 0.03 past the parcel's eastern edge at world x=32.
              position: new Vector3(16.02, 1, 8),
              rotation: Quaternion.Identity(),
              scale: new Vector3(0.02, 0.02, 0.02),
              parent: 0 as Entity
            })
            .put(meshColliderComponent, entity, ++timestamp, {
              collisionMask: MASK,
              mesh: { $case: 'box', box: {} }
            } as any)
            .finish()
        })
        enforceColliderBounds($.ctx)
      })

      it('should stay enabled, because the plane slack covers what the shrink cannot', () => {
        expect(colliderOf(entity).isEnabled(false)).toBe(true)
      })
    })

    describe('when a collider straddles the parcel edge', () => {
      let entity: Entity

      beforeEach(async () => {
        // Centre at scene-local x=15.75 puts the box's far face at 16.25, a
        // quarter-metre past the parcel's eastern edge.
        entity = await putColliderAt(new Vector3(15.75, 1, 8))
      })

      // The client tests CONTAINMENT of the whole bounds, not intersection, so a
      // collider poking out at all is out.
      it('should be disabled, because containment is of the whole box', () => {
        expect(colliderOf(entity).isEnabled(false)).toBe(false)
      })
    })

    describe('when a collider is above the scene height limit', () => {
      let entity: Entity

      beforeEach(async () => {
        // One parcel gives log2(2)*20 = 20 metres of height.
        entity = await putColliderAt(new Vector3(8, 25, 8))
      })

      it('should be disabled', () => {
        expect(colliderOf(entity).isEnabled(false)).toBe(false)
      })
    })

    describe('when a collider is below ground level', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = await putColliderAt(new Vector3(8, -30, 8))
      })

      // The client checks only `bounds.max.y <= Height` — there is no floor, and a
      // scene burying a collider is not reaching anyone else's land.
      it('should stay enabled, since the client bounds only the ceiling', () => {
        expect(colliderOf(entity).isEnabled(false)).toBe(true)
      })
    })

    describe('when an out-of-bounds collider comes back inside', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = await putColliderAt(new Vector3(40, 1, 8))
        await $.ctx.crdtSendToRenderer({
          data: new CrdtBuilder()
            .put(transformComponent, entity, ++timestamp, {
              position: new Vector3(8, 1, 8),
              rotation: Quaternion.Identity(),
              scale: new Vector3(1, 1, 1),
              parent: 0 as Entity
            })
            .finish()
        })
        // NO hand-written computeWorldMatrix here. An earlier version of this fixture
        // had one, and it was the only reason this passed: `getBoundingInfo()` reads
        // the CACHED matrix and `_evaluateActiveMeshes` skips disabled meshes, so
        // production never refreshed a disabled collider and the disable was a
        // one-way latch. The refresh belongs in enforceColliderBounds, and this test
        // only proves that if it does not do the work itself.
        enforceColliderBounds($.ctx)
      })

      // One-way disabling would let a scene permanently kill its own colliders by
      // moving them out and back — a moving platform would stop existing.
      it('should be re-enabled rather than disabled forever', () => {
        expect(colliderOf(entity).isEnabled(false)).toBe(true)
      })
    })

    describe('when a player walks outside the scene parcels', () => {
      let capsule: ReturnType<typeof avatarCapsule>

      function avatarCapsule() {
        return $.ctx
          .getOrCreateStaticEntity(StaticEntities.PlayerEntity)
          .getChildMeshes(true)
          .find((mesh) => mesh.name === 'avatar_capsule')!
      }

      beforeEach(() => {
        // The local capsule is built only once the player has a position, and is placed
        // from this atom rather than from entity 1's transform — see
        // positionLocalPlayerCapsule.
        playerEntityAtom.swap({
          absolutePosition: new Vector3(0, PLAYER_CAPSULE_HALF_HEIGHT, 0),
          absoluteRotationQuaternion: Quaternion.Identity()
        } as unknown as TransformNode)
        updateAvatarColliders($.ctx)
        // Entity 1 sits at the scene origin, which for a scene based at 1,1 is world
        // (16,0,16) — the parcel's own corner, so the capsule straddles the edge and
        // would fail a containment test.
        enforceColliderBounds($.ctx)
        capsule = avatarCapsule()
      })

      // Avatars are not scene-authored geometry, the client does not bounds-check
      // them, and a player standing on a parcel edge should not stop being
      // raycastable.
      it('should leave the avatar capsule enabled', () => {
        expect(capsule.isEnabled(false)).toBe(true)
      })
    })
  }
)

// The block above drives `enforceColliderBounds` directly, because
// babylon-test-helper mocks `ctx.updateInteractionSystems` — which is where the
// production wiring lives. Verified by mutation: removing the call from
// scene-context.ts left every case above green while nothing enforced bounds at
// all in production.
testWithEngine(
  'scene collider bounds, wired into the frame',
  {
    baseUrl: '/',
    entity: {
      content: [],
      metadata: { scene: { base: '1,1', parcels: ['1,1'] } } as unknown as Scene,
      type: 'scene'
    },
    urn: 'scene-bounds-wiring'
  },
  ($) => {
    let timestamp = 0
    let outOfBounds: Entity

    beforeEach(async () => {
      $.startEngine()
      outOfBounds = 800 as Entity
      await $.ctx.crdtSendToRenderer({
        data: new CrdtBuilder()
          .put(transformComponent, outOfBounds, ++timestamp, {
            // Scene-local x=40 is world x=56, well past this parcel's edge at 32.
            position: new Vector3(40, 1, 8),
            rotation: Quaternion.Identity(),
            scale: new Vector3(1, 1, 1),
            parent: 0 as Entity
          })
          .put(meshColliderComponent, outOfBounds, ++timestamp, {
            collisionMask: MASK,
            mesh: { $case: 'box', box: {} }
          } as any)
          .finish()
      })

      const spy = $.ctx.updateInteractionSystems as unknown as jest.SpyInstance
      spy.mockRestore()
      $.ctx.updateInteractionSystems()
    })

    afterEach(() => {
      jest.spyOn($.ctx, 'updateInteractionSystems').mockImplementation(() => void 0)
    })

    it('should disable an out-of-bounds collider without anything calling the system by hand', () => {
      const collider = $.ctx.entities.get(outOfBounds)!.appliedComponents.meshCollider!.collider!
      expect(collider.isEnabled(false)).toBe(false)
    })
  }
)

// `if (minX)` treated a parcel coordinate of 0 as "no scene bounds at all", so a
// scene whose leftmost parcel sits on x=0 built no bounding box — it was never
// frustum-culled, and with bounds enforcement it would never be checked either.
// Genesis City is centred on 0,0, so this is not an exotic layout.
testWithEngine(
  'a scene whose leftmost parcel sits on x=0',
  {
    baseUrl: '/',
    entity: {
      content: [],
      metadata: { scene: { base: '0,0', parcels: ['0,0'] } } as unknown as Scene,
      type: 'scene'
    },
    urn: 'scene-bounds-origin'
  },
  ($) => {
    it('should still build a bounding box, so its colliders can be bounds-checked', () => {
      expect($.ctx.boundingBox === undefined).toBe(false)
    })
  }
)
