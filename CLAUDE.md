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
node dist/cli.js --realm=localhost:8000 --authenticated
npx @dcl/hammurabi-server --position=0,0  # Default to peer.decentraland.org
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
- In-process WebWorker using QuickJS with MemoryTransport (no actual worker threads)
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
- Command-line argument parsing: `--realm`, `--position`, `--authenticated`
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