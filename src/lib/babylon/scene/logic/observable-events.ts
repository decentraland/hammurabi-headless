import { EventData, EventDataType } from '@dcl/protocol/out-js/decentraland/kernel/apis/engine_api.gen'
import { limits } from '../../../misc/limits'
import { limitLogger } from '../../../misc/limit-logger'

/**
 * SDK observable events (`EngineApi.subscribe` + `EngineApi.sendBatch`).
 *
 * This is the channel behind `@dcl/sdk/observables` — `onPlayerConnected`,
 * `onEnterScene`, `onPlayerExpression`, and friends. `subscribe` used to throw
 * `not implemented` and `sendBatch` returned an empty list, so a scene importing
 * that module got a rejection instead of events.
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
  playerExpression: 'playerExpression',
  profileChanged: 'profileChanged',
  comms: 'comms',
  // Emitted by the reference client but NOT by this server:
  //  - playerClicked needs pointer picking against avatars, which headless has
  //    no avatar meshes for;
  //  - onRealmChanged cannot happen here, since a worker serves exactly one
  //    scene in one realm for its whole life.
  // They are still accepted by subscribe() so a scene that asks for them keeps
  // running; they simply never fire.
  playerClicked: 'playerClicked',
  realmChanged: 'onRealmChanged'
} as const

const KNOWN_EVENT_IDS: ReadonlySet<string> = new Set(Object.values(SDK_OBSERVABLE_EVENTS))

export type ObservableEventQueue = {
  subscribe(eventId: string): void
  unsubscribe(eventId: string): void
  /** Queues an event if (and only if) the scene subscribed to it. */
  emit(eventId: string, payload: unknown): void
  isSubscribed(eventId: string): boolean
  /** Drains everything queued since the last call. */
  drain(): EventData[]
  readonly queued: number
}

export function createObservableEventQueue(): ObservableEventQueue {
  const MAX_QUEUE = limits.maxObservableEventQueue

  const subscribed = new Set<string>()
  let pending: EventData[] = []

  return {
    get queued() {
      return pending.length
    },

    subscribe(eventId: string) {
      // Unknown ids are dropped rather than stored. The set is keyed by a
      // scene-controlled string and nothing can ever emit an id this server does
      // not produce, so keeping them would be pure memory cost with no effect.
      // (The reference client stores arbitrary strings in an unbounded set.)
      if (!KNOWN_EVENT_IDS.has(eventId)) return
      subscribed.add(eventId)
    },

    unsubscribe(eventId: string) {
      subscribed.delete(eventId)
      if (subscribed.size === 0 && pending.length > 0) {
        // Nothing can consume these any more; holding them would pin memory
        // until the scene happened to subscribe again.
        pending = []
      }
    },

    isSubscribed(eventId: string) {
      return subscribed.has(eventId)
    },

    emit(eventId: string, payload: unknown) {
      if (!subscribed.has(eventId)) return

      // Drop-oldest. A scene may subscribe and then never call sendBatch (the
      // SDK only polls while an observable has listeners), so peers churning or
      // chatting would otherwise grow this without bound.
      if (pending.length >= MAX_QUEUE) {
        pending.shift()
        limitLogger.hit('maxObservableEventQueue', eventId)
      }

      pending.push({
        type: EventDataType.EDT_GENERIC,
        generic: {
          eventId,
          // The scene JSON.parses this. Payloads are built host-side from
          // primitives, so stringify cannot throw here.
          eventData: JSON.stringify(payload)
        }
      })
    },

    drain(): EventData[] {
      if (pending.length === 0) return []
      // Hand the array over and start a fresh one rather than copying+clearing
      // (same pattern as SceneContext.getNetworkMessages).
      const drained = pending
      pending = []
      return drained
    }
  }
}
