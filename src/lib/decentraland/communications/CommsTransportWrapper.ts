import * as proto from '@dcl/protocol/out-js/decentraland/kernel/comms/rfc4/comms.gen'
import mitt from 'mitt'
import { CommsTransportEvents, MinimumCommunicationsTransport, TransportMessageEvent, commsLogger } from './types'

export enum RoomConnectionStatus {
  NONE,
  CONNECTING,
  CONNECTED,
  DISCONNECTED
}

export type TransportPacket<T> = {
  // sender address
  address: string
  // [TODO] add local time in which the message was sent
  //   senderLocalTime: number
  data: T
}

export type CommsEvents = Pick<CommsTransportEvents, 'DISCONNECTION' | 'PEER_CONNECTED' | 'PEER_DISCONNECTED'> & {
  // ADR-104 messages
  sceneMessageBus: TransportPacket<proto.Scene>
  chatMessage: TransportPacket<proto.Chat>
  profileMessage: TransportPacket<proto.AnnounceProfileVersion>
  position: TransportPacket<proto.Position>
  movement: TransportPacket<proto.Movement>
  voiceMessage: TransportPacket<proto.Voice>
  profileResponse: TransportPacket<proto.ProfileResponse>
  profileRequest: TransportPacket<proto.ProfileRequest>
}

/**
 * This class implements ADR-104 on top of a MinimumCommunicationsTransport. The idea behind it is
 * to serve as a reference implementation for comss. MinimumCommunicationsTransport can be an IRC
 * server, an echo server, a mocked implementation or WebSocket among many others.
 */
// Inbound packets come from untrusted remote peers and are decoded in host code.
// Drop anything larger than this before decoding, and rate-limit per peer so a
// single peer can't flood the CRDT/profile pipeline.
const MAX_INBOUND_PACKET_BYTES = 128 * 1024
const INBOUND_RATE_WINDOW_MS = 1000
const MAX_MESSAGES_PER_WINDOW = 300 // generous: allows ~30Hz movement + other traffic

export class CommsTransportWrapper {
  readonly events = mitt<CommsEvents>()
  readonly sceneId: string
  public state: RoomConnectionStatus = RoomConnectionStatus.NONE

  // Per-peer fixed-window inbound rate counters (address -> window state).
  private readonly inboundRate = new Map<string, { windowStart: number; count: number }>()

  constructor(private transport: MinimumCommunicationsTransport, sceneId: string) {
    this.sceneId = sceneId
    this.transport.events.on('message', this.handleMessage.bind(this))
    this.transport.events.on('DISCONNECTION', (event) => this.events.emit('DISCONNECTION', event))
    this.transport.events.on('PEER_CONNECTED', (event) => this.events.emit('PEER_CONNECTED', event))
    this.transport.events.on('PEER_DISCONNECTED', (event) => {
      this.inboundRate.delete(event.address)
      this.events.emit('PEER_DISCONNECTED', event)
    })
  }

  // Fixed-window rate limit: returns true when the peer has exceeded its quota
  // for the current window and the message should be dropped.
  private isRateLimited(address: string): boolean {
    const now = Date.now()
    const entry = this.inboundRate.get(address)
    if (!entry || now - entry.windowStart >= INBOUND_RATE_WINDOW_MS) {
      this.inboundRate.set(address, { windowStart: now, count: 1 })
      return false
    }
    entry.count++
    return entry.count > MAX_MESSAGES_PER_WINDOW
  }

  async connect(): Promise<void> {
    if (this.state !== RoomConnectionStatus.NONE) return
    try {
      this.state = RoomConnectionStatus.CONNECTING
      await this.transport.connect()
      this.state = RoomConnectionStatus.CONNECTED
    } catch (e: any) {
      this.state = RoomConnectionStatus.DISCONNECTED
      this.events.emit('DISCONNECTION', { error: e, kicked: false, clientInitiated: false })
      console.error(e)
    }
  }

  sendPositionMessage(position: proto.Position): Promise<void> {
    return this.sendMessage(
      false,
      {
        message: {
          $case: 'position',
          position
        },
        protocolVersion: 0
      },
      []
    )
  }
  sendParcelSceneMessage(scene: proto.Scene, destination: string[]): Promise<void> {
    return this.sendMessage(
      true,
      {
        message: { $case: 'scene', scene },
        protocolVersion: 100
      },
      destination
    )
  }
  sendProfileMessage(profileVersion: proto.AnnounceProfileVersion): Promise<void> {
    return this.sendMessage(
      false,
      {
        message: { $case: 'profileVersion', profileVersion },
        protocolVersion: 0
      },
      []
    )
  }
  sendProfileRequest(profileRequest: proto.ProfileRequest): Promise<void> {
    return this.sendMessage(
      false,
      {
        message: { $case: 'profileRequest', profileRequest },
        protocolVersion: 0
      },
      []
    )
  }
  sendProfileResponse(profileResponse: proto.ProfileResponse): Promise<void> {
    return this.sendMessage(
      false,
      {
        message: { $case: 'profileResponse', profileResponse },
        protocolVersion: 0
      },
      []
    )
  }
  sendChatMessage(chat: proto.Chat): Promise<void> {
    return this.sendMessage(
      true,
      {
        message: { $case: 'chat', chat },
        protocolVersion: 0
      },
      []
    )
  }
  sendVoiceMessage(voice: proto.Voice): Promise<void> {
    return this.sendMessage(
      false,
      {
        message: { $case: 'voice', voice },
        protocolVersion: 0
      },
      []
    )
  }

  async disconnect() {
    await this.transport.disconnect()
  }

  getRoomInfo(): { roomName: string; isConnected: boolean } | undefined {
    return this.transport.getRoomInfo?.()
  }

  private handleMessage({ data, address }: TransportMessageEvent) {
    // Rate-limit FIRST so an oversized-packet flood also consumes the peer's
    // budget (and can't spam the error log below unbounded).
    if (this.isRateLimited(address)) {
      return
    }
    // Bound untrusted inbound traffic before doing any decode work.
    if (data.length > MAX_INBOUND_PACKET_BYTES) {
      commsLogger.error(`Dropping oversized packet from ${address}: ${data.length} bytes`)
      return
    }

    let message: proto.Packet['message']
    try {
      message = proto.Packet.decode(data).message
    } catch (error: any) {
      commsLogger.error(`Failed to decode packet from ${address}: ${error.message}`)
      return
    }

    if (!message) {
      return
    }

    switch (message.$case) {
      case 'position': {
        this.transport.setVoicePosition(address, message.position)
        this.events.emit('position', { address, data: message.position })
        break
      }
      case 'scene': {
        this.events.emit('sceneMessageBus', { address, data: message.scene })
        break
      }
      case 'chat': {
        this.events.emit('chatMessage', { address, data: message.chat })
        break
      }
      case 'voice': {
        this.events.emit('voiceMessage', { address, data: message.voice })
        break
      }
      case 'profileRequest': {
        this.events.emit('profileRequest', {
          address,
          data: message.profileRequest
        })
        break
      }
      case 'profileResponse': {
        this.events.emit('profileResponse', {
          address,
          data: message.profileResponse
        })
        break
      }
      case 'profileVersion': {
        this.events.emit('profileMessage', {
          address,
          data: message.profileVersion
        })
        break
      }
      case 'movement': {
        this.events.emit('movement', { address, data: message.movement })
        break
      }
    }
  }

  private async sendMessage(reliable: boolean, topicMessage: proto.Packet, destination: string[]) {
    if (Object.keys(topicMessage).length === 0) {
      throw new Error('Invalid empty message')
    }
    const bytes = proto.Packet.encode(topicMessage as any).finish()
    if (!this.transport) debugger
    this.transport.send(bytes, { reliable }, destination)
  }
}
