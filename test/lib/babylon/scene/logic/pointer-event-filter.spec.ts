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

  // Hover carries no button on the wire, so it is not matched against the pressed
  // input — but it IS still gated on the entry's own button. The client's
  // `AppendPointerInputIfQualified` requires `Button is IaPointer or IaAny` for every
  // enter/leave append.
  describe('when the event is a hover', () => {
    it('should accept an entry that names IA_POINTER', () => {
      expect(
        entryAccepts(
          entry({ eventType: PointerEventType.PET_HOVER_ENTER, eventInfo: { button: InputAction.IA_POINTER } }),
          PointerEventType.PET_HOVER_ENTER,
          InputAction.IA_ANY
        )
      ).toBe(true)
    })

    it('should accept an entry that names IA_ANY', () => {
      expect(
        entryAccepts(
          entry({ eventType: PointerEventType.PET_HOVER_ENTER, eventInfo: {} }),
          PointerEventType.PET_HOVER_ENTER,
          InputAction.IA_ANY
        )
      ).toBe(true)
    })

    // An earlier revision accepted this, so a `{PET_HOVER_ENTER, IA_PRIMARY}` entry
    // fired here and nowhere else.
    it('should reject an entry naming any other button, as the client does', () => {
      expect(
        entryAccepts(
          entry({ eventType: PointerEventType.PET_HOVER_ENTER, eventInfo: { button: InputAction.IA_PRIMARY } }),
          PointerEventType.PET_HOVER_ENTER,
          InputAction.IA_ANY
        )
      ).toBe(false)
    })
  })

  // The proto documents FOUR branches. The client cannot implement them: it calls
  // PrepareDefaultValues on the same Info instance immediately before the check, and
  // assigning a C# protobuf optional scalar SETS ITS HAS-BIT, so both fields always
  // read as present and only the OR branch is reachable. We follow the client.
  //
  // NOTE these cases pass a large playerDistance whenever the player term is meant to
  // be false. maxPlayerDistance defaults to 0, so `playerDistance <= 0` is satisfied
  // by a player standing exactly on the hit point — an edge the client shares, but one
  // that makes 0 a misleading "don't care" value in a test.
  describe('when only maxDistance is present', () => {
    it('should qualify within it', () => {
      expect(isQualifiedByDistance({ maxDistance: 5 }, 4, 1000)).toBe(true)
    })

    it('should not qualify beyond it', () => {
      expect(isQualifiedByDistance({ maxDistance: 5 }, 6, 1000)).toBe(false)
    })
  })

  // THE CASE THAT CHANGED. A literal reading of the proto restricts this to the player
  // check alone; the client also allows the default 10m camera check, so implementing
  // the proto made this server silently STRICTER than every player's machine.
  describe('when only maxPlayerDistance is present', () => {
    it('should qualify on player distance when the camera is far away', () => {
      expect(isQualifiedByDistance({ maxPlayerDistance: 2 }, 1000, 1)).toBe(true)
    })

    it('should ALSO qualify within the default 10m camera range, as the client does', () => {
      expect(isQualifiedByDistance({ maxPlayerDistance: 2 }, 5, 500)).toBe(true)
    })

    it('should not qualify when both the camera and the player are out of range', () => {
      expect(isQualifiedByDistance({ maxPlayerDistance: 2 }, 1000, 3)).toBe(false)
    })
  })

  // OR, not AND. An entity can be reachable either by pointing at it from across the
  // room or by standing next to it; requiring both would make the pair strictly more
  // restrictive than either alone.
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
      expect(isQualifiedByDistance({}, 10.1, 1000)).toBe(false)
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

  // `priority` deliberately does NOT filter an entity's entry list. The proto calls it
  // "resolution order when multiple events overlap, higher wins", and an earlier
  // revision read that as "keep only the top-priority entries" — but the client never
  // does: its only use of Priority is in PlayerOriginatedProximitySystem, selecting
  // which ENTITY becomes the proximity target. Filtering here made this server emit
  // FEWER results than every client.
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

    it('should report all of them, leaving priority to the proximity target choice', () => {
      expect(firing.map((e) => resolvePointerInfo(e.eventInfo).priority)).toEqual([1, 7, 3])
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
