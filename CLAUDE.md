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
```

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
- Scene code runs inside a **QuickJS (WASM) sandbox** (`src/lib/quick-js/`),
  communicating with the host only over `@dcl/rpc` on a `MemoryTransport`. This
  is the security boundary: scene code is untrusted (authored by scene
  deployers) and the QuickJS interpreter gives it no access to Node globals
  (`process`, `require`, host `Function`/`eval`), so it cannot read the worker's
  private key or execute host code. The VM is bounded by memory / stack ceilings
  and a per-turn execution deadline (`withQuickJsVm`).
- DO NOT run scene code via `new Function`/`eval` in the host realm. A previous
  `with (proxy)` + allowlist "sandbox" was removed because it was trivially
  escapable (`Function('return this')()` reaches the real global); all scene
  execution must go through the QuickJS runtime.
- Scene-facing capability APIs (`~system/SignedFetch`, `~system/UserIdentity`)
  use a separate **unprivileged guest identity** (`sceneIdentity`), never the
  server's authoritative identity, and `SignedFetch` enforces an SSRF egress
  guard (`src/lib/misc/ssrf.ts`).
- **Untrusted-input bounds (do not remove).** Scene CRDT/assets and remote-peer
  comms are parsed in HOST code, outside the VM's limits, so these caps are
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
  `coerceMaybeU8Array` guards null / caps size.
  Inbound comms: `CommsTransportWrapper.handleMessage` drops oversized packets and
  rate-limits per peer before decoding; the avatar system dedupes + rate-limits
  per-peer profile fetches (`avatar-communication-system.ts`) to bound Catalyst
  amplification, drops non-finite peer transforms, and caps its tombstone map.
- **QuickJS execution deadline (`quick-js/index.ts`).** The per-turn deadline is
  reset at the START of every synchronous entry into the VM (eval / onStart /
  onUpdate / each setImmediate callback / each `executePendingJobs`), NOT
  cumulatively — a time-based "reset on gap" heuristic false-kills long-lived
  scenes once the sum of their turns crosses the budget. A separate async-turn
  timeout bounds a never-settling onUpdate promise. `require()` results are
  cached so repeated calls don't leak host handles; VM teardown always disposes
  even if job-draining times out.
- **QuickJS teardown & hot-reload shutdown (do not weaken).** Any host-side
  handle still alive at `vm.dispose()` aborts JS_FreeRuntime in the release WASM
  build, and any Emscripten abort permanently poisons the process-wide cached
  WASM module. The recovery in `withQuickJsVm` therefore drops the module cache
  on the error TYPE (`WebAssembly.RuntimeError`, via `classifyTeardownError`) —
  never narrow it back to matching the assert message, JS_FreeRuntime has many
  asserts besides `gc_obj_list`. `vm.alive` is STALE-TRUE after a throwing
  `vm.dispose()` (the library flips `_alive` only after the disposer returns),
  so teardown-race guards must use host-controlled state (`PromiseTracking.tornDown`,
  `safeDispose`), never `vm.alive` alone; every step of the teardown `finally`
  is individually throw-proofed so a poisoned module can't skip `clearInterval`
  or mask the scene's failure. `SceneContext` owns the scene's RPC transports
  (`registerRpcTransport`): `dispose()` closes them (ending the runtime's update
  loop) and resolves `stopped` in a `finally` — new runtime flavors must register
  their transport instead of hooking `stopped` at the call site. Shutdown vs.
  scene failure is classified by `isTransportClosedError` (`common-runtime/game-loop.ts`),
  which matches @dcl/rpc's `'RPC Transport closed'` rejection and is pinned by a
  contract test against the real library — update both together if the message
  ever changes.
- **Binary marshalling (`quick-js/convert-handles.ts`).** Uint8Arrays cross the
  VM boundary through the WASM ArrayBuffer APIs (`newArrayBuffer` /
  `getArrayBuffer`), NOT as JSON text — the JSON detour measured 2-3 orders of
  magnitude slower and silently corrupted nested payloads (empty `sendBinary`).
  The VM-side classifier/wrapper helpers are compiled BEFORE any scene code runs
  and their handles are host-private (never exposed on the VM global), so a
  scene cannot see or replace what the host calls to read its values. Binary
  detection is the `%TypedArray%.prototype.buffer` getter — an unspoofable
  internal-slot check (a `Symbol.toStringTag` brand is scene-controllable), and
  the copy goes through ArrayBuffer/typed-array views only so no scene code runs
  while marshalling. Every primordial the helpers touch (that buffer getter plus
  byteOffset/byteLength, `Object.keys`, `Array.isArray`) is captured at install
  time so prototype poisoning can't forge host-side bytes, and the placeholder
  that marks an extracted buffer in the dumped tree uses a per-VM random nonce
  key the scene can't predict or forge. Per-payload (16MB) and per-value (4096
  buffers) caps bound host allocations; these are load-bearing.
- **Scene bundle evaluation (`quick-js/rpc-scene-runtime.ts`).** The scene main
  file is evaluated inside a CommonJS-style function wrapper, NOT as a raw global
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
- **Adapter System** (`src/lib/decentraland/communications/connect-adapter.ts`)
  - `connectLocalAdapter`: Local preview via comms-gatekeeper
  - `connectGenesisAdapter`: Production Genesis City connections
  - `connectProductionAdapter`: Flexible production realm connections
  - Protocol support: livekit, ws-room, offline, signed-login
- **Comms Gatekeeper URLs**:
  - Local: `https://comms-gatekeeper-local.decentraland.org`
  - Production: `https://comms-gatekeeper.decentraland.zone`

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