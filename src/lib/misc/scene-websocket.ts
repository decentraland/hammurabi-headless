import WS from 'ws'
import { assertPublicSceneUrl } from './ssrf'
import { limits } from './limits'
import { limitLogger } from './limit-logger'

// Per-frame message ceiling. Incoming frames larger than this are rejected by
// `ws` (maxPayload) which closes the socket; outgoing frames are checked here.
// Bounds host memory a scene can drive through a single socket. (HAMMURABI_MAX_WS_MESSAGE_BYTES)
const DEFAULT_MAX_MESSAGE_BYTES = limits.maxWsMessageBytes

// Ceiling on unflushed outbound bytes (ws bufferedAmount). Bounds host memory when
// a scene sends faster than a slow/stalled peer drains — the per-frame cap alone
// does not, since ws queues frames without a default limit. (HAMMURABI_MAX_WS_BUFFERED_BYTES)
const DEFAULT_MAX_BUFFERED_BYTES = limits.maxWsBufferedBytes

// Abort a stalled upgrade instead of hanging forever (ws has no default). Bounds a
// black-hole/slowloris host that accepts TCP but never completes the handshake. (HAMMURABI_WS_HANDSHAKE_TIMEOUT_MS)
const HANDSHAKE_TIMEOUT_MS = limits.wsHandshakeTimeoutMs

// WHATWG / `ws` ready states (identical numeric values).
export const WS_CONNECTING = 0
export const WS_OPEN = 1
export const WS_CLOSING = 2
export const WS_CLOSED = 3

/**
 * Host-side view of a scene WebSocket. Deliberately VM-agnostic: the isolated-vm
 * bridge (see isolated-vm/network-globals.ts) registers listeners and forwards
 * events into the scene's `on*` handlers. Data crosses as strings — scene comms is
 * overwhelmingly text/JSON, and this keeps the marshalling simple.
 */
export interface HostWebSocket {
  readonly url: string
  readonly readyState: number
  readonly bufferedAmount: number
  // 'blob' (default) delivers binary frames as UTF-8 strings (Blob is unsupported);
  // 'arraybuffer' delivers them as bytes. Text frames are always strings.
  binaryType: string
  on(event: 'open', listener: () => void): void
  on(event: 'message', listener: (data: string | Uint8Array) => void): void
  on(event: 'error', listener: (message: string) => void): void
  on(event: 'close', listener: (code: number, reason: string) => void): void
  send(data: unknown): void
  close(code?: number, reason?: string): void
}

export type HostWebSocketFactory = (url: string, protocols?: string | string[]) => HostWebSocket

export type SceneWebSocketDeps = {
  // Injectable so tests can connect to a localhost ws server (the real guard
  // blocks loopback). Defaults to the real guard; production never overrides it.
  assertPublicUrl?: (url: string) => Promise<void>
  maxMessageBytes?: number
  maxBufferedBytes?: number
  // Injectable ws implementation for tests. Defaults to the `ws` package.
  WebSocketImpl?: typeof WS
}

/** Fully-resolved deps handed to each connection (all defaults applied). */
type ResolvedSceneWebSocketDeps = {
  assertPublicUrl: (url: string) => Promise<void>
  maxMessageBytes: number
  maxBufferedBytes: number
  WebSocketImpl: typeof WS
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Normalize a ws frame (Buffer | ArrayBuffer | Buffer[]) to a UTF-8 string. */
export function rawDataToString(data: WS.RawData): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf-8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf-8')
  return Buffer.from(data as ArrayBuffer).toString('utf-8')
}

/** Normalize a ws frame to a Uint8Array (for binaryType 'arraybuffer' delivery). */
export function rawDataToBytes(data: WS.RawData): Uint8Array {
  if (typeof data === 'string') return new Uint8Array(Buffer.from(data, 'utf-8'))
  if (Buffer.isBuffer(data)) return new Uint8Array(data)
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  return new Uint8Array(data as ArrayBuffer)
}

/**
 * Reject close args that `ws` would choke on. `ws.close(badCode)` flips its state
 * to CLOSING and *then* throws, wedging the socket (no frame sent, un-re-closable),
 * so we must reject BEFORE calling it. Mirrors the browser rule: a close code must
 * be 1000 or in the application range 3000–4999, and the reason ≤ 123 UTF-8 bytes.
 */
function assertValidCloseArgs(code?: number, reason?: string): void {
  if (code !== undefined && !(Number.isInteger(code) && (code === 1000 || (code >= 3000 && code <= 4999)))) {
    throw new Error(`WebSocket: invalid close code ${code}`)
  }
  if (reason !== undefined && Buffer.byteLength(reason) > 123) {
    throw new Error('WebSocket: close reason exceeds the 123-byte limit')
  }
}

/** Rewrite ws://→http:// and wss://→https:// so the (http-only) SSRF guard runs. */
function toGuardableUrl(wsUrl: string): string {
  const url = new URL(wsUrl)
  if (url.protocol === 'ws:') url.protocol = 'http:'
  else if (url.protocol === 'wss:') url.protocol = 'https:'
  return url.toString()
}

type Listeners = {
  open: Array<() => void>
  message: Array<(data: string | Uint8Array) => void>
  error: Array<(message: string) => void>
  close: Array<(code: number, reason: string) => void>
}

class SceneWebSocketConnection implements HostWebSocket {
  readonly url: string
  binaryType = 'blob'
  private state: number = WS_CONNECTING
  private socket: WS | null = null
  private closeRequested: { code?: number; reason?: string } | null = null
  private readonly listeners: Listeners = { open: [], message: [], error: [], close: [] }
  private readonly maxMessageBytes: number
  private readonly maxBufferedBytes: number
  private readonly WebSocketImpl: typeof WS

  constructor(url: string, protocols: string | string[] | undefined, deps: ResolvedSceneWebSocketDeps) {
    this.url = url
    this.maxMessageBytes = deps.maxMessageBytes
    this.maxBufferedBytes = deps.maxBufferedBytes
    this.WebSocketImpl = deps.WebSocketImpl
    // Validate the protocol synchronously so an obviously-bad URL fails fast; the
    // SSRF/DNS check is async and runs before the connection is opened.
    let protocol: string
    try {
      protocol = new URL(url).protocol
    } catch {
      queueMicrotask(() => this.failConnect('WebSocket: invalid URL'))
      return
    }
    if (protocol !== 'ws:' && protocol !== 'wss:') {
      queueMicrotask(() => this.failConnect(`WebSocket: unsupported protocol "${protocol}"`))
      return
    }
    void this.connect(protocols, deps.assertPublicUrl)
  }

  get readyState(): number {
    return this.state
  }

  get bufferedAmount(): number {
    return this.socket?.bufferedAmount ?? 0
  }

  private emit(event: 'open'): void
  private emit(event: 'message', data: string | Uint8Array): void
  private emit(event: 'error', message: string): void
  private emit(event: 'close', code: number, reason: string): void
  private emit(event: keyof Listeners, ...args: any[]): void {
    for (const listener of this.listeners[event]) {
      try {
        ;(listener as (...a: any[]) => void)(...args)
      } catch {
        // A listener throwing (e.g. VM dispatch during teardown) must not stop the
        // others or bubble into the ws event loop.
      }
    }
  }

  private failConnect(message: string): void {
    if (this.state === WS_CLOSED) return
    this.state = WS_CLOSED
    this.emit('error', message)
    this.emit('close', 1006, message)
  }

  private async connect(protocols: string | string[] | undefined, assertPublicUrl: (url: string) => Promise<void>): Promise<void> {
    try {
      await assertPublicUrl(toGuardableUrl(this.url))
    } catch (err) {
      this.failConnect(errorMessage(err))
      return
    }
    // close() may have been called during the async guard.
    if (this.closeRequested && this.state === WS_CLOSED) return

    let socket: WS
    try {
      socket = new this.WebSocketImpl(this.url, protocols, {
        maxPayload: this.maxMessageBytes,
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS
      })
    } catch (err) {
      this.failConnect(errorMessage(err))
      return
    }
    this.socket = socket

    socket.on('open', () => {
      // A close() requested before the connection opened: honor it now.
      if (this.closeRequested) {
        this.state = WS_CLOSING
        socket.close(this.closeRequested.code, this.closeRequested.reason)
        return
      }
      this.state = WS_OPEN
      this.emit('open')
    })
    socket.on('message', (data: WS.RawData, isBinary: boolean) => {
      // Text frames are always strings; binary frames become bytes only when the
      // scene opted into binaryType 'arraybuffer' (else fall back to a UTF-8 string).
      if (isBinary && this.binaryType === 'arraybuffer') {
        this.emit('message', rawDataToBytes(data))
      } else {
        this.emit('message', rawDataToString(data))
      }
    })
    socket.on('error', (err: Error) => this.emit('error', errorMessage(err)))
    socket.on('close', (code: number, reason: Buffer) => {
      this.state = WS_CLOSED
      this.emit('close', typeof code === 'number' ? code : 1006, reason?.toString() ?? '')
    })
  }

  on(event: keyof Listeners, listener: (...args: any[]) => void): void {
    this.listeners[event].push(listener as any)
  }

  send(data: unknown): void {
    if (this.state !== WS_OPEN || !this.socket) {
      throw new Error('WebSocket: cannot send, socket is not open')
    }
    let payload: string | Uint8Array
    if (typeof data === 'string') payload = data
    else if (data instanceof Uint8Array) payload = data
    else payload = String(data)
    const byteLength = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength
    if (byteLength > this.maxMessageBytes) {
      limitLogger.hit('maxWsMessageBytes', `${byteLength} bytes`)
      throw new Error(`WebSocket: message exceeds ${this.maxMessageBytes} bytes`)
    }
    // Backpressure: refuse to keep queueing when the peer isn't draining, so a
    // slow/stalled peer can't make the ws outbound buffer grow without bound.
    if (this.socket.bufferedAmount + byteLength > this.maxBufferedBytes) {
      limitLogger.hit('maxWsBufferedBytes', `buffered ${this.socket.bufferedAmount} + ${byteLength}`)
      throw new Error('WebSocket: send buffer is full')
    }
    this.socket.send(payload)
  }

  close(code?: number, reason?: string): void {
    // Reject bad args before touching ws (see assertValidCloseArgs): keeps the
    // socket open and usable, matching the browser, instead of wedging it.
    assertValidCloseArgs(code, reason)
    // Record intent so a close during CONNECTING is honored once open (or skips
    // the connection entirely if the guard hasn't resolved yet).
    this.closeRequested = { code, reason }
    if (this.state === WS_CLOSED || this.state === WS_CLOSING) return
    if (this.socket) {
      // Covers OPEN and CONNECTING-with-socket: ws aborts an in-flight handshake
      // (abortHandshake) and emits 'close', so a stalled/black-hole connection is
      // torn down rather than leaking its FD and its slot in `live` until teardown.
      this.socket.close(code, reason)
      this.state = WS_CLOSING
    } else {
      // Still resolving the SSRF guard / not yet connected: connect() will see the
      // recorded close and skip opening. Emit `close` asynchronously so a handler
      // registered right after construction still fires — otherwise a scene that
      // opens-then-immediately-closes never gets an onclose event.
      this.state = WS_CLOSED
      queueMicrotask(() => this.emit('close', typeof code === 'number' ? code : 1000, reason ?? ''))
    }
  }
}

/**
 * Build the factory backing the scene's global `WebSocket` constructor. Each call
 * validates the URL against the SSRF guard (ws/wss mapped to http/https) before
 * opening, enforces a per-message size cap, and delivers messages as strings.
 */
export function createSceneWebSocketFactory(deps: SceneWebSocketDeps = {}): HostWebSocketFactory {
  const resolved: ResolvedSceneWebSocketDeps = {
    assertPublicUrl: deps.assertPublicUrl ?? assertPublicSceneUrl,
    maxMessageBytes: deps.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
    maxBufferedBytes: deps.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
    WebSocketImpl: deps.WebSocketImpl ?? WS
  }
  return (url: string, protocols?: string | string[]) => new SceneWebSocketConnection(url, protocols, resolved)
}
