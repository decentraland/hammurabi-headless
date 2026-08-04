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
const RAYCASTS_PATH = '../../../src/lib/babylon/scene/logic/raycasts'
const RAYCAST_COMPONENT_PATH = '../../../src/lib/decentraland/sdk-components/raycast-component'

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

  // The raycast ceilings report through the same throttled logger. Asserting the
  // KEY (not just that something was logged) is the point: CLAUDE.md constrains it
  // to `keyof Limits` so the per-key state map stays bounded, and the two raycast
  // keys are easy to transpose — measured, swapping them failed no test.
  it('reports the maxRaycastIntersectionsPerFrame key when one raycast spans too many colliders', () => {
    const hit = jest.fn()
    jest.resetModules()
    jest.doMock(LIMIT_LOGGER_PATH, () => ({ limitLogger: { hit } }))
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const BABYLON = require('@babylonjs/core')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { processRaycasts } = require(RAYCASTS_PATH)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { raycastComponent, raycastResultComponent } = require(RAYCAST_COMPONENT_PATH)

    const engine = new BABYLON.NullEngine()
    const scene = new BABYLON.Scene(engine)
    try {
      const plane = BABYLON.MeshBuilder.CreatePlane('p_collider', { width: 1, height: 1 }, scene)
      plane.position.set(0, 0, 50)
      plane.computeWorldMatrix(true)
      // Past the 50_000 mesh ceiling, so the mesh branch answers before any scan.
      const meshes = new Array(60_000).fill(plane)
      const raycast = {
        queryType: 0,
        continuous: false,
        timestamp: 0,
        collisionMask: undefined,
        direction: undefined,
        originOffset: undefined
      }
      processRaycasts({
        currentTick: 0,
        entityId: 'logger-spec',
        rootNode: { position: BABYLON.Vector3.Zero(), getChildMeshes: () => meshes },
        pendingRaycastOperations: new Set([1]),
        components: {
          [raycastComponent.componentId]: { getOrNull: () => raycast },
          [raycastResultComponent.componentId]: { createOrReplace: () => undefined }
        },
        getEntityOrNull: (id: number) => ({
          entityId: id,
          appliedComponents: {
            raycast: { ray: new BABYLON.Ray(BABYLON.Vector3.Zero(), BABYLON.Vector3.Forward(), 999) }
          },
          getWorldMatrix: () => BABYLON.Matrix.Identity()
        })
      })

      expect(hit).toHaveBeenCalledWith('maxRaycastIntersectionsPerFrame', expect.stringContaining('60000 colliders'))
    } finally {
      scene.dispose()
      engine.dispose()
    }
  })

  // The sibling of the mesh-ceiling case above. Both raycast keys report from the
  // same function a few lines apart, so transposing them is the easy mistake — and
  // covering only one of the two is what let that go unnoticed.
  it('reports the maxRaycastTrianglesPerFrame key when one raycast spans too many triangles', () => {
    const hit = jest.fn()
    jest.resetModules()
    jest.doMock(LIMIT_LOGGER_PATH, () => ({ limitLogger: { hit } }))
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const BABYLON = require('@babylonjs/core')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { processRaycasts } = require(RAYCASTS_PATH)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { raycastComponent, raycastResultComponent } = require(RAYCAST_COMPONENT_PATH)

    const engine = new BABYLON.NullEngine()
    const scene = new BABYLON.Scene(engine)
    try {
      const sphere = BABYLON.MeshBuilder.CreateSphere('s_collider', { diameter: 1, segments: 16 }, scene)
      sphere.position.set(0, 0, 50)
      sphere.computeWorldMatrix(true)
      // 1296 triangles each: 600 spheres is 777_600, past the 600_000 ceiling, while
      // 600 candidates is ~1% of the mesh ceiling — so only the triangle guard fires.
      const meshes = new Array(600).fill(sphere)
      const raycast = {
        queryType: 0,
        continuous: false,
        timestamp: 0,
        collisionMask: undefined,
        direction: undefined,
        originOffset: undefined
      }
      processRaycasts({
        currentTick: 0,
        entityId: 'logger-spec',
        rootNode: { position: BABYLON.Vector3.Zero(), getChildMeshes: () => meshes },
        pendingRaycastOperations: new Set([1]),
        components: {
          [raycastComponent.componentId]: { getOrNull: () => raycast },
          [raycastResultComponent.componentId]: { createOrReplace: () => undefined }
        },
        getEntityOrNull: (id: number) => ({
          entityId: id,
          appliedComponents: {
            raycast: { ray: new BABYLON.Ray(BABYLON.Vector3.Zero(), BABYLON.Vector3.Forward(), 999) }
          },
          getWorldMatrix: () => BABYLON.Matrix.Identity()
        })
      })

      expect(hit).toHaveBeenCalledWith('maxRaycastTrianglesPerFrame', expect.stringContaining('triangles'))
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
