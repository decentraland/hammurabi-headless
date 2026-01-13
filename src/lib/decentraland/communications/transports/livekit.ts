import * as proto from '@dcl/protocol/out-js/decentraland/kernel/comms/rfc4/comms.gen'
import { ConnectionState, DisconnectReason, Room, RoomEvent } from '@livekit/rtc-node'

import mitt from 'mitt'
import { CommsTransportEvents, MinimumCommunicationsTransport, SendHints, commsLogger } from '../types'
import { Scene } from '@babylonjs/core'

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

export class LivekitAdapter implements MinimumCommunicationsTransport {
  public readonly events = mitt<CommsTransportEvents>()

  private disposed = false
  private readonly room: Room

  constructor(private config: LivekitConfig) {
    this.room = new Room()

    this.room
      .on(RoomEvent.ParticipantConnected, (_) => {
        const address = _.identity
        this.events.emit('PEER_CONNECTED', {
          address: address
        })
      })
      .on(RoomEvent.ParticipantDisconnected, (_) => {
        const address = _.identity

        this.events.emit('PEER_DISCONNECTED', {
          address: address
        })
      })
      .on(RoomEvent.Disconnected, (reason) => {
        if (this.disposed) {
          return
        }

        // Only show the warning if it's not a manual disconnect during restart
        if (reason !== DisconnectReason.CLIENT_INITIATED) {
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
        this.doDisconnect(kicked).catch((err) => {
          commsLogger.error(`error during disconnection ${err.toString()}`)
        })
      })
      .on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: any, _?: any) => {
        if (participant) {
          this.handleMessage(participant.identity, payload)
        }
      })
  }

  async connect(): Promise<void> {
    await this.room.connect(this.config.url, this.config.token)
    commsLogger.log(`Connected to livekit room ${this.room.name?.split(':')[0]}`, {
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
      const message = proto.Packet.decode(data)
      commsLogger.error('Skipping big message over comms', message)
      return
    }

    if (this.room.connectionState !== ConnectionState.CONN_CONNECTED) {
      commsLogger.error('Not connected to LiveKit', this.room.connectionState)
      return
    }

    try {
      await this.room.localParticipant?.publishData(data, { reliable, destination_identities: destination })
    } catch (err: any) {
      // NOTE: for tracking purposes only, this is not a "code" error, this is a failed connection or a problem with the livekit instance
      await this.disconnect()
    }
  }

  async disconnect() {
    return this.doDisconnect(false)
  }

  async doDisconnect(kicked: boolean) {
    if (this.disposed) {
      return
    }

    this.disposed = true
    await this.room.disconnect().catch(commsLogger.error)
    this.events.emit('DISCONNECTION', { kicked })
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
