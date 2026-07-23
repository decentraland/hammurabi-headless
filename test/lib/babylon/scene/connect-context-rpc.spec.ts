// NOTE: this project's jest transformer (esbuild) does not hoist `jest.mock`
// above imports, so we register the mock first and then `require` the modules
// under test. Type-only imports are erased by esbuild and are safe to keep.
import type { RpcClientPort } from '@dcl/rpc'
import type { SceneContext } from '../../../../src/lib/babylon/scene/scene-context'
import type { ExplorerIdentity } from '../../../../src/lib/decentraland/identity/types'

// The network-signing function is mocked so we can assert WHICH identity a scene
// request is signed with, without performing any real request.
jest.mock('../../../../src/lib/decentraland/identity/signed-fetch', () => ({
  signedFetch: jest.fn(),
  getSignedHeaders: jest.fn(() => ({}))
}))

const { createRpcClient, createRpcServer } = require('@dcl/rpc')
const { MemoryTransport } = require('@dcl/rpc/dist/transports/Memory')
const { connectContextToRpcServer, registerService } = require('../../../../src/lib/babylon/scene/connect-context-rpc')
const {
  UserActionModuleServiceDefinition
} = require('@dcl/protocol/out-js/decentraland/kernel/apis/user_action_module.gen')
const { loadModuleForPort } = require('../../../../src/lib/common-runtime/modules')
const { sceneIdentity, userIdentity, currentRealm } = require('../../../../src/lib/decentraland/state')
const { signedFetch } = require('../../../../src/lib/decentraland/identity/signed-fetch')
const signedFetchMock = signedFetch as jest.Mock

// Distinguishable fake identities. The authChain sentinels let us prove which
// identity signed a scene request.
const GUEST_AUTH_CHAIN = { tag: 'GUEST' } as any
const AUTHORITATIVE_AUTH_CHAIN = { tag: 'AUTHORITATIVE' } as any

const guestIdentity: ExplorerIdentity = {
  address: '0xguest',
  isGuest: true,
  authChain: GUEST_AUTH_CHAIN,
  signer: async () => 'guest-sig'
}
const authoritativeIdentity: ExplorerIdentity = {
  address: '0xauthoritative',
  isGuest: false,
  authChain: AUTHORITATIVE_AUTH_CHAIN,
  signer: async () => 'authoritative-sig'
}

const sceneCtx = {
  loadableScene: {
    urn: 'urn:decentraland:entity:bafktest',
    entity: { metadata: { scene: { base: '0,0' } } }
  }
} as unknown as SceneContext

async function createScenePort(): Promise<RpcClientPort> {
  const rpcServer = createRpcServer<SceneContext>({})
  rpcServer.setHandler(async (port: any) => {
    connectContextToRpcServer(port)
  })
  const { client: clientSocket, server: serverSocket } = MemoryTransport()
  const clientPromise = createRpcClient(clientSocket)
  rpcServer.attachTransport(serverSocket, sceneCtx)
  const client = await clientPromise
  return client.createPort('test-scene')
}

describe('scene RPC capabilities', () => {
  let port: RpcClientPort

  beforeEach(async () => {
    // The server holds the PRIVILEGED authoritative identity; scenes must only
    // ever see the unprivileged guest identity.
    userIdentity.swap(authoritativeIdentity)
    sceneIdentity.swap(guestIdentity)
    currentRealm.swap({
      baseUrl: 'https://realm.example',
      connectionString: 'https://realm.example',
      aboutResponse: { configurations: { realmName: 'test-realm' } } as any
    })
    signedFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {},
      text: '{"ok":true}'
    })
    port = await createScenePort()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('when a scene calls signedFetch for a public URL', () => {
    beforeEach(async () => {
      const service: any = loadModuleForPort(port, '~system/SignedFetch')
      await service.signedFetch({ url: 'https://8.8.8.8/api', init: { method: 'GET', headers: {} } })
    })

    it('should sign with the unprivileged guest identity, never the authoritative one', () => {
      expect(signedFetchMock).toHaveBeenCalledTimes(1)
      expect(signedFetchMock.mock.calls[0][1]).toBe(GUEST_AUTH_CHAIN)
      expect(signedFetchMock.mock.calls[0][1]).not.toBe(AUTHORITATIVE_AUTH_CHAIN)
    })

    it('should label the request metadata with the kernel-scene signer role while staying a guest', () => {
      const metadata = signedFetchMock.mock.calls[0][3]
      expect(metadata).toMatchObject({ isGuest: true, signer: 'decentraland-kernel-scene' })
    })
  })

  describe('when a scene calls signedFetch for a blocked (metadata) URL', () => {
    let response: any

    beforeEach(async () => {
      const service: any = loadModuleForPort(port, '~system/SignedFetch')
      response = await service.signedFetch({
        url: 'http://169.254.169.254/latest/meta-data/',
        init: { method: 'GET', headers: {} }
      })
    })

    it('should not perform the signed request', () => {
      expect(signedFetchMock).not.toHaveBeenCalled()
    })

    it('should respond with a non-ok result', () => {
      expect(response.ok).toBe(false)
    })
  })

  describe('when a public URL redirects to another public URL', () => {
    let response: any

    beforeEach(async () => {
      signedFetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 302,
          statusText: 'Found',
          headers: { location: 'https://9.9.9.9/next' },
          text: ''
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: {},
          text: '{"ok":true}'
        })
      const service: any = loadModuleForPort(port, '~system/SignedFetch')
      response = await service.signedFetch({ url: 'https://8.8.8.8/start', init: { method: 'GET', headers: {} } })
    })

    it('should follow the redirect and re-sign each hop for its own URL', () => {
      expect(signedFetchMock).toHaveBeenCalledTimes(2)
      expect(signedFetchMock.mock.calls[0][0]).toBe('https://8.8.8.8/start')
      expect(signedFetchMock.mock.calls[1][0]).toBe('https://9.9.9.9/next')
    })

    it('should return the final response', () => {
      expect(response.status).toBe(200)
      expect(response.ok).toBe(true)
    })
  })

  describe('when a public URL redirects to a blocked (private) URL', () => {
    let response: any

    beforeEach(async () => {
      signedFetchMock.mockResolvedValueOnce({
        ok: false,
        status: 302,
        statusText: 'Found',
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        text: ''
      })
      const service: any = loadModuleForPort(port, '~system/SignedFetch')
      response = await service.signedFetch({ url: 'https://8.8.8.8/start', init: { method: 'GET', headers: {} } })
    })

    it('should re-validate the redirect target and never fetch the private host', () => {
      expect(signedFetchMock).toHaveBeenCalledTimes(1)
      expect(signedFetchMock.mock.calls[0][0]).toBe('https://8.8.8.8/start')
    })

    it('should respond with a non-ok result', () => {
      expect(response.ok).toBe(false)
    })
  })

  describe('when a redirect crosses to a different origin', () => {
    beforeEach(async () => {
      signedFetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 302,
          statusText: 'Found',
          headers: { location: 'https://9.9.9.9/next' },
          text: ''
        })
        .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', headers: {}, text: '{}' })
      const service: any = loadModuleForPort(port, '~system/SignedFetch')
      await service.signedFetch({
        url: 'https://8.8.8.8/start',
        init: { method: 'GET', headers: { 'x-secret': 'abc' } }
      })
    })

    it('forwards scene headers on the first (same-origin) request', () => {
      expect(signedFetchMock.mock.calls[0][2].headers).toMatchObject({ 'x-secret': 'abc' })
    })

    it('strips scene headers on the cross-origin hop', () => {
      expect(signedFetchMock.mock.calls[1][2].headers).toEqual({})
    })
  })

  describe('when a redirect stays on the same origin', () => {
    beforeEach(async () => {
      signedFetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 302,
          statusText: 'Found',
          headers: { location: 'https://8.8.8.8/next' },
          text: ''
        })
        .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', headers: {}, text: '{}' })
      const service: any = loadModuleForPort(port, '~system/SignedFetch')
      await service.signedFetch({
        url: 'https://8.8.8.8/start',
        init: { method: 'GET', headers: { 'x-secret': 'abc' } }
      })
    })

    it('keeps scene headers across a same-origin redirect', () => {
      expect(signedFetchMock.mock.calls[1][2].headers).toMatchObject({ 'x-secret': 'abc' })
    })
  })

  describe('when a scene calls signedFetch for the realm\'s own (otherwise blocked) origin', () => {
    let response: any

    beforeEach(async () => {
      // Local preview: the realm runs on localhost, which the SSRF guard blocks
      // for every other destination. The realm origin is operator-supplied, so
      // scene requests to it (storage endpoints) must go through.
      currentRealm.swap({
        baseUrl: 'http://localhost:8000',
        connectionString: 'http://localhost:8000',
        aboutResponse: { configurations: { realmName: 'localhost' } } as any
      })
      const service: any = loadModuleForPort(port, '~system/SignedFetch')
      response = await service.signedFetch({
        url: 'http://localhost:8000/values/leaderboard',
        init: { method: 'GET', headers: {} }
      })
    })

    it('should perform the request instead of blocking it', () => {
      expect(signedFetchMock).toHaveBeenCalledTimes(1)
      expect(signedFetchMock.mock.calls[0][0]).toBe('http://localhost:8000/values/leaderboard')
      expect(response.ok).toBe(true)
    })
  })

  describe('when a scene under a localhost realm targets another loopback port', () => {
    let response: any

    beforeEach(async () => {
      currentRealm.swap({
        baseUrl: 'http://localhost:8000',
        connectionString: 'http://localhost:8000',
        aboutResponse: { configurations: { realmName: 'localhost' } } as any
      })
      signedFetchMock.mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', headers: {}, text: '{}' })
      const service: any = loadModuleForPort(port, '~system/SignedFetch')
      // Different port = different origin, so the realm-origin exemption does
      // not apply — but the localhost realm enables the loopback relaxation,
      // so a dev's own local backend is reachable from server-side scene code.
      response = await service.signedFetch({
        url: 'http://localhost:9999/api',
        init: { method: 'GET', headers: {} }
      })
    })

    it('should allow the request through the loopback relaxation', () => {
      expect(signedFetchMock).toHaveBeenCalledTimes(1)
      expect(response.ok).toBe(true)
    })
  })

  describe('when a scene under a localhost realm targets a private non-loopback host', () => {
    let response: any

    beforeEach(async () => {
      currentRealm.swap({
        baseUrl: 'http://localhost:8000',
        connectionString: 'http://localhost:8000',
        aboutResponse: { configurations: { realmName: 'localhost' } } as any
      })
      const service: any = loadModuleForPort(port, '~system/SignedFetch')
      // The loopback relaxation must never extend to LAN / private ranges.
      response = await service.signedFetch({
        url: 'http://192.168.1.7/admin',
        init: { method: 'GET', headers: {} }
      })
    })

    it('should still block the request', () => {
      expect(signedFetchMock).not.toHaveBeenCalled()
      expect(response.ok).toBe(false)
    })

    it('should report the block as a 403 naming the SSRF guard, not a fake 500', () => {
      expect(response.status).toBe(403)
      expect(response.statusText).toContain('SSRF guard')
    })
  })

  describe('when a scene requests the user public key', () => {
    let response: any

    beforeEach(async () => {
      const service: any = loadModuleForPort(port, '~system/UserIdentity')
      response = await service.getUserPublicKey({})
    })

    it('should return the guest identity address, not the authoritative one', () => {
      expect(response.address).toBe('0xguest')
    })
  })

  describe('when a scene requests user data', () => {
    let data: any

    beforeEach(async () => {
      const service: any = loadModuleForPort(port, '~system/UserIdentity')
      const response = await service.getUserData({})
      data = response.data
    })

    it('should report the guest address as the userId', () => {
      expect(data.userId).toBe('0xguest')
    })

    it('should report the caller as not web3-connected', () => {
      expect(data.hasConnectedWeb3).toBe(false)
    })
  })
})

// @dcl/protocol is resolved at the user's install time, so the runtime can see
// service definitions declaring methods this server was never compiled with.
// @dcl/rpc binds every declared method at module load, so without the tolerant
// wrapper ONE missing method breaks the whole module ("Cannot read properties
// of undefined (reading 'bind')").
describe('registerService protocol-drift tolerance', () => {
  let port: RpcClientPort
  let consoleErrorSpy: jest.SpyInstance

  beforeEach(async () => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const rpcServer = createRpcServer<SceneContext>({})
    rpcServer.setHandler(async (serverPort: any) => {
      // Simulates drift: the definition declares requestTeleport, the
      // implementation provides nothing.
      registerService(serverPort, UserActionModuleServiceDefinition, async () => ({}))
    })
    const { client: clientSocket, server: serverSocket } = MemoryTransport()
    const clientPromise = createRpcClient(clientSocket)
    rpcServer.attachTransport(serverSocket, sceneCtx)
    const client = await clientPromise
    port = await client.createPort('drift-test')
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  describe('when the implementation is missing a declared method', () => {
    let service: any

    beforeEach(async () => {
      service = loadModuleForPort(port, '~system/UserActionModule')
      // Force the module load to complete (loadService defers it to first call).
      await service.requestTeleport({ destination: '0,0' }).catch(() => {})
    })

    it('should log the missing method by service and name', () => {
      const logged = consoleErrorSpy.mock.calls.flat().join(' ')
      expect(logged).toContain('UserActionModuleService')
      expect(logged).toContain('requestTeleport')
    })

    it('should reject calls to the missing method with a descriptive error', async () => {
      await expect(service.requestTeleport({ destination: '0,0' })).rejects.toThrow(
        /requestTeleport is not implemented by this server version/
      )
    })
  })
})
