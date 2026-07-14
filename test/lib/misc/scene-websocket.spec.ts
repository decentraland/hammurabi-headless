import { AddressInfo } from 'net'
import WS, { WebSocketServer } from 'ws'
import { createSceneWebSocketFactory, rawDataToString, WS_OPEN } from '../../../src/lib/misc/scene-websocket'
import type { HostWebSocketFactory } from '../../../src/lib/misc/scene-websocket'

// A ws stand-in whose handshake never completes (never emits 'open'), used to
// exercise close() while the connection is still CONNECTING. close() emits 'close'
// to mirror ws's abortHandshake.
class StallingWebSocket {
  readyState = 0
  bufferedAmount = 0
  private readonly handlers: Record<string, Array<(...args: any[]) => void>> = {}
  constructor(_url: string, _protocols?: unknown, _options?: unknown) {}
  on(event: string, listener: (...args: any[]) => void): this {
    ;(this.handlers[event] = this.handlers[event] || []).push(listener)
    return this
  }
  send(): void {}
  close(code?: number, reason?: string): void {
    this.readyState = 2
    for (const listener of this.handlers.close || []) {
      listener(typeof code === 'number' ? code : 1006, Buffer.from(reason || ''))
    }
  }
}

// Host-side view of the scene global `WebSocket`. The real SSRF guard blocks
// loopback, so the connect path injects a permissive guard; the block path uses
// the real one.
describe('when a scene opens a WebSocket', () => {
  let wss: WebSocketServer
  let url: string
  let factory: HostWebSocketFactory

  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
    const { port } = wss.address() as AddressInfo
    url = `ws://127.0.0.1:${port}`
    factory = createSceneWebSocketFactory({ assertPublicUrl: async () => undefined })
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  })

  describe('and the server echoes messages', () => {
    beforeEach(() => {
      wss.on('connection', (socket) => {
        socket.on('message', (message) => socket.send(message.toString()))
      })
    })

    it('should connect, exchange a message, and close', async () => {
      const received: string[] = []
      const socket = factory(url)

      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => socket.send('ping'))
        socket.on('message', (data) => {
          received.push(data)
          socket.close()
        })
        socket.on('close', () => resolve())
        socket.on('error', (message) => reject(new Error(message)))
      })

      expect(received).toEqual(['ping'])
    })
  })

  describe('and the target host is not public', () => {
    beforeEach(() => {
      factory = createSceneWebSocketFactory()
    })

    it('should emit error then close without connecting', async () => {
      const events: string[] = []
      const socket = factory('ws://127.0.0.1:1')

      await new Promise<void>((resolve) => {
        socket.on('error', () => events.push('error'))
        socket.on('close', () => {
          events.push('close')
          resolve()
        })
      })

      expect(events).toEqual(['error', 'close'])
    })
  })

  describe('and the scene sends before the socket is open', () => {
    it('should throw', () => {
      const socket = factory(url)

      expect(() => socket.send('too early')).toThrow(/not open/)
    })
  })

  describe('and the scene closes before the socket finishes connecting', () => {
    it('should fire close and never open', async () => {
      const events: string[] = []
      const socket = factory(url)
      socket.on('open', () => events.push('open'))
      socket.on('close', () => events.push('close'))

      socket.close()
      await new Promise<void>((resolve) => socket.on('close', () => resolve()))

      expect(events).toEqual(['close'])
    })
  })

  describe('and the url uses an unsupported protocol', () => {
    it('should emit error then close without connecting', async () => {
      const events: string[] = []
      const socket = factory('http://example.org/')

      await new Promise<void>((resolve) => {
        socket.on('error', () => events.push('error'))
        socket.on('close', () => {
          events.push('close')
          resolve()
        })
      })

      expect(events).toEqual(['error', 'close'])
    })
  })

  describe('and the scene sends a message over the size cap', () => {
    beforeEach(() => {
      wss.on('connection', () => undefined)
      factory = createSceneWebSocketFactory({ assertPublicUrl: async () => undefined, maxMessageBytes: 8 })
    })

    it('should throw', async () => {
      const socket = factory(url)
      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => resolve())
        socket.on('error', (message) => reject(new Error(message)))
      })

      expect(() => socket.send('this is definitely longer than eight bytes')).toThrow(/exceeds/)

      socket.close()
    })
  })

  describe('and the scene closes with an invalid code', () => {
    beforeEach(() => {
      wss.on('connection', () => undefined)
    })

    it('should throw but leave the socket open and still closable', async () => {
      const socket = factory(url)
      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => resolve())
        socket.on('error', (message) => reject(new Error(message)))
      })

      // ws rejects codes outside the valid range; the socket must not get stuck.
      expect(() => socket.close(42)).toThrow()
      expect(socket.readyState).toBe(WS_OPEN)

      // A subsequent valid close still works.
      await new Promise<void>((resolve) => {
        socket.on('close', () => resolve())
        socket.close()
      })
    })
  })

  describe('and the server sends a binary frame', () => {
    beforeEach(() => {
      wss.on('connection', (socket) => socket.send(Buffer.from('héllo', 'utf8')))
    })

    it('should deliver it decoded as a UTF-8 string', async () => {
      const received: string[] = []
      const socket = factory(url)

      await new Promise<void>((resolve, reject) => {
        socket.on('message', (data) => {
          received.push(data)
          socket.close()
        })
        socket.on('close', () => resolve())
        socket.on('error', (message) => reject(new Error(message)))
      })

      expect(received).toEqual(['héllo'])
    })
  })

  describe('and the server sends a message over the cap', () => {
    beforeEach(() => {
      factory = createSceneWebSocketFactory({ assertPublicUrl: async () => undefined, maxMessageBytes: 8 })
      wss.on('connection', (socket) => socket.send('x'.repeat(100)))
    })

    it('should reject the oversized frame instead of delivering it', async () => {
      const received: string[] = []
      const socket = factory(url)

      await new Promise<void>((resolve) => {
        socket.on('message', (data) => received.push(data))
        socket.on('error', () => undefined)
        socket.on('close', () => resolve())
      })

      expect(received).toEqual([])
    })
  })

  describe('and the scene sends past the outbound buffer cap', () => {
    beforeEach(() => {
      wss.on('connection', () => undefined)
      factory = createSceneWebSocketFactory({ assertPublicUrl: async () => undefined, maxBufferedBytes: 4 })
    })

    it('should refuse the send', async () => {
      const socket = factory(url)
      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => resolve())
        socket.on('error', (message) => reject(new Error(message)))
      })

      expect(() => socket.send('more than four bytes')).toThrow(/send buffer is full/)

      socket.close()
    })
  })

  describe('and the scene closes with an over-long reason', () => {
    beforeEach(() => {
      wss.on('connection', () => undefined)
    })

    it('should throw but leave the socket open and still closable', async () => {
      const socket = factory(url)
      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => resolve())
        socket.on('error', (message) => reject(new Error(message)))
      })

      expect(() => socket.close(1000, 'x'.repeat(200))).toThrow(/123-byte/)
      expect(socket.readyState).toBe(WS_OPEN)

      await new Promise<void>((resolve) => {
        socket.on('close', () => resolve())
        socket.close()
      })
    })
  })

  describe('and the scene closes while the handshake is still pending', () => {
    let stallingFactory: HostWebSocketFactory

    beforeEach(() => {
      // A ws stand-in that never fires 'open' (stalled upgrade). close() emits
      // 'close', mirroring ws's abortHandshake so the connection is torn down.
      stallingFactory = createSceneWebSocketFactory({
        assertPublicUrl: async () => undefined,
        WebSocketImpl: StallingWebSocket as unknown as typeof WS
      })
    })

    it('should abort the pending connection and fire close rather than leak it', async () => {
      const events: string[] = []
      const socket = stallingFactory('ws://stalled.example/')
      socket.on('open', () => events.push('open'))
      socket.on('close', () => events.push('close'))

      // Let the guard resolve so the (stalled) socket is created; state is CONNECTING.
      await new Promise((resolve) => setTimeout(resolve, 10))
      socket.close()
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(events).toEqual(['close'])
    })
  })
})

describe('when normalizing an incoming ws frame', () => {
  describe('and the frame is a Buffer', () => {
    let frame: Buffer

    beforeEach(() => {
      frame = Buffer.from('héllo', 'utf8')
    })

    it('should decode it as UTF-8', () => {
      expect(rawDataToString(frame)).toBe('héllo')
    })
  })

  describe('and the frame is a Buffer array', () => {
    let frame: Buffer[]

    beforeEach(() => {
      frame = [Buffer.from('a'), Buffer.from('bc')]
    })

    it('should concatenate then decode', () => {
      expect(rawDataToString(frame)).toBe('abc')
    })
  })

  describe('and the frame is an ArrayBuffer', () => {
    let frame: ArrayBuffer

    beforeEach(() => {
      frame = new TextEncoder().encode('xy').buffer
    })

    it('should decode it as UTF-8', () => {
      expect(rawDataToString(frame)).toBe('xy')
    })
  })
})
