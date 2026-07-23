import ivm from 'isolated-vm'
import { ProvideOptions } from './types'
import { limits } from '../misc/limits'
import { limitLogger, reportLimitHitChecked, DEFAULT_LIMIT_LOG_INTERVAL_MS } from '../misc/limit-logger'

// The valid limit keys, resolved once. The isolate reports cap hits by key over a
// Reference; validating against this set means a bad/spoofed key can never grow
// the throttle map (defense in depth — the Reference is closured away from scene code).
const KNOWN_LIMIT_KEYS: ReadonlySet<string> = new Set(Object.keys(limits))

// Upper bound on the total binary bytes in a single host-call argument, enforced
// IN THE ISOLATE before the structured copy runs (isolated-vm copies the argument
// into HOST memory before any host code executes, so a host-side check is too
// late). Interpolated into the require shim as a constant (HAMMURABI_MAX_HOST_CALL_ARG_BYTES).
const MAX_HOST_CALL_ARG_BYTES = limits.maxHostCallArgBytes
// Bound simultaneously-in-flight host calls from one scene so a single turn can't
// fan out many un-awaited large copies and amplify into host OOM.
const MAX_INFLIGHT_HOST_CALLS = limits.maxInflightHostCalls
// In-isolate limit-report throttle window, mirroring the host logger's interval so
// the two layers stay aligned (interpolated into the require shim as a constant).
const REPORT_INTERVAL_MS = DEFAULT_LIMIT_LOG_INTERVAL_MS

/**
 * Returns an Error carrying only `err`'s message, with the host stack stripped so
 * absolute host paths / internal frames don't cross into the isolate (untrusted
 * scene code can read `err.stack`). The message is preserved because scenes rely
 * on it (e.g. `Unknown module fs`).
 */
function sanitizeHostError(err: unknown): Error {
  const e = new Error(String((err as { message?: unknown })?.message ?? err))
  e.stack = undefined
  return e
}
export const matchesTimeoutError = (err: unknown): boolean =>
  /timed out/i.test(String((err as { message?: unknown })?.message ?? err))

/**
 * Rejection handler for the async main-thread pumps (setImmediate drain, WebSocket
 * dispatch): a runaway synchronous scene callback trips the per-call `timeout` on
 * the isolate thread — dispose the scene so the next turn unwinds cleanly. Any
 * other rejection (or an already-disposed isolate) is a no-op.
 */
export function disposeOnTimeout(isolate: ivm.Isolate, err: unknown): void {
  if (!isolate.isDisposed && matchesTimeoutError(err)) {
    limitLogger.hit('maxSyncExecutionMs', 'runaway isolate callback disposed')
    try { isolate.dispose() } catch { /* already gone */ }
  }
}

/**
 * Base bootstrap evaluated once, before any scene code, in a fresh isolate.
 * Installs the CommonJS module surface (`module`/`exports`/`self`/`global`) and a
 * host-private `__callExport(name, dt)` dispatcher the host uses to invoke
 * `module.exports.onStart` / `onUpdate`. Always returns a Promise so the host can
 * uniformly await the turn.
 */
export const BOOTSTRAP_SOURCE = `;(function () {
  var g = globalThis;
  g.global = g;
  g.self = g;
  var module = { exports: {} };
  g.module = module;
  g.exports = module.exports;
  // Host-private turn dispatcher. Reads module.exports fresh each call so a scene
  // that reassigns module.exports (module.exports = {...}) keeps working. Resolves
  // to undefined (not the scene's return value) so the host doesn't structure-copy
  // a scene-chosen value out of the isolate every frame — the update loop discards
  // it anyway, and a scene could otherwise return a huge value each turn.
  g.__callExport = function (name, dt) {
    var e = g.module && g.module.exports;
    var fn = e && e[name];
    return Promise.resolve(typeof fn === 'function' ? fn(dt) : undefined).then(function () {});
  };
})();`

/**
 * The CommonJS wrapper the scene bundle is evaluated inside — identical to the
 * reference runtimes. A top-level `var` in the bundle must NOT become a
 * `globalThis` property (e.g. the SDK's `var DEBUG_NETWORK_MESSAGES` vs the
 * documented `globalThis.DEBUG_NETWORK_MESSAGES` flag). Single line so the
 * bundle's stack-trace line numbers are preserved.
 *
 * The trailing `, void 0` makes the eval's completion value `undefined` — a bundle
 * whose last statement is `return <huge>` (the IIFE body can `return`) would
 * otherwise be structure-copied out of the isolate uncapped at load time. The
 * runtime discards the bundle-eval result anyway.
 */
export function wrapSceneBundle(sceneCode: string): string {
  return `;(function (module, exports) { ${sceneCode}\n}).call(module.exports, module, module.exports), void 0;`
}

/**
 * Installs `console.log`/`console.error` (plus warn/info/debug aliases) backed by
 * the host `opts.log`/`opts.error`. Non-copyable args (functions/symbols) are
 * neutralised in-realm so a scene logging them can't throw across the boundary;
 * the raw host references are captured in a closure and removed from the global so
 * scene code can never reach them.
 */
export function provideConsole(context: ivm.Context, opts: ProvideOptions): void {
  context.global.setSync('__hostLog', new ivm.Reference((...args: any[]) => opts.log(...args)))
  context.global.setSync('__hostError', new ivm.Reference((...args: any[]) => opts.error(...args)))
  context.evalSync(`;(function () {
    var hostLog = globalThis.__hostLog;
    var hostError = globalThis.__hostError;
    var MAX_ARGS = 32, MAX_STR = 8192;
    function emit(ref, argsLike) {
      // Bound the cheap/common flood vectors: cap arg count and truncate top-level
      // strings. Non-copyable values (functions/symbols) are neutralised so a scene
      // logging them can't throw across the boundary. NOTE: a large object/array/
      // typed-array arg is still structure-copied whole (bounded only by the 256MB
      // isolate heap) — logging a giant nested value is self-limited by that, not
      // capped here.
      var out = [], n = Math.min(argsLike.length, MAX_ARGS);
      for (var i = 0; i < n; i++) {
        var a = argsLike[i], t = typeof a;
        if (t === 'function') out.push('[Function]');
        else if (t === 'symbol') out.push(a.toString());
        else if (t === 'string') out.push(a.length > MAX_STR ? a.slice(0, MAX_STR) + '…' : a);
        else out.push(a);
      }
      try { ref.applyIgnored(undefined, out, { arguments: { copy: true } }); }
      catch (e) { try { ref.applyIgnored(undefined, out.map(String), { arguments: { copy: true } }); } catch (e2) {} }
    }
    globalThis.console = {
      log: function () { emit(hostLog, arguments); },
      info: function () { emit(hostLog, arguments); },
      debug: function () { emit(hostLog, arguments); },
      error: function () { emit(hostError, arguments); },
      warn: function () { emit(hostError, arguments); }
    };
    delete globalThis.__hostLog;
    delete globalThis.__hostError;
  })();`)
}

/**
 * Installs the CommonJS `require` backed by `opts.require`. On first `require(name)`
 * the host builds the service object once (cached), the in-realm wrapper reads its
 * method names, and each method becomes an in-realm function that calls the host
 * over a `Reference` — request/response objects (incl. `Uint8Array` fields)
 * cross via structured copy, and the host promise is awaited in-isolate. The raw
 * host references are closured and deleted from the global.
 */
export function provideRequire(context: ivm.Context, opts: ProvideOptions): void {
  // One canonical service object per module name (the host factory is called once).
  const requireCache = new Map<string, any>()
  const getService = (name: string) => {
    let svc = requireCache.get(name)
    if (!svc) {
      svc = opts.require(name)
      requireCache.set(name, svc)
    }
    return svc
  }

  context.global.setSync('__hostModuleMethods', new ivm.Reference((name: string) => {
    try {
      const svc = getService(name)
      return Object.keys(svc).filter((k) => typeof svc[k] === 'function')
    } catch (err) {
      throw sanitizeHostError(err)
    }
  }))
  context.global.setSync('__hostCall', new ivm.Reference(async (name: string, method: string, arg: any) => {
    try {
      const svc = getService(name)
      const fn = svc[method]
      if (typeof fn !== 'function') throw new Error(`${name}.${method} is not a function`)
      return await fn(arg)
    } catch (err) {
      throw sanitizeHostError(err)
    }
  }))
  // Fire-and-forget host callback the require shim uses to report an in-isolate cap
  // hit (arg too large / too many concurrent host calls) so the operator gets a
  // throttled log. `applyIgnored` never blocks the isolate thread; the actual log
  // volume is bounded host-side by the throttled limitLogger, and the key is
  // validated against KNOWN_LIMIT_KEYS.
  context.global.setSync(
    '__reportLimit',
    new ivm.Reference((key: unknown, detail: unknown) => reportLimitHitChecked(limitLogger, KNOWN_LIMIT_KEYS, key, detail as string | undefined))
  )

  // In-isolate caps. The argument is deep-cloned into INERT data ONCE (every
  // getter read exactly once), measured during the clone, and the CLONE — not the
  // live arg — is handed to \`apply\`. This is load-bearing:
  //  - reading the live arg to measure it and then letting \`copy: true\` re-read it
  //    is a TOCTOU hole (a getter returning small-then-huge bypasses the cap);
  //  - the enumeration/size primitives (\`Object.keys\`, \`ArrayBuffer.isView\`, the
  //    %TypedArray%/ArrayBuffer byteLength getters) are captured BEFORE any scene
  //    code runs, so later prototype/global poisoning can't make the measurement
  //    undercount what V8's serializer actually copies.
  context.evalSync(`;(function () {
    var _keys = Object.keys, _isArray = Array.isArray, _isView = ArrayBuffer.isView;
    var _gOPD = Object.getOwnPropertyDescriptor, _getProto = Object.getPrototypeOf;
    var _U8 = Uint8Array;
    var _abByteLen = _gOPD(ArrayBuffer.prototype, 'byteLength').get;
    var _taProto = _getProto(Uint8Array.prototype);
    var _taByteLen = _gOPD(_taProto, 'byteLength').get;
    var _taByteOff = _gOPD(_taProto, 'byteOffset').get;
    var _taBuffer = _gOPD(_taProto, 'buffer').get;
    var _Map = Map;
    var _BIG_MAX = (1n << 128n); // reject bigints beyond ~2^128 (no ~system/* field needs more)

    var hostMethods = globalThis.__hostModuleMethods;
    var hostCall = globalThis.__hostCall;
    var reportLimit = globalThis.__reportLimit;
    // In-isolate throttle for limit reports. The host limitLogger already
    // throttles EMISSION, but that does not bound the applyIgnored host-callback
    // volume a hostile scene could drive by hammering a cap in a tight loop —
    // each rejected call would still enqueue a host task. Report at most one hit
    // per key per interval from inside the shim; suppressed hits ride along in
    // the detail. Date.now is captured here, before scene code runs, so a scene
    // reassigning Date cannot disable the throttle. reportState stays bounded:
    // report() is closured (scene cannot call it) and only ever sees the two
    // literal keys below.
    var _reportNow = Date.now;
    var REPORT_INTERVAL_MS = ${REPORT_INTERVAL_MS};
    var reportState = Object.create(null);
    function report(key, detail) {
      var t = 0; try { t = _reportNow(); } catch (e) {}
      var s = reportState[key] || (reportState[key] = { last: -1 / 0, n: 0 });
      if (t - s.last < REPORT_INTERVAL_MS) { s.n++; return; }
      var d = s.n > 0 ? detail + ' (+' + s.n + ' more)' : detail;
      s.last = t; s.n = 0;
      try { reportLimit.applyIgnored(undefined, [key, d], { arguments: { copy: true } }); } catch (e) {}
    }
    var cache = Object.create(null);
    var inFlight = 0;
    var MAX_ARG_BYTES = ${MAX_HOST_CALL_ARG_BYTES};
    var MAX_INFLIGHT = ${MAX_INFLIGHT_HOST_CALLS};

    function tooLarge() { throw new Error('request payload too large'); }
    // Deep-clone to inert data while charging bytes against \`budget\`. Detects
    // binary via unspoofable internal-slot getters and copies bytes once. A flat
    // per-node charge bounds STRUCTURAL size too (a huge plain number-array or
    // wide object scores few binary bytes but still copies large into host) and
    // gives an early exit — the walk stops as soon as the budget is exhausted, so
    // a 50M-element array is rejected after ~2M nodes, not fully traversed.
    function clone(v, depth, budget, seen) {
      if (depth > 8) throw new Error('request too deeply nested');
      if (v === null || v === undefined) return v;
      budget.n -= 8; if (budget.n < 0) tooLarge();
      var t = typeof v;
      if (t === 'number' || t === 'boolean') return v;
      // Bound a bigint by magnitude (the comparison allocates nothing) and charge
      // its full serialized width (~16 bytes at the 2^128 ceiling), so a large
      // array of near-max bigints can't undercount what the copy actually sends.
      if (t === 'bigint') { if (v > _BIG_MAX || -v > _BIG_MAX) tooLarge(); budget.n -= 16; if (budget.n < 0) tooLarge(); return v; }
      if (t === 'string') { budget.n -= v.length * 2; if (budget.n < 0) tooLarge(); return v; }
      if (t === 'function' || t === 'symbol') return undefined;
      // ArrayBuffer (internal-slot check via the captured byteLength getter). A
      // buffer seen before is re-aliased and NOT re-charged, so an aliased payload
      // (one message broadcast to N peers) is charged its unique bytes once.
      var isAB = false, abn = -1;
      try { abn = _abByteLen.call(v); isAB = true; } catch (e) {}
      if (isAB) {
        if (seen.has(v)) return seen.get(v);
        budget.n -= abn; if (budget.n < 0) tooLarge();
        var abCopy = new _U8(new _U8(v)).buffer;
        seen.set(v, abCopy); return abCopy;
      }
      // Typed array (not DataView); DataView/other views are rejected.
      if (_isView(v)) {
        if (seen.has(v)) return seen.get(v);
        var tan;
        try { tan = _taByteLen.call(v); } catch (e) { throw new Error('unsupported binary type in request'); }
        budget.n -= tan; if (budget.n < 0) tooLarge();
        var taCopy = new _U8(new _U8(_taBuffer.call(v), _taByteOff.call(v), tan));
        seen.set(v, taCopy); return taCopy;
      }
      if (_isArray(v)) { var out = []; for (var i = 0; i < v.length; i++) out.push(clone(v[i], depth + 1, budget, seen)); return out; }
      if (t === 'object') {
        var o = {}, ks = _keys(v);
        for (var j = 0; j < ks.length; j++) {
          var k = ks[j];
          budget.n -= k.length * 2; if (budget.n < 0) tooLarge(); // charge the KEY string too
          o[k] = clone(v[k], depth + 1, budget, seen);
        }
        return o;
      }
      return undefined;
    }

    globalThis.require = function (name) {
      var mod = cache[name];
      if (mod) return mod;
      var methods = hostMethods.applySync(undefined, [name], { arguments: { copy: true }, result: { copy: true } });
      mod = {};
      for (var i = 0; i < methods.length; i++) {
        (function (m) {
          mod[m] = function (arg) {
            var safe;
            try { safe = clone(arg, 0, { n: MAX_ARG_BYTES }, new _Map()); }
            catch (err) {
              // Attribute to the byte cap ONLY for its own error: clone also throws
              // for depth / unsupported binary types and re-throws scene getter
              // errors — none of those are maxHostCallArgBytes hits. The probe is
              // guarded: err can be a scene value whose .message getter throws,
              // and that must not escape this catch (the pre-existing contract is
              // that mod[m] always returns a promise, never throws synchronously).
              var msg; try { msg = err && err.message; } catch (e3) {}
              if (msg === 'request payload too large') report('maxHostCallArgBytes', name + '.' + m);
              return Promise.reject(err);
            }
            if (inFlight >= MAX_INFLIGHT) { report('maxInflightHostCalls', name + '.' + m); return Promise.reject(new Error('too many concurrent host calls')); }
            inFlight++;
            var p;
            try { p = hostCall.apply(undefined, [name, m, safe], { arguments: { copy: true }, result: { promise: true, copy: true } }); }
            catch (err2) { inFlight--; return Promise.reject(err2); }
            return p.then(function (r) { inFlight--; return r; }, function (e) { inFlight--; throw e; });
          };
        })(methods[i]);
      }
      cache[name] = mod;
      return mod;
    };
    delete globalThis.__hostModuleMethods;
    delete globalThis.__hostCall;
    delete globalThis.__reportLimit;
  })();`)
}

/**
 * `setImmediate` polyfill: scene callbacks are queued in-realm and drained by a
 * host 16ms interval calling the in-realm `__drainImmediates`. Draining a SNAPSHOT
 * (splice) means a self-requeuing callback runs on the NEXT tick — matching Node's
 * semantics and the QuickJS runtime it replaces.
 *
 * The drain uses ASYNC `apply`, not `applySync`. This is load-bearing: `applySync`
 * blocks the host main thread on the isolate lock, and a wedged turn continuation
 * (`await hostPromise; while(true){}` runs in isolated-vm's untimed microtask
 * checkpoint on a background thread and holds that lock) would then freeze the
 * whole host loop — and the async-turn watchdog (a host `setTimeout`) could never
 * fire to dispose it. Async `apply` keeps the main thread free, so the watchdog
 * fires and disposes the isolate, terminating the wedge. A runaway *synchronous*
 * setImmediate callback trips the drain's `timeout` (bounded on the isolate
 * thread, not the host thread) and we dispose the scene.
 */
export function provideSetImmediate(
  context: ivm.Context,
  isolate: ivm.Isolate,
  maxSyncExecutionMs: number
): { dispose: () => void } {
  context.evalSync(`;(function () {
    var queue = [];
    globalThis.setImmediate = function (fn) { if (typeof fn === 'function') queue.push(fn); };
    globalThis.__drainImmediates = function () {
      var batch = queue.splice(0);
      for (var i = 0; i < batch.length; i++) {
        try { batch[i](); } catch (e) { /* scene errors surface via its own logging */ }
      }
    };
  })();`)

  const drain = context.global.getSync('__drainImmediates', { reference: true }) as ivm.Reference<any>
  // Remove it from the scene global (the host keeps it via the captured Reference).
  context.evalSync('delete globalThis.__drainImmediates')
  let draining = false

  const int = setInterval(() => {
    if (isolate.isDisposed || draining) return
    draining = true
    drain
      .apply(undefined, [], { timeout: maxSyncExecutionMs })
      .then(
        () => { draining = false },
        (err) => {
          draining = false
          // A runaway synchronous callback tripped the deadline — tear the scene
          // down (the next onUpdate then throws and the runtime unwinds cleanly).
          disposeOnTimeout(isolate, err)
        }
      )
  }, 16)

  return {
    dispose() {
      clearInterval(int)
      try { drain.release() } catch { /* isolate already gone */ }
    }
  }
}
