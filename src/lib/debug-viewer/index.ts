import * as http from 'http'
import * as BABYLON from '@babylonjs/core'
import { WebSocketServer, WebSocket } from 'ws'
import type { SceneContext } from '../babylon/scene/scene-context'
import { buildSnapshot } from './snapshot'
import { VIEWER_PAGE_HTML } from './page'
import { createLogger, createRateLimitedErrorLogger } from '../misc/logger'

const logger = createLogger('debug-viewer')

const DEFAULT_PORT = 8080
const DEFAULT_HZ = 15
// Per-snapshot entity cap (see buildSnapshot). 5k entities is far more than any
// real scene renders and still bounds the serialization cost of a hostile one.
const MAX_ENTITIES_PER_SNAPSHOT = 5000
// A viewer that stops reading (paused tab, slow link) must not become a memory
// leak in the authoritative process: skip sends while its socket is behind.
const MAX_BUFFERED_BYTES = 1024 * 1024
// Bounds the fan-out cost of a snapshot. This is a single-developer debug tool.
const MAX_CLIENTS = 4

export type DebugViewerHandle = {
  readonly port: number
  close(): void
}

export type DebugViewerOptions = {
  babylonScene: BABYLON.Scene
  scenes: () => Iterable<SceneContext>
}

/**
 * Parse HAMMURABI_DEBUG_VIEWER. Accepts a port, or a boolean-ish value meaning
 * "on, at the default port" — matching the HAMMURABI_XHR_DEBUG convention that
 * only 1/true/yes/on enable a debug feature, so `=0`/`=false` read as off.
 * Exported for tests.
 */
export function parseViewerPort(value: string | undefined): number | null {
  const normalized = (value ?? '').trim().toLowerCase()
  if (!normalized) return null
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return DEFAULT_PORT
  if (['0', 'false', 'no', 'off'].includes(normalized)) return null
  const port = Number(normalized)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    logger.error(`Ignoring HAMMURABI_DEBUG_VIEWER="${normalized}": expected a port number, 1-65535`)
    return null
  }
  return port
}

function parseHz(value: string | undefined): number {
  const parsed = Number(value)
  if (!(parsed > 0)) return DEFAULT_HZ
  // Above the render rate the extra snapshots would be duplicates of the same
  // frame; below 1Hz it stops being a live view.
  return Math.min(Math.max(parsed, 1), 60)
}

/**
 * An opt-in, read-only window into the host's own scene graph — the entities,
 * world transforms, colliders and avatar capsules exactly as the authoritative
 * server holds them. This is deliberately NOT the same thing as watching a
 * client connected to the same room: a client renders its own reconstruction of
 * what the scene chose to sync, so it cannot show server-only entities or a
 * server/client divergence, which are the two things worth looking at.
 *
 * Constraints this must keep:
 * - OFF unless HAMMURABI_DEBUG_VIEWER is set, and loopback-only by default. The
 *   process runs untrusted scene code and the snapshot exposes scene content, so
 *   binding a listener on a public interface is an explicit operator decision.
 * - Never able to break the render loop. Every callback is throw-proofed; a
 *   failure here logs (throttled) and skips a snapshot.
 * - Zero cost with no client attached: the observer returns before touching any
 *   entity when no socket is connected.
 */
export function startDebugViewer(options: DebugViewerOptions): DebugViewerHandle | undefined {
  const port = parseViewerPort(process.env.HAMMURABI_DEBUG_VIEWER)
  if (port === null) return undefined

  const hz = parseHz(process.env.HAMMURABI_DEBUG_VIEWER_HZ)
  const host = process.env.HAMMURABI_DEBUG_VIEWER_HOST || '127.0.0.1'
  if (host !== '127.0.0.1' && host !== 'localhost') {
    logger.error(
      `⚠️  Binding the debug viewer to ${host} exposes this scene's live state to the network. ` +
        `Only do this on a trusted network.`
    )
  }

  const intervalMs = 1000 / hz
  const sockets = new Set<WebSocket>()
  const logSnapshotError = createRateLimitedErrorLogger()

  const server = http.createServer((req, res) => {
    // Exactly one route, and the body is a compile-time constant: no file
    // serving, so there is no path to traverse.
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(VIEWER_PAGE_HTML)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  })

  const wss = new WebSocketServer({ server })

  wss.on('connection', (ws) => {
    if (sockets.size >= MAX_CLIENTS) {
      ws.close(1013, 'too many viewer clients')
      return
    }
    sockets.add(ws)
    logger.log(`viewer connected (${sockets.size} client${sockets.size === 1 ? '' : 's'})`)
    ws.on('close', () => sockets.delete(ws))
    // Without a handler, a socket error would raise an 'error' event with no
    // listener — which Node turns into an uncaught exception.
    ws.on('error', () => sockets.delete(ws))
  })

  server.on('error', (err: any) => {
    // A debug tool must never take the server down. The most common failure is
    // EADDRINUSE from a previous run or a second preview; say so and carry on.
    logger.error(
      err?.code === 'EADDRINUSE'
        ? `port ${port} is already in use — the viewer is disabled for this run (the scene is unaffected)`
        : `disabled after a listener error (the scene is unaffected): ${err?.message ?? err}`
    )
  })

  server.listen(port, host, () => {
    logger.log(`👁️  watching this server's scene graph at http://${host}:${port} (${hz}Hz)`)
  })

  let lastSentAt = 0
  const observer = options.babylonScene.onAfterRenderObservable.add(() => {
    try {
      if (sockets.size === 0) return
      const now = performance.now()
      if (now - lastSentAt < intervalMs) return
      lastSentAt = now

      const payload = JSON.stringify(buildSnapshot(options.scenes(), MAX_ENTITIES_PER_SNAPSHOT))

      for (const ws of sockets) {
        if (ws.readyState !== WebSocket.OPEN) continue
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) continue
        ws.send(payload)
      }
    } catch (error: any) {
      logSnapshotError('[debug-viewer] snapshot failed (frame skipped):', error)
    }
  })

  return {
    port,
    close() {
      // Order matters on a hot reload: stop producing snapshots first, then drop
      // the clients, then release the port — the next run binds it ~100ms later.
      try {
        options.babylonScene.onAfterRenderObservable.remove(observer)
      } catch {
        /* best-effort */
      }
      for (const ws of sockets) {
        try {
          ws.close(1001, 'server restarting')
        } catch {
          /* best-effort */
        }
      }
      sockets.clear()
      try {
        wss.close()
      } catch {
        /* best-effort */
      }
      try {
        server.close()
      } catch {
        /* best-effort */
      }
    }
  }
}
