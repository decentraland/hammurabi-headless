import * as proto from '@dcl/protocol/out-js/decentraland/kernel/comms/rfc4/comms.gen'
import { ConnectionState, DisconnectReason, Room, RoomEvent } from '@livekit/rtc-node'

import mitt from 'mitt'
import { CommsTransportEvents, MinimumCommunicationsTransport, SendHints, commsLogger } from '../types'
import { Scene } from '@babylonjs/core'
import { limits } from '../../../misc/limits'

export type LivekitConfig = {
  url: string
  token: string
  scene: Scene
}

export type VoiceSpatialParams = {
  position: [number, number, number]
  orientation: [number, number, number]
}

const MAXIMUM_NETWORK_MSG_LENGTH = 30_000
// Upper bound on a LiveKit connect; the FFI layer itself has no timeout.
const CONNECT_TIMEOUT_MS = limits.livekitConnectTimeoutMs // HAMMURABI_LIVEKIT_CONNECT_TIMEOUT_MS
const UNATTRIBUTED_WARN_INTERVAL_MS = 10_000

export class LivekitAdapter implements MinimumCommunicationsTransport {
  public readonly events = mitt<CommsTransportEvents>()

  private disposed = false
  private unattributedDrops = 0
  private lastUnattributedWarn = 0
  private readonly room: Room

  constructor(private config: LivekitConfig) {
    this.room = new Room()

    this.room
      .on(RoomEvent.ParticipantConnected, (_) => {
        const address = _.identity
        commsLogger.log(`👤 Participant connected to livekit room`, { address, room: this.room.name })
        this.events.emit('PEER_CONNECTED', {
          address: address
        })
      })
      .on(RoomEvent.ParticipantDisconnected, (_) => {
        const address = _.identity
        commsLogger.log(`👋 Participant disconnected from livekit room`, { address, room: this.room.name })

        this.events.emit('PEER_DISCONNECTED', {
          address: address
        })
      })
      .on(RoomEvent.Disconnected, (reason) => {
        if (this.disposed) {
          return
        }

        const clientInitiated = reason === DisconnectReason.CLIENT_INITIATED

        // Only show the warning if it's not a manual disconnect during restart
        if (!clientInitiated) {
          console.error('\n' + '═'.repeat(60))
          console.error('⚠️  LIVEKIT DISCONNECTED - SERVER COMMUNICATION LOST')
          console.error('═'.repeat(60))
          console.error(`Reason: ${DisconnectReason[reason] || reason}`)
          console.error(`Room: ${this.room.name}`)
          console.error('═'.repeat(60))
          console.error('Press [R] to restart the server or [Ctrl+C] to exit')
          console.error('═'.repeat(60) + '\n')
        }

        const kicked = reason === DisconnectReason.DUPLICATE_IDENTITY
        this.doDisconnect(kicked, clientInitiated).catch((err) => {
          commsLogger.error(`error during disconnection ${err.toString()}`)
        })
      })
      .on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: any, _?: any) => {
        if (participant) {
          this.handleMessage(participant.identity, payload)
        } else {
          this.unattributedDrops++
          const now = Date.now()
          if (now - this.lastUnattributedWarn >= UNATTRIBUTED_WARN_INTERVAL_MS) {
            this.lastUnattributedWarn = now
            commsLogger.log(
              `⚠️ Dropped ${this.unattributedDrops} data packet(s) so far from peers not yet in the participant map (join race)`,
              { room: this.room.name, bytes: payload.byteLength }
            )
          }
        }
      })
  }

  async connect(): Promise<void> {
    // Bound the connect: the underlying FfiClient.waitFor has no timeout, so a
    // half-open SFU (socket accepted, connect callback never delivered) would hang
    // forever — the supervised process would then neither connect nor exit-to-restart.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.room.connect(this.config.url, this.config.token),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`LiveKit connect timed out after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS)
        })
      ])
    } catch (err) {
      // A failed/timed-out connect leaves our RoomEvent handlers attached (and a
      // library-internal FfiClient listener that Room.disconnect() won't remove
      // while !isConnected). Best-effort remove ours so a repeated dev reconnect
      // doesn't accumulate them; in production the process exits on connect failure,
      // reclaiming the residual. Mark disposed so this dead adapter no-ops.
      this.disposed = true
      try { this.room.removeAllListeners() } catch { /* best-effort */ }
      try { await this.room.disconnect() } catch { /* best-effort */ }
      throw err
    } finally {
      if (timer) clearTimeout(timer)
    }
    commsLogger.log(`Connected to livekit room ${this.room.name}`, {
      sid: await this.room.getSid(),
      metadata: this.room.metadata
    })
  }

  async send(data: Uint8Array, { reliable }: SendHints, destination?: string[]): Promise<void> {
    if (this.disposed) {
      commsLogger.error('disposed')
      return
    }

    if (data.length > MAXIMUM_NETWORK_MSG_LENGTH) {
      // don't decode the packet just to log it — report size and drop
      commsLogger.error(`Skipping big message over comms (${data.length} bytes)`)
      return
    }

    if (this.room.connectionState !== ConnectionState.CONN_CONNECTED) {
      commsLogger.error('Not connected to LiveKit', this.room.connectionState)
      return
    }

    try {
      await this.room.localParticipant?.publishData(data, { reliable, destination_identities: destination })
    } catch (err: any) {
      // A single publishData failure is usually transient (position/movement
      // publishes at up to 30Hz) — do NOT tear the whole server down over one
      // glitch (that turned a flaky SFU into a restart storm). Real connection loss
      // still surfaces via the connectionState guard above and the
      // RoomEvent.Disconnected handler, which drives the graceful restart.
      commsLogger.error(`publishData failed (message dropped): ${err?.message ?? err}`)
    }
  }

  async disconnect() {
    // Public disconnect is a clean, locally-initiated teardown (restart/shutdown).
    return this.doDisconnect(false, true)
  }

  async doDisconnect(kicked: boolean, clientInitiated = false) {
    if (this.disposed) {
      return
    }

    this.disposed = true
    await this.room.disconnect().catch(commsLogger.error)
    this.events.emit('DISCONNECTION', { kicked, clientInitiated })
  }

  setVoicePosition(address: string, position: proto.Position) {
    // No-op for headless server
  }

  getRoomInfo(): { roomName: string; isConnected: boolean } | undefined {
    if (!this.room.name) return undefined
    return {
      roomName: this.room.name,
      isConnected: this.room.connectionState === ConnectionState.CONN_CONNECTED
    }
  }

  handleMessage(address: string, data: Uint8Array) {
    this.events.emit('message', {
      address,
      data
    })
  }
}

export function getSpatialParamsFor(position: proto.Position): VoiceSpatialParams {
  return {
    position: [position.positionX, position.positionY, position.positionZ],
    orientation: [0, 0, 1] // Default forward orientation for headless
  }
}
