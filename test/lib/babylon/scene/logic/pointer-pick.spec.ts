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
import { pointerEventsResultComponent } from '../../../../../src/lib/decentraland/sdk-components/pointer-events-result'
import { Entity } from '../../../../../src/lib/decentraland/types'
import { loadedScenesByEntityId } from '../../../../../src/lib/decentraland/state'
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

      // The ENTRY's button, not the raw input. This is also what replaced the
      // `InputAction.UNRECOGNIZED` (-1) that hovers used to report.
      it('should report the entry button rather than the raw input', () => {
        expect(resultsFor(entity)[0].button).toBe(InputAction.IA_ANY)
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
  }
)
