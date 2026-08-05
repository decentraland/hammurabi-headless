import * as BABYLON from '@babylonjs/core'
import { Vector3 } from '@babylonjs/core'
import { Scene } from '@dcl/schemas'
import { ColliderLayer } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen'
import { InputAction, InteractionType, PointerEventType } from '@dcl/protocol/out-js/decentraland/sdk/components/common/input_action.gen'
import { meshColliderComponent } from '../../../../../src/lib/decentraland/sdk-components/mesh-collider-component'
import { pointerEventsComponent } from '../../../../../src/lib/decentraland/sdk-components/pointer-events'
import { transformComponent } from '../../../../../src/lib/decentraland/sdk-components/transform-component'
import {
  interactWithScene,
  MAX_POINTER_PICK_DISTANCE,
  pickActivePointerEventsEntity,
  pickPointerEventsMesh
} from '../../../../../src/lib/babylon/scene/logic/pointer-events'
import { updateAvatarColliders } from '../../../../../src/lib/babylon/scene/logic/avatar-colliders'
import { addFloorMesh, floorMeshes, setColliderMask } from '../../../../../src/lib/babylon/scene/logic/colliders'
import { pointerEventsResultComponent } from '../../../../../src/lib/decentraland/sdk-components/pointer-events-result'
import { Entity } from '../../../../../src/lib/decentraland/types'
import { loadedScenesByEntityId, playerEntityAtom } from '../../../../../src/lib/decentraland/state'
import { PLAYER_CAPSULE_HALF_HEIGHT, StaticEntities } from '../../../../../src/lib/babylon/scene/logic/static-entities'
import { CrdtBuilder, testWithEngine } from '../../babylon-test-helper'

// The centre-screen pick had NO test at all, and no distance limit: `scene.pick`
// tests the whole scene, so an entity a kilometre away could be hovered and clicked
// here while the client caps its pointer ray at
// `PlayerOriginatedRaycastSystem.MAX_RAYCAST_DISTANCE`.
//
// The per-entry `maxDistance` filter (default 10m) rejects most of those anyway, but a
// scene is free to ask for maxDistance 500 — on the client that still cannot fire past
// the ray cap, so without this the two disagree for exactly the scenes that opt into
// long-range interaction.

testWithEngine(
  'pointer pick reach',
  {
    baseUrl: '/',
    entity: { content: [], metadata: {} as Scene, type: 'scene' },
    urn: 'pointer-pick'
  },
  ($) => {
    let timestamp = 0
    let nextEntityId = 700
    let camera: BABYLON.FreeCamera
    let created: Entity[] = []

    /**
     * A pointer-interactive box straight ahead at `distance` metres: a CL_POINTER
     * collider plus a PointerEvents component, which is what the pick predicate
     * requires.
     */
    async function putInteractiveBox(distance: number, entries?: any[]): Promise<Entity> {
      const entity = nextEntityId++ as Entity
      created.push(entity)
      await $.ctx.crdtSendToRenderer({
        data: new CrdtBuilder()
          .put(transformComponent, entity, ++timestamp, {
            position: new Vector3(0, 0, distance),
            rotation: BABYLON.Quaternion.Identity(),
            scale: new Vector3(1, 1, 1),
            parent: 0 as Entity
          })
          .put(meshColliderComponent, entity, ++timestamp, {
            collisionMask: ColliderLayer.CL_POINTER,
            mesh: { $case: 'box', box: {} }
          } as any)
          .put(pointerEventsComponent, entity, ++timestamp, {
            pointerEvents: entries ?? [
              {
                eventType: PointerEventType.PET_DOWN,
                interactionType: InteractionType.CURSOR,
                // Deliberately far beyond the pick cap: the ENTRY is willing, so only
                // the pick's own reach can stop it.
                eventInfo: { maxDistance: 10_000 }
              }
            ]
          } as any)
          .finish()
      })
      return entity
    }

    /** PointerEventsResult is a grow-only SET, so `get` hands back a ReadonlySet. */
    const resultsFor = (entity: Entity): any[] =>
      Array.from($.ctx.components[pointerEventsResultComponent.componentId].get(entity) ?? [])

    beforeEach(() => {
      $.startEngine()
      created = []
      // `pickPointerEventsMesh` early-returns unless some LOADED scene has a
      // PointerEvents component, and it looks that up through the global scene
      // registry — which the test helper does not populate, so the pick never ran and
      // `lastPickedEntity` stayed null. Registering the context is what production
      // does when a scene loads.
      loadedScenesByEntityId.set($.ctx.entityId, $.ctx)
      // A camera at the origin looking down +Z, so the centre of the screen points
      // straight at the boxes placed above.
      camera = new BABYLON.FreeCamera('pick-camera', Vector3.Zero(), $.scene)
      camera.setTarget(new Vector3(0, 0, 1))
      $.scene.activeCamera = camera
    })

    afterEach(async () => {
      camera.dispose()
      loadedScenesByEntityId.delete($.ctx.entityId)
      // Entities outlive each test in this shared SceneContext, and a nearer box left
      // behind is simply picked instead — the out-of-reach case "failed" by finding
      // the previous test's entity at 10 metres.
      if (!created.length) return
      const teardown = new CrdtBuilder()
      for (const entity of created) teardown.deleteEntity(entity)
      await $.ctx.crdtSendToRenderer({ data: teardown.finish() })
    })

    describe('when an interactive entity is comfortably within reach', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = await putInteractiveBox(10)
      })

      it('should be picked', () => {
        expect(pickActivePointerEventsEntity($.scene)?.entityId).toBe(entity)
      })
    })

    describe('when an interactive entity is beyond the pick reach', () => {
      beforeEach(async () => {
        await putInteractiveBox(MAX_POINTER_PICK_DISTANCE + 50)
      })

      // Its own entry asks for maxDistance 10_000, so nothing but the pick cap can
      // refuse it — which is what makes this the assertion for the cap rather than
      // for the per-entry filter.
      // `=== null` rather than `toBeNull()`: the failing value is a BabylonEntity, and
      // handing one to a matcher makes pretty-format walk its whole object graph (see
      // the note in mesh-renderer-component.spec.ts). Measured here as an unreadable
      // dump of every private field on the node.
      it('should not be picked, however willing its own entry is', () => {
        expect(pickActivePointerEventsEntity($.scene) === null).toBe(true)
      })
    })

    // The filter rules are unit-tested in pointer-event-filter.spec.ts and the pick
    // reach above, but nothing exercised interactWithScene ITSELF — verified by
    // mutation, both "bypass the filter entirely" and "report the raw input button
    // instead of the entry's" left the whole suite green.
    describe('when a picked entity declares a single specific entry', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = await putInteractiveBox(5, [
          {
            eventType: PointerEventType.PET_DOWN,
            interactionType: InteractionType.CURSOR,
            eventInfo: { button: InputAction.IA_PRIMARY }
          }
        ])
        pickPointerEventsMesh($.scene)
      })

      it('should emit a result for the event it asked for', () => {
        interactWithScene(PointerEventType.PET_DOWN, InputAction.IA_PRIMARY)
        expect(resultsFor(entity).map((r) => r.state)).toEqual([PointerEventType.PET_DOWN])
      })

      // The bug this replaces: nothing compared the event type, so an entity asking
      // only for PET_DOWN also received PET_UP.
      it('should emit nothing for an event type it never asked for', () => {
        interactWithScene(PointerEventType.PET_UP, InputAction.IA_PRIMARY)
        expect(resultsFor(entity)).toEqual([])
      })

      it('should emit nothing for a button it never asked for', () => {
        interactWithScene(PointerEventType.PET_DOWN, InputAction.IA_SECONDARY)
        expect(resultsFor(entity)).toEqual([])
      })
    })

    describe('when a picked entity declares IA_ANY', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = await putInteractiveBox(5, [
          {
            eventType: PointerEventType.PET_DOWN,
            interactionType: InteractionType.CURSOR,
            eventInfo: { button: InputAction.IA_ANY }
          }
        ])
        pickPointerEventsMesh($.scene)
        interactWithScene(PointerEventType.PET_DOWN, InputAction.IA_SECONDARY)
      })

      it('should accept the press', () => {
        expect(resultsFor(entity)).toHaveLength(1)
      })

      // The RAW input action, not the entry's button. The client reports the concrete
      // action pressed (`AddInputAction(ecsInputAction, ...)`), and it matters: the
      // canonical SDK click declares `{PET_DOWN, IA_ANY}`, so reporting the entry's
      // button gave the scene IA_ANY and `getInputCommand(IA_ANY, PET_DOWN, entity)`
      // resolved to null — onPointerDown never fired.
      it('should report the raw input action, which is what the SDK matches on', () => {
        expect(resultsFor(entity)[0].button).toBe(InputAction.IA_SECONDARY)
      })
    })

    describe('when a picked entity is inside the pick reach but past its own maxDistance', () => {
      let entity: Entity

      beforeEach(async () => {
        // 50m away, entry left at the documented 10m default.
        entity = await putInteractiveBox(50, [
          { eventType: PointerEventType.PET_DOWN, interactionType: InteractionType.CURSOR, eventInfo: {} }
        ])
        pickPointerEventsMesh($.scene)
        interactWithScene(PointerEventType.PET_DOWN, InputAction.IA_ANY)
      })

      // It IS picked — well within the 100m pick reach — so only the per-entry
      // distance filter can refuse the event.
      it('should emit nothing, because the entry only reaches 10 metres', () => {
        expect(resultsFor(entity)).toEqual([])
      })
    })

    // The client measures max_player_distance from the player's FEET
    // (`PlayerInteractionEntity.PlayerPosition` is `cc.transform.position`), while its
    // PROXIMITY system deliberately uses the capsule CENTRE. `playerEntityAtom` holds
    // the capsule, so using it raw put this check 0.85m out — and nothing exercised
    // max_player_distance through the pointer path at all, so it was unverified.
    //
    // Discriminating fixture, and it has to work harder than it looks. The distance
    // rules are a single OR, and `max_distance` defaults to 10 — so with the box
    // anywhere inside 10m the FIRST term qualifies it whatever origin the player
    // distance uses, and the test proves nothing. (It did not, for a while: removing
    // the feet offset entirely left all 12 cases in this file green.)
    //
    // So the box sits at z=12, near face 11.5, putting it past the default
    // `max_distance` and leaving `max_player_distance` as the only term that can fire.
    // From the FEET at the origin that hit point is 11.500m; from the capsule CENTRE
    // 0.85m up it is 11.531m. A threshold of 11.52 sits between them.
    describe('when an entry gates on max_player_distance alone', () => {
      let entity: Entity

      beforeEach(async () => {
        playerEntityAtom.swap({
          absolutePosition: new Vector3(0, PLAYER_CAPSULE_HALF_HEIGHT, 0),
          absoluteRotationQuaternion: BABYLON.Quaternion.Identity()
        } as unknown as BABYLON.TransformNode)

        entity = await putInteractiveBox(12, [
          {
            eventType: PointerEventType.PET_DOWN,
            interactionType: InteractionType.CURSOR,
            // maxPlayerDistance ONLY, so the camera check is not what decides this.
            eventInfo: { maxPlayerDistance: 11.52 }
          }
        ])
        pickPointerEventsMesh($.scene)
        interactWithScene(PointerEventType.PET_DOWN, InputAction.IA_ANY)
      })

      it('should measure from the feet, so the entry qualifies', () => {
        expect(resultsFor(entity)).toHaveLength(1)
      })
    })

    // Passing a predicate to `scene.pick` REPLACES Babylon's default
    // isEnabled/isVisible/isPickable filter rather than adding to it, so without an
    // explicit check a collider that scene-bounds.ts disabled for leaving its parcels
    // still absorbed pointer events — verbatim the griefing vector that module exists
    // to close. The raycast path already honoured it.
    describe('when an interactive collider has been disabled', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = await putInteractiveBox(5)
        const collider = $.ctx.entities.get(entity)!.appliedComponents.meshCollider!.collider!
        collider.setEnabled(false)
      })

      it('should not be picked', () => {
        expect(pickActivePointerEventsEntity($.scene) === null).toBe(true)
      })
    })

    // The client hard-codes IA_POINTER for hover in WritePointerEventResultsSystem,
    // with the comment "the scenes are expecting an input action of type IaPointer" —
    // and the SDK confirms it: getInputCommand expands IA_ANY over a list that does not
    // contain IA_ANY, so an IA_ANY-buttoned hover is invisible to every scene.
    describe('when hovering an entity that declares a hover entry', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = await putInteractiveBox(5, [
          { eventType: PointerEventType.PET_HOVER_ENTER, interactionType: InteractionType.CURSOR, eventInfo: {} }
        ])
        pickPointerEventsMesh($.scene)
      })

      it('should report the hover', () => {
        expect(resultsFor(entity).map((r) => r.state)).toEqual([PointerEventType.PET_HOVER_ENTER])
      })

      it('should report IA_POINTER, the only value a scene can match a hover on', () => {
        expect(resultsFor(entity)[0].button).toBe(InputAction.IA_POINTER)
      })

      // One clock for every PointerEventsResult in the scene. The SDK gates on
      // `timestamp > previousFrameMaxTimestamp`, a maximum taken over ALL entities and
      // never decreasing, so a private counter here alongside proximity's tick meant a
      // single proximity event silenced every hover and click in the scene forever.
      it('should timestamp from the scene tick, the same source proximity uses', () => {
        expect(resultsFor(entity)[0].timestamp).toBe($.ctx.currentTick)
      })
    })

    // The pick used to assign `lastPickPoint` before the leave was emitted, so the
    // OUTGOING entity's leave was distance-gated against the INCOMING entity's distance
    // and carried its hit. Looking from a near button to a far one dropped the leave
    // entirely and stranded the scene's hover state on the first button.
    describe('when the pointer moves from a near entity to a distant one', () => {
      let near: Entity

      beforeEach(async () => {
        near = await putInteractiveBox(3, [
          { eventType: PointerEventType.PET_HOVER_ENTER, interactionType: InteractionType.CURSOR, eventInfo: {} },
          // Default maxDistance of 10: satisfied by this entity's own 2.5m pick,
          // and not by the 29.5m one that replaces it.
          { eventType: PointerEventType.PET_HOVER_LEAVE, interactionType: InteractionType.CURSOR, eventInfo: {} }
        ])
        pickPointerEventsMesh($.scene)

        // A second entity off to the side, so it does not sit behind the first — which
        // would now be occluded rather than picked.
        const far = nextEntityId++ as Entity
        created.push(far)
        await $.ctx.crdtSendToRenderer({
          data: new CrdtBuilder()
            .put(transformComponent, far, ++timestamp, {
              position: new Vector3(30, 0, 0),
              rotation: BABYLON.Quaternion.Identity(),
              scale: new Vector3(1, 1, 1),
              parent: 0 as Entity
            })
            .put(meshColliderComponent, far, ++timestamp, {
              collisionMask: ColliderLayer.CL_POINTER,
              mesh: { $case: 'box', box: {} }
            } as any)
            .put(pointerEventsComponent, far, ++timestamp, {
              pointerEvents: [
                {
                  eventType: PointerEventType.PET_HOVER_ENTER,
                  interactionType: InteractionType.CURSOR,
                  eventInfo: { maxDistance: 10_000 }
                }
              ]
            } as any)
            .finish()
        })
        camera.setTarget(new Vector3(1, 0, 0))
        pickPointerEventsMesh($.scene)
      })

      it('should still fire the leave for the entity it left', () => {
        expect(resultsFor(near).map((r) => r.state)).toEqual([
          PointerEventType.PET_HOVER_ENTER,
          PointerEventType.PET_HOVER_LEAVE
        ])
      })
    })

    // `max_distance` is measured from the PLAYER, not from the camera. This server's
    // camera sits 8m behind the player, so measuring from it made the protocol's own
    // default of 10 stop qualifying about two metres in front of the player — entities
    // every client reports as interactable out to 10m were silently unclickable.
    describe('when the player stands well ahead of the camera', () => {
      let entity: Entity
      let previousPlayer: BABYLON.TransformNode | null

      beforeEach(async () => {
        previousPlayer = playerEntityAtom.getOrNull()
        // Camera at the origin, player 8m down +Z — the production geometry.
        playerEntityAtom.swap({
          absolutePosition: new Vector3(0, PLAYER_CAPSULE_HALF_HEIGHT, 8),
          absoluteRotationQuaternion: BABYLON.Quaternion.Identity()
        } as unknown as BABYLON.TransformNode)

        // 11.5m from the camera, 3.6m from the player: only a player-relative
        // measurement leaves it inside the default max_distance of 10.
        entity = await putInteractiveBox(12, [
          { eventType: PointerEventType.PET_DOWN, interactionType: InteractionType.CURSOR, eventInfo: {} }
        ])
        pickPointerEventsMesh($.scene)
        interactWithScene(PointerEventType.PET_DOWN, InputAction.IA_PRIMARY)
      })

      afterEach(() => {
        if (previousPlayer) playerEntityAtom.swap(previousPlayer)
      })

      it('should qualify, because the distance is measured from the player', () => {
        expect(resultsFor(entity)).toHaveLength(1)
      })
    })

    // The client fills press results once per ENTITY, outside its entry loop
    // (`TryAppendButtonAction`), and only hover/proximity go per entry. Emitting per
    // entry produced byte-identical duplicates once presses started reporting the raw
    // action, halving a 10-element result history for nothing.
    describe('when two entries both qualify for the same press', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = await putInteractiveBox(3, [
          { eventType: PointerEventType.PET_DOWN, interactionType: InteractionType.CURSOR, eventInfo: {} },
          {
            eventType: PointerEventType.PET_DOWN,
            interactionType: InteractionType.CURSOR,
            eventInfo: { button: InputAction.IA_PRIMARY }
          }
        ])
        pickPointerEventsMesh($.scene)
        interactWithScene(PointerEventType.PET_DOWN, InputAction.IA_PRIMARY)
      })

      it('should emit one result rather than one per entry', () => {
        expect(resultsFor(entity)).toHaveLength(1)
      })
    })

    // The predicate used to admit only interactables, so the closest hit was always
    // interactable and nothing could block it: hover and click passed through walls,
    // floors and other players, none of which is reachable on any client. The client
    // casts one closest hit over OnPointerEvent | Default | OtherAvatars and hovers
    // nothing when that hit is not a scene interactable.
    describe('when a plain physics collider stands between the player and the entity', () => {
      beforeEach(async () => {
        await putInteractiveBox(6)

        const wall = nextEntityId++ as Entity
        created.push(wall)
        await $.ctx.crdtSendToRenderer({
          data: new CrdtBuilder()
            .put(transformComponent, wall, ++timestamp, {
              position: new Vector3(0, 0, 3),
              rotation: BABYLON.Quaternion.Identity(),
              scale: new Vector3(4, 4, 1),
              parent: 0 as Entity
            })
            // CL_PHYSICS only, and no PointerEvents: not interactable, but solid.
            .put(meshColliderComponent, wall, ++timestamp, {
              collisionMask: ColliderLayer.CL_PHYSICS,
              mesh: { $case: 'box', box: {} }
            } as any)
            .finish()
        })
      })

      it('should hover nothing, because the wall is what the pointer reaches first', () => {
        expect(pickActivePointerEventsEntity($.scene)).toBeNull()
      })
    })

    // The centre-screen pick is a full-scene CPU raycast — a predicate over every mesh,
    // then triangle tests — and it runs every frame. Hover synthesis is its only
    // consumer here, so a scene declaring no PointerEvents at all must not pay for it.
    // Nothing exercised the skip: every other case in this file has pointer events, so
    // the `return false` in `anySceneHasPointerEvents` never ran.
    describe('when no loaded scene declares any pointer events', () => {
      let pickSpy: jest.SpyInstance

      beforeEach(() => {
        // Clear any hover carried over from an earlier case: the early-out is
        // deliberately skipped while something is still hovered, so that HOVER_LEAVE
        // can fire after the last PointerEvents component disappears.
        pickPointerEventsMesh($.scene)
        pickSpy = jest.spyOn($.scene, 'pick')
      })

      afterEach(() => {
        pickSpy.mockRestore()
      })

      it('should skip the full-scene pick entirely', () => {
        pickPointerEventsMesh($.scene)
        expect(pickSpy).not.toHaveBeenCalled()
      })
    })

    // The candidate set is a SET because its two groups overlap: `setColliderMask` enrols
    // every mesh named `*_collider` into `floorMeshes`, and every primitive collider is
    // named exactly that — so a scene's colliders are in both the scene-root walk and the
    // floor group. Collected into an array they were triangle-tested TWICE, which made
    // this path 2x slower than the `Scene.prototype.pick` it replaced on a heavy mesh
    // (4.25ms against 2.06ms for an 80 000-triangle floor).
    //
    // The ANSWER was never wrong — both hits are the same mesh at the same distance — so
    // only a measurement or this assertion can catch it. Counting `intersects` calls is
    // the property itself: each candidate is tested once per pick.
    describe('when a collider is reachable through both the scene root and floorMeshes', () => {
      let entity: Entity
      let intersects: jest.SpyInstance

      beforeEach(async () => {
        // A CYLINDER, off-axis. A box cannot show this: its AABB entry distance EQUALS
        // its surface hit, so the HIT_FIRST early-out (`entries[i] >= nearestHit`) skips
        // the duplicate for free and the bug hides. Here the ray enters the bounding box
        // at 3.5 and meets the curved surface at 3.6, so the duplicate is genuinely
        // tested. A sphere would not work either — it takes the analytic path and never
        // calls `intersects` at all.
        entity = nextEntityId++ as Entity
        created.push(entity)
        await $.ctx.crdtSendToRenderer({
          data: new CrdtBuilder()
            .put(transformComponent, entity, ++timestamp, {
              position: new Vector3(-0.3, 0, 5),
              rotation: BABYLON.Quaternion.Identity(),
              scale: new Vector3(1, 1, 1),
              parent: 0 as Entity
            })
            .put(meshColliderComponent, entity, ++timestamp, {
              collisionMask: ColliderLayer.CL_POINTER,
              mesh: { $case: 'cylinder', cylinder: {} }
            } as any)
            .put(pointerEventsComponent, entity, ++timestamp, {
              pointerEvents: [
                { eventType: PointerEventType.PET_DOWN, interactionType: InteractionType.CURSOR, eventInfo: {} }
              ]
            } as any)
            .finish()
        })
        const collider = $.ctx.entities.get(entity)!.appliedComponents.meshCollider!.collider!
        expect(floorMeshes.has(collider)).toBe(true) // the overlap this case exists for
        intersects = jest.spyOn(collider, 'intersects')
        pickActivePointerEventsEntity($.scene)
      })

      afterEach(() => {
        intersects.mockRestore()
      })

      it('should intersect it once per pick, not once per group it appears in', () => {
        expect(intersects).toHaveBeenCalledTimes(1)
      })
    })

    // The prefilter reads `getBoundingInfo()`, which re-derives the world box from the
    // CACHED matrix — and `_evaluateActiveMeshes` never bumps the render id of a mesh it
    // skipped, so without an explicit sweep a collider is prefiltered against where it
    // USED to be. `Scene.prototype.pick` never needed this because `Ray.intersectsMesh`
    // transforms the ray into each mesh's LOCAL space instead of comparing world boxes.
    //
    // The raycast path has `raycast-stale-bounds.spec.ts` for its own sweep; this is the
    // pointer path's equivalent. Moving the collider far OFF-AXIS is what makes it
    // discriminating: stale bounds still place it on the ray, so it stays a candidate and
    // is reported as hovered when it is nowhere near the crosshair.
    describe('when a hovered collider moves off-axis without a frame in between', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = await putInteractiveBox(5)
        pickPointerEventsMesh($.scene)

        await $.ctx.crdtSendToRenderer({
          data: new CrdtBuilder()
            .put(transformComponent, entity, ++timestamp, {
              position: new Vector3(50, 0, 5),
              rotation: BABYLON.Quaternion.Identity(),
              scale: new Vector3(1, 1, 1),
              parent: 0 as Entity
            })
            .finish()
        })
      })

      it('should stop being hovered, rather than being picked where it used to be', () => {
        expect(pickActivePointerEventsEntity($.scene) === null).toBe(true)
      })
    })

    // The pick resolves a SphereMesh in closed form, the same way raycasts do. It used
    // to go through `Scene.prototype.pick` and so through Babylon's 1296-triangle hull,
    // which is an inscribed polyhedron — it reports the surface slightly FURTHER away
    // than the true sphere, and the two paths disagreed by up to 3.8mm on the same
    // collider. The client's SphereCollider is analytic, so this converges on both.
    //
    // Measured OFF-AXIS deliberately: dead-centre the tessellation has a vertex exactly
    // at the pole and both paths return 3.5 exactly, so a centred ray cannot tell them
    // apart. At 0.3m off-axis the analytic answer is 3.600 and the hull's is 3.602.
    describe('when the pointer grazes a sphere collider off-centre', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = nextEntityId++ as Entity
        created.push(entity)
        await $.ctx.crdtSendToRenderer({
          data: new CrdtBuilder()
            .put(transformComponent, entity, ++timestamp, {
              position: new Vector3(-0.3, 0, 5),
              rotation: BABYLON.Quaternion.Identity(),
              scale: new Vector3(1, 1, 1),
              parent: 0 as Entity
            })
            .put(meshColliderComponent, entity, ++timestamp, {
              collisionMask: ColliderLayer.CL_POINTER,
              mesh: { $case: 'sphere', sphere: {} }
            } as any)
            .put(pointerEventsComponent, entity, ++timestamp, {
              pointerEvents: [
                { eventType: PointerEventType.PET_DOWN, interactionType: InteractionType.CURSOR, eventInfo: {} }
              ]
            } as any)
            .finish()
        })
        pickPointerEventsMesh($.scene)
        interactWithScene(PointerEventType.PET_DOWN, InputAction.IA_PRIMARY)
      })

      // 3.600 is the true sphere; the tessellated hull answers 3.602. The tolerance sits
      // between them, so this fails if the pick falls back to triangles.
      it('should report the analytic surface, not the tessellated hull', () => {
        expect(resultsFor(entity)[0].hit.length).toBeCloseTo(3.6, 3)
      })
    })

    // The pick walks every LOADED scene's root, not just one. A second SceneContext
    // exists in ordinary operation (the local avatar scene), and its colliders are as
    // solid as any other's — walking only one root would let a neighbouring scene's wall
    // stop occluding, which `Scene.prototype.pick` never did because it saw every mesh.
    describe('when an occluder belongs to a DIFFERENT loaded scene', () => {
      let otherRoot: BABYLON.TransformNode

      beforeEach(async () => {
        await putInteractiveBox(6)

        otherRoot = new BABYLON.TransformNode('other-scene-root', $.scene)
        // Deliberately NOT given the `_collider` name suffix: that suffix makes
        // setColliderMask enrol the mesh in floorMeshes, which would keep it a candidate
        // through the OTHER group and let a mutant that walks only one scene root survive
        // this case. Only the scene-root walk can find it.
        const wall = BABYLON.MeshBuilder.CreateBox('other-scene-wall', { width: 4, height: 4, depth: 1 }, $.scene)
        wall.parent = otherRoot
        wall.position.set(0, 0, 3)
        wall.computeWorldMatrix(true)
        setColliderMask(wall, ColliderLayer.CL_PHYSICS)

        loadedScenesByEntityId.set('other-scene', {
          rootNode: otherRoot,
          components: { [pointerEventsComponent.componentId]: { iterator: () => [][Symbol.iterator]() } }
        } as any)
      })

      afterEach(() => {
        loadedScenesByEntityId.delete('other-scene')
        otherRoot.dispose(false)
      })

      it('should be blocked by it, as it was when the pick saw every mesh', () => {
        expect(pickActivePointerEventsEntity($.scene) === null).toBe(true)
      })
    })

    // The camera sits BEHIND the player (ArcRotateCamera, radius 8), so the local
    // avatar is between the camera and everything the player looks at. If its capsule
    // occludes, every pointer interaction in the game dies.
    //
    // The client excludes it deliberately: PLAYER_ORIGIN_RAYCAST_MASK is
    // `OnPointerEvent | Default | OtherAvatars` and the local CharacterController layer
    // is not in it, while OTHER avatars are — so a remote player blocks your pointer
    // and your own body does not.
    describe('when the local players own capsule stands between the camera and the entity', () => {
      let entity: Entity
      let previousPlayer: BABYLON.TransformNode | null

      beforeEach(async () => {
        previousPlayer = playerEntityAtom.getOrNull()
        playerEntityAtom.swap({
          absolutePosition: new Vector3(0, PLAYER_CAPSULE_HALF_HEIGHT, 3),
          absoluteRotationQuaternion: BABYLON.Quaternion.Identity()
        } as unknown as BABYLON.TransformNode)

        // Aim through the capsule's WAIST, not along y=0. The capsule stands on the
        // player's feet and spans y 0..1.6, so a ray at y=0 merely grazes its bottom
        // pole and misses — which is how the first version of this case passed against
        // the very bug it was written for.
        camera.position.set(0, 0.8, 0)
        camera.setTarget(new Vector3(0, 0.8, 1))

        entity = nextEntityId++ as Entity
        created.push(entity)
        await $.ctx.crdtSendToRenderer({
          data: new CrdtBuilder()
            .put(transformComponent, entity, ++timestamp, {
              position: new Vector3(0, 0.8, 6),
              rotation: BABYLON.Quaternion.Identity(),
              scale: new Vector3(1, 1, 1),
              parent: 0 as Entity
            })
            .put(meshColliderComponent, entity, ++timestamp, {
              collisionMask: ColliderLayer.CL_POINTER,
              mesh: { $case: 'box', box: {} }
            } as any)
            .put(pointerEventsComponent, entity, ++timestamp, {
              pointerEvents: [
                {
                  eventType: PointerEventType.PET_DOWN,
                  interactionType: InteractionType.CURSOR,
                  eventInfo: { maxDistance: 10_000 }
                }
              ]
            } as any)
            .finish()
        })
        // Builds and places the local capsule at the player — directly on the ray.
        updateAvatarColliders($.ctx)
        // Render once so the capsule's world matrix actually reflects the position just
        // assigned. `computeWorldMatrix` is gated on the scene's render id, so without a
        // frame the capsule keeps the matrix it was built with and sits at the origin —
        // which is exactly how an earlier version of this case passed against the bug.
        // Production gets this for free: the pick runs inside onBeforeRenderObservable.
        $.scene.render()
      })

      afterEach(() => {
        if (previousPlayer) playerEntityAtom.swap(previousPlayer)
        $.ctx
          .getOrCreateStaticEntity(StaticEntities.PlayerEntity)
          .getChildMeshes(true)
          .forEach((mesh) => mesh.dispose())
      })

      it('should still hover the entity behind it', () => {
        expect(pickActivePointerEventsEntity($.scene)?.entityId).toBe(entity)
      })

      // The other half of the same parity rule, and the reason the exclusion is keyed
      // on CL_MAIN_PLAYER rather than on "is an avatar": OtherAvatars IS in the
      // client's mask, so a REMOTE player standing in front of a button blocks it.
      it('should still be blocked by a REMOTE player standing in the same place', () => {
        const remote = $.ctx.getOrCreateStaticEntity(32 as Entity)
        updateAvatarColliders($.ctx)
        const capsule = remote.getChildMeshes(true).find((m) => m.name === 'avatar_capsule')!
        capsule.position.set(0, 0.8, 3)
        $.scene.render()

        try {
          expect(pickActivePointerEventsEntity($.scene) === null).toBe(true)
        } finally {
          capsule.dispose()
        }
      })
    })

    // An occluder need not belong to an entity at all: `ambientLights.ts` masks a
    // ground mesh that hangs off no BabylonEntity, so `getParentEntity` walks to the
    // root and returns null. That return had never executed — the occlusion case above
    // uses a CRDT-authored wall, which does have a parent entity.
    describe('when the nearest occluder belongs to no entity', () => {
      let ground: BABYLON.Mesh

      beforeEach(async () => {
        await putInteractiveBox(6)
        ground = BABYLON.MeshBuilder.CreateBox('ground', { width: 8, height: 8, depth: 1 }, $.scene)
        ground.position.set(0, 0, 3)
        ground.computeWorldMatrix(true)
        setColliderMask(ground, ColliderLayer.CL_PHYSICS)
        // Registered exactly as `ambientLights.ts` registers the real ambient ground: it
        // is not named `*_collider`, so `setColliderMask` does not enrol it, and it hangs
        // off no entity. `floorMeshes` is what keeps it in the pointer's candidate set now
        // that the pick walks scene roots instead of every mesh in the Babylon scene.
        addFloorMesh(ground)
      })

      afterEach(() => {
        ground.dispose()
      })

      it('should hover nothing rather than treating it as interactable', () => {
        expect(pickActivePointerEventsEntity($.scene)).toBeNull()
      })
    })

    // The hovered entity has not CHANGED, so `hoverNewEntity` takes its early-return
    // path — which still has to refresh `lastPickPoint`, because the entity (or the
    // player) may have moved. Nothing exercised that branch: every other case in this
    // file picks once, or picks a different entity the second time.
    //
    // Without the refresh a press reports where the entity USED to be, which is the
    // same class of bug as the stale hover-leave, just harder to notice.
    describe('when the same entity stays hovered but moves closer', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = await putInteractiveBox(5, [
          { eventType: PointerEventType.PET_DOWN, interactionType: InteractionType.CURSOR, eventInfo: {} }
        ])
        pickPointerEventsMesh($.scene)

        await $.ctx.crdtSendToRenderer({
          data: new CrdtBuilder()
            .put(transformComponent, entity, ++timestamp, {
              position: new Vector3(0, 0, 3),
              rotation: BABYLON.Quaternion.Identity(),
              scale: new Vector3(1, 1, 1),
              parent: 0 as Entity
            })
            .finish()
        })
        pickPointerEventsMesh($.scene)
        interactWithScene(PointerEventType.PET_DOWN, InputAction.IA_PRIMARY)
      })

      // 1.5, not 2.5: `pickingInfo.distance` is measured along the PICKING ray, whose
      // origin is the camera's NEAR PLANE (`FreeCamera.minZ` defaults to 1), not the
      // camera position. The box's near face is at z=2.5, so 1.5 from a ray starting at
      // z=1. Stale, it would report 3.5 — the near face of where the box used to be.
      //
      // (Only `hit.length` is ray-relative like this. The `max_distance` and
      // `max_player_distance` checks measure from the player, so they are unaffected.)
      it('should report the hit where the entity is now, not where it was', () => {
        expect(resultsFor(entity)[0].hit.length).toBeCloseTo(1.5, 5)
      })
    })
  }
)
