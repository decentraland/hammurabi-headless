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
export function entryAccepts(entry: PBPointerEvents_Entry, eventType: PointerEventType, action: InputAction): boolean {
  if (entry.eventType !== eventType) return false

  if (eventType === PointerEventType.PET_HOVER_ENTER || eventType === PointerEventType.PET_HOVER_LEAVE) {
    return true
  }

  const { button } = resolvePointerInfo(entry.eventInfo)
  return button === InputAction.IA_ANY || button === action
}

/**
 * The protocol's distance rules, quoted from pointer_events.proto:
 *
 *   1) only `max_distance`        -> camera distance <= max_distance
 *   2) only `max_player_distance` -> player distance <= max_player_distance
 *   3) BOTH                       -> either check passing is enough (OR)
 *   4) neither                    -> as if max_distance were 10
 *
 * Note case 3 is an OR, not an AND: an entity can be reachable either by pointing at
 * it from across the room or by standing next to it, and requiring both would make
 * the pair strictly more restrictive than one alone. Presence is tested on the RAW
 * info because "unset" and "set to 0" mean different things here — `maxDistance: 0`
 * is a legitimate "only when touching".
 */
export function isQualifiedByDistance(
  info: PBPointerEvents_Info | undefined,
  cameraDistance: number,
  playerDistance: number
): boolean {
  const hasMaxDistance = info?.maxDistance !== undefined
  const hasMaxPlayerDistance = info?.maxPlayerDistance !== undefined
  const resolved = resolvePointerInfo(info)

  if (hasMaxDistance && !hasMaxPlayerDistance) return cameraDistance <= resolved.maxDistance
  if (!hasMaxDistance && hasMaxPlayerDistance) return playerDistance <= resolved.maxPlayerDistance
  if (hasMaxDistance && hasMaxPlayerDistance) {
    return cameraDistance <= resolved.maxDistance || playerDistance <= resolved.maxPlayerDistance
  }
  return cameraDistance <= resolved.maxDistance
}

/**
 * The entries of `entries` that should fire, highest `priority` first and nothing
 * below the winning priority.
 *
 * `priority` is documented as "resolution order when multiple events overlap, higher
 * wins". An entity declaring a low-priority and a high-priority entry for the same
 * button must report only the high one, or a scene using priority to disambiguate
 * gets both and cannot tell which the player meant.
 */
export function selectFiringEntries(
  entries: PBPointerEvents_Entry[],
  eventType: PointerEventType,
  action: InputAction,
  cameraDistance: number,
  playerDistance: number,
  interactionType: InteractionType
): PBPointerEvents_Entry[] {
  const qualified = entries.filter(
    (entry) =>
      interactionTypeOf(entry) === interactionType &&
      entryAccepts(entry, eventType, action) &&
      isQualifiedByDistance(entry.eventInfo, cameraDistance, playerDistance)
  )

  if (qualified.length < 2) return qualified

  let winning = 0
  for (const entry of qualified) {
    const { priority } = resolvePointerInfo(entry.eventInfo)
    if (priority > winning) winning = priority
  }

  return qualified.filter((entry) => resolvePointerInfo(entry.eventInfo).priority === winning)
}
