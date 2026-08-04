import http from 'http'
import { AddressInfo } from 'net'

/**
 * Integration check that a real enforcement site routes a cap hit through the
 * shared `limitLogger` (asserting WHICH key is reported). The throttle + emit
 * behaviour itself is unit-tested in limit-logger.spec.ts.
 *
 * IMPORTANT: this repo's jest transform is esbuild (test/jest-transformer.js),
 * which does NOT hoist `jest.mock` the way babel-jest does. A top-level
 * `import` therefore loads the REAL limit-logger before any mock runs. So we
 * `jest.resetModules()` + `jest.doMock()` and then `require()` the consumer, so
 * its transitive `import { limitLogger }` resolves to the mock.
 */
const LIMIT_LOGGER_PATH = '../../../src/lib/misc/limit-logger'
const SCENE_FETCH_PATH = '../../../src/lib/misc/scene-fetch'
const MARSHAL_UTILS_PATH = '../../../src/lib/common-runtime/marshal-utils'
const PRIMITIVE_MESHES_PATH = '../../../src/lib/babylon/scene/logic/primitive-meshes'

describe('limit logging wiring', () => {
  let server: http.Server
  let baseUrl: string

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  afterEach(() => {
    jest.dontMock(LIMIT_LOGGER_PATH)
    jest.resetModules()
  })

  it('reports the maxConcurrentFetches key when the global fetch concurrency cap is hit', async () => {
    const hit = jest.fn()
    jest.resetModules()
    jest.doMock(LIMIT_LOGGER_PATH, () => ({ limitLogger: { hit } }))
    // Require AFTER doMock so scene-fetch's transitive import binds the mock.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createSceneFetch } = require(SCENE_FETCH_PATH)

    // A hanging SSRF guard keeps the single allowed request in flight; the cap
    // check runs in the wrapper BEFORE the guard, so the rejected call never
    // touches the network. The held request settles against the localhost server
    // once released, so there are no dangling handles.
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const cappedFetch = createSceneFetch({ maxConcurrent: 1, assertPublicUrl: () => gate })

    const inflight = cappedFetch(`${baseUrl}/a`)
    try {
      await expect(cappedFetch(`${baseUrl}/b`)).rejects.toThrow(/too many concurrent/)
    } finally {
      release()
      await Promise.allSettled([inflight])
    }

    expect(hit).toHaveBeenCalledWith('maxConcurrentFetches', `${baseUrl}/b`)
  })

  it('reports the maxCoercedBytes key when a coerced payload exceeds the cap', () => {
    const hit = jest.fn()
    jest.resetModules()
    jest.doMock(LIMIT_LOGGER_PATH, () => ({ limitLogger: { hit } }))
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { coerceMaybeU8Array } = require(MARSHAL_UTILS_PATH)
    // limits.maxCoercedBytes defaults to 16MB; one byte over the cap trips it.
    const oversize = new Uint8Array(16 * 1024 * 1024 + 1)

    expect(() => coerceMaybeU8Array(oversize)).toThrow(/too large/)
    expect(hit.mock.calls[0]?.[0]).toBe('maxCoercedBytes')
  })

  // A clamped radius is silent apart from this call: the mesh is still built, still
  // pickable and still collidable, just not the size the scene asked for. Without
  // the hit an operator has no signal that a scene is feeding hostile geometry.
  it('reports the maxPrimitiveRadiusMeters key when a cylinder radius is clamped', () => {
    const hit = jest.fn()
    jest.resetModules()
    jest.doMock(LIMIT_LOGGER_PATH, () => ({ limitLogger: { hit } }))
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const BABYLON = require('@babylonjs/core')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createCylinderMesh } = require(PRIMITIVE_MESHES_PATH)

    const engine = new BABYLON.NullEngine()
    const scene = new BABYLON.Scene(engine)
    try {
      createCylinderMesh(scene, 'cylinder_collider', 1e30, 0.5)
      expect(hit.mock.calls[0]?.[0]).toBe('maxPrimitiveRadiusMeters')
    } finally {
      scene.dispose()
      engine.dispose()
    }
  })

  it('stays silent when every cylinder radius is within bounds', () => {
    const hit = jest.fn()
    jest.resetModules()
    jest.doMock(LIMIT_LOGGER_PATH, () => ({ limitLogger: { hit } }))
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const BABYLON = require('@babylonjs/core')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createCylinderMesh } = require(PRIMITIVE_MESHES_PATH)

    const engine = new BABYLON.NullEngine()
    const scene = new BABYLON.Scene(engine)
    try {
      createCylinderMesh(scene, 'cylinder_collider', 0.5, undefined)
      expect(hit).not.toHaveBeenCalled()
    } finally {
      scene.dispose()
      engine.dispose()
    }
  })
})
