/**
 * XMLHttpRequest polyfill for Node.js environment
 * Enables Babylon.js GLTF loading in headless server
 */
export function setupXMLHttpRequestPolyfill() {
  if (typeof (globalThis as any).XMLHttpRequest !== 'undefined') return

  const https = require('https')
  const http = require('http')
  const { URL } = require('url')

  // keep-alive + IPv4 agents: scenes load many assets from the same host, so
  // reusing sockets avoids a fresh TCP+TLS handshake per request. family: 4
  // skips the IPv6 path that has no route on most headless hosts (ENETUNREACH).
  const agentOpts = { keepAlive: true, family: 4, maxSockets: 16 }
  const httpsAgent = new https.Agent(agentOpts)
  const httpAgent = new http.Agent(agentOpts)

  const MAX_ATTEMPTS = 2
  const backoffMs = (attempt: number) => Math.min(250 * 2 ** (attempt - 1), 2000)

  // Per-request start/success logs are opt-in: a Genesis City scene load makes
  // hundreds of requests, each log line being a synchronous stdout write.
  // Errors and timeouts are always logged.
  const XHR_DEBUG = !!process.env.HAMMURABI_XHR_DEBUG

  // Cap the response body size. Scene assets (glTF/GLB) are fetched through this
  // polyfill and handed to Babylon's NATIVE glTF parser, which runs outside the
  // QuickJS sandbox. Bounding the bytes limits both worker-heap exhaustion and the
  // size of hostile input reaching that native parser.
  const MAX_RESPONSE_BYTES = 64 * 1024 * 1024

  class XMLHttpRequestPolyfill {
    static _seq = 0
    public readyState = 0
    public status = 0
    public statusText = ''
    public responseType = ''
    public response: any = null
    public responseText = ''
    public responseXML: any = null
    public timeout = 0

    private _listeners: { [key: string]: Function[] } = {}
    private _headers: Record<string, string> = {}

    // Event handlers
    public onreadystatechange: (() => void) | null = null
    public onload: (() => void) | null = null
    public onerror: (() => void) | null = null
    public ontimeout: (() => void) | null = null
    public onabort: (() => void) | null = null
    public onloadstart: (() => void) | null = null
    public onloadend: (() => void) | null = null
    public onprogress: ((event: any) => void) | null = null

    private method = ''
    private url = ''

    open(method: string, url: string, async = true) {
      this.method = method
      this.url = url
      this.readyState = 1
      this._setReadyState(1)
    }

    send(body?: any) {
      this.readyState = 2
      this._setReadyState(2)

      const parsedUrl = new URL(this.url)
      const isHttps = parsedUrl.protocol === 'https:'
      const client = isHttps ? https : http

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: this.method,
        agent: isHttps ? httpsAgent : httpAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Node.js XMLHttpRequest polyfill)',
          ...this._headers
        }
      }

      const id = ++XMLHttpRequestPolyfill._seq
      const timeoutMs = this.timeout && this.timeout > 0 ? this.timeout : 15000

      // retry transient connect failures/timeouts with backoff before giving up
      const attempt = (n: number) => {
        const t0 = Date.now()
        let sizeExceeded = false
        if (XHR_DEBUG) console.log(`[XHR] #${id} → ${this.method} ${this.url}${n > 1 ? ` (retry ${n}/${MAX_ATTEMPTS})` : ''}`)

        const req = client.request(options, (res: any) => {
          this.status = res.statusCode
          this.statusText = res.statusMessage
          this._setReadyState(3)

          // Non-2xx responses (including un-followed 3xx redirects) must not have
          // their body handed to Babylon's native glTF parser as if it were a
          // valid asset. Drain and surface an error instead.
          if (res.statusCode < 200 || res.statusCode >= 300) {
            console.error(`[XHR] #${id} ✗ ${res.statusCode} ${this.method} ${this.url}`)
            res.resume() // discard the body
            this.readyState = 4
            this._setReadyState(4)
            this._triggerError()
            return
          }

          const chunks: Buffer[] = []
          let received = 0
          res.on('data', (chunk: Buffer) => {
            received += chunk.length
            if (received > MAX_RESPONSE_BYTES) {
              console.error(`[XHR] #${id} ✗ response exceeded ${MAX_RESPONSE_BYTES}b cap: ${this.method} ${this.url}`)
              // Deterministic failure: the asset is simply too big, so abort
              // without retrying (retrying would re-download the hostile asset).
              sizeExceeded = true
              req.destroy(new Error(`response exceeded ${MAX_RESPONSE_BYTES} bytes`))
              return
            }
            chunks.push(chunk)
          })

          res.on('end', () => {
            const buffer = Buffer.concat(chunks)

            if (this.responseType === 'arraybuffer') {
              // Buffer.concat already allocated a fresh buffer. Whenever it owns
              // its whole ArrayBuffer (any response larger than Node's small
              // allocation pool), hand that ArrayBuffer over directly instead of
              // copying the entire asset a second time.
              this.response =
                buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength
                  ? buffer.buffer
                  : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
            } else {
              this.responseText = buffer.toString('utf8')
              this.response = this.responseText
            }

            if (XHR_DEBUG) console.log(`[XHR] #${id} ✓ ${res.statusCode} ${this.method} ${this.url} (${buffer.length}b in ${Date.now() - t0}ms)`)
            this.readyState = 4
            this._setReadyState(4)
            this._triggerLoad()
          })
        })

        req.setTimeout(timeoutMs, () => {
          console.error(`[XHR] #${id} ⏱ TIMEOUT after ${Date.now() - t0}ms: ${this.method} ${this.url}`)
          req.destroy(new Error(`XHR timeout after ${timeoutMs}ms`))
        })

        req.on('error', (error: any) => {
          const cause = error?.code || error?.message || error
          console.error(`[XHR] #${id} ✗ FAILED in ${Date.now() - t0}ms (attempt ${n}/${MAX_ATTEMPTS}): ${this.method} ${this.url} — ${cause}`)
          // A size-cap abort is deterministic — don't retry it.
          if (!sizeExceeded && n < MAX_ATTEMPTS) {
            setTimeout(() => attempt(n + 1), backoffMs(n))
          } else {
            this._triggerError()
          }
        })

        if (body) req.write(body)
        req.end()
      }

      attempt(1)
    }

    setRequestHeader(name: string, value: string) {
      this._headers[name] = value
    }

    addEventListener(type: string, listener: Function) {
      if (!this._listeners[type]) this._listeners[type] = []
      this._listeners[type].push(listener)
    }

    removeEventListener(type: string, listener: Function) {
      if (this._listeners[type]) {
        const index = this._listeners[type].indexOf(listener)
        if (index > -1) this._listeners[type].splice(index, 1)
      }
    }

    private _setReadyState(state: number) {
      this.readyState = state
      if (this.onreadystatechange) this.onreadystatechange()
      this._dispatchEvent('readystatechange', {})
    }

    private _triggerLoad() {
      if (this.onload) this.onload()
      this._dispatchEvent('load', {})
    }

    private _triggerError() {
      if (this.onerror) this.onerror()
      this._dispatchEvent('error', {})
    }

    private _dispatchEvent(type: string, event: any) {
      const listeners = this._listeners[type] || []
      listeners.forEach(listener => listener(event))
    }

    abort() { /* No-op */ }
    getAllResponseHeaders() { return '' }
    getResponseHeader() { return null }
    overrideMimeType() { /* No-op */ }
    dispatchEvent() { return true }
  }

  (globalThis as any).XMLHttpRequest = XMLHttpRequestPolyfill
}
