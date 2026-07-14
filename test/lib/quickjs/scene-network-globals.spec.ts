import http from 'http'
import { AddressInfo } from 'net'
import { WebSocketServer } from 'ws'
import { withQuickJsVm } from '../../../src/lib/quick-js/index'
import { createSceneFetch } from '../../../src/lib/misc/scene-fetch'
import { createSceneWebSocketFactory } from '../../../src/lib/misc/scene-websocket'
import type { HostWebSocketFactory } from '../../../src/lib/misc/scene-websocket'
import type { SceneResponse } from '../../../src/lib/misc/scene-fetch'

// End-to-end coverage of the ADR-133 network globals THROUGH the VM boundary:
// the host `fetch`/`WebSocket` are installed as VM globals and driven from scene
// code, exercising the promise + object marshalling and the event bridge.

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('when a scene uses the global fetch', () => {
  let logs: any[]
  let stubFetch: (url: string) => Promise<SceneResponse>

  beforeEach(() => {
    logs = []
    stubFetch = async (url: string) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      url,
      redirected: false,
      headers: {
        get: () => 'application/json',
        has: () => true,
        entries: () => [['content-type', 'application/json']] as [string, string][],
        keys: () => ['content-type'],
        values: () => ['application/json']
      },
      async json() {
        return { hello: 'world' }
      },
      async text() {
        return '{"hello":"world"}'
      },
      async bytes() {
        return new Uint8Array([1, 2, 3])
      }
    })
  })

  it('should resolve a Response and await its json() body', async () => {
    await withQuickJsVm(async (opts) => {
      opts.provide({
        log: (...args) => logs.push(...args),
        error: (...args) => logs.push('ERR', ...args),
        require: () => {
          throw new Error('not implemented')
        },
        fetch: stubFetch
      })

      opts.eval(`
        module.exports.onStart = async function () {
          const res = await fetch('https://example.org/data', { method: 'GET' })
          const body = await res.json()
          console.log('status', res.status, 'hello', body.hello)
        }
      `)

      await opts.onStart()
    })

    expect(logs).toEqual(['status', 200, 'hello', 'world'])
  })
})

describe('when a scene uses the global WebSocket', () => {
  let wss: WebSocketServer
  let url: string

  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
    wss.on('connection', (socket) => {
      socket.on('message', (message) => socket.send(message.toString()))
    })
    const { port } = wss.address() as AddressInfo
    url = `ws://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  })

  it('should open, echo a message into onmessage, and fire onclose', async () => {
    const logs: any[] = []
    const webSocket = createSceneWebSocketFactory({ assertPublicUrl: async () => undefined })

    await withQuickJsVm(async (opts) => {
      opts.provide({
        log: (...args) => logs.push(...args),
        error: (...args) => logs.push('ERR', ...args),
        require: () => {
          throw new Error('not implemented')
        },
        webSocket
      })

      opts.eval(`
        const ws = new WebSocket(${JSON.stringify(url)})
        ws.onopen = () => ws.send('ping')
        ws.onmessage = (e) => { console.log('msg', e.data); ws.close() }
        ws.onclose = () => console.log('closed')
        ws.onerror = (e) => console.log('err', e.message)
      `)

      // Socket events dispatch into the VM on the event loop; wait for the round trip.
      await waitFor(() => logs.includes('closed'))
    })

    expect(logs).toEqual(['msg', 'ping', 'closed'])
  })

  it('should expose readyState transitions and the ready-state constants', async () => {
    const logs: any[] = []
    const webSocket = createSceneWebSocketFactory({ assertPublicUrl: async () => undefined })

    await withQuickJsVm(async (opts) => {
      opts.provide({
        log: (...args) => logs.push(...args),
        error: (...args) => logs.push('ERR', ...args),
        require: () => {
          throw new Error('not implemented')
        },
        webSocket
      })

      opts.eval(`
        const ws = new WebSocket(${JSON.stringify(url)})
        ws.onopen = () => { console.log('open', ws.readyState === WebSocket.OPEN); ws.close() }
        ws.onclose = () => console.log('closed', ws.readyState === WebSocket.CLOSED)
      `)

      await waitFor(() => logs.includes('closed'))
    })

    expect(logs).toEqual(['open', true, 'closed', true])
  })

  it('should expose instanceof, instance ready-state constants, and the CLOSING transition', async () => {
    const logs: any[] = []
    const webSocket = createSceneWebSocketFactory({ assertPublicUrl: async () => undefined })

    await withQuickJsVm(async (opts) => {
      opts.provide({
        log: (...args) => logs.push(...args),
        error: (...args) => logs.push('ERR', ...args),
        require: () => {
          throw new Error('not implemented')
        },
        webSocket
      })

      opts.eval(`
        const ws = new WebSocket(${JSON.stringify(url)})
        ws.onopen = () => {
          console.log('instanceof', ws instanceof WebSocket)
          console.log('instConst', ws.OPEN === 1, ws.CLOSED === 3)
          ws.close()
          console.log('closing', ws.readyState === WebSocket.CLOSING)
        }
        ws.onclose = () => console.log('closed')
      `)

      await waitFor(() => logs.includes('closed'))
    })

    expect(logs).toEqual(['instanceof', true, 'instConst', true, true, 'closing', true, 'closed'])
  })

  it('should deliver events to addEventListener listeners (with event.type)', async () => {
    const logs: any[] = []
    const webSocket = createSceneWebSocketFactory({ assertPublicUrl: async () => undefined })

    await withQuickJsVm(async (opts) => {
      opts.provide({
        log: (...args) => logs.push(...args),
        error: (...args) => logs.push('ERR', ...args),
        require: () => {
          throw new Error('not implemented')
        },
        webSocket
      })

      opts.eval(`
        const ws = new WebSocket(${JSON.stringify(url)})
        ws.addEventListener('open', () => ws.send('ping'))
        ws.addEventListener('message', (e) => { console.log('msg', e.data, e.type); ws.close() })
        ws.addEventListener('close', () => console.log('closed'))
      `)

      await waitFor(() => logs.includes('closed'))
    })

    expect(logs).toEqual(['msg', 'ping', 'message', 'closed'])
  })

  it('should not invoke a listener removed mid-dispatch by an earlier listener', async () => {
    const logs: any[] = []
    const webSocket = createSceneWebSocketFactory({ assertPublicUrl: async () => undefined })

    await withQuickJsVm(async (opts) => {
      opts.provide({
        log: (...args) => logs.push(...args),
        error: (...args) => logs.push('ERR', ...args),
        require: () => {
          throw new Error('not implemented')
        },
        webSocket
      })

      opts.eval(`
        const ws = new WebSocket(${JSON.stringify(url)})
        function second() { console.log('second') }
        function first() { console.log('first'); ws.removeEventListener('message', second) }
        ws.addEventListener('open', () => ws.send('ping'))
        ws.addEventListener('message', first)
        ws.addEventListener('message', second)
        ws.addEventListener('message', () => ws.close())
        ws.addEventListener('close', () => console.log('closed'))
      `)

      await waitFor(() => logs.includes('closed'))
    })

    // 'second' was removed by 'first' during the same event, so it must not fire.
    expect(logs).toEqual(['first', 'closed'])
  })
})

describe('when a scene echoes a binary WebSocket frame', () => {
  let wss: WebSocketServer
  let url: string
  let echoedBack: number[] | string | undefined

  beforeEach(async () => {
    echoedBack = undefined
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
    wss.on('connection', (socket) => {
      socket.send(Buffer.from([9, 8, 7]), { binary: true })
      socket.on('message', (data, isBinary) => {
        echoedBack = isBinary && Buffer.isBuffer(data) ? Array.from(data) : `text:${data.toString()}`
      })
    })
    const { port } = wss.address() as AddressInfo
    url = `ws://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  })

  it('should deliver an ArrayBuffer and send it back as a binary frame', async () => {
    const logs: any[] = []
    const webSocket = createSceneWebSocketFactory({ assertPublicUrl: async () => undefined })

    await withQuickJsVm(async (opts) => {
      opts.provide({
        log: (...args) => logs.push(...args),
        error: (...args) => logs.push('ERR', ...args),
        require: () => {
          throw new Error('not implemented')
        },
        webSocket
      })

      opts.eval(`
        const ws = new WebSocket(${JSON.stringify(url)})
        ws.binaryType = 'arraybuffer'
        ws.onmessage = (e) => { console.log('isAB', e.data instanceof ArrayBuffer); ws.send(e.data); ws.close() }
        ws.onclose = () => console.log('closed')
      `)

      await waitFor(() => logs.includes('closed'))
    })

    // The server must have received the echo back as a genuine binary frame.
    await waitFor(() => echoedBack !== undefined)
    expect(logs).toEqual(['isAB', true, 'closed'])
    expect(echoedBack).toEqual([9, 8, 7])
  })
})

describe('when a scene uses fetch against a real server', () => {
  let server: http.Server
  let baseUrl: string
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
  let fetchImpl: ReturnType<typeof createSceneFetch>

  beforeEach(async () => {
    handler = (_req, res) => {
      res.writeHead(200)
      res.end('ok')
    }
    server = http.createServer((req, res) => handler(req, res))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${port}`
    // Real host fetch with a permissive guard (loopback would be blocked otherwise).
    fetchImpl = createSceneFetch({ assertPublicUrl: async () => undefined })
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('should expose the body as an ArrayBuffer via response.arrayBuffer()', async () => {
    const logs: any[] = []
    handler = (_req, res) => {
      res.writeHead(200)
      res.end(Buffer.from([10, 20, 30]))
    }

    await withQuickJsVm(async (opts) => {
      opts.provide({
        log: (...args) => logs.push(...args),
        error: (...args) => logs.push('ERR', ...args),
        require: () => {
          throw new Error('not implemented')
        },
        fetch: fetchImpl
      })

      opts.eval(`
        module.exports.onStart = async function () {
          const res = await fetch(${JSON.stringify(`${baseUrl}/bin`)})
          const buf = await res.arrayBuffer()
          console.log('isAB', buf instanceof ArrayBuffer, 'bytes', Array.from(new Uint8Array(buf)).join(','))
        }
      `)

      await opts.onStart()
    })

    expect(logs).toEqual(['isAB', true, 'bytes', '10,20,30'])
  })

  it('should reject with an AbortError when the signal is already aborted', async () => {
    const logs: any[] = []

    await withQuickJsVm(async (opts) => {
      opts.provide({
        log: (...args) => logs.push(...args),
        error: (...args) => logs.push('ERR', ...args),
        require: () => {
          throw new Error('not implemented')
        },
        fetch: fetchImpl
      })

      opts.eval(`
        module.exports.onStart = async function () {
          const controller = new AbortController()
          controller.abort()
          try {
            await fetch(${JSON.stringify(`${baseUrl}/x`)}, { signal: controller.signal })
            console.log('resolved')
          } catch (e) {
            console.log('rejected', e && e.name)
          }
        }
      `)

      await opts.onStart()
    })

    expect(logs).toEqual(['rejected', 'AbortError'])
  })

  it('should abort an in-flight request when the signal fires', async () => {
    const logs: any[] = []
    // A server that accepts the request but never responds, so abort is the only exit.
    handler = () => undefined

    await withQuickJsVm(async (opts) => {
      opts.provide({
        log: (...args) => logs.push(...args),
        error: (...args) => logs.push('ERR', ...args),
        require: () => {
          throw new Error('not implemented')
        },
        fetch: fetchImpl
      })

      opts.eval(`
        module.exports.onStart = async function () {
          const controller = new AbortController()
          const promise = fetch(${JSON.stringify(`${baseUrl}/hang`)}, { signal: controller.signal })
          controller.abort()
          try {
            await promise
            console.log('resolved')
          } catch (e) {
            console.log('rejected', e && e.name)
          }
        }
      `)

      await opts.onStart()
    })

    expect(logs).toEqual(['rejected', 'AbortError'])
  })
})

describe('when a scene opens more WebSockets than allowed', () => {
  let logs: any[]
  let stubFactory: HostWebSocketFactory

  beforeEach(() => {
    logs = []
    // Sockets that never open or close, so every one stays counted as live.
    stubFactory = (() => ({
      url: '',
      readyState: 0,
      on: () => undefined,
      send: () => undefined,
      close: () => undefined
    })) as unknown as HostWebSocketFactory
  })

  it('should throw once the concurrent-socket cap is reached', async () => {
    await withQuickJsVm(async (opts) => {
      opts.provide({
        log: (...args) => logs.push(...args),
        error: (...args) => logs.push('ERR', ...args),
        require: () => {
          throw new Error('not implemented')
        },
        webSocket: stubFactory
      })

      opts.eval(`
        module.exports.onStart = function () {
          let opened = 0
          let message = ''
          try {
            for (let i = 0; i < 40; i++) { new WebSocket('ws://host/' + i); opened++ }
          } catch (e) {
            message = String(e && e.message ? e.message : e)
          }
          console.log(opened, message)
        }
      `)

      await opts.onStart()
    })

    expect(logs[0]).toBe(32)
    expect(String(logs[1])).toMatch(/too many/)
  })
})

describe('when a scene leaves a WebSocket open at teardown', () => {
  let wss: WebSocketServer
  let url: string
  let serverSawClose: Promise<void>
  let logs: any[]
  let webSocket: HostWebSocketFactory
  let errorSpy: jest.SpyInstance

  beforeEach(async () => {
    logs = []
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
    serverSawClose = new Promise<void>((resolve) => {
      wss.on('connection', (socket) => socket.on('close', () => resolve()))
    })
    const { port } = wss.address() as AddressInfo
    url = `ws://127.0.0.1:${port}`
    webSocket = createSceneWebSocketFactory({ assertPublicUrl: async () => undefined })
  })

  afterEach(async () => {
    errorSpy.mockRestore()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  })

  it('should close the socket at teardown and free its handles without a leak', async () => {
    await withQuickJsVm(async (opts) => {
      opts.provide({
        log: (...args) => logs.push(...args),
        error: () => undefined,
        require: () => {
          throw new Error('not implemented')
        },
        webSocket
      })

      opts.eval(`
        const ws = new WebSocket(${JSON.stringify(url)})
        ws.onopen = () => console.log('opened')
      `)

      // Wait until the socket is actually open, then leave the VM WITHOUT closing it.
      await waitFor(() => logs.includes('opened'))
    })

    // Teardown must have closed the socket (server observes it) ...
    await serverSawClose
    // ... and disposed the retained instance handle (a leak logs a JS_FreeRuntime abort).
    const leaked = errorSpy.mock.calls.some((call) => /leaked handles/i.test(String(call[0] ?? '')))
    expect(leaked).toBe(false)
  })
})

// Hot reload disposes the old VM (SceneContext.dispose → transport close → update
// loop ends → withQuickJsVm finally → closeAll) and spawns a fresh one. Two
// sequential VM lifecycles reproduce that: if cycle 1's teardown leaked a handle it
// would abort JS_FreeRuntime and poison the process-cached WASM module, so cycle 2
// (a fresh VM) would fail. Cycle 2 working proves reload safety.
describe('when the scene runtime is torn down and restarted (hot reload)', () => {
  let wss: WebSocketServer
  let url: string
  let webSocket: HostWebSocketFactory
  let errorSpy: jest.SpyInstance

  beforeEach(async () => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
    wss.on('connection', (socket) => {
      socket.on('message', (message) => socket.send(message.toString()))
    })
    const { port } = wss.address() as AddressInfo
    url = `ws://127.0.0.1:${port}`
    webSocket = createSceneWebSocketFactory({ assertPublicUrl: async () => undefined })
  })

  afterEach(async () => {
    errorSpy.mockRestore()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  })

  it('should run a fresh VM cleanly after a prior one left a socket open at teardown', async () => {
    const provide = (opts: any, logs: any[]) =>
      opts.provide({
        log: (...args: any[]) => logs.push(...args),
        error: () => undefined,
        require: () => {
          throw new Error('not implemented')
        },
        webSocket
      })

    // Cycle 1: open a socket and tear down WITHOUT closing it (the risky case).
    const logs1: any[] = []
    await withQuickJsVm(async (opts) => {
      provide(opts, logs1)
      opts.eval(`
        const ws = new WebSocket(${JSON.stringify(url)})
        ws.onopen = () => console.log('opened')
      `)
      await waitFor(() => logs1.includes('opened'))
    })

    // Cycle 2: a brand-new VM must still work end to end (module not poisoned).
    const logs2: any[] = []
    await withQuickJsVm(async (opts) => {
      provide(opts, logs2)
      opts.eval(`
        const ws = new WebSocket(${JSON.stringify(url)})
        ws.onopen = () => ws.send('ping')
        ws.onmessage = (e) => { console.log('echo', e.data); ws.close() }
        ws.onclose = () => console.log('done')
      `)
      await waitFor(() => logs2.includes('done'))
    })

    expect(logs2).toEqual(['echo', 'ping', 'done'])
    const leaked = errorSpy.mock.calls.some((call) => /leaked handles/i.test(String(call[0] ?? '')))
    expect(leaked).toBe(false)
  })
})
