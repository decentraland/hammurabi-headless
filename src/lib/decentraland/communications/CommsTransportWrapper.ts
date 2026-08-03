import * as proto from '@dcl/protocol/out-js/decentraland/kernel/comms/rfc4/comms.gen'
import mitt from 'mitt'
import { CommsTransportEvents, MinimumCommunicationsTransport, TransportMessageEvent, commsLogger } from './types'
import { limits } from '../../misc/limits'
import { DEFAULT_LIMIT_LOG_INTERVAL_MS, limitLogger, sanitizeLogDetail } from '../../misc/limit-logger'

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
const MAX_INBOUND_PACKET_BYTES = limits.maxInboundPacketBytes // HAMMURABI_MAX_INBOUND_PACKET_BYTES
const INBOUND_RATE_WINDOW_MS = limits.inboundRateWindowMs // HAMMURABI_INBOUND_RATE_WINDOW_MS
const MAX_MESSAGES_PER_WINDOW = limits.maxMessagesPerWindow // HAMMURABI_MAX_MESSAGES_PER_WINDOW (allows ~30Hz movement + other traffic)
// Hard cap on the per-peer rate map. It is normally pruned on PEER_DISCONNECTED,
// but a `message` event can arrive AFTER a peer's disconnect (LiveKit does not
// strictly order DataReceived vs. ParticipantDisconnected), re-creating an entry
// that is then never pruned. Bound it independently so sustained churn can't grow
// the map without limit; entries are tiny and the oldest is evicted first.
const MAX_RATE_ENTRIES = limits.maxRateEntries // HAMMURABI_MAX_RATE_ENTRIES

// Throttle window for the unhandled-packet-variant report below. Reuses the
// limit-logger cadence so every throttled, operator-facing log in this process shares
// one rhythm. Like that constant it is deliberately NOT an env knob: it is a log-volume
// cadence, not a resource cap.
const UNHANDLED_VARIANT_LOG_INTERVAL_MS = DEFAULT_LIMIT_LOG_INTERVAL_MS
// Global ceiling on unhandled-variant lines emitted per interval, across ALL peers and
// variants. The per-(peer, variant) throttle alone does not bound log volume: peer
// address is remote-controlled, so a peer cycling identities would get a fresh throttle
// slot — and therefore an immediate line — for every new address. Since stderr is
// blocking, that is an event-loop stall vector, so total emissions are capped too.
// 6 unhandled variants across a handful of distinct peers fits comfortably under this.
const MAX_UNHANDLED_VARIANT_LOGS_PER_INTERVAL = 20

export class CommsTransportWrapper {
  readonly events = mitt<CommsEvents>()
  readonly sceneId: string
  public state: RoomConnectionStatus = RoomConnectionStatus.NONE

  // Per-peer fixed-window inbound rate counters (address -> window state).
  private readonly inboundRate = new Map<string, { windowStart: number; count: number }>()

  // Throttle state for unhandled rfc4 packet variants: address -> $case -> state.
  // Nested (rather than a composite `address|case` key) so a disconnect prunes a peer's
  // whole subtree in one O(1) delete, exactly like `inboundRate`. The outer map is
  // remote-keyed and so is bounded by MAX_RATE_ENTRIES with oldest-first eviction; the
  // inner map is keyed by decoder-produced `$case` values, so it is bounded by the rfc4
  // oneof itself (currently at most the 6 variants listed in `dispatchMessage`).
  private readonly unhandledVariants = new Map<string, Map<string, { lastLogAt: number; suppressed: number }>>()
  // Global fixed window backing MAX_UNHANDLED_VARIANT_LOGS_PER_INTERVAL.
  private unhandledVariantWindowStart = Number.NEGATIVE_INFINITY
  private unhandledVariantEmitted = 0
  private unhandledVariantOverBudget = 0

  constructor(private transport: MinimumCommunicationsTransport, sceneId: string) {
    this.sceneId = sceneId
    this.transport.events.on('message', this.handleMessage.bind(this))
    this.transport.events.on('DISCONNECTION', (event) => this.events.emit('DISCONNECTION', event))
    this.transport.events.on('PEER_CONNECTED', (event) => this.events.emit('PEER_CONNECTED', event))
    this.transport.events.on('PEER_DISCONNECTED', (event) => {
      this.inboundRate.delete(event.address)
      this.unhandledVariants.delete(event.address)
      this.events.emit('PEER_DISCONNECTED', event)
    })
  }

  // Fixed-window rate limit: returns true when the peer has exceeded its quota
  // for the current window and the message should be dropped.
  private isRateLimited(address: string): boolean {
    const now = Date.now()
    const entry = this.inboundRate.get(address)
    if (!entry || now - entry.windowStart >= INBOUND_RATE_WINDOW_MS) {
      // Evict the oldest entry (Map preserves insertion order) if a leaked/straggler
      // set has pushed the map past its cap, so it can't grow without bound.
      if (!entry && this.inboundRate.size >= MAX_RATE_ENTRIES) {
        const oldest = this.inboundRate.keys().next().value
        if (oldest !== undefined) this.inboundRate.delete(oldest)
        limitLogger.hit('maxRateEntries')
      }
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
      limitLogger.hit('maxMessagesPerWindow', address)
      return
    }
    // Bound untrusted inbound traffic before doing any decode work. Throttled: many
    // distinct peers each sending oversized packets would otherwise flood the log.
    if (data.length > MAX_INBOUND_PACKET_BYTES) {
      limitLogger.hit('maxInboundPacketBytes', `${address}: ${data.length} bytes`)
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

    // The decode above is guarded, but the dispatch is not: a downstream listener
    // throwing on a validly-decoded-but-hostile field (or an unexpected
    // participant shape) would otherwise become an uncaught exception driven by a
    // remote peer. Drop the packet and log (throttled) instead.
    try {
      this.dispatchMessage(address, message)
    } catch (error: any) {
      commsLogger.error(`Failed to dispatch packet from ${address}: ${error?.message ?? error}`)
    }
  }

  private dispatchMessage(address: string, message: NonNullable<proto.Packet['message']>) {
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
      // The rfc4 `Packet` oneof currently has 14 members; the 8 cases above are the ones
      // this server implements. The remaining 6 are NOT handled and land here:
      //
      //   playerEmote (9), sceneEmote (10), movementCompressed (12),
      //   lookAtPosition (13), reaction (14), chatReaction (15)
      //
      // They are still dropped — implementing them is out of scope — but the drop is no
      // longer silent, which it was: no log, no metric, no trace of any kind. That made
      // real protocol gaps invisible. The shipped Unity explorer sends `playerEmote`
      // (decentraland/sdk-multiplayer-server#117), and `movementCompressed` carries
      // avatar position, so a client flipping its `compressed` flag would make that
      // peer's avatar simply never exist for this authoritative server — with nothing in
      // the logs to say so. A NEW variant added to rfc4 upstream now surfaces here too
      // instead of vanishing.
      default: {
        this.reportUnhandledVariant(address, message.$case)
        break
      }
    }
  }

  /**
   * Report an unhandled rfc4 packet variant, THROTTLED per (peer address, variant) so a
   * flood of unrecognized packets cannot become an event-loop stall on blocking stderr.
   *
   * This deliberately does not go through `limitLogger`: its key space is `keyof Limits`
   * and an unimplemented protocol variant is not a resource cap (there is no numeric
   * ceiling and no `HAMMURABI_*` knob to add), so adding a `Limits` field for it would be
   * wrong. limit-logger also documents why its keys must stay bounded — a remote-
   * controlled key would grow its state map without limit. So this reuses the same
   * throttling *approach* (emit first hit, count and then report intervening ones) with
   * local state, keyed finely enough to tell peers apart while staying bounded: the
   * address map is capped and oldest-evicted like `inboundRate`, and a global
   * per-interval emission budget bounds total log volume however many addresses appear.
   */
  private reportUnhandledVariant(address: string, variant: string) {
    const now = Date.now()

    let byVariant = this.unhandledVariants.get(address)
    if (!byVariant) {
      // Evict the oldest peer (Map preserves insertion order) once the remote-keyed map
      // reaches its cap, so it can't grow without bound.
      if (this.unhandledVariants.size >= MAX_RATE_ENTRIES) {
        const oldest = this.unhandledVariants.keys().next().value
        if (oldest !== undefined) this.unhandledVariants.delete(oldest)
      }
      byVariant = new Map()
      this.unhandledVariants.set(address, byVariant)
    }

    let state = byVariant.get(variant)
    if (!state) {
      // NEGATIVE_INFINITY so the very first hit always clears the interval and emits.
      state = { lastLogAt: Number.NEGATIVE_INFINITY, suppressed: 0 }
      byVariant.set(variant, state)
    }
    if (now - state.lastLogAt < UNHANDLED_VARIANT_LOG_INTERVAL_MS) {
      state.suppressed++
      return
    }

    // Roll the global budget window before charging this emission against it.
    if (now - this.unhandledVariantWindowStart >= UNHANDLED_VARIANT_LOG_INTERVAL_MS) {
      this.unhandledVariantWindowStart = now
      this.unhandledVariantEmitted = 0
      state.suppressed += this.unhandledVariantOverBudget
      this.unhandledVariantOverBudget = 0
    }
    if (this.unhandledVariantEmitted >= MAX_UNHANDLED_VARIANT_LOGS_PER_INTERVAL) {
      // Over the global budget: count it, and leave `lastLogAt` untouched so this
      // (peer, variant) pair can still report as soon as the budget refreshes.
      this.unhandledVariantOverBudget++
      state.suppressed++
      return
    }
    this.unhandledVariantEmitted++

    const windowSec = state.lastLogAt === Number.NEGATIVE_INFINITY ? null : Math.round((now - state.lastLogAt) / 1000)
    const suffix = state.suppressed > 0 ? ` (${state.suppressed} more in ${windowSec ?? '?'}s)` : ''
    state.lastLogAt = now
    state.suppressed = 0

    // `variant` is a `$case` produced by the generated decoder, so it is one of a fixed
    // set of literals; `address` is remote-controlled and must be sanitized.
    commsLogger.error(
      `Dropped unhandled rfc4 packet variant "${variant}" from ${sanitizeLogDetail(address)}` +
        ` — this protocol feature is not implemented${suffix}`
    )
  }

  private async sendMessage(reliable: boolean, topicMessage: proto.Packet, destination: string[]) {
    const bytes = proto.Packet.encode(topicMessage as any).finish()
    this.transport.send(bytes, { reliable }, destination)
  }
}
