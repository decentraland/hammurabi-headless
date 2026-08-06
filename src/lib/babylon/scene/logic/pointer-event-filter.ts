import { InputAction, InteractionType, PointerEventType } from '@dcl/protocol/out-js/decentraland/sdk/components/common/input_action.gen'
import { PBPointerEvents_Entry, PBPointerEvents_Info } from '@dcl/protocol/out-js/decentraland/sdk/components/pointer_events.gen'

/**
 * The rules deciding whether a PointerEvents entry fires, extracted from the
 * pointer pipeline so they can be tested without a camera, a scene or a pick.
 *
 * None of this existed. `pointer-events.ts` read ZERO fields off
 * `PBPointerEvents_Info` and never looked at the entry list at all — it emitted one
 * result for whatever entity was hovered, with whatever button the caller passed.
 * So this server fired interactions no client can produce: a button pressed from
 * 500m away, a PET_UP on an entity that only asked for PET_DOWN, and a hover
 * carrying `InputAction.UNRECOGNIZED` (-1), which is a ts-proto "unknown enum"
 * sentinel rather than an InputAction any scene can match on.
 *
 * Defaults mirror the client's `PBPointerEvents_Info.PrepareDefaultValues`, and the
 * distance rules are spelled out in pointer_events.proto itself — this is one of the
 * few places where the protocol text and the client agree in detail, so there is no
 * judgement call to make.
 */

/** `maxDistance` when the scene leaves it unset — the protocol's documented default. */
export const DEFAULT_POINTER_MAX_DISTANCE = 10

/**
 * Info with every optional field resolved, so callers never repeat the defaults.
 *
 * `button` defaults to IA_ANY rather than IA_POINTER: IA_POINTER is 0, which is what
 * an unset protobuf enum decodes to, so defaulting to it would make "no button
 * specified" indistinguishable from "the pointer button specifically".
 */
export interface ResolvedPointerInfo {
  button: InputAction
  maxDistance: number
  maxPlayerDistance: number
  priority: number
}

export function resolvePointerInfo(info: PBPointerEvents_Info | undefined): ResolvedPointerInfo {
  return {
    button: info?.button ?? InputAction.IA_ANY,
    // `?? DEFAULT` and not `|| DEFAULT`: a scene asking for maxDistance 0 means
    // "only when touching", and `||` would silently widen that to 10 metres.
    maxDistance: info?.maxDistance ?? DEFAULT_POINTER_MAX_DISTANCE,
    maxPlayerDistance: info?.maxPlayerDistance ?? 0,
    priority: info?.priority ?? 0
  }
}

/** CURSOR unless the entry says otherwise; the protocol documents 0 == CURSOR. */
export function interactionTypeOf(entry: PBPointerEvents_Entry): InteractionType {
  return entry.interactionType ?? InteractionType.CURSOR
}

/**
 * Whether an entry accepts `action` for `eventType`.
 *
 * IA_ANY accepts every button, which is why it is the default — an entry that names
 * no button reacts to all of them. Hover events carry no button on the wire, so they
 * match on event type alone and REPORT the entry's own button.
 */
export function isHover(eventType: PointerEventType): boolean {
  return eventType === PointerEventType.PET_HOVER_ENTER || eventType === PointerEventType.PET_HOVER_LEAVE
}

export function entryAccepts(entry: PBPointerEvents_Entry, eventType: PointerEventType, action: InputAction): boolean {
  if (entry.eventType !== eventType) return false

  if (isHover(eventType)) {
    // Still button-gated, just not against the pressed input. The client's
    // `AppendPointerInputIfQualified` requires `Button is IaPointer or IaAny` for
    // EVERY enter/leave append, so an entry declaring `{PET_HOVER_ENTER, IA_PRIMARY}`
    // fires here and nowhere else.
    const { button } = resolvePointerInfo(entry.eventInfo)
    return button === InputAction.IA_POINTER || button === InputAction.IA_ANY
  }

  const { button } = resolvePointerInfo(entry.eventInfo)
  return button === InputAction.IA_ANY || button === action
}

/**
 * Whether an entry's distance criteria are met.
 *
 * `pointer_events.proto` documents FOUR branches — only `max_distance` means the
 * camera check, only `max_player_distance` means the player check, both means either
 * passing is enough, neither behaves as if `max_distance` were 10. The client does
 * NOT implement four branches, and cannot: `ProcessPointerEventsSystem` calls
 * `info.PrepareDefaultValues()` on the same Info instance immediately before the
 * check, and assigning a C# protobuf `optional` scalar SETS ITS HAS-BIT
 * (`PointerEvents.gen.cs`: `set { _hasBits0 |= 2; ... }`). So both fields always read
 * as present by then and only the OR branch is ever reached.
 *
 * We follow the client, per the standing decision for proto-vs-client conflicts, so
 * this is one expression: the camera check against `max_distance` (default 10) OR the
 * player check against `max_player_distance` (default 0).
 *
 * That is not equivalent to the proto text in one case, and it is a case scenes hit:
 * an entry setting ONLY `max_player_distance` is reachable from up to 10 metres away
 * on every client, where a literal reading of the proto would restrict it to the
 * player check alone. Implementing the proto made us silently stricter than every
 * player's machine.
 *
 * The default-0 player term is effectively "never" rather than "always", which is why
 * the maxDistance-only and neither-set cases still behave as the proto describes.
 */
export function isQualifiedByDistance(
  info: PBPointerEvents_Info | undefined,
  cameraDistance: number,
  playerDistance: number
): boolean {
  const resolved = resolvePointerInfo(info)
  return cameraDistance <= resolved.maxDistance || playerDistance <= resolved.maxPlayerDistance
}

/**
 * The entries of `entries` that should fire.
 *
 * `priority` is deliberately NOT applied here. The proto describes it as "resolution
 * order when multiple events overlap, higher wins", and an earlier revision used it to
 * keep only the top-priority entries — but the client never filters an entity's entry
 * list by it. `grep -rn "\.Priority"` across its Interaction assembly hits only
 * `PlayerOriginatedProximitySystem`, where priority selects which ENTITY becomes the
 * proximity target. That is implemented, in proximity-interaction.ts.
 *
 * Dropping entries here made this server emit fewer results than every client for an
 * entity that declares two qualifying entries at different priorities.
 */
export function selectFiringEntries(
  entries: PBPointerEvents_Entry[],
  eventType: PointerEventType,
  action: InputAction,
  cameraDistance: number,
  playerDistance: number,
  interactionType: InteractionType
): PBPointerEvents_Entry[] {
  return entries.filter(
    (entry) =>
      interactionTypeOf(entry) === interactionType &&
      entryAccepts(entry, eventType, action) &&
      isQualifiedByDistance(entry.eventInfo, cameraDistance, playerDistance)
  )
}
