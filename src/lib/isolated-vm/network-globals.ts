import ivm from 'isolated-vm'
import { ProvideOptions } from './types'
import { disposeOnTimeout } from './globals'
import { HostWebSocketFactory } from '../misc/scene-websocket'
import { limits } from '../misc/limits'
import { limitLogger } from '../misc/limit-logger'

/**
 * Install the scene-facing global `fetch` (ADR-133): unprivileged, SSRF-guarded,
 * body-capped. isolated-vm cannot copy host functions or live objects across the
 * boundary, so unlike the QuickJS bridge the host returns the FULLY-READ response
 * as plain data (`{ ok, status, headers, bodyText, bodyBytes }`) and the in-realm
 * shim rebuilds a WHATWG-shaped `Response` (`text/json/bytes/arrayBuffer`, a
 * `Headers`-like object) from it. AbortSignal cancellation threads to the host via
 * a per-request token. The raw host hooks are closured and removed from the global.
 */
export function provideFetch(context: ivm.Context, opts: ProvideOptions): { abortAll: () => void } {
  const hostFetch = opts.fetch!
  // Correlates a scene AbortSignal (isolate side) to the host AbortController for
  // its in-flight request; entries are removed when the request settles.
  const fetchControllers = new Map<number, AbortController>()

  context.global.setSync('__hostFetch', new ivm.Reference(async (url: string, init: any, token: number) => {
    const controller = new AbortController()
    if (typeof token === 'number') fetchControllers.set(token, controller)
    try {
      const raw = await hostFetch(url, init, controller.signal)
      const headers: Record<string, string> = {}
      for (const [k, v] of raw.headers.entries()) headers[k] = v
      // scene-fetch reads the body once and derives text()/bytes() from the cache.
      const bodyBytes = await raw.bytes()
      // Only decode the text form when the body is plausibly text (or small):
      // eagerly UTF-8-decoding a large binary asset (glTF/image/audio) would copy
      // a second full-size string across the boundary for a `.text()` no scene
      // calls on it. `.text()`/`.json()` on a large binary response then yield ''.
      const contentType = (headers['content-type'] || '').toLowerCase()
      const texty = /text\/|json|xml|javascript|urlencoded/.test(contentType)
      let bodyText = ''
      if (texty || bodyBytes.byteLength <= 512 * 1024) {
        try { bodyText = await raw.text() } catch { bodyText = '' }
      }
      return {
        ok: raw.ok, status: raw.status, statusText: raw.statusText,
        url: raw.url, redirected: raw.redirected, headers, bodyText, bodyBytes
      }
    } finally {
      if (typeof token === 'number') fetchControllers.delete(token)
    }
  }))
  context.global.setSync('__hostAbortFetch', new ivm.Reference((token: number) => {
    if (typeof token === 'number') fetchControllers.get(token)?.abort()
  }))

  context.evalSync(SCENE_FETCH_SHIM)

  return {
    // Abort every in-flight scene fetch at teardown so hot reload / shutdown
    // releases host sockets promptly (mirrors WebSocket closeAll); without this,
    // up to the concurrency cap of requests would run to completion.
    abortAll: () => {
      for (const controller of fetchControllers.values()) {
        try { controller.abort() } catch { /* best-effort */ }
      }
      fetchControllers.clear()
    }
  }
}

/**
 * Install the scene-facing global `WebSocket` (ADR-133), backed by host
 * connections. Sockets are identified by a numeric id: the host keeps the
 * `HostWebSocket` in a map, exposes live reads (`bufferedAmount`, `binaryType`)
 * and actions (`send`, `close`) as synchronous host References keyed by id, and
 * pushes events into the isolate via the in-realm `__wsDispatch`. Returns a
 * manager whose `closeAll()` closes every live socket at teardown.
 */
export function provideWebSocket(
  context: ivm.Context,
  isolate: ivm.Isolate,
  factory: HostWebSocketFactory,
  maxSyncExecutionMs: number
): { closeAll: () => void } {
  const sockets = new Map<number, ReturnType<HostWebSocketFactory>>()
  let nextId = 1
  let tornDown = false
  // Cap concurrent sockets so untrusted scene code can't exhaust host connections
  // with a `new WebSocket()` loop. Closed sockets leave the map, so this bounds the
  // simultaneously-open count, not the lifetime total. (HAMMURABI_MAX_OPEN_SOCKETS)
  const MAX_OPEN_SOCKETS = limits.maxOpenSockets
  // Bound events queued into the isolate at once: a hostile/fast peer can emit
  // frames faster than a slow scene handler drains them, and each pending async
  // dispatch pins its (≤1MB) event payload in host memory. Past this, inbound
  // events are dropped (the socket's own frames, not the runtime) — lossy, but it
  // caps host memory the way MAX_OPEN_SOCKETS / the fetch concurrency cap do.
  const MAX_PENDING_DISPATCH = limits.maxWsPendingDispatch
  // Reference to the in-realm __wsDispatch, captured after the shim installs it.
  let dispatchRef: ivm.Reference<any> | undefined
  let pendingDispatch = 0

  const dispatch = (id: number, type: string, event: unknown): void => {
    if (tornDown || !dispatchRef || isolate.isDisposed) return
    // Always let lifecycle events (open/close) through; only drop backlogged data.
    if (pendingDispatch >= MAX_PENDING_DISPATCH && type === 'message') {
      limitLogger.hit('maxWsPendingDispatch')
      return
    }
    pendingDispatch++
    // ASYNC `apply`, not `applySync`: a synchronous host→isolate call would block
    // the host main thread on the isolate lock, so a wedged turn continuation (or a
    // runaway handler) would freeze the whole host loop. Async keeps the main thread
    // free; the deadline is enforced on the isolate thread and a runaway event
    // handler disposes the scene. (See provideSetImmediate for the full rationale.)
    dispatchRef
      .apply(undefined, [id, type, event], { arguments: { copy: true }, timeout: maxSyncExecutionMs })
      .then(
        () => { pendingDispatch-- },
        (err) => {
          pendingDispatch--
          disposeOnTimeout(isolate, err)
        }
      )
  }

  context.global.setSync('__wsCreate', new ivm.Reference((url: string, protocols: any) => {
    if (tornDown) throw new Error('WebSocket: runtime shutting down')
    if (typeof url !== 'string') throw new Error('WebSocket: url must be a string')
    if (sockets.size >= MAX_OPEN_SOCKETS) {
      limitLogger.hit('maxOpenSockets')
      throw new Error('WebSocket: too many open connections for this scene')
    }
    const id = nextId++
    const socket = factory(url, protocols as string | string[] | undefined)
    sockets.set(id, socket)
    socket.on('open', () => dispatch(id, 'open', { type: 'open' }))
    socket.on('message', (data) => dispatch(id, 'message', { type: 'message', data }))
    socket.on('error', (message) => dispatch(id, 'error', { type: 'error', message }))
    socket.on('close', (code, reason) => {
      dispatch(id, 'close', { type: 'close', code, reason, wasClean: code === 1000 })
      sockets.delete(id)
    })
    return id
  }))
  context.global.setSync('__wsBufferedAmount', new ivm.Reference((id: number) => sockets.get(id)?.bufferedAmount ?? 0))
  context.global.setSync('__wsBinaryType', new ivm.Reference((id: number) => sockets.get(id)?.binaryType ?? 'blob'))
  context.global.setSync('__wsSetBinaryType', new ivm.Reference((id: number, v: string) => {
    const s = sockets.get(id)
    if (s && (v === 'arraybuffer' || v === 'blob')) s.binaryType = v
  }))
  context.global.setSync('__wsSend', new ivm.Reference((id: number, data: unknown) => sockets.get(id)?.send(data)))
  context.global.setSync('__wsClose', new ivm.Reference((id: number, code: any, reason: any) => {
    sockets.get(id)?.close(typeof code === 'number' ? code : undefined, typeof reason === 'string' ? reason : undefined)
  }))

  context.evalSync(WEBSOCKET_SHIM)

  // Capture the dispatcher, then remove it from the global so scene code only sees
  // the standard constructor. The Reference keeps the function alive after delete.
  dispatchRef = context.global.getSync('__wsDispatch', { reference: true }) as ivm.Reference<any>
  context.evalSync('delete globalThis.__wsDispatch;')

  return {
    closeAll: () => {
      tornDown = true
      for (const socket of sockets.values()) {
        try {
          socket.close(1000, 'scene shutdown')
        } catch {
          // best-effort: teardown continues regardless
        }
      }
      sockets.clear()
      try { dispatchRef?.release() } catch { /* isolate already gone */ }
    }
  }
}

// In-realm `fetch`: wraps the host __hostFetch (which returns plain response data)
// into a WHATWG-shaped Response, threading AbortSignal cancellation via a token.
// Provides a minimal AbortController/AbortSignal (the isolate lacks them).
const SCENE_FETCH_SHIM = `;(function () {
  var hostFetch = globalThis.__hostFetch;
  var hostAbort = globalThis.__hostAbortFetch;
  var nextToken = 1;
  if (typeof globalThis.AbortController === "undefined") {
    var AbortSignal = function () { this.aborted = false; this.reason = undefined; this._listeners = []; };
    AbortSignal.prototype.addEventListener = function (type, fn) { if (type === "abort" && typeof fn === "function") this._listeners.push(fn); };
    AbortSignal.prototype.removeEventListener = function (type, fn) { var i = this._listeners.indexOf(fn); if (i !== -1) this._listeners.splice(i, 1); };
    AbortSignal.prototype.dispatchEvent = function () { return true; };
    var AbortController = function () { this.signal = new AbortSignal(); };
    AbortController.prototype.abort = function (reason) {
      var s = this.signal; if (s.aborted) return; s.aborted = true; s.reason = reason;
      if (typeof s.onabort === "function") { try { s.onabort({ type: "abort" }); } catch (e) {} }
      var list = s._listeners.slice(); for (var i = 0; i < list.length; i++) { try { list[i]({ type: "abort" }); } catch (e) {} }
    };
    globalThis.AbortController = AbortController; globalThis.AbortSignal = AbortSignal;
  }
  function abortError() { var e = new Error("The operation was aborted"); e.name = "AbortError"; return e; }
  function buildHeaders(obj) {
    obj = obj || {};
    return {
      get: function (k) { k = String(k).toLowerCase(); return Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : null; },
      has: function (k) { k = String(k).toLowerCase(); return Object.prototype.hasOwnProperty.call(obj, k); },
      entries: function () { var e = []; for (var k in obj) { if (Object.prototype.hasOwnProperty.call(obj, k)) e.push([k, obj[k]]); } return e; },
      keys: function () { return Object.keys(obj); },
      values: function () { return Object.keys(obj).map(function (k) { return obj[k]; }); }
    };
  }
  function wrapResponse(raw) {
    return {
      ok: raw.ok, status: raw.status, statusText: raw.statusText, url: raw.url, redirected: raw.redirected,
      headers: buildHeaders(raw.headers),
      text: function () { return Promise.resolve(raw.bodyText); },
      json: function () { return Promise.resolve().then(function () { return JSON.parse(raw.bodyText); }); },
      bytes: function () { return Promise.resolve(new Uint8Array(raw.bodyBytes)); },
      arrayBuffer: function () { return Promise.resolve(raw.bodyBytes.buffer); }
    };
  }
  globalThis.fetch = function (url, init) {
    init = init || {};
    var signal = init.signal;
    if (signal && signal.aborted) return Promise.reject(abortError());
    var token = nextToken++;
    var onAbort;
    if (signal) { onAbort = function () { hostAbort.applyIgnored(undefined, [token], { arguments: { copy: true } }); }; signal.addEventListener("abort", onAbort); }
    var cleanInit = { method: init.method, headers: init.headers, body: init.body, redirect: init.redirect };
    return hostFetch.apply(undefined, [url, cleanInit, token], { arguments: { copy: true }, result: { promise: true, copy: true } }).then(function (raw) {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      return wrapResponse(raw);
    }, function (err) {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      if (signal && signal.aborted) throw abortError();
      throw err;
    });
  };
  delete globalThis.__hostFetch; delete globalThis.__hostAbortFetch;
})();`

// In-realm `WebSocket`: id-based, backed by host References. Instances are held in
// a registry so host-pushed events (__wsDispatch) reach the right socket.
const WEBSOCKET_SHIM = `;(function () {
  var create = globalThis.__wsCreate;
  var bufAmt = globalThis.__wsBufferedAmount;
  var getBin = globalThis.__wsBinaryType;
  var setBin = globalThis.__wsSetBinaryType;
  var wsSend = globalThis.__wsSend;
  var wsClose = globalThis.__wsClose;
  var registry = Object.create(null);
  function WebSocket(url, protocols) {
    var id = create.applySync(undefined, [url, protocols], { arguments: { copy: true }, result: { copy: true } });
    this.__id = id;
    this.url = String(url);
    this.readyState = 0;
    this.__listeners = {};
    registry[id] = this;
  }
  WebSocket.CONNECTING = WebSocket.prototype.CONNECTING = 0;
  WebSocket.OPEN = WebSocket.prototype.OPEN = 1;
  WebSocket.CLOSING = WebSocket.prototype.CLOSING = 2;
  WebSocket.CLOSED = WebSocket.prototype.CLOSED = 3;
  Object.defineProperty(WebSocket.prototype, 'bufferedAmount', {
    enumerable: true,
    get: function () { return bufAmt.applySync(undefined, [this.__id], { result: { copy: true } }); }
  });
  Object.defineProperty(WebSocket.prototype, 'binaryType', {
    enumerable: true,
    get: function () { return getBin.applySync(undefined, [this.__id], { result: { copy: true } }); },
    set: function (v) { setBin.applyIgnored(undefined, [this.__id, v], { arguments: { copy: true } }); }
  });
  WebSocket.prototype.addEventListener = function (type, listener) {
    if (typeof listener !== "function") return;
    var arr = this.__listeners[type] || (this.__listeners[type] = []);
    if (arr.indexOf(listener) === -1) arr.push(listener);
  };
  WebSocket.prototype.removeEventListener = function (type, listener) {
    var arr = this.__listeners && this.__listeners[type];
    if (!arr) return;
    var i = arr.indexOf(listener);
    if (i !== -1) arr.splice(i, 1);
  };
  WebSocket.prototype.send = function (data) {
    if (data instanceof ArrayBuffer) { data = new Uint8Array(data); }
    else if (ArrayBuffer.isView(data) && !(data instanceof Uint8Array)) { data = new Uint8Array(data.buffer, data.byteOffset, data.byteLength); }
    wsSend.applyIgnored(undefined, [this.__id, data], { arguments: { copy: true } });
  };
  WebSocket.prototype.close = function (code, reason) {
    // WHATWG: reject invalid close args IN the scene. The host validates too, but its
    // throw is swallowed by applyIgnored, so without mirroring the FULL host rule
    // here the scene would wrongly advance readyState while the host socket stays
    // open. Must match assertValidCloseArgs (scene-websocket.ts): integer code in
    // {1000, 3000..4999}, and reason ≤ 123 UTF-8 bytes.
    if (code !== undefined && !(Number.isInteger(code) && (code === 1000 || (code >= 3000 && code <= 4999)))) {
      var err = new Error("Failed to execute 'close' on 'WebSocket': invalid code " + code);
      err.name = 'InvalidAccessError';
      throw err;
    }
    if (reason !== undefined && unescape(encodeURIComponent(String(reason))).length > 123) {
      var e2 = new Error("Failed to execute 'close' on 'WebSocket': reason exceeds 123 bytes");
      e2.name = 'SyntaxError';
      throw e2;
    }
    wsClose.applyIgnored(undefined, [this.__id, code, reason], { arguments: { copy: true } });
    // Reflect the synchronous state move (CLOSING, or CLOSED if never connected)
    // to the scene, matching WHATWG.
    if (this.readyState === 0) this.readyState = 3;
    else if (this.readyState === 1) this.readyState = 2;
  };
  globalThis.__wsDispatch = function (id, type, event) {
    var ws = registry[id];
    if (!ws) return;
    if (type === "open") ws.readyState = 1;
    if (type === "close") { ws.readyState = 3; delete registry[id]; }
    // Binary frames arrive as a Uint8Array; expose them as an ArrayBuffer (what
    // binaryType "arraybuffer" promises).
    if (type === "message" && event && event.data instanceof Uint8Array) { event.data = event.data.buffer; }
    var handler = ws["on" + type];
    if (typeof handler === "function") { try { handler.call(ws, event); } catch (e) {} }
    var arr = ws.__listeners && ws.__listeners[type];
    // Snapshot but skip a listener removed mid-dispatch by an earlier one.
    if (arr) { var list = arr.slice(); for (var i = 0; i < list.length; i++) { if (arr.indexOf(list[i]) === -1) continue; try { list[i].call(ws, event); } catch (e) {} } }
  };
  globalThis.WebSocket = WebSocket;
  delete globalThis.__wsCreate; delete globalThis.__wsBufferedAmount; delete globalThis.__wsBinaryType;
  delete globalThis.__wsSetBinaryType; delete globalThis.__wsSend; delete globalThis.__wsClose;
})();`
