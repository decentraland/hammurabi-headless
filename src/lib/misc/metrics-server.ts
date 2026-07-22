
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { metrics } from './metrics'
import { createLogger } from './logger'
import { currentRealm, loadedScenesByEntityId } from '../decentraland/state'
import { commsStateGauge, RoomConnectionStatus } from '../decentraland/communications/CommsTransportWrapper'

const logger = createLogger('📈 metrics')

metrics.gauge('hammurabi_process_uptime_seconds', 'Process uptime in seconds', () => process.uptime())
metrics.gauge('hammurabi_process_resident_memory_bytes', 'Resident set size in bytes', () => process.memoryUsage.rss())

function healthSnapshot() {
  const realm = currentRealm.getOrNull()
  let sceneIds: string[] = []
  try {
    sceneIds = Array.from(loadedScenesByEntityId.values(), (ctx) => ctx.loadableScene.urn)
  } catch {
  }
  return {
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    realm: realm?.connectionString ?? null,
    realmBaseUrl: realm?.baseUrl ?? null,
    sceneIds,
    comms: RoomConnectionStatus[commsStateGauge.get()] ?? 'NONE'
  }
}

export function metricsRequestListener(req: IncomingMessage, res: ServerResponse): void {
  try {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain' }).end('method not allowed')
      return
    }
    const path = (req.url ?? '').split('?')[0]
    if (path === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }).end(metrics.render())
    } else if (path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(healthSnapshot()))
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    }
  } catch (err: any) {
    logger.error(`request failed: ${err?.message ?? err}`)
    try {
      res.writeHead(500).end()
    } catch {
    }
  }
}

let started: Server | undefined

export function startMetricsServer(env: NodeJS.ProcessEnv = process.env): Server | undefined {
  if (started) return started
  const raw = env.HAMMURABI_METRICS_PORT
  if (raw === undefined || raw.trim() === '') return undefined
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    logger.error(`HAMMURABI_METRICS_PORT="${raw}" is not a valid port; metrics endpoint disabled`)
    return undefined
  }
  const server = createServer(metricsRequestListener)
  server.on('error', (err) => logger.error(`server error: ${err.message}`))
  server.listen(port, '0.0.0.0', () => {
    const address = server.address() as AddressInfo | null
    logger.log(`serving /health and /metrics on 0.0.0.0:${address?.port ?? port}`)
  })
  server.unref()
  started = server
  return server
}
