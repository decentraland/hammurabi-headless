import type { SceneContext } from '../../../../src/lib/babylon/scene/scene-context'
import type { StorageDelegation, CurrentRealm } from '../../../../src/lib/decentraland/state'

const { Authenticator } = require('@dcl/crypto')
const { createUnsafeIdentity } = require('@dcl/crypto/dist/crypto')
const { getStorageSigningStrategy } = require('../../../../src/lib/babylon/scene/connect-context-rpc')

const realm = {
  baseUrl: 'https://worlds-content-server.decentraland.zone',
  connectionString: 'boedo.dcl.eth',
  aboutResponse: { configurations: { realmName: 'boedo.dcl.eth' } } as any
} as CurrentRealm

const sceneCtx = {
  loadableScene: {
    urn: 'urn:decentraland:entity:bafktest',
    entity: { metadata: { scene: { base: '0,0' } } }
  }
} as unknown as SceneContext

// A real ephemeral keypair so createSimpleAuthChain produces a verifiable chain.
const ephemeral = createUnsafeIdentity()

function makeDelegation(overrides: Partial<StorageDelegation> = {}): StorageDelegation {
  return {
    v: 1,
    world: 'boedo.dcl.eth',
    ephemeral: { privateKey: ephemeral.privateKey, publicKey: ephemeral.publicKey, address: ephemeral.address },
    scope: { payload: 'Decentraland Authoritative Storage Delegation\n...', signature: '0xsig' },
    ...overrides
  }
}

const STORAGE_URL = 'https://storage.decentraland.zone/values/globalLeaderboard'

describe('getStorageSigningStrategy', () => {
  describe('when the delegation is absent', () => {
    it('returns null (worker falls back to the guest identity)', () => {
      expect(getStorageSigningStrategy(STORAGE_URL, null, realm, sceneCtx)).toBeNull()
    })
  })

  describe('when the target host is not the world storage service', () => {
    it('returns null even with a valid delegation', () => {
      expect(getStorageSigningStrategy('https://attacker.example/values/x', makeDelegation(), realm, sceneCtx)).toBeNull()
    })

    it('rejects lookalike hosts', () => {
      const url = 'https://storage.decentraland.zone.evil.com/values/x'
      expect(getStorageSigningStrategy(url, makeDelegation(), realm, sceneCtx)).toBeNull()
    })
  })

  describe('when the host is the world storage service and the delegation is valid', () => {
    let strategy: ReturnType<typeof getStorageSigningStrategy>

    beforeEach(() => {
      strategy = getStorageSigningStrategy(STORAGE_URL, makeDelegation(), realm, sceneCtx)
    })

    it('returns a storage signing strategy', () => {
      expect(strategy).not.toBeNull()
    })

    it('reports an authoritative (non-guest) signer scoped to the delegation world', () => {
      expect(strategy!.metadata).toMatchObject({
        signer: 'dcl:authoritative-server',
        isGuest: false,
        realmName: 'boedo.dcl.eth',
        realm: { serverName: 'boedo.dcl.eth' }
      })
    })

    it('attaches the base64 x-authoritative-scope claim header', () => {
      const header = strategy!.options.extraHeaders['x-authoritative-scope']
      const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
      expect(decoded).toEqual(makeDelegation().scope)
    })

    it('signs as the standalone ephemeral (owner == ephemeral, not the authoritative address)', () => {
      const payload = 'get:/values/globalleaderboard:123:{}'
      const chain = strategy!.options.chainProvider(payload)
      expect(Authenticator.ownerAddress(chain).toLowerCase()).toBe(ephemeral.address.toLowerCase())
    })
  })
})
