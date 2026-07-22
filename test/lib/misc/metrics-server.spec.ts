import { Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { startMetricsServer } from '../../../src/lib/misc/metrics-server'
import { metrics } from '../../../src/lib/misc/metrics'

describe('startMetricsServer', () => {
  describe('when HAMMURABI_METRICS_PORT is unset (the default)', () => {
    it('does not start a server', () => {
      expect(startMetricsServer({})).toBeUndefined()
      expect(startMetricsServer({ HAMMURABI_METRICS_PORT: '' })).toBeUndefined()
    })
  })

  describe('when HAMMURABI_METRICS_PORT is not a valid port', () => {
    let errorSpy: jest.SpyInstance

    beforeEach(() => {
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
      errorSpy.mockRestore()
    })

    it('logs and stays disabled instead of throwing', () => {
      expect(startMetricsServer({ HAMMURABI_METRICS_PORT: 'abc' })).toBeUndefined()
      expect(startMetricsServer({ HAMMURABI_METRICS_PORT: '70000' })).toBeUndefined()
      expect(startMetricsServer({ HAMMURABI_METRICS_PORT: '80.5' })).toBeUndefined()
      expect(errorSpy).toHaveBeenCalledTimes(3)
    })
  })

  describe('when enabled on an ephemeral port', () => {
    let server: Server
    let baseUrl: string

    beforeAll(async () => {
      server = startMetricsServer({ HAMMURABI_METRICS_PORT: '0' })!
      expect(server).toBeDefined()
      await new Promise<void>((resolve) => server.once('listening', resolve))
      const { port } = server.address() as AddressInfo
      baseUrl = `http://127.0.0.1:${port}`
    })

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    it('is idempotent: a second start returns the same server', () => {
      expect(startMetricsServer({ HAMMURABI_METRICS_PORT: '0' })).toBe(server)
    })

    it('serves /health as JSON with uptime, realm and comms state', async () => {
      const res = await fetch(`${baseUrl}/health`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/json')
      const body = await res.json()
      expect(body.status).toBe('ok')
      expect(typeof body.uptimeSeconds).toBe('number')
      expect(body.realm).toBeNull()
      expect(Array.isArray(body.sceneIds)).toBe(true)
      expect(body.comms).toBe('NONE')
    })

    it('serves /metrics in Prometheus text format 0.0.4', async () => {
      metrics.counter('hammurabi_spec_probe_total', 'metrics-server spec probe').inc(3)
      const res = await fetch(`${baseUrl}/metrics`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8')
      const body = await res.text()
      expect(body).toContain('# TYPE hammurabi_process_uptime_seconds gauge')
      expect(body).toContain('# TYPE hammurabi_process_resident_memory_bytes gauge')
      expect(body).toContain('hammurabi_spec_probe_total 3\n')
      const rss = body.match(/^hammurabi_process_resident_memory_bytes (\d+)$/m)
      expect(Number(rss?.[1])).toBeGreaterThan(0)
    })

    it('returns 404 for unknown paths and 405 for non-GET methods', async () => {
      expect((await fetch(`${baseUrl}/nope`)).status).toBe(404)
      expect((await fetch(`${baseUrl}/metrics`, { method: 'POST' })).status).toBe(405)
    })
  })
})
