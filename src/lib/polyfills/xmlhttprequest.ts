/**
 * XMLHttpRequest polyfill for Node.js environment
 * Enables Babylon.js GLTF loading in headless server
 */
export function setupXMLHttpRequestPolyfill() {
  if (typeof (globalThis as any).XMLHttpRequest !== 'undefined') return
  
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

      const https = require('https')
      const http = require('http')
      const { URL } = require('url')

      const parsedUrl = new URL(this.url)
      const client = parsedUrl.protocol === 'https:' ? https : http

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: this.method,
        // prefer IPv4: the headless host often has no IPv6 route (ENETUNREACH spam)
        family: 4,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Node.js XMLHttpRequest polyfill)'
        }
      }

      // log every request so we can see exactly which asset URL fails (and how slow)
      const id = ++XMLHttpRequestPolyfill._seq
      const t0 = Date.now()
      console.log(`[XHR] #${id} → ${this.method} ${this.url}`)

      const req = client.request(options, (res: any) => {
        this.status = res.statusCode
        this.statusText = res.statusMessage
        this._setReadyState(3)

        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))

        res.on('end', () => {
          const buffer = Buffer.concat(chunks)

          if (this.responseType === 'arraybuffer') {
            this.response = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
          } else {
            this.responseText = buffer.toString('utf8')
            this.response = this.responseText
          }

          console.log(`[XHR] #${id} ✓ ${res.statusCode} ${this.method} ${this.url} (${buffer.length}b in ${Date.now() - t0}ms)`)
          this.readyState = 4
          this._setReadyState(4)
          this._triggerLoad()
        })
      })

      // fail fast instead of hanging for the full OS connect timeout
      const timeoutMs = this.timeout && this.timeout > 0 ? this.timeout : 15000
      req.setTimeout(timeoutMs, () => {
        console.error(`[XHR] #${id} ⏱ TIMEOUT after ${Date.now() - t0}ms: ${this.method} ${this.url}`)
        req.destroy(new Error(`XHR timeout after ${timeoutMs}ms`))
      })

      req.on('error', (error: any) => {
        console.error(`[XHR] #${id} ✗ FAILED in ${Date.now() - t0}ms: ${this.method} ${this.url} — ${error?.code || error?.message || error}`)
        this._triggerError()
      })

      if (body) req.write(body)
      req.end()
    }
    
    setRequestHeader(name: string, value: string) { /* No-op */ }
    
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