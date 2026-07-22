import { CommsEvents } from './CommsTransportWrapper'

/** A logical comms capability — a group of RFC-4 message types the wrapper decodes. */
export type Listener = 'presence' | 'position' | 'profile' | 'chat' | 'sceneBus' | 'voice'

export type Transport = 'pulse' | 'livekit'

export const ALL_LISTENERS: readonly Listener[] = ['presence', 'position', 'profile', 'chat', 'sceneBus', 'voice']

/**
 * Which listeners each transport can serve today. Grow `pulse` one entry at a time as the
 * PulseAdapter learns to emit that message type — the handler downstream is transport-agnostic,
 * so a new capability is a one-line change here plus the adapter emitting it.
 */
export const CAPABILITIES: Record<Transport, ReadonlySet<Listener>> = {
  pulse: new Set<Listener>(['position']),
  livekit: new Set<Listener>(['presence', 'position', 'profile', 'chat', 'sceneBus', 'voice'])
}

/**
 * The wrapper events each listener owns — routing is applied at this typed-event level (after the
 * per-transport wrapper has decoded + rate-limited). `position` deliberately covers `movement` too:
 * both encode "where a peer is", so they must move together or two transports would fight over the
 * same Transform. Lifecycle events (DISCONNECTION, error) are NOT here — the router forwards those
 * from every connected transport.
 */
export const LISTENER_EVENTS: Record<Listener, readonly (keyof CommsEvents)[]> = {
  presence: ['PEER_CONNECTED', 'PEER_DISCONNECTED'],
  position: ['position', 'movement'],
  profile: ['profileMessage'],
  chat: ['chatMessage'],
  sceneBus: ['sceneMessageBus'],
  voice: ['voiceMessage']
}

export interface RoutingPlan {
  /** Per-listener owning transport. */
  owners: Record<Listener, Transport>
  /** Distinct transports that own >= 1 listener — connect ONLY these. */
  connectionSet: Set<Transport>
}

/**
 * Resolve one owner per listener: Pulse wins iff it is enabled AND declares the capability,
 * otherwise LiveKit. The connection set falls out of the owners, so a transport that ends up
 * owning nothing is never connected.
 */
export function resolveRouting(pulseEnabled: boolean): RoutingPlan {
  const owners = {} as Record<Listener, Transport>
  for (const listener of ALL_LISTENERS) {
    owners[listener] = pulseEnabled && CAPABILITIES.pulse.has(listener) ? 'pulse' : 'livekit'
  }
  const connectionSet = new Set<Transport>(ALL_LISTENERS.map((listener) => owners[listener]))
  return { owners, connectionSet }
}

/**
 * Pulse is enabled via the (reinterpreted) HAMMURABI_COMMS_PROTOCOL=pulse opt-in: it now means
 * "route Pulse's capability set through Pulse, everything else through LiveKit, connect both".
 * Any other value (including unset) keeps LiveKit-only.
 */
export function isPulseEnabled(envProtocol: string | undefined): boolean {
  return envProtocol === 'pulse'
}
