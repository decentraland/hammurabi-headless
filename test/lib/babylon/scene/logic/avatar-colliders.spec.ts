import { AbstractMesh, Quaternion, TransformNode, Vector3 } from '@babylonjs/core'
import { Scene } from '@dcl/schemas'
import { ColliderLayer } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen'
import { RaycastQueryType } from '@dcl/protocol/out-js/decentraland/sdk/components/raycast.gen'
import { transformComponent } from '../../../../../src/lib/decentraland/sdk-components/transform-component'
import {
  raycastComponent,
  raycastResultComponent
} from '../../../../../src/lib/decentraland/sdk-components/raycast-component'
import { processRaycasts } from '../../../../../src/lib/babylon/scene/logic/raycasts'
import {
  AVATAR_CAPSULE_RADIUS,
  isRemotePlayerEntity,
  LOCAL_PLAYER_CAPSULE_HEIGHT,
  REMOTE_PLAYER_CAPSULE_HEIGHT,
  updateAvatarColliders
} from '../../../../../src/lib/babylon/scene/logic/avatar-colliders'
import { playerEntityAtom } from '../../../../../src/lib/decentraland/state'
import { floorMeshes, getColliderLayers, setColliderMask } from '../../../../../src/lib/babylon/scene/logic/colliders'
import {
  AVATAR_ENTITY_RANGE,
  PLAYER_CAPSULE_HALF_HEIGHT,
  PLAYER_HEIGHT,
  StaticEntities
} from '../../../../../src/lib/babylon/scene/logic/static-entities'
import { EntityUtils } from '../../../../../src/lib/decentraland/crdt-internal/generational-index-pool'
import { Entity } from '../../../../../src/lib/decentraland/types'
import { CrdtBuilder, testWithEngine } from '../../babylon-test-helper'

// A CL_PLAYER raycast used to return an empty result on this server, always: no
// avatar collider existed anywhere. The reference client resolves player hits in
// `ExecuteRaycastSystem.DoesHitColliderQualify`, so a scene doing player detection
// (proximity triggers, aiming, "who is standing here") worked for every real
// player and silently found nobody here.
//
// The local player's CharacterController capsule could not be reused: it lives
// outside every scene's node tree, and `pickMeshesForMask` walks DOWN from the
// scene root, so it was unreachable by construction.
//
// FIXTURE CONSTRAINT, and why the cases below are shaped as they are: player
// entities are ENGINE-owned and cannot be positioned from a test. Writing them via
// `crdtSendToRenderer` is rejected by the scene write-guard (the reserved range is
// not scene-writable), and assigning `entity.position` directly does not survive —
// `BabylonEntity._setTransformParametersBeforeMatrixCalculation` resets position to
// zero on every matrix computation for an entity with no transform COMMANDS, which
// only the avatar-comms CRDT sync produces. So every player entity here sits at the
// scene origin, and the RAY moves instead of the players.

/** First id in the avatar-comms range (32-255). */
const FIRST_REMOTE_PLAYER = 32 as Entity

testWithEngine(
  'avatar colliders',
  {
    baseUrl: '/',
    entity: { content: [], metadata: {} as Scene, type: 'scene' },
    urn: 'avatar-colliders'
  },
  ($) => {
    let timestamp = 0
    let nextEntityId = 700
    let raycastEntity: Entity

    const resultOf = (entity: Entity) =>
      $.ctx.components[raycastResultComponent.componentId].getOrNull(entity) as any

    const capsuleOf = (playerEntity: Entity): AbstractMesh | undefined =>
      $.ctx
        .getOrCreateStaticEntity(playerEntity)
        .getChildMeshes(true)
        .find((mesh) => mesh.name === 'avatar_capsule')

    /**
     * Fires from 10m along -Z back towards the origin, at the players standing
     * there. Chest height, so it crosses a standing capsule rather than passing
     * over or under it.
     */
    async function fireAtTheOrigin(collisionMask: number): Promise<void> {
      raycastEntity = nextEntityId++ as Entity
      await $.ctx.crdtSendToRenderer({
        data: new CrdtBuilder()
          .put(transformComponent, raycastEntity, ++timestamp, {
            position: new Vector3(0, PLAYER_CAPSULE_HALF_HEIGHT, -10),
            rotation: Quaternion.Identity(),
            scale: new Vector3(1, 1, 1),
            parent: 0 as Entity
          })
          .put(raycastComponent, raycastEntity, ++timestamp, {
            timestamp: 1,
            maxDistance: 100,
            queryType: RaycastQueryType.RQT_HIT_FIRST,
            continuous: false,
            collisionMask,
            direction: { $case: 'globalDirection', globalDirection: new Vector3(0, 0, 1) }
          } as any)
          .finish()
      })
      processRaycasts($.ctx)
    }

    beforeEach(() => {
      $.startEngine()
      // The LOCAL capsule is positioned from this atom, not from entity 1's transform
      // (entity 1 never receives one — see positionLocalPlayerCapsule), and is not
      // built at all until the player has a position. Feet at the scene origin, so the
      // ray fixture below still crosses it: the atom holds the CharacterController
      // capsule, whose position is its CENTRE.
      playerEntityAtom.swap({
        absolutePosition: new Vector3(0, PLAYER_CAPSULE_HALF_HEIGHT, 0),
        absoluteRotationQuaternion: Quaternion.Identity()
      } as unknown as TransformNode)

      // Materialize the remote player BEFORE the system looks for it: it only
      // gives capsules to entities that already exist, and nothing here creates
      // entity 32 otherwise. Without this the first test in the file ran against a
      // scene with no remote player and every later one passed on a capsule built
      // during the previous test's setup.
      $.ctx.getOrCreateStaticEntity(FIRST_REMOTE_PLAYER)
      updateAvatarColliders($.ctx)
    })

    afterEach(() => {
      // Capsules are built ONCE per entity and the entities outlive each test, so a
      // test that re-masks one to isolate a hit would otherwise leave it that way
      // for the rest of the file. Disposing them makes the next beforeEach rebuild
      // from the production path, which is also what keeps the tagging assertions
      // above testing the SOURCE rather than a value the fixture just wrote.
      capsuleOf(StaticEntities.PlayerEntity)?.dispose()
      capsuleOf(FIRST_REMOTE_PLAYER)?.dispose()
    })

    describe('when the collider system has seen the player entities', () => {
      it('should give the local player a capsule', () => {
        expect(capsuleOf(StaticEntities.PlayerEntity) === undefined).toBe(false)
      })

      it('should give a remote player a capsule', () => {
        expect(capsuleOf(FIRST_REMOTE_PLAYER) === undefined).toBe(false)
      })

      // `PLAYER_QUALIFYING_BITS = ClPlayer | ClMainPlayer` in the client: a mask
      // naming only CL_MAIN_PLAYER must find the local player. This is the bit that
      // was still called CL_RESERVED2 before the protocol bump.
      it('should tag the local player as both a player and THE main player', () => {
        expect(getColliderLayers(capsuleOf(StaticEntities.PlayerEntity)!)).toBe(
          ColliderLayer.CL_PLAYER | ColliderLayer.CL_MAIN_PLAYER
        )
      })

      it('should tag a remote player as a player but not the main one', () => {
        expect(getColliderLayers(capsuleOf(FIRST_REMOTE_PLAYER)!)).toBe(ColliderLayer.CL_PLAYER)
      })

      // Player entity transforms are FEET-anchored while CreateCapsule centres its
      // mesh on the origin, so an unlifted capsule stands half-buried, and a ray at
      // chest height passes over a crouching half-person. Asserted on the REMOTE
      // player, whose capsule really does hang off its entity's transform; the local
      // one is placed in world terms instead (see below).
      it('should stand the capsule on the entity rather than centring it there', () => {
        expect(capsuleOf(FIRST_REMOTE_PLAYER)!.position.y).toBeCloseTo(REMOTE_PLAYER_CAPSULE_HEIGHT / 2, 5)
      })

      // The client's two prefabs disagree, and so must we: `CharacterObject.prefab` is
      // 1.6 tall and `RemoteAvatarCollider.prefab` is 1.9.
      it('should build the local player at the clients local-player height', () => {
        const extent = capsuleOf(StaticEntities.PlayerEntity)!.getBoundingInfo().boundingBox.extendSize
        expect(extent.y * 2).toBeCloseTo(LOCAL_PLAYER_CAPSULE_HEIGHT, 5)
      })

      it('should build a remote player at the clients remote-player height', () => {
        const extent = capsuleOf(FIRST_REMOTE_PLAYER)!.getBoundingInfo().boundingBox.extendSize
        expect(extent.y * 2).toBeCloseTo(REMOTE_PLAYER_CAPSULE_HEIGHT, 5)
      })

      it('should build it at the clients capsule radius', () => {
        const extent = capsuleOf(StaticEntities.PlayerEntity)!.getBoundingInfo().boundingBox.extendSize
        expect(extent.x).toBeCloseTo(AVATAR_CAPSULE_RADIUS, 5)
      })

      // setColliderMask registers anything named `*_collider` as a ground-detection
      // candidate. A person is not a floor, which is why the capsule is deliberately
      // NOT given that suffix.
      it('should not register a player as a floor candidate', () => {
        expect(floorMeshes.has(capsuleOf(StaticEntities.PlayerEntity)!)).toBe(false)
      })

      // The system runs every frame for every scene. Building a capsule per frame
      // would leak one mesh per frame per player for as long as anyone is connected.
      it('should build each capsule once rather than once per frame', () => {
        for (let frame = 0; frame < 5; frame++) updateAvatarColliders($.ctx)

        const capsules = $.ctx
          .getOrCreateStaticEntity(FIRST_REMOTE_PLAYER)
          .getChildMeshes(true)
          .filter((mesh) => mesh.name === 'avatar_capsule')
        expect(capsules).toHaveLength(1)
      })
    })

    describe('when a scene raycasts for CL_PLAYER', () => {
      beforeEach(async () => {
        await fireAtTheOrigin(ColliderLayer.CL_PLAYER)
      })

      it('should report a hit instead of the empty result this always used to give', () => {
        expect(resultOf(raycastEntity).hits).toHaveLength(1)
      })

      // Radius 0.3 around the origin, ray starting 10m away.
      it('should report the distance to the capsule surface', () => {
        expect(resultOf(raycastEntity).hits[0].length).toBeCloseTo(9.7, 1)
      })
    })

    // Entity 1 never receives a Transform of its own — `updateStaticEntities` writes it
    // host->scene and nothing ingests it back — so a capsule merely PARENTED to that
    // entity stays at the scene root origin no matter where the player walks. That
    // shipped: `CL_MAIN_PLAYER` reported a confident hit on a phantom at the parcel
    // corner while missing the real player, which is worse than the empty result it
    // replaced. This is the case that pins the position being driven from the atom.
    describe('when the local player has walked away from the scene origin', () => {
      beforeEach(async () => {
        playerEntityAtom.swap({
          absolutePosition: new Vector3(5, PLAYER_CAPSULE_HALF_HEIGHT, 7),
          absoluteRotationQuaternion: Quaternion.Identity()
        } as unknown as TransformNode)
        updateAvatarColliders($.ctx)
      })

      it('should move the capsule with the player rather than leaving it at the origin', () => {
        const capsule = capsuleOf(StaticEntities.PlayerEntity)!
        expect([capsule.position.x, capsule.position.z]).toEqual([5, 7])
      })

      it('should not report a hit where the player no longer is', async () => {
        await fireAtTheOrigin(ColliderLayer.CL_MAIN_PLAYER)
        expect(resultOf(raycastEntity).hits).toHaveLength(0)
      })
    })

    describe('when a scene raycasts for CL_MAIN_PLAYER only', () => {
      beforeEach(async () => {
        // Take the remote player out of the running so the hit is unambiguous:
        // every player entity sits at the origin (see the fixture note above), so
        // two qualifying capsules would be coincident.
        setColliderMask(capsuleOf(FIRST_REMOTE_PLAYER)!, ColliderLayer.CL_NONE)
        await fireAtTheOrigin(ColliderLayer.CL_MAIN_PLAYER)
      })

      it('should find the local player', () => {
        expect(resultOf(raycastEntity).hits).toHaveLength(1)
      })

      // The client reports the local player as SpecialEntitiesID.PLAYER_ENTITY.
      it('should report it as entity 1', () => {
        expect(resultOf(raycastEntity).hits[0].entityId).toBe(StaticEntities.PlayerEntity)
      })
    })

    describe('when a remote player is the only one a CL_PLAYER ray can reach', () => {
      beforeEach(async () => {
        setColliderMask(capsuleOf(StaticEntities.PlayerEntity)!, ColliderLayer.CL_NONE)
        await fireAtTheOrigin(ColliderLayer.CL_PLAYER)
      })

      it('should still report the hit', () => {
        expect(resultOf(raycastEntity).hits).toHaveLength(1)
      })

      // Matches the client, whose DoesHitColliderQualify returns true for the
      // other-avatars layer with `foundEntity` left null. Our capsules ARE children
      // of the scene entity so the id is right there — it is suppressed on purpose,
      // because a scene author who read it here would find it undefined for every
      // real player.
      it('should report no entityId, as the client does for remote avatars', () => {
        expect(resultOf(raycastEntity).hits[0].entityId).toBeUndefined()
      })
    })

    // Everything above drives `updateAvatarColliders` directly, because
    // babylon-test-helper mocks `ctx.updateInteractionSystems` — which is where the
    // production wiring lives. That left the wiring itself unverified: removing the
    // call from scene-context.ts kept the whole suite green while the feature was
    // dead in production. Verified by mutation, before and after this case.
    describe('when the scene runs its real per-frame interaction update', () => {
      let restoreMock: () => void

      beforeEach(() => {
        capsuleOf(StaticEntities.PlayerEntity)?.dispose()
        capsuleOf(FIRST_REMOTE_PLAYER)?.dispose()

        const spy = $.ctx.updateInteractionSystems as unknown as jest.SpyInstance
        spy.mockRestore()
        // Re-arm the helper's mock afterwards: leaving the real method live would
        // let the render loop drive it for the rest of the file.
        restoreMock = () => {
          jest.spyOn($.ctx, 'updateInteractionSystems').mockImplementation(() => void 0)
        }

        $.ctx.updateInteractionSystems()
      })

      afterEach(() => {
        restoreMock()
      })

      it('should build the avatar capsules, so the feature is reachable in production', () => {
        expect(capsuleOf(StaticEntities.PlayerEntity) === undefined).toBe(false)
      })
    })

    // A REUSED slot. PlayerEntityManager returns `toEntityId(number, version + 1)`, so
    // a slot's second occupant is `32 | (1 << 16)` = 65568 — which a raw
    // `id >= 32 && id < 256` comparison rejects and a `for (id = 32; id < 256)` probe
    // never reaches. Every player after the first join/leave cycle on a slot was
    // invisible to CL_PLAYER, and the whole spec passed because it only ever used
    // version-0 ids.
    describe('when a remote slot has been reused, so its id carries a version', () => {
      let versioned: Entity

      beforeEach(() => {
        versioned = EntityUtils.toEntityId(AVATAR_ENTITY_RANGE[0], 1)
        // The path avatar CRDT ingestion takes.
        ;($.ctx as any).tryGetOrCreateEntity(versioned)
        updateAvatarColliders($.ctx)
      })

      it('should recognise it as a remote player despite the version bits', () => {
        expect(isRemotePlayerEntity(versioned)).toBe(true)
      })

      // Not via capsuleOf: that uses getOrCreateStaticEntity, which rejects ids at or
      // past MAX_RESERVED_ENTITY, and a versioned id is numerically far past it.
      it('should give it a capsule', () => {
        const capsules = $.ctx
          .getEntityOrNull(versioned)!
          .getChildMeshes(true)
          .filter((mesh) => mesh.name === 'avatar_capsule')
        expect(capsules).toHaveLength(1)
      })
    })

    // BabylonEntity.dispose() calls super.dispose(true, false), and
    // TransformNode.dispose(doNotRecurse) DETACHES children rather than disposing them
    // — so an orphaned capsule survives in scene.meshes, re-evaluated every frame, one
    // per join/leave cycle for the life of the process.
    describe('when a player entity is removed', () => {
      let capsule: ReturnType<typeof capsuleOf>

      beforeEach(() => {
        capsule = capsuleOf(FIRST_REMOTE_PLAYER)
        $.ctx.removeEntity(FIRST_REMOTE_PLAYER)
      })

      it('should dispose its capsule rather than orphaning it into the scene', () => {
        expect(capsule!.isDisposed()).toBe(true)
      })

      it('should stop tracking it as a player entity', () => {
        expect($.ctx.playerEntities.has(FIRST_REMOTE_PLAYER)).toBe(false)
      })
    })

    describe('when a scene raycasts for CL_PHYSICS', () => {
      beforeEach(async () => {
        await fireAtTheOrigin(ColliderLayer.CL_PHYSICS)
      })

      // Avatars carry only the player bits. A scene raycasting for walls and floors
      // must not start hitting people.
      it('should not hit a player', () => {
        expect(resultOf(raycastEntity).hits).toHaveLength(0)
      })
    })
  }
)
