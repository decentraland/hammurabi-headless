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
const { connectContextToRpcServer } = require('../../../../src/lib/babylon/scene/connect-context-rpc')
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

    it('should mark the request metadata as a guest signer', () => {
      const metadata = signedFetchMock.mock.calls[0][3]
      expect(metadata).toMatchObject({ isGuest: true, signer: 'dcl:scene-guest' })
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
