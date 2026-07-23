# Hammurabi Headless


A headless Node.js implementation of the Decentraland protocol using Babylon.js for 3D scene processing.

This server can run Decentraland scenes in a headless environment, making it perfect for:
- **Server-side simulation** of Decentraland worlds
- **Multiplayer backend** processing with LiveKit communications  
- **Scene validation** and testing infrastructure
- **Headless bots** and automated agents
- **Performance testing** without browser overhead

## Features

- 🏃‍♂️ **Headless 3D Processing** - Full Babylon.js scene simulation without rendering
- 🌐 **LiveKit Communications** - Real multiplayer support via Node.js LiveKit SDK
- 🤖 **Scene Execution** - Runs Decentraland SDK7 scenes with full ECS support
- 🔧 **Asset Loading** - GLTF models, textures, and colliders for spatial logic
- 🎮 **Avatar System** - Multiplayer player management without visual rendering
- 🔄 **Hot Reload** - Development server with automatic scene updates
- ⚡ **Error Resilient** - Continues running despite scene errors

## Installation

### Global Installation
```bash
npm install -g @dcl/hammurabi-server
hammurabi --realm=localhost:8000
```

### Local Development
```bash
git clone https://github.com/decentraland/hammurabi
cd hammurabi
npm install
npm run build
./hammurabi --realm=localhost:8000
```

## Usage

### Basic Server
```bash
# Connect to local development realm
hammurabi --realm=localhost:8000

# Connect to remote realm
hammurabi --realm=https://sdk-team-cdn.decentraland.org
```

### Programmatic Usage
```typescript
import { main } from '@dcl/hammurabi-server'

const scene = await main({
  realmUrl: 'localhost:8000'
})

console.log('Headless scene running:', !!scene)
```

## Architecture

### Headless Components
- **Babylon.js NullEngine** - 3D processing without GPU rendering
- **Isolated Scene Runtime** - Untrusted scene code runs in a per-scene V8 isolate (isolated-vm)
- **LiveKit Node.js SDK** - Multiplayer communications
- **Asset Manager** - GLTF loading with collider support
- **Avatar Renderer** - Multiplayer entities without UI textures

### Scene Support  
- **ECS7 Scenes** - Full Decentraland SDK7 compatibility
- **Component Systems** - Transform, mesh, avatar, pointer events
- **CRDT Protocol** - Entity state synchronization
- **Asset Loading** - Models, textures, audio (headless)
- **Spatial Queries** - Raycasting and collision detection

## Development

### Build
```bash
npm run build      # Compile TypeScript
npm run test       # Run test suite  
npm start          # Start development server
```

## Configuration

At startup the server automatically creates a guest identity, fetches realm
configuration from the realm's `/about` endpoint, establishes a LiveKit room for
multiplayer communications, loads and executes scene scripts in the isolated
runtime, and processes CRDT messages for entity synchronization.

Behavior is controlled by **command-line arguments** and **environment variables**.
All environment variables are optional; each resource limit defaults to the value
shown, so default behavior is unchanged unless you set the variable.

### Command-line arguments

| Argument | Description |
| --- | --- |
| `--realm=<url>` | Realm URL to connect to. Default: `localhost:8000` for local, `peer.decentraland.org` for a `--position`. May be a `.dcl.eth` World name (e.g. `boedo.dcl.eth`). |
| `--position=<x,y>` | Parcel coordinates to fetch the scene from the content server (required for Genesis City). |
| `--scene-id=<hash>` | Target scene entity hash for multi-scene Worlds. When omitted, the first scene in the World's `about.json` is loaded. |
| `--private-key=<hex>` | Private key for authentication (hex, with or without `0x`). Also settable via the `PRIVATE_KEY` env var. |
| `--env=<zone\|org>` | Decentraland services environment. `org` = production (`decentraland.org`), `zone` = development (`decentraland.zone`). Default: `org`. |
| `--production` | Run without interactive controls and exit non-zero on failed startup (for process spawning). |
| `--help`, `-h` | Show usage help. |

```bash
hammurabi --realm=localhost:8000
hammurabi --position=80,80
hammurabi --position=80,80 --env=zone
hammurabi --realm=boedo.dcl.eth
hammurabi --position=0,0 --private-key=0x<your-hex-key>
PRIVATE_KEY=0x<your-hex-key> hammurabi --position=0,0
```

### General environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PRIVATE_KEY` | _(generated guest identity)_ | Private key for authentication (hex). Equivalent to `--private-key`. |
| `HAMMURABI_FPS` | `30` | Renderer tick rate, clamped to `[1, 60]`. |
| `HAMMURABI_XHR_DEBUG` | `off` | Per-request asset-fetch logging. Enable with `1`/`true`/`yes`/`on`. |

### Resource & DoS limits

Every numeric cap and timeout that bounds an untrusted scene, a remote comms peer,
or a content-server response is configurable via a `HAMMURABI_*` environment
variable. Units are named in the suffix — `_MS` = milliseconds, `_BYTES` = bytes,
`_MB` = megabytes — otherwise the value is a plain count. An override that is not a
valid integer at or above the field's minimum is ignored (the default is kept) and
logged once at startup. Values are read once at process start. The single source of
truth is [`src/lib/misc/limits.ts`](src/lib/misc/limits.ts).

> These processes are typically spawned one-scene-per-process by a supervisor
> (e.g. `sdk-multiplayer-server`), which forwards the whole `HAMMURABI_*` prefix
> into each worker — so setting these on the supervisor tunes every scene worker.

#### Isolate sandbox (per-scene V8 isolate)

| Variable | Default | Description |
| --- | --- | --- |
| `HAMMURABI_ISOLATE_MEMORY_LIMIT_MB` | `256` | Per-scene isolate JS heap ceiling (MB; minimum 8). |
| `HAMMURABI_MAX_SYNC_EXECUTION_MS` | `10000` | Max wall-clock for one synchronous turn (eval / `onStart` / the sync part of `onUpdate` / a `setImmediate` drain). Overrun terminates and disposes the isolate. |
| `HAMMURABI_MAX_ASYNC_TURN_MS` | `60000` | Max wall-clock for an async turn to settle. Overrun abandons the turn and disposes the isolate. |
| `HAMMURABI_MAX_HOST_CALL_ARG_BYTES` | `16777216` | Max binary bytes in a single host-call argument (enforced in-isolate before the copy). |
| `HAMMURABI_MAX_INFLIGHT_HOST_CALLS` | `16` | Max simultaneously in-flight host calls from one scene. |
| `HAMMURABI_MAX_COERCED_BYTES` | `16777216` | Max size of a binary payload coerced from a plain object at the marshalling layer. |
| `HAMMURABI_MAX_OPEN_SOCKETS` | `32` | Max concurrent scene WebSocket connections. |
| `HAMMURABI_MAX_WS_PENDING_DISPATCH` | `256` | Max inbound WS events queued into the isolate at once (excess data frames are dropped). |

#### Scene / CRDT

| Variable | Default | Description |
| --- | --- | --- |
| `HAMMURABI_MAX_LIVE_ENTITIES` | `100000` | Max concurrent entities per scene (minimum 512). |
| `HAMMURABI_MAX_DELETED_TOMBSTONES` | `100000` | Max retained delete tombstones per scene. |
| `HAMMURABI_MAX_CRDT_PAYLOAD_BYTES` | `8388608` | Max size of a single CRDT payload sent to the renderer. |
| `HAMMURABI_MAX_INCOMING_QUEUE` | `1024` | Max queued CRDT buffers awaiting processing. |
| `HAMMURABI_MAX_NETWORK_MESSAGE_QUEUE` | `1024` | Max inbound scene-bus messages queued from peers. |
| `HAMMURABI_MAX_ECHO_DEDUPE_ENTRIES` | `8192` | Max entries in the CRDT echo-dedupe map. |

#### Inbound communications (remote peers)

| Variable | Default | Description |
| --- | --- | --- |
| `HAMMURABI_MAX_INBOUND_PACKET_BYTES` | `131072` | Max size of an inbound comms packet (larger packets are dropped). |
| `HAMMURABI_INBOUND_RATE_WINDOW_MS` | `1000` | Per-peer inbound rate-limit window. |
| `HAMMURABI_MAX_MESSAGES_PER_WINDOW` | `300` | Max inbound packets per peer per window. |
| `HAMMURABI_MAX_RATE_ENTRIES` | `4096` | Max entries in the per-peer rate-limit map. |
| `HAMMURABI_MAX_AVATAR_TOMBSTONES` | `4096` | Max avatar delete-tombstones retained. |
| `HAMMURABI_PROFILE_FETCH_COOLDOWN_MS` | `10000` | Per-peer cooldown between Catalyst profile fetches (`0` disables the cooldown). |
| `HAMMURABI_LIVEKIT_CONNECT_TIMEOUT_MS` | `30000` | Max time to establish a LiveKit connection (minimum 1000). |

#### Scene RPC capabilities

| Variable | Default | Description |
| --- | --- | --- |
| `HAMMURABI_MAX_SEND_PEERS` | `256` | Max destination peers per scene `sendBinary`. |
| `HAMMURABI_MAX_SEND_MESSAGES` | `512` | Max messages per scene `sendBinary`. |
| `HAMMURABI_MAX_COMMS_MESSAGE_BYTES` | `30000` | Max size of a single scene→comms message. |
| `HAMMURABI_MAX_SIGNED_FETCH_REDIRECTS` | `5` | Max redirects a scene `SignedFetch` follows; each hop is re-checked by the SSRF guard (`0` disables following). |

#### Fetch / network / assets / WebSocket

| Variable | Default | Description |
| --- | --- | --- |
| `HAMMURABI_FETCH_TIMEOUT_MS` | `15000` | Per-attempt host/scene fetch timeout (minimum 100). |
| `HAMMURABI_FETCH_RETRIES` | `2` | Total fetch attempts (minimum 1). |
| `HAMMURABI_MAX_BODY_BYTES` | `10485760` | Default cap for buffered HTTP response bodies (`/about`, world `/scenes`, entity JSON). |
| `HAMMURABI_MAX_ASSET_BYTES` | `67108864` | Max deployed-asset / `readFile` body size. |
| `HAMMURABI_MAX_XHR_RESPONSE_BYTES` | `67108864` | Max glTF/texture response body via the XHR polyfill. |
| `HAMMURABI_MAX_FETCH_REDIRECTS` | `5` | Max redirects the scene global `fetch` follows; each hop is re-checked by the SSRF guard (`0` disables following). |
| `HAMMURABI_MAX_CONCURRENT_FETCHES` | `32` | Max concurrent in-flight scene fetches. |
| `HAMMURABI_MAX_WS_MESSAGE_BYTES` | `1048576` | Max size of a single WebSocket frame (inbound and outbound). |
| `HAMMURABI_MAX_WS_BUFFERED_BYTES` | `8388608` | Max unflushed outbound WebSocket bytes. |
| `HAMMURABI_WS_HANDSHAKE_TIMEOUT_MS` | `15000` | Max time for a WebSocket upgrade to complete (minimum 100). |

#### Render loop / scheduling / shutdown

| Variable | Default | Description |
| --- | --- | --- |
| `HAMMURABI_MIN_FRAME_TIME_MS` | `24` | Minimum scene update-loop frame time. |
| `HAMMURABI_MS_PER_FRAME_PROCESSING_SCENE_MESSAGES` | `10` | Per-frame budget for processing scene messages. |
| `HAMMURABI_SHUTDOWN_HOOK_TIMEOUT_MS` | `2000` | Max time the graceful-shutdown hook may run before draining. |
| `HAMMURABI_SHUTDOWN_DRAIN_MS` | `1500` | Drain wait after the shutdown hook before the process exits. |

#### Raycasting

| Variable | Default | Description |
| --- | --- | --- |
| `HAMMURABI_MAX_RAYCAST_INTERSECTIONS_PER_FRAME` | `50000` | Max ray↔mesh intersection tests per frame across all of a scene's raycasts. |

## Publishing

This package is automatically published via GitHub Actions:
- **Main branch** → Latest release to npm  
- **Pull requests** → Snapshot versions for testing
- **Releases** → Tagged versions with provenance

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/amazing-feature`
3. Make changes and test: `npm run build && npm run test`
4. Create pull request - snapshots will be automatically published for testing

## License

Apache-2.0

---

**Protocol Squad** - Building the future of virtual worlds 🌐
