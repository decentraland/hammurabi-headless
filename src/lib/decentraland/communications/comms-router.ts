import mitt, { Emitter } from 'mitt'
import * as proto from '@dcl/protocol/out-js/decentraland/kernel/comms/rfc4/comms.gen'
import { CommsEvents, CommsTransportWrapper } from './CommsTransportWrapper'
import { ALL_LISTENERS, LISTENER_EVENTS, RoutingPlan, Transport } from './comms-routing'

/**
 * The comms surface the scene runtime consumes. Satisfied structurally by both a single
 * {@link CommsTransportWrapper} (LiveKit-only) and the multi-transport {@link CommsRouter}, so the
 * avatar system and scene context bind to it without caring how many transports are live.
 */
export interface CommsChannel {
  readonly events: Emitter<CommsEvents>
  sendParcelSceneMessage(scene: proto.Scene, destination: string[]): Promise<void>
  getRoomInfo(): { roomName: string; isConnected: boolean } | undefined
  connect(): Promise<void>
  disconnect(): Promise<void>
}

/**
 * Runs one or more transports at once and forwards each typed event ONLY from the transport that
 * owns its listener (see {@link ./comms-routing}). Outbound sends go to LiveKit — the only sendable
 * transport. Lifecycle DISCONNECTION is forwarded from every connected transport, so losing any of
 * them surfaces to the restart handler.
 */
export class CommsRouter implements CommsChannel {
  readonly events = mitt<CommsEvents>()

  constructor(
    private readonly plan: RoutingPlan,
    private readonly transports: Partial<Record<Transport, CommsTransportWrapper>>
  ) {
    // mitt's emit is strongly keyed; forwarding a dynamic (key, payload) pair needs a loose alias.
    const forward = this.events.emit.bind(this.events) as unknown as (type: keyof CommsEvents, payload: any) => void

    for (const listener of ALL_LISTENERS) {
      const wrapper = this.transports[this.plan.owners[listener]]
      if (!wrapper) continue
      for (const event of LISTENER_EVENTS[listener]) {
        wrapper.events.on(event, (payload: any) => forward(event, payload))
      }
    }

    // Losing any connected transport degrades the server (position OR scene bus), so forward
    // DISCONNECTION from all of them; the restart handler acts on the first non-clientInitiated one.
    for (const wrapper of this.connectedWrappers()) {
      wrapper.events.on('DISCONNECTION', (event) => this.events.emit('DISCONNECTION', event))
    }
  }

  private connectedWrappers(): CommsTransportWrapper[] {
    return [...this.plan.connectionSet]
      .map((transport) => this.transports[transport])
      .filter((wrapper): wrapper is CommsTransportWrapper => wrapper !== undefined)
  }

  async connect(): Promise<void> {
    await Promise.all(this.connectedWrappers().map((wrapper) => wrapper.connect()))
  }

  async disconnect(): Promise<void> {
    await Promise.all(this.connectedWrappers().map((wrapper) => wrapper.disconnect()))
  }

  sendParcelSceneMessage(scene: proto.Scene, destination: string[]): Promise<void> {
    // Pulse is receive-only; scene→peer traffic always goes over LiveKit when present.
    return this.transports.livekit?.sendParcelSceneMessage(scene, destination) ?? Promise.resolve()
  }

  getRoomInfo(): { roomName: string; isConnected: boolean } | undefined {
    // Prefer LiveKit's room identity (the realm room); fall back to whatever is connected.
    for (const wrapper of this.connectedWrappers()) {
      const info = wrapper.getRoomInfo()
      if (info) return info
    }
    return undefined
  }
}
