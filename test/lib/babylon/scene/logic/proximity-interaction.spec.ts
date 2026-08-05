import { Quaternion, TransformNode, Vector3 } from '@babylonjs/core'
import { Scene } from '@dcl/schemas'
import {
  InputAction,
  InteractionType,
  PointerEventType
} from '@dcl/protocol/out-js/decentraland/sdk/components/common/input_action.gen'
import { PBPointerEvents_Entry } from '@dcl/protocol/out-js/decentraland/sdk/components/pointer_events.gen'
import { transformComponent } from '../../../../../src/lib/decentraland/sdk-components/transform-component'
import { pointerEventsComponent } from '../../../../../src/lib/decentraland/sdk-components/pointer-events'
import { pointerEventsResultComponent } from '../../../../../src/lib/decentraland/sdk-components/pointer-events-result'
import { updateProximityInteractions } from '../../../../../src/lib/babylon/scene/logic/proximity-interaction'
import { playerEntityAtom } from '../../../../../src/lib/decentraland/state'
import { Entity } from '../../../../../src/lib/decentraland/types'
import { limits } from '../../../../../src/lib/misc/limits'
import { CrdtBuilder, testWithEngine } from '../../babylon-test-helper'

// InteractionType.PROXIMITY was entirely unimplemented: entries of that type never
// fired, so a scene using proximity triggers (a door that greets you, a sign that
// lights up as you approach) got nothing here while working for every real player.
//
// Geometry matched from the client's PlayerOriginatedProximitySystem: a 3-metre search
// radius, a 120-degree HORIZONTAL cone in front of the player, gated by the entry's
// maxPlayerDistance, highest priority winning and the closest breaking ties.

const proximityEntry = (over: Partial<PBPointerEvents_Entry> = {}): PBPointerEvents_Entry => ({
  eventType: PointerEventType.PET_PROXIMITY_ENTER,
  interactionType: InteractionType.PROXIMITY,
  eventInfo: { maxPlayerDistance: 3 },
  ...over
})

testWithEngine(
  'proximity interactions',
  {
    baseUrl: '/',
    entity: { content: [], metadata: {} as Scene, type: 'scene' },
    urn: 'proximity'
  },
  ($) => {
    let timestamp = 0
    let nextEntityId = 700
    let previousPlayer: TransformNode | null
    let created: Entity[] = []

    /** Puts the local player at a world position, facing +Z. */
    function placePlayer(position: Vector3, facing = Quaternion.Identity()): void {
      playerEntityAtom.swap({
        absolutePosition: position,
        absoluteRotationQuaternion: facing
      } as unknown as TransformNode)
    }

    async function putProximityEntity(position: Vector3, entries: PBPointerEvents_Entry[]): Promise<Entity> {
      const entity = nextEntityId++ as Entity
      created.push(entity)
      await $.ctx.crdtSendToRenderer({
        data: new CrdtBuilder()
          .put(transformComponent, entity, ++timestamp, {
            position,
            rotation: Quaternion.Identity(),
            scale: new Vector3(1, 1, 1),
            parent: 0 as Entity
          })
          .put(pointerEventsComponent, entity, ++timestamp, { pointerEvents: entries } as any)
          .finish()
      })
      return entity
    }

    // PointerEventsResult is a GROW-ONLY SET, so `get` returns a ReadonlySet rather
    // than an array — an earlier version of this helper flatMapped the iterator and
    // got the Set object itself as a single element, which read as one result whose
    // every field was undefined.
    const resultsFor = (entity: Entity): any[] =>
      Array.from($.ctx.components[pointerEventsResultComponent.componentId].get(entity) ?? [])

    beforeEach(() => {
      $.startEngine()
      previousPlayer = playerEntityAtom.getOrNull()
      created = []
    })

    afterEach(async () => {
      if (previousPlayer) playerEntityAtom.swap(previousPlayer)

      // Entities outlive each test in this shared SceneContext, and a proximity
      // entity left at the same spot keeps WINNING: iteration is insertion-ordered
      // and ties go to the first seen, so the previous test's entity stayed the
      // target and the current test's never fired at all. Tear them down.
      if (!created.length) return
      const teardown = new CrdtBuilder()
      for (const entity of created) teardown.deleteEntity(entity)
      await $.ctx.crdtSendToRenderer({ data: teardown.finish() })
      // Drop the remembered target too, so the next test starts from "nobody near".
      updateProximityInteractions($.ctx)
    })

    describe('when the player stands in front of a proximity entity, within range', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = await putProximityEntity(new Vector3(0, 0, 2), [proximityEntry()])
        placePlayer(new Vector3(0, 0, 0))
        updateProximityInteractions($.ctx)
      })

      it('should report a PET_PROXIMITY_ENTER, which never fired before', () => {
        expect(resultsFor(entity).map((r) => r.state)).toEqual([PointerEventType.PET_PROXIMITY_ENTER])
      })

      // A proximity event has no ray and no intersection, so there is nothing to
      // report. Inventing a synthetic ray would hand scenes an origin and direction
      // no pointer ever travelled.
      it('should report no hit, because nothing was intersected', () => {
        expect(resultsFor(entity)[0].hit).toBeUndefined()
      })

      it('should report the entry button rather than a sentinel', () => {
        expect(resultsFor(entity)[0].button).toBe(InputAction.IA_ANY)
      })

      // THE TICK, not a private counter. The scene-side SDK gates every lookup on
      // `timestamp > previousFrameMaxTimestamp`, with the maximum taken over ALL
      // entities' results — so a second counter that lags the cursor path's (it always
      // does, hover fires every frame) makes every proximity result look stale and be
      // silently discarded. The client uses TickNumber for both fields.
      it('should timestamp from the scene tick, the same source as every other result', () => {
        expect(resultsFor(entity)[0].timestamp).toBe($.ctx.currentTick)
      })
    })

    describe('when the entity is behind the player', () => {
      let entity: Entity

      beforeEach(async () => {
        // Player faces +Z (identity), entity sits at -Z: outside the 120-degree cone.
        entity = await putProximityEntity(new Vector3(0, 0, -2), [proximityEntry()])
        placePlayer(new Vector3(0, 0, 0))
        updateProximityInteractions($.ctx)
      })

      it('should not fire, since proximity is limited to a forward cone', () => {
        expect(resultsFor(entity)).toEqual([])
      })
    })

    describe('when the entity is beyond the entry maxPlayerDistance', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = await putProximityEntity(new Vector3(0, 0, 2.5), [
          proximityEntry({ eventInfo: { maxPlayerDistance: 1 } })
        ])
        placePlayer(new Vector3(0, 0, 0))
        updateProximityInteractions($.ctx)
      })

      it('should not fire', () => {
        expect(resultsFor(entity)).toEqual([])
      })
    })

    describe('when the entity is outside the search radius entirely', () => {
      let entity: Entity

      beforeEach(async () => {
        // maxPlayerDistance is generous, but the 3m search radius still applies —
        // matching the client, which only overlaps a 3m sphere in the first place.
        entity = await putProximityEntity(new Vector3(0, 0, 10), [
          proximityEntry({ eventInfo: { maxPlayerDistance: 100 } })
        ])
        placePlayer(new Vector3(0, 0, 0))
        updateProximityInteractions($.ctx)
      })

      it('should not fire', () => {
        expect(resultsFor(entity)).toEqual([])
      })
    })

    describe('when the player walks away from an entity already in proximity', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = await putProximityEntity(new Vector3(0, 0, 2), [
          proximityEntry(),
          proximityEntry({ eventType: PointerEventType.PET_PROXIMITY_LEAVE })
        ])
        placePlayer(new Vector3(0, 0, 0))
        updateProximityInteractions($.ctx)

        placePlayer(new Vector3(0, 0, -50))
        updateProximityInteractions($.ctx)
      })

      it('should report ENTER then LEAVE, in that order', () => {
        expect(resultsFor(entity).map((r) => r.state)).toEqual([
          PointerEventType.PET_PROXIMITY_ENTER,
          PointerEventType.PET_PROXIMITY_LEAVE
        ])
      })
    })

    describe('when the player stays in proximity across several frames', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = await putProximityEntity(new Vector3(0, 0, 2), [proximityEntry()])
        placePlayer(new Vector3(0, 0, 0))
        for (let frame = 0; frame < 5; frame++) updateProximityInteractions($.ctx)
      })

      // ENTER is a transition, not a state. Re-firing every frame would flood the
      // scene's result stream for as long as the player stands still.
      it('should report ENTER once, not once per frame', () => {
        expect(resultsFor(entity)).toHaveLength(1)
      })
    })

    describe('when two proximity entities are in range at different priorities', () => {
      let low: Entity
      let high: Entity

      beforeEach(async () => {
        // The LOW priority one is deliberately CLOSER, so distance alone would pick
        // it and only priority can produce the right answer.
        low = await putProximityEntity(new Vector3(0, 0, 1), [
          proximityEntry({ eventInfo: { maxPlayerDistance: 3, priority: 1 } })
        ])
        high = await putProximityEntity(new Vector3(0, 0, 2), [
          proximityEntry({ eventInfo: { maxPlayerDistance: 3, priority: 9 } })
        ])
        placePlayer(new Vector3(0, 0, 0))
        updateProximityInteractions($.ctx)
      })

      it('should pick the higher priority even though it is further away', () => {
        expect(resultsFor(high)).toHaveLength(1)
      })

      it('should leave the nearer, lower-priority entity alone', () => {
        expect(resultsFor(low)).toEqual([])
      })
    })

    // ORDER MATTERS and an earlier version of this file missed it. With the
    // high-priority entity declared FIRST, a lower-priority candidate seen afterwards
    // must be rejected outright — dropping the `priority < best` guard still passed
    // when the low-priority one came first, because the tie-break happened to sort it
    // out. Verified by mutation.
    describe('and the higher-priority entity is seen before a closer lower-priority one', () => {
      let high: Entity
      let low: Entity

      beforeEach(async () => {
        high = await putProximityEntity(new Vector3(0, 0, 2.5), [
          proximityEntry({ eventInfo: { maxPlayerDistance: 3, priority: 9 } })
        ])
        low = await putProximityEntity(new Vector3(0, 0, 1), [
          proximityEntry({ eventInfo: { maxPlayerDistance: 3, priority: 1 } })
        ])
        placePlayer(new Vector3(0, 0, 0))
        updateProximityInteractions($.ctx)
      })

      it('should keep the higher-priority entity as the target', () => {
        expect(resultsFor(high)).toHaveLength(1)
      })

      it('should not let the closer, lower-priority one take over', () => {
        expect(resultsFor(low)).toEqual([])
      })
    })

    describe('when two equal-priority entities are in range', () => {
      let near: Entity
      let far: Entity

      beforeEach(async () => {
        far = await putProximityEntity(new Vector3(0, 0, 2.5), [proximityEntry()])
        near = await putProximityEntity(new Vector3(0, 0, 1), [proximityEntry()])
        placePlayer(new Vector3(0, 0, 0))
        updateProximityInteractions($.ctx)
      })

      it('should pick the closest', () => {
        expect(resultsFor(near)).toHaveLength(1)
      })

      it('should pick exactly one, not both', () => {
        expect(resultsFor(far)).toEqual([])
      })
    })

    // The scan is bounded by entities EXAMINED, counted before the distance test.
    //
    // That ordering is the whole point and it was wrong: counting only candidates
    // already found to be IN RANGE bounded the cheap half and left the expensive half —
    // an entity lookup, a world-matrix refresh and vector maths for every OUT-of-range
    // entity — completely unbounded. Out-of-range is the ordinary case, since most
    // triggers are further than 3m from the player. Measured before the fix: 29.45ms
    // per frame at 50_000 out-of-range proximity entities, with the ceiling never
    // firing once.
    //
    // Observable through the ceiling's consequence: the highest-priority entity is
    // declared LAST, past the limit, so it is never examined and cannot win.
    describe('when more proximity candidates exist than the scan ceiling allows', () => {
      let beyondTheCeiling: Entity
      let restore: number

      beforeEach(async () => {
        restore = limits.maxProximityCandidates
        limits.maxProximityCandidates = 2

        // Fill the allowance with entities that are OUT of range, so the test also
        // fails if the count moves back behind the distance check.
        for (let i = 0; i < 2; i++) {
          await putProximityEntity(new Vector3(0, 0, 50), [proximityEntry()])
        }
        // Declared last, in range, and the only one that would win on priority.
        beyondTheCeiling = await putProximityEntity(new Vector3(0, 0, 1), [
          proximityEntry({ eventInfo: { maxPlayerDistance: 3, priority: 99 } })
        ])
        placePlayer(new Vector3(0, 0, 0))
        updateProximityInteractions($.ctx)
      })

      afterEach(() => {
        limits.maxProximityCandidates = restore
      })

      it('should never reach the entity past the ceiling, however high its priority', () => {
        expect(resultsFor(beyondTheCeiling)).toEqual([])
      })
    })

    // The client takes the minimum max_player_distance over EVERY entry, with no
    // interaction-type filter, and an unset one reads 0 — so an entity that is both
    // clickable and proximity-aware is never a proximity candidate there at all.
    // Filtering to PROXIMITY entries first made this server fire proximity events that
    // no player's client fires, for an entirely ordinary way to author an entity.
    describe('when an entity mixes a cursor entry with a proximity entry', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = await putProximityEntity(new Vector3(0, 0, 1), [
          // eventInfo deliberately EMPTY: an unset max_player_distance reads 0, so the
          // client's minimum over both entries is 0 and the entity never qualifies.
          proximityEntry({
            interactionType: InteractionType.CURSOR,
            eventType: PointerEventType.PET_DOWN,
            eventInfo: {}
          }),
          proximityEntry({ eventInfo: { maxPlayerDistance: 3 } })
        ])
        placePlayer(new Vector3(0, 0, 0))
        updateProximityInteractions($.ctx)
      })

      it('should not become a proximity candidate, as it cannot on the client', () => {
        expect(resultsFor(entity)).toEqual([])
      })
    })

    // The client's AppendPointerInputIfQualified requires IaPointer or IaAny for every
    // proximity enter/leave append, and nothing pinned that here: removing the gate
    // left all 18 proximity cases green.
    describe('when a proximity entry asks for a button that is neither POINTER nor ANY', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = await putProximityEntity(new Vector3(0, 0, 1), [
          proximityEntry({ eventInfo: { maxPlayerDistance: 3, button: InputAction.IA_PRIMARY } })
        ])
        placePlayer(new Vector3(0, 0, 0))
        updateProximityInteractions($.ctx)
      })

      it('should emit nothing, as the client does not append it either', () => {
        expect(resultsFor(entity)).toEqual([])
      })
    })

    describe('when an entity declares only CURSOR entries', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = await putProximityEntity(new Vector3(0, 0, 2), [
          proximityEntry({ interactionType: InteractionType.CURSOR })
        ])
        placePlayer(new Vector3(0, 0, 0))
        updateProximityInteractions($.ctx)
      })

      // Proximity must not hijack cursor entries; those belong to the pointer pick.
      it('should not fire a proximity event for it', () => {
        expect(resultsFor(entity)).toEqual([])
      })
    })

    // Everything above drives `updateProximityInteractions` directly, because
    // babylon-test-helper mocks `ctx.updateInteractionSystems` — which is where the
    // production wiring lives. Verified by mutation: removing the call from
    // scene-context.ts left every case above green while proximity never ran at all
    // in production.
    describe('when the scene runs its real per-frame interaction update', () => {
      let entity: Entity

      beforeEach(async () => {
        entity = await putProximityEntity(new Vector3(0, 0, 2), [proximityEntry()])
        placePlayer(new Vector3(0, 0, 0))

        const spy = $.ctx.updateInteractionSystems as unknown as jest.SpyInstance
        spy.mockRestore()
        $.ctx.updateInteractionSystems()
      })

      afterEach(() => {
        jest.spyOn($.ctx, 'updateInteractionSystems').mockImplementation(() => void 0)
      })

      it('should fire proximity without anything calling the system by hand', () => {
        expect(resultsFor(entity)).toHaveLength(1)
      })
    })
  }
)
