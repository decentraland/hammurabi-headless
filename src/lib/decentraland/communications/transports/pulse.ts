import * as proto from '@dcl/protocol/out-js/decentraland/kernel/comms/rfc4/comms.gen'
import mitt from 'mitt'
import { connect } from '@dcl/pulse-client'
import type { ParcelGridConfig, Player, SceneListener } from '@dcl/pulse-client'
import { CommsTransportEvents, MinimumCommunicationsTransport, SendHints, commsLogger } from '../types'

export type PulseConfig = {
  host: string
  port: number
  realm: string
  parcelIndices: number[]
  authChain: string
  grid: ParcelGridConfig
}

/** Default DCL parcel-grid config (matches the .zone Pulse server). */
export const DEFAULT_PARCEL_GRID: ParcelGridConfig = {
  minX: -152,
  minZ: -152,
  maxParcel: 163,
  padding: 2,
  parcelSize: 16
}

const IDENTITY_ROTATION = { x: 0, y: 0, z: 0, w: 1 }

export class PulseAdapter implements MinimumCommunicationsTransport {
  public readonly events = mitt<CommsTransportEvents>()

  private listener?: SceneListener
  private disposed = false
  private connected = false
  // The pulse-client contract: `disconnected` fires exactly once on every terminal loop
  // exit, while `error` is non-fatal (e.g. one malformed packet, an abandoned resync).
  // This flag keeps DISCONNECTION single-fire regardless.
  private terminated = false
  // subjectId -> address, seeded from joined/updated so playerLeft (which only
  // carries a subjectId) can resolve an address it is never given directly.
  private readonly subjectAddresses = new Map<string, string>()

  constructor(private readonly config: PulseConfig) {}

  async connect(): Promise<void> {
    this.listener = await connect({
      host: this.config.host,
      port: this.config.port,
      realm: this.config.realm,
      parcelIndices: this.config.parcelIndices,
      authChain: this.config.authChain,
      grid: this.config.grid
    })
    this.connected = true

    this.listener.on('playerJoined', (player) => {
      if (this.disposed) return
      const address = this.track(player)
      this.events.emit('PEER_CONNECTED', { address })
      this.emitPosition(player, address)
    })
    this.listener.on('playerUpdated', (player) => {
      if (this.disposed) return
      this.emitPosition(player, this.track(player))
    })
    this.listener.on('playerTeleported', (player) => {
      if (this.disposed) return
      this.emitPosition(player, this.track(player))
    })
    this.listener.on('playerLeft', (subjectId) => {
      if (this.disposed) return
      const address = this.subjectAddresses.get(subjectId) ?? subjectId
      this.subjectAddresses.delete(subjectId)
      this.events.emit('PEER_DISCONNECTED', { address })
    })
    this.listener.on('error', (error) => {
      commsLogger.error(`Pulse listener error: ${error.message}`)
      this.events.emit('error', error)
    })
    this.listener.on('disconnected', (reason) => this.terminate(reason ? new Error(reason) : undefined))
  }

  /** Terminal loop exit: flip the connection state and surface DISCONNECTION exactly once. */
  private terminate(error: Error | undefined): void {
    this.connected = false
    if (this.disposed || this.terminated) return
    this.terminated = true
    this.events.emit('DISCONNECTION', { kicked: false, error })
  }

  // Receive-only observer: the scene listener never publishes peer traffic.
  send(_data: Uint8Array, _hints: SendHints, _destination: string[]): void {}

  setVoicePosition(_address: string, _position: proto.Position): void {}

  async disconnect(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.connected = false
    this.listener?.close()
    this.listener = undefined
    this.subjectAddresses.clear()
  }

  getRoomInfo(): { roomName: string; isConnected: boolean } | undefined {
    return { roomName: this.config.realm, isConnected: this.connected }
  }

  private track(player: Player): string {
    const address = player.address ?? player.subjectId
    this.subjectAddresses.set(player.subjectId, address)
    return address
  }

  // Re-encode pulse player state back into an RFC-4 position Packet so the
  // existing CommsTransportWrapper decode path (and the avatar system) are
  // reused verbatim and stay future-proof for other packet types.
  private emitPosition(player: Player, address: string): void {
    const rotation = player.rotation ?? IDENTITY_ROTATION
    const position: proto.Position = {
      index: player.sequence,
      positionX: player.position.x,
      positionY: player.position.y,
      positionZ: player.position.z,
      rotationX: rotation.x,
      rotationY: rotation.y,
      rotationZ: rotation.z,
      rotationW: rotation.w
    }
    if (process.env.PULSE_DEBUG) {
      const p = player.position
      commsLogger.log(`📍 recv ${address} pos=(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}) seq=${player.sequence}`)
    }
    const packet: proto.Packet = { message: { $case: 'position', position }, protocolVersion: 0 }
    this.events.emit('message', { address, data: proto.Packet.encode(packet).finish() })
  }
}
