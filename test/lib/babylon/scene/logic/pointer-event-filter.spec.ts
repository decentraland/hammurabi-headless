import { InputAction, InteractionType, PointerEventType } from '@dcl/protocol/out-js/decentraland/sdk/components/common/input_action.gen'
import { PBPointerEvents_Entry } from '@dcl/protocol/out-js/decentraland/sdk/components/pointer_events.gen'
import {
  DEFAULT_POINTER_MAX_DISTANCE,
  entryAccepts,
  interactionTypeOf,
  isQualifiedByDistance,
  resolvePointerInfo,
  selectFiringEntries
} from '../../../../../src/lib/babylon/scene/logic/pointer-event-filter'

// None of these rules were implemented. pointer-events.ts read ZERO fields off
// PBPointerEvents_Info and never looked at the entry list, so this server fired
// interactions no client can produce: a button pressed from any distance, a PET_UP on
// an entity that only asked for PET_DOWN, and a hover carrying
// InputAction.UNRECOGNIZED (-1).
//
// The distance rules are quoted verbatim from pointer_events.proto, which is unusually
// explicit about them — one of the few places the protocol text and the client agree
// in detail, so there is no judgement call being made here.

const entry = (over: Partial<PBPointerEvents_Entry> = {}): PBPointerEvents_Entry => ({
  eventType: PointerEventType.PET_DOWN,
  eventInfo: {},
  ...over
})

describe('pointer event filtering', () => {
  describe('when an entry leaves its Info fields unset', () => {
    let resolved: ReturnType<typeof resolvePointerInfo>

    beforeEach(() => {
      resolved = resolvePointerInfo({})
    })

    // IA_ANY and not IA_POINTER. IA_POINTER is 0, which is what an unset protobuf
    // enum decodes to, so defaulting to it would make "no button specified"
    // indistinguishable from "the pointer button specifically".
    it('should default the button to IA_ANY so the entry reacts to every input', () => {
      expect(resolved.button).toBe(InputAction.IA_ANY)
    })

    it('should default maxDistance to the 10 metres the protocol documents', () => {
      expect(resolved.maxDistance).toBe(DEFAULT_POINTER_MAX_DISTANCE)
    })

    it('should default maxPlayerDistance to 0', () => {
      expect(resolved.maxPlayerDistance).toBe(0)
    })

    it('should default priority to 0', () => {
      expect(resolved.priority).toBe(0)
    })
  })

  // `?? DEFAULT`, never `|| DEFAULT`. A scene asking for maxDistance 0 means "only
  // when touching", and `||` silently widens that to 10 metres — the opposite of
  // what was asked for.
  describe('when an entry asks for a maxDistance of exactly 0', () => {
    it('should keep the 0 rather than treating it as unset', () => {
      expect(resolvePointerInfo({ maxDistance: 0 }).maxDistance).toBe(0)
    })
  })

  describe('when an entry does not say which interaction type it is', () => {
    it('should read as CURSOR, the protocol default', () => {
      expect(interactionTypeOf(entry())).toBe(InteractionType.CURSOR)
    })
  })

  describe('when an entry names a specific button', () => {
    let target: PBPointerEvents_Entry

    beforeEach(() => {
      target = entry({ eventInfo: { button: InputAction.IA_PRIMARY } })
    })

    it('should accept that button', () => {
      expect(entryAccepts(target, PointerEventType.PET_DOWN, InputAction.IA_PRIMARY)).toBe(true)
    })

    it('should reject a different button', () => {
      expect(entryAccepts(target, PointerEventType.PET_DOWN, InputAction.IA_SECONDARY)).toBe(false)
    })

    // The bug this replaces: an entity declaring only PET_DOWN received PET_UP too,
    // because nothing compared the event type at all.
    it('should reject a different event type even with the right button', () => {
      expect(entryAccepts(target, PointerEventType.PET_UP, InputAction.IA_PRIMARY)).toBe(false)
    })
  })

  describe('when an entry names IA_ANY', () => {
    it('should accept any button, which is why it is the default', () => {
      expect(
        entryAccepts(entry({ eventInfo: { button: InputAction.IA_ANY } }), PointerEventType.PET_DOWN, InputAction.IA_SECONDARY)
      ).toBe(true)
    })
  })

  // Hover carries no button on the wire, so it matches on event type alone and the
  // REPORTED button comes from the entry.
  describe('when the event is a hover', () => {
    it('should accept it regardless of the button asked about', () => {
      expect(
        entryAccepts(
          entry({ eventType: PointerEventType.PET_HOVER_ENTER, eventInfo: { button: InputAction.IA_PRIMARY } }),
          PointerEventType.PET_HOVER_ENTER,
          InputAction.IA_ANY
        )
      ).toBe(true)
    })
  })

  // The four cases are quoted from pointer_events.proto.
  describe('when only maxDistance is present', () => {
    it('should qualify within it, ignoring how far the player is', () => {
      expect(isQualifiedByDistance({ maxDistance: 5 }, 4, 1000)).toBe(true)
    })

    it('should not qualify beyond it', () => {
      expect(isQualifiedByDistance({ maxDistance: 5 }, 6, 0)).toBe(false)
    })
  })

  describe('when only maxPlayerDistance is present', () => {
    it('should qualify on player distance, ignoring the camera distance', () => {
      expect(isQualifiedByDistance({ maxPlayerDistance: 2 }, 1000, 1)).toBe(true)
    })

    it('should not qualify when the player is too far', () => {
      expect(isQualifiedByDistance({ maxPlayerDistance: 2 }, 0, 3)).toBe(false)
    })
  })

  // OR, not AND. An entity can be reachable either by pointing at it from across the
  // room or by standing next to it; requiring both would make the pair strictly more
  // restrictive than either alone, which is not what the protocol says.
  describe('when both distances are present', () => {
    it('should qualify when only the camera check passes', () => {
      expect(isQualifiedByDistance({ maxDistance: 20, maxPlayerDistance: 2 }, 15, 50)).toBe(true)
    })

    it('should qualify when only the player check passes', () => {
      expect(isQualifiedByDistance({ maxDistance: 20, maxPlayerDistance: 2 }, 50, 1)).toBe(true)
    })

    it('should not qualify when neither passes', () => {
      expect(isQualifiedByDistance({ maxDistance: 20, maxPlayerDistance: 2 }, 50, 50)).toBe(false)
    })
  })

  describe('when neither distance is present', () => {
    it('should behave as though maxDistance were 10', () => {
      expect(isQualifiedByDistance({}, 9.9, 1000)).toBe(true)
    })

    it('should reject past 10 metres, which is what made anything clickable before', () => {
      expect(isQualifiedByDistance({}, 10.1, 0)).toBe(false)
    })
  })

  describe('when an entity declares entries of both interaction types', () => {
    let entries: PBPointerEvents_Entry[]

    beforeEach(() => {
      entries = [
        entry({ interactionType: InteractionType.CURSOR }),
        entry({ interactionType: InteractionType.PROXIMITY })
      ]
    })

    it('should select only the cursor entry for a cursor interaction', () => {
      const firing = selectFiringEntries(entries, PointerEventType.PET_DOWN, InputAction.IA_ANY, 1, 1, InteractionType.CURSOR)
      expect(firing.map(interactionTypeOf)).toEqual([InteractionType.CURSOR])
    })
  })

  // `priority` is documented as "resolution order when multiple events overlap,
  // higher wins". Reporting both would leave a scene unable to tell which the player
  // meant, which is the whole reason the field exists.
  describe('when several qualifying entries have different priorities', () => {
    let firing: PBPointerEvents_Entry[]

    beforeEach(() => {
      firing = selectFiringEntries(
        [
          entry({ eventInfo: { priority: 1 } }),
          entry({ eventInfo: { priority: 7 } }),
          entry({ eventInfo: { priority: 3 } })
        ],
        PointerEventType.PET_DOWN,
        InputAction.IA_ANY,
        1,
        1,
        InteractionType.CURSOR
      )
    })

    it('should report only the highest', () => {
      expect(firing.map((e) => resolvePointerInfo(e.eventInfo).priority)).toEqual([7])
    })
  })

  describe('when several qualifying entries share the top priority', () => {
    it('should report all of them, since none outranks another', () => {
      const firing = selectFiringEntries(
        [entry({ eventInfo: { priority: 4 } }), entry({ eventInfo: { priority: 4 } })],
        PointerEventType.PET_DOWN,
        InputAction.IA_ANY,
        1,
        1,
        InteractionType.CURSOR
      )
      expect(firing).toHaveLength(2)
    })
  })

  describe('when an entry qualifies on type but not on distance', () => {
    it('should not fire, so distance is not merely advisory', () => {
      const firing = selectFiringEntries(
        [entry({ eventInfo: { maxDistance: 2 } })],
        PointerEventType.PET_DOWN,
        InputAction.IA_ANY,
        50,
        50,
        InteractionType.CURSOR
      )
      expect(firing).toEqual([])
    })
  })
})
