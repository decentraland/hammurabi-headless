# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
# Build TypeScript and worker bundle
npm run build              # Runs tsc + esbuild for worker bundle

# Run tests
npm run test               # Jest tests for *.spec.ts files

# Development with hot reload
npm run dev                # Local preview (localhost:8000) with nodemon
npm run dev:genesis        # Genesis City at position 23,-24 with nodemon

# Start production server
npm start                  # Runs: node dist/cli.js --realm=localhost:8000

# Run with different configurations
node dist/cli.js --realm=https://peer.decentraland.org --position=80,80
node dist/cli.js --realm=http://localhost:8000 --env=zone
node dist/cli.js --position=0,0 --production   # No interactive controls, exits non-zero on failed startup
npx @dcl/hammurabi-server --position=0,0  # Default to peer.decentraland.org

# Environment variables
HAMMURABI_FPS=60 node dist/cli.js ...        # renderer tick rate (default 30, max 60)
HAMMURABI_XHR_DEBUG=1 node dist/cli.js ...   # per-request asset fetch logging

# Pulse comms (augments LiveKit; see "Comms transport routing" below)
HAMMURABI_COMMS_PROTOCOL=pulse node dist/cli.js ...  # route Pulse's capability set through Pulse
HAMMURABI_PULSE_HOST=localhost ...           # pulse server host (default pulse-server.decentraland.zone)
HAMMURABI_PULSE_PORT=7777 ...                # pulse UDP port (default 7777, valid 1-65535)
HAMMURABI_PULSE_REALM=main ...               # realm sent in the handshake (default main)
HAMMURABI_PULSE_DEBUG=1 ...                  # log each received Pulse position

# Configurable resource/DoS limits (all optional; each defaults to the value that
# used to be hard-coded, so behavior is unchanged unless set). Examples:
HAMMURABI_ISOLATE_MEMORY_LIMIT_MB=512 node dist/cli.js ...      # per-scene isolate heap ceiling (MB)
HAMMURABI_MAX_ASYNC_TURN_MS=30000 node dist/cli.js ...          # async-turn watchdog deadline
HAMMURABI_MAX_LIVE_ENTITIES=50000 node dist/cli.js ...          # concurrent entities per scene
HAMMURABI_MAX_MESSAGES_PER_WINDOW=150 node dist/cli.js ...      # per-peer inbound comms rate
```

## Configurable Resource Limits

Every numeric resource/DoS cap and timeout that bounds an untrusted scene, a remote
comms peer, or a content-server response is centralized in
**`src/lib/misc/limits.ts`** and overridable via `HAMMURABI_*` environment variables.
That module's `KNOBS` table is the single source of truth: it lists every knob's env
var name, default (equal to the former hard-coded value), unit (named in the suffix:
`_MS`/`_BYTES`/`_MB`, else a count), and hard minimum. `readLimits(env)` parses and
validates each — a non-integer / below-minimum / non-numeric override is ignored
(default kept) and logged once at startup — and exports a `limits` singleton read once
from `process.env` at first import. Consumers import `limits` instead of declaring a
local `const MAX_…`; the isolate-side caps are interpolated into the in-realm shim
strings as constants. Add a new tunable by adding a field to the `Limits` interface
**and** a row to `KNOBS` (a spec test asserts every field is populated). Only
resource/DoS caps + timeouts are configurable; WHATWG spec validators (WebSocket close
codes, redirect method rewrites) are deliberately fixed. These processes are spawned
one-scene-per-process by a supervisor (`sdk-multiplayer-server`) that sets the env per
worker; it forwards the whole `HAMMURABI_*` prefix into the fork's allowlisted env.

**Limit-hit logging (`src/lib/misc/limit-logger.ts`).** When a cap is reached the
enforcement site calls `limitLogger.hit('<Limits field>', detail?)` so an operator
can see a scene/peer hammering a ceiling. Emission is THROTTLED — at most once per
interval PER KEY, with a suppressed-count on the next emission — because an unthrottled
log per hit would itself be an amplification vector (a scene tripping a cap every frame
would flood stdout). The throttle key is restricted to `keyof Limits` so the per-key
state map stays bounded; scene/peer-controlled context (url, size, peer id) goes in the
free-form `detail`, never the key, and `detail` is length-capped and sanitized at emit
(control chars collapsed so a crafted value can't fake extra log lines, URL userinfo
redacted). Isolate-side caps (`maxHostCallArgBytes`, `maxInflightHostCalls`) report via
a `__reportLimit` `ivm.Reference` (fire-and-forget `applyIgnored`, captured+deleted
from the isolate global like `console`), validated host-side against the known key
set, AND throttled in-shim per key per interval — host throttling bounds emission,
not the cross-isolate callback volume, so a scene hammering a cap must not enqueue
one host task per rejected call. Wire a new cap by
adding a `limitLogger.hit(...)` at its drop/reject/truncate site. Not every knob is a
discrete hit: frame-pacing/shutdown/raycast are cooperative yields (not logged);
`profileFetchCooldownMs` is normal debounce (deliberately not logged);
`fetchTimeoutMs`/`fetchRetries` already log per-failure inside `robustFetch`;
`livekitConnectTimeoutMs`/`wsHandshakeTimeoutMs` surface as ordinary connection
errors; `isolateMemoryLimitBytes` is a fatal V8 abort (no hook to log from); and
`maxSyncExecutionMs` is logged only on the pump/`disposeOnTimeout` path — an
onStart/onUpdate/eval sync-turn timeout raises its error without a limit log.

## Project Architecture

This is the **Hammurabi Server** - a headless implementation of the Decentraland protocol that runs entirely in Node.js without browser dependencies.

### Core Architecture Components

**Engine Entry (`src/lib/engine-main.ts`)**
- Creates Babylon.js NullEngine (no WebGL/canvas)
- Generates guest identity for authentication
- Fetches realm configuration from `/about` endpoint
- Routes to local or remote scene loading based on realm URL
- Manages all subsystems initialization

**Scene Loading System (`src/lib/babylon/scene/load.ts`)**
- `loadSceneContextFromLocal`: Local development with hot reload via file watching
- `loadSceneContextFromPosition`: Fetches scenes from Genesis City by coordinates
- Uses content server API: `/content/entities/active` for remote scenes
- Handles scene manifests and asset URLs

**Scene Runtime (`src/lib/babylon/scene/`)**
- `SceneContext`: Central state manager for CRDT messages and entity lifecycle
- `BabylonEntity`: Component-based wrapper around Babylon.js objects
- Scene code runs inside an **isolated-vm (V8 isolate) sandbox**
  (`src/lib/isolated-vm/`), communicating with the host only over `@dcl/rpc` on a
  `MemoryTransport`. This is the security boundary: scene code is untrusted
  (authored by scene deployers) and the isolate is a FRESH V8 realm with no access
  to Node globals (`process`, `require`, host `Function`/`eval`), so it cannot read
  the worker's private key or execute host code. The isolate is bounded by a memory
  ceiling and a per-turn execution deadline (`withIsolatedVm`). Migrated from
  QuickJS (a no-JIT WASM interpreter ~90× slower than V8) so physics-heavy scenes
  stopped blowing the per-turn watchdog; the engine seam is engine-agnostic
  (`common-runtime/types.ts` `RunWithVmOptions`/`ProvideOptions`).
- DO NOT run scene code via `new Function`/`eval` in the host realm. A previous
  `with (proxy)` + allowlist "sandbox" was removed because it was trivially
  escapable (`Function('return this')()` reaches the real global); all scene
  execution must go through the isolated-vm runtime.
- **Never hand a host object/function INTO the isolate directly** — only as an
  `ivm.Reference` wrapped by an in-realm shim. A bare host function placed on the
  isolate global leaks the host `Function` constructor via `.constructor` (the
  classic `vm`-context escape). Every host capability (`console`, `require`,
  `fetch`, `WebSocket`, `setImmediate`) is installed as a Reference whose raw
  handle is captured in an IIFE closure and `delete`d from the isolate global, so
  scene code only sees the standard-shaped wrapper. Data crosses via structured
  copy (`{ arguments/result: { copy: true } }`), which carries `Uint8Array`.
- Scene-facing capability APIs (`~system/SignedFetch`, `~system/UserIdentity`)
  use a separate **unprivileged guest identity** (`sceneIdentity`), never the
  server's authoritative identity, and `SignedFetch` enforces an SSRF egress
  guard (`src/lib/misc/ssrf.ts`).
- **Hard OOM containment depends on the DEPLOYMENT (a supervisor spawns+restarts
  these processes).** isolated-vm's `memoryLimit` is best-effort: incremental/
  array-backed growth is caught (a catchable "Isolate was disposed … due to memory
  limit"), but a hash-table rehash (`new Map(); while(true) m.set('k'+i++, i)`, a
  dict object with string keys, or a `Set`) makes V8 hit a FATAL OOM (`abort()`/
  SIGABRT) in one allocation before the interrupt-based limit can fire — crashing
  the whole process. QuickJS's allocator threw a catchable OOM instead, so a
  single-process runtime contained this; isolated-vm does not, and a host-side
  heap-poll watchdog does NOT help (`getHeapStatisticsSync` blocks on the isolate
  lock a synchronous fill holds, and the jump to fatal is too fast). This is
  ACCEPTABLE only because the process is one-scene-per-process under a supervisor
  that restarts on exit — the crash is contained to that scene's process. A
  co-hosted-scenes deployment would need real per-scene process isolation. Do not
  claim the memory ceiling alone contains a hostile scene.
- **Process lifecycle & graceful shutdown (`misc/shutdown.ts`, do not weaken).**
  Calling `process.exit()` — or disposing a scene isolate — WHILE a turn runs on
  the isolate's native thread races teardown and SIGSEGVs (~100% mid-turn, 0% idle;
  pinned by `test/lib/misc/shutdown.spec.ts` + PoCs). So comms-loss
  (`engine-main.ts` DISCONNECTION) and SIGTERM/SIGINT (`cli.ts`, production only) go
  through `runGracefulShutdown`: it runs the shutdown hook (dispose scene → its RPC
  transport closes → the scene's update loop exits BETWEEN turns → `withIsolatedVm`
  disposes the now-idle isolate → LiveKit disconnects), drains briefly, then exits.
  For a SIGNAL it re-raises the default signal (crash-free OS termination); for a
  non-signal it `process.exit`s a distinct `EXIT_CODES` value (COMMS_LOST/CONFIG/
  STARTUP) so the supervisor can distinguish transient from permanent faults. Never
  hard-`exit()` or force-`dispose()` a running turn. (Residual: a scene stuck in a
  long turn when comms drops can still crash after the drain — rare; the sync/async
  deadlines bound turn length.) Note: `uncaughtException`/`unhandledRejection`
  handlers currently keep the process alive (log-only) — under a restart supervisor
  a genuinely-fatal one arguably should exit; left as a deliberate policy choice.
- **Untrusted-input bounds (do not remove).** Scene CRDT/assets and remote-peer
  comms are parsed in HOST code, outside the isolate's limits, so these caps are
  load-bearing:
  the CRDT reader (`crdt-wire-protocol/message.ts` `readAllMessages`) must never
  spin on an unknown/zero-length message (host hang), and `crdtMessageProtocol.ts`
  rejects a declared length shorter than the 8-byte header; `scene-context.ts`
  caps live entities, delete-tombstones, and CRDT payload size / queue depth;
  `connect-context-rpc.ts` `sendBinary` caps peers/messages/size to bound
  scene→LiveKit amplification, and its `signedFetch` follows redirects MANUALLY,
  re-running the SSRF guard on every hop (fetch would otherwise auto-follow a
  redirect onto a private host) — the realm's OWN origin is exempt from the
  guard (operator-supplied via CLI, not scene-controlled; local preview serves
  the scene's storage endpoints from localhost, which the guard would block);
  `connect-context-rpc.ts` registers services through a drift-tolerant wrapper
  because @dcl/protocol is resolved at user-install time and may declare methods
  this server doesn't implement — a missing method must degrade to a rejecting
  stub, never fail the whole module load (@dcl/rpc binds every declared
  method); both `scene.update()` and `scene.lateUpdate()`
  are wrapped in try/catch (`update-scheduler.ts`) so a malformed CRDT can't crash
  the shared render loop; the XHR polyfill caps response size and treats non-2xx
  as an error (never feeds an error body to the native glTF parser);
  `coerceMaybeU8Array` guards null / caps size; `AssetManager.readFile` caps the
  body at 64MB via `readBodyCappedBytes` (reachable by scene code through the
  `~system/Runtime.readFile` RPC + auto-reads `main.crdt`). Every host fetch that
  buffers a body must go through `readBodyCapped(Bytes)` — never a raw
  `.json()`/`.arrayBuffer()` (the World `/scenes` fetch and `misc/json.ts` are
  capped for this reason). `resolveFile` (`content-server-entity.ts`) validates the
  deployer-controlled content hash is an alphanumeric CID before it's concatenated
  into a fetch URL — a `../`-bearing hash would otherwise WHATWG-normalize into a
  path traversal on the realm origin. Scene→LiveKit `sendBinary` caps peers,
  messages, per-message size AND the per-message destination-identities list.
  Inbound comms: `CommsTransportWrapper.handleMessage` drops oversized packets and
  rate-limits per peer before decoding; the avatar system dedupes + rate-limits
  per-peer profile fetches (`avatar-communication-system.ts`) to bound Catalyst
  amplification, drops non-finite peer transforms, and caps its tombstone map.
- **isolated-vm execution deadline (`isolated-vm/index.ts`).** Each synchronous
  turn (eval / onStart / onUpdate's sync part / each setImmediate drain) is bounded
  by a `timeout` on `evalSync` / `ref.apply`; on overrun V8 terminates and
  DISPOSES the isolate. There is no per-turn "resume" like QuickJS — a runaway turn
  kills the scene, which matches QuickJS's net effect (its interrupt also tore the
  runtime down). A separate host-side `Promise.race` (`runTurn`) bounds a
  never-settling onStart/onUpdate promise — the async-turn timeout, unchanged
  message `scene async turn exceeded {ms}ms`. `require()` results are cached per
  module name so the host factory runs once. **Load-bearing (do not weaken):** the
  isolate `timeout` bounds only the *synchronous* part of a turn — an
  `await hostPromise; while(true){}` continuation runs in isolated-vm's *untimed*
  microtask checkpoint on a background thread. The async-turn watchdog is what
  catches it, and it can only fire if the host main thread stays free — so the
  main-thread pumps (setImmediate drain `globals.ts`, WebSocket dispatch
  `network-globals.ts`) MUST use async `apply`, never `applySync` (which blocks the
  main thread on the isolate lock a wedged continuation holds). Those pumps also
  `isolate.dispose()` on a deadline error instead of swallowing it, so a runaway
  *synchronous* setImmediate/onmessage callback tears the scene down instead of
  re-freezing the host every tick.
- **isolated-vm teardown & hot-reload shutdown (do not weaken).** Teardown is
  simple compared to QuickJS (no shared WASM module to poison, no handle-leak
  `JS_FreeRuntime` abort): `withIsolatedVm`'s `finally` closes host resources
  FIRST (WebSocket `closeAll`, the setImmediate `setInterval`, `fetch`
  AbortControllers) so no late callback dispatches into a disposed isolate, then
  `isolate.dispose()`. Every step is individually throw-proofed so one failure
  can't skip `isolate.dispose()`. `SceneContext` owns the scene's RPC transports
  (`registerRpcTransport`): `dispose()` closes them (ending the runtime's update
  loop) and resolves `stopped` in a `finally` — new runtime flavors must register
  their transport instead of hooking `stopped` at the call site. Shutdown vs.
  scene failure is classified by `isTransportClosedError` (`common-runtime/game-loop.ts`),
  which matches @dcl/rpc's `'RPC Transport closed'` rejection and is pinned by a
  contract test against the real library — update both together if the message
  ever changes.
- **Binary marshalling (`isolated-vm/globals.ts` / `network-globals.ts`).**
  Request/response objects cross the boundary via isolated-vm's structured copy
  (`{ arguments/result: { copy: true } }`), which carries `Uint8Array` (and nested
  plain objects/arrays) natively — no per-handle plumbing, no nonce placeholders.
  A real typed array is serialized by its internal slots, so prototype poisoning
  (`Uint8Array.prototype`, `Symbol.species`, `Array.isArray`) can't change the
  bytes the host receives (pinned by `deadline.spec.ts`). NOTE: structured copy
  DOES invoke an object's own getters during serialization, but they run in the
  ISOLATE realm (bounded by the isolate), not the host — a scene passing an object
  with a throwing getter to a host method just makes that copy (and its RPC call)
  reject. `coerceMaybeU8Array` (`common-runtime/marshal-utils.ts`) is defense in
  depth for the documented byte-keyed-object fallback and caps its size. Host
  functions/live objects CANNOT be copied, so `fetch` returns fully-read plain
  data (`{ok,status,headers,bodyText,bodyBytes}`) rebuilt into a Response in-realm,
  and `WebSocket` uses a numeric-id registry with sync host References for live
  reads (`bufferedAmount`, `binaryType`).
  **Load-bearing host-copy caps (`globals.ts` require shim):** structured copy
  duplicates the argument into HOST memory *before* any host code runs, so the 16MB
  per-call byte cap and the in-flight concurrency cap are enforced INSIDE the
  isolate before `hostCall.apply` — a host-side check is too late. The arg is
  deep-CLONED to inert data ONCE (every getter read a single time) and the CLONE is
  sent: measuring the live arg then letting `copy: true` re-read it is a TOCTOU hole
  (a size-changing getter bypasses the cap), and the clone/measure primitives
  (`Object.keys`, `ArrayBuffer.isView`, the byteLength getters) are captured BEFORE
  scene code runs so prototype/global poisoning can't make the measurement
  undercount what V8 copies. Without these a scene amplifies isolate-bounded data
  into unbounded host OOM. Host-side Reference callbacks also strip their error
  `.stack` (`sanitizeHostError`) so host paths don't leak via `err.stack`, and
  `console` truncates oversized string args.
- **Scene bundle evaluation (`isolated-vm/rpc-scene-runtime.ts`).** The scene main
  file is decoded on the HOST (the isolate has no `TextDecoder`) and evaluated
  inside a CommonJS-style function wrapper (`wrapSceneBundle`), NOT as a raw global
  script. Reference runtimes do the same and scenes depend on it: a top-level
  `var` in the bundle must not become a `globalThis` property (e.g. the SDK's
  `var DEBUG_NETWORK_MESSAGES = () => globalThis.DEBUG_NETWORK_MESSAGES ?? false`
  vs. the documented `globalThis.DEBUG_NETWORK_MESSAGES = true` debug flag —
  global-scope eval lets the flag overwrite the function and the scene crashes
  with "not a function" when a player joins). The wrapper is single-line so
  bundle stack-trace line numbers are preserved.
- Scene assets can only be fetched from the scene's own content manifest
  (`baseUrl + content-hash`); arbitrary-URL/host asset fetches are not possible,
  and only the glTF/GLB loader is registered.
- Entity ID allocation: 1 for local player, 32-255 for remote players

**Communications System**
- **LiveKit Transport** (`src/lib/decentraland/communications/transports/livekit.ts`)
  - Uses `@livekit/rtc-node` for Node.js WebRTC
  - Room connection without browser APIs
  - Handles `connectionState` instead of browser `state` property
  - A single `publishData` failure is logged-and-dropped, NOT treated as a
    disconnect — position/movement publish at ~30Hz, and turning one transient
    glitch into `doDisconnect` made a flaky SFU cause restart storms. Real
    connection loss surfaces via `connectionState` + `RoomEvent.Disconnected`.
  - `connect()` is bounded by `CONNECT_TIMEOUT_MS` (the FFI `waitFor` has none, so a
    half-open SFU would hang the supervised process forever), and a failed connect
    removes our room listeners (best-effort) to avoid leaking them on dev reconnect.
- **Adapter System** (`src/lib/decentraland/communications/connect-adapter.ts`)
  - `connectLocalAdapter`: Local preview via comms-gatekeeper
  - `connectGenesisAdapter`: Production Genesis City connections
  - `connectProductionAdapter`: Flexible production realm connections
  - Protocol support: livekit, ws-room, offline, signed-login
- **Comms Gatekeeper URLs**:
  - Local: `https://comms-gatekeeper-local.decentraland.org`
  - Production: `https://comms-gatekeeper.decentraland.zone`
- **Comms transport routing** (`communications/comms-routing.ts` + `comms-router.ts`)
  - LiveKit is the default and carries every message type. `HAMMURABI_COMMS_PROTOCOL=pulse`
    ADDITIONALLY runs Pulse alongside LiveKit and routes Pulse's capability set
    (`CAPABILITIES.pulse`, currently just `position`) through it — Pulse AUGMENTS LiveKit,
    it does not replace it (Pulse is receive-only: no scene MessageBus / profile / chat).
  - `resolveRouting(pulseEnabled)` picks one owner per listener and connects ONLY the
    transports that own something; `CommsRouter` forwards each typed event from its owning
    transport into one merged stream the avatar system + scene context consume unchanged.
  - To move a message type onto Pulse: add it to `CAPABILITIES.pulse` AND teach `PulseAdapter`
    to emit it. The downstream handler is transport-agnostic — do NOT fork per-transport
    handlers. `position` intentionally includes `movement` (both encode "where a peer is"),
    so the two can't split across transports and fight over a peer's Transform.

**RPC Services (`src/lib/babylon/scene/connect-context-rpc.ts`)**
- Scene-kernel communication via RPC protocol
- Service definitions: Runtime, Permissions, UserIdentity, PortableExperiences, CommsApi
- CRDT message passing between scene and kernel

**CLI Interface (`src/cli.ts`)**
- Command-line argument parsing: `--realm`, `--position`, `--scene-id`, `--private-key`, `--env`, `--production`
- XMLHttpRequest polyfill for Babylon.js GLTF loading
- Global error handlers that keep server running
- Restart listener for 'r' key during development

### Technical Details

**Node.js Requirements**
- Version 18+ (uses native fetch API)
- No DOM polyfills needed
- Custom XMLHttpRequest implementation for asset loading

**Babylon.js Adaptations**
- Always uses NullEngine (no rendering)
- Avatar system without UI textures when OffscreenCanvas unavailable
- Simplified materials and lighting for headless mode
- All packages pinned to version 6.4.1 for compatibility

**Build System**
- TypeScript compilation to `dist/` folder
- esbuild creates `dist/worker-bundle.cjs` for CommonJS compatibility
- Worker bundle excludes native modules and Node.js built-ins
- Production builds include minification and tree-shaking

## Key Implementation Notes

**Position Parameter**
- Format: `--position=x,y` for Genesis City coordinates
- Required for remote realms, not for localhost
- Fetches scene from content server's active entities

**Realm Detection**
- localhost/127.0.0.1: Uses local scene loading with hot reload
- Other URLs: Requires position parameter for remote scene fetching
- Default realm: `https://peer.decentraland.org` for Genesis City

**Error Resilience**
- Global uncaught exception handlers prevent crashes
- Scene errors logged but don't stop server
- Communications failures handled gracefully

**Development Mode**
- Hot reload via file watching for local scenes
- Nodemon integration for source code changes
- Press 'r' to manually restart during development

## GitHub Actions Publishing

The `.github/workflows/build-release.yaml` workflow:
- Triggers on main branch pushes, PRs, and releases
- Uses `decentraland/oddish-action@master` for npm publishing
- Creates snapshot versions for PR testing
- Publishes to `@dcl/hammurabi-server` on npm