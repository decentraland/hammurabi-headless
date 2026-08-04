import { EventData, EventDataType } from '@dcl/protocol/out-js/decentraland/kernel/apis/engine_api.gen'
import { limits } from '../../../misc/limits'
import { limitLogger } from '../../../misc/limit-logger'

/**
 * SDK observable events (`EngineApi.subscribe` + `EngineApi.sendBatch`).
 *
 * This is the channel behind `@dcl/sdk/observables` — `onPlayerConnected`,
 * `onEnterScene`, and friends. `subscribe` used to throw `not implemented` and
 * `sendBatch` returned an empty list, so a scene importing that module got a
 * rejection instead of events.
 *
 * The event ids and payload shapes are fixed by the reference client
 * (`SDKObservableEventIds` / the payload structs beside it) — a scene parses
 * `eventData` as JSON with those exact field names.
 */
export const SDK_OBSERVABLE_EVENTS = {
  sceneStart: 'sceneStart',
  playerConnected: 'playerConnected',
  playerDisconnected: 'playerDisconnected',
  enterScene: 'onEnterScene',
  leaveScene: 'onLeaveScene',
  profileChanged: 'profileChanged',
  comms: 'comms',
  // Accepted by subscribe() so a scene that asks for them keeps running, but
  // never fired by this server:
  //  - playerClicked needs pointer picking against avatars, which headless has
  //    no avatar meshes for;
  //  - onRealmChanged cannot happen here, since a worker serves exactly one
  //    scene in one realm for its whole life;
  //  - playerExpression is the LOCAL player's expression — the reference
  //    client's PlayerExpressionPayload carries only an expressionId and no
  //    user field, and this server has no local player driving emotes. Routing
  //    remote peers' emotes into it would hand a scene an unattributable event
  //    (which of the 224 peers waved?). Remote emotes reach SDK7 scenes as
  //    AvatarEmoteCommand on the peer's own entity instead, which is both
  //    attributable and the channel the SDK actually documents for them.
  playerClicked: 'playerClicked',
  realmChanged: 'onRealmChanged',
  playerExpression: 'playerExpression'
} as const

const KNOWN_EVENT_IDS: ReadonlySet<string> = new Set(Object.values(SDK_OBSERVABLE_EVENTS))

export type ObservableEventQueue = {
  subscribe(eventId: string): void
  unsubscribe(eventId: string): void
  /** Queues an event if (and only if) the scene subscribed to it. */
  emit(eventId: string, payload: unknown): void
  /**
   * Queues a ONE-SHOT event that must survive being emitted before the scene could
   * subscribe. Delivered immediately when already subscribed, otherwise held and
   * queued by the next `subscribe` for that id.
   */
  emitLatched(eventId: string, payload: unknown): void
  isSubscribed(eventId: string): boolean
  /** Drains everything queued since the last call. */
  drain(): EventData[]
  /** Drops every subscription, every queued event and every latch. */
  reset(): void
  readonly queued: number
  readonly queuedBytes: number
}

export function createObservableEventQueue(): ObservableEventQueue {
  const MAX_QUEUE = limits.maxObservableEventQueue // HAMMURABI_MAX_OBSERVABLE_EVENT_QUEUE
  const MAX_QUEUE_BYTES = limits.maxObservableEventQueueBytes // HAMMURABI_MAX_OBSERVABLE_EVENT_QUEUE_BYTES

  const subscribed = new Set<string>()
  // One-shot events emitted before anything could receive them (see emitLatched).
  // Bounded by construction: only host code calls emitLatched, and only with known ids.
  const latched = new Map<string, unknown>()

  // FIFO with a moving head instead of `shift()`. Once the queue saturates, every
  // further emit drops the oldest entry, and `shift()` there is a memmove of the whole
  // (1024-entry) backing array per inbound message.
  let pending: (EventData | undefined)[] = []
  let head = 0
  let pendingBytes = 0

  // What one queued event costs us to hold: its JSON payload, which for `comms` embeds
  // the whole peer-supplied message body.
  function sizeOf(event: EventData): number {
    return Buffer.byteLength(event.generic?.eventData ?? '')
  }

  function dropOldest(eventId: string) {
    const oldest = pending[head]
    if (oldest === undefined) return
    pendingBytes -= sizeOf(oldest)
    pending[head] = undefined
    head++
    limitLogger.hit('maxObservableEventQueue', eventId)
    // Reclaim the dead prefix once it dominates the array, so a long-saturated queue
    // does not keep growing the backing store.
    if (head > 64 && head * 2 > pending.length) {
      pending = pending.slice(head)
      head = 0
    }
  }

  function enqueue(eventId: string, payload: unknown) {
    const event: EventData = {
      type: EventDataType.EDT_GENERIC,
      generic: {
        eventId,
        // The scene JSON.parses this. Payloads are built host-side from
        // primitives, so stringify cannot throw here.
        eventData: JSON.stringify(payload)
      }
    }
    const size = sizeOf(event)

    // Drop-oldest, by COUNT and by BYTES. A scene may subscribe and then never call
    // sendBatch (the SDK only polls while an observable has listeners), so peers
    // churning or chatting would otherwise grow this without bound. The byte cap is
    // what actually bounds memory: a `comms` payload carries the whole message body
    // (up to maxCommsMessageBytes), so a count-only cap admitted ~1024 x 30KB = 30MB
    // per scene, and the same bytes sit in `incomingNetworkMessages` under its own cap.
    while (pending.length - head >= MAX_QUEUE) dropOldest(eventId)
    while (pendingBytes + size > MAX_QUEUE_BYTES && pending.length - head > 0) dropOldest(eventId)

    pending.push(event)
    pendingBytes += size
  }

  return {
    get queued() {
      return pending.length - head
    },

    get queuedBytes() {
      return pendingBytes
    },

    subscribe(eventId: string) {
      // Unknown ids are dropped rather than stored. The set is keyed by a
      // scene-controlled string and nothing can ever emit an id this server does
      // not produce, so keeping them would be pure memory cost with no effect.
      // (The reference client stores arbitrary strings in an unbounded set.)
      if (!KNOWN_EVENT_IDS.has(eventId)) return
      subscribed.add(eventId)

      // A latched event fired before this subscription existed. Deliver it now, so it
      // lands on the scene's next drain.
      if (latched.has(eventId)) {
        const payload = latched.get(eventId)
        latched.delete(eventId)
        enqueue(eventId, payload)
      }
    },

    unsubscribe(eventId: string) {
      subscribed.delete(eventId)
      if (subscribed.size === 0 && pending.length - head > 0) {
        // Nothing can consume these any more; holding them would pin memory
        // until the scene happened to subscribe again.
        pending = []
        head = 0
        pendingBytes = 0
      }
    },

    isSubscribed(eventId: string) {
      return subscribed.has(eventId)
    },

    emit(eventId: string, payload: unknown) {
      if (!subscribed.has(eventId)) return
      enqueue(eventId, payload)
    },

    emitLatched(eventId: string, payload: unknown) {
      if (subscribed.has(eventId)) {
        enqueue(eventId, payload)
        return
      }
      // Held, not dropped. `sceneStart` is emitted on the frame that resolves the
      // scene's FIRST CRDT rpc — before any observer registered in the scene's main()
      // can have subscribed — and unlike every other event it has no natural
      // re-trigger, so dropping it means the scene never sees it at all.
      latched.set(eventId, payload)
    },

    drain(): EventData[] {
      if (pending.length - head === 0) return []
      // Hand the array over and start a fresh one rather than copying+clearing
      // (same pattern as SceneContext.getNetworkMessages).
      const drained = (head === 0 ? pending : pending.slice(head)) as EventData[]
      pending = []
      head = 0
      pendingBytes = 0
      return drained
    },

    reset() {
      subscribed.clear()
      latched.clear()
      pending = []
      head = 0
      pendingBytes = 0
    }
  }
}
