import type { RpcClientPort } from '@dcl/rpc'
import { Vector3 } from '@babylonjs/core'
import { Scene } from '@dcl/schemas'
import mitt from 'mitt'
import { limits } from '../../../../src/lib/misc/limits'
import { testWithEngine } from '../babylon-test-helper'

// NOTE: this project's jest transformer (esbuild) does not hoist `jest.mock`
// above imports, so the RPC pieces are `require`d rather than imported.
const { createRpcClient, createRpcServer } = require('@dcl/rpc')
const { MemoryTransport } = require('@dcl/rpc/dist/transports/Memory')
const { connectContextToRpcServer, userDataFromProfile } = require('../../../../src/lib/babylon/scene/connect-context-rpc')
const { loadModuleForPort } = require('../../../../src/lib/common-runtime/modules')
const { currentRealm } = require('../../../../src/lib/decentraland/state')
const { playerEntityManager } = require('../../../../src/lib/decentraland/communications/player-entity-manager')

// `~system/Players` and `~system/EnvironmentApi` previously threw
// `Unknown module` from modules.ts. These drive both through a real RPC port
// into a real SceneContext, feeding peers in over the transport the way comms
// does rather than reaching into the avatar system's internals.

const makeEmitter = () => mitt<Record<string, any>>()

// The scene under test occupies parcel 0,0 only, so world x/z in [0,16) is
// inside it and anything else is not.
const SCENE_METADATA = { scene: { base: '0,0', parcels: ['0,0'] } } as unknown as Scene

function positionPacket(x: number, y: number, z: number) {
  return {
    positionX: x,
    positionY: y,
    positionZ: z,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0,
    rotationW: 1
  }
}

/** A real RPC client for both modules, talking to `context` over a MemoryTransport. */
async function connectModules(context: any): Promise<{ players: any; environmentApi: any }> {
  const rpcServer = createRpcServer({})
  rpcServer.setHandler(async (port: any) => connectContextToRpcServer(port))
  const { client: clientSocket, server: serverSocket } = MemoryTransport()
  const clientPromise = createRpcClient(clientSocket)
  rpcServer.attachTransport(serverSocket, context)
  const client = await clientPromise
  const port: RpcClientPort = await client.createPort('players-env-test')
  return {
    players: loadModuleForPort(port, '~system/Players'),
    environmentApi: loadModuleForPort(port, '~system/EnvironmentApi')
  }
}

/**
 * Undo one `attachLivekitTransport`.
 *
 * It creates an avatar system and PUSHES a subscription every time it is called,
 * and `testWithEngine` builds a single SceneContext for the whole file — so
 * without this every test would leave a live system bound to its (now dead)
 * transport and one more entry on `ctx.subscriptions`.
 */
function detachTransport(context: any) {
  context.avatarSystem?.dispose()
  for (const subscription of context.subscriptions) subscription.dispose()
  context.subscriptions.length = 0
}

testWithEngine(
  'players and environment api over rpc',
  {
    baseUrl: '/',
    entity: { content: [], metadata: SCENE_METADATA, type: 'scene' },
    urn: 'players-env-spec'
  },
  ($) => {
    let transport: { events: ReturnType<typeof makeEmitter> }
    let players: any
    let environmentApi: any

    beforeEach(async () => {
      playerEntityManager.clear()
      transport = { events: makeEmitter() }
      $.ctx.attachLivekitTransport(transport as any)
      ;({ players, environmentApi } = await connectModules($.ctx))
    })

    afterEach(() => {
      detachTransport($.ctx)
      currentRealm.swap(undefined)
      playerEntityManager.clear()
      jest.restoreAllMocks()
    })

    describe('when two peers are connected and one stands inside the scene parcels', () => {
      beforeEach(() => {
        transport.events.emit('position', { address: '0xInside', data: positionPacket(8, 0, 8) })
        transport.events.emit('position', { address: '0xOutside', data: positionPacket(500, 0, 500) })
      })

      it('should report both of them as connected players', async () => {
        const result = await players.getConnectedPlayers({})
        expect(result.players.map((p: any) => p.userId).sort()).toEqual(['0xinside', '0xoutside'])
      })

      it('should report only the one standing on a scene parcel as in-scene', async () => {
        const result = await players.getPlayersInScene({})
        expect(result.players.map((p: any) => p.userId)).toEqual(['0xinside'])
      })
    })

    describe('when a peer is connected but has not reported a position yet', () => {
      beforeEach(() => {
        // A profile announcement adopts the peer without placing it. Same for a
        // chat message, an emote, and every peer already in the room when this
        // worker joined (those are replayed through the transport registry).
        transport.events.emit('profileMessage', { address: '0xGhost', data: { profileVersion: 1 } })
      })

      it('should still report it as a connected player', async () => {
        const result = await players.getConnectedPlayers({})
        expect(result.players.map((p: any) => p.userId)).toContain('0xghost')
      })

      // Being unable to place a peer must not be reported as "standing in the
      // scene" -- that is the assertion a scene would act on. Inventing a
      // position (the scene base, the origin) would answer with a lie.
      it('should not claim it is inside the scene', async () => {
        const result = await players.getPlayersInScene({})
        expect(result.players.map((p: any) => p.userId)).not.toContain('0xghost')
      })
    })

    describe('when a peer that reported a position inside the scene stops sending packets', () => {
      beforeEach(() => {
        transport.events.emit('position', { address: '0xStationary', data: positionPacket(8, 0, 8) })
        // Any number of other peers' packets later, this peer has sent nothing more.
        transport.events.emit('position', { address: '0xOther', data: positionPacket(500, 0, 500) })
      })

      // Standing still is the normal reason a client sends nothing, so the last
      // known position stands until the transport says the peer is gone. There
      // is deliberately no staleness timeout.
      it('should keep reporting it as being in the scene', async () => {
        const result = await players.getPlayersInScene({})
        expect(result.players.map((p: any) => p.userId)).toContain('0xstationary')
      })

      describe('and the transport then reports the peer as disconnected', () => {
        beforeEach(() => {
          transport.events.emit('PEER_DISCONNECTED', { address: '0xStationary' })
        })

        it('should stop reporting it as being in the scene', async () => {
          const result = await players.getPlayersInScene({})
          expect(result.players.map((p: any) => p.userId)).not.toContain('0xstationary')
        })

        it('should stop reporting it as a connected player', async () => {
          const result = await players.getConnectedPlayers({})
          expect(result.players.map((p: any) => p.userId)).not.toContain('0xstationary')
        })
      })
    })

    describe('when a peer sits exactly on the far edge of the scene parcel', () => {
      beforeEach(() => {
        // Parcel 0,0 spans [0,16) on both axes; 16 belongs to parcel 1,0.
        transport.events.emit('position', { address: '0xEdge', data: positionPacket(16, 0, 8) })
      })

      it('should treat the position as belonging to the neighbouring parcel', async () => {
        const result = await players.getPlayersInScene({})
        expect(result.players.map((p: any) => p.userId)).not.toContain('0xedge')
      })
    })

    describe('when a peer stands on a negative-coordinate parcel outside the scene', () => {
      beforeEach(() => {
        // Guards against a truncating `| 0` conversion, which would map -1 to
        // parcel 0 and wrongly place this peer inside the scene.
        transport.events.emit('position', { address: '0xNegative', data: positionPacket(-1, 0, -1) })
      })

      it('should not report it as being in the scene', async () => {
        const result = await players.getPlayersInScene({})
        expect(result.players.map((p: any) => p.userId)).not.toContain('0xnegative')
      })
    })

    describe('when a scene asks for the data of a player with no resolved profile', () => {
      beforeEach(() => {
        transport.events.emit('position', { address: '0xNoProfile', data: positionPacket(8, 0, 8) })
      })

      it('should return no data rather than fabricating a profile', async () => {
        const result = await players.getPlayerData({ userId: '0xNoProfile' })
        expect(result.data).toBeUndefined()
      })
    })

    describe('when a scene asks for the data of a player using a checksummed address', () => {
      beforeEach(() => {
        transport.events.emit('position', { address: '0xAliCE', data: positionPacket(8, 0, 8) })
        jest.spyOn($.ctx.avatarSystem as any, 'getKnownProfile').mockReturnValue({ name: 'Alice', version: 3 })
      })

      // A scene keying a map on `data.userId` would otherwise end up with two
      // entries for one player: this one, and the lowercase spelling every other
      // Players method reports.
      it('should report the same normalized address getConnectedPlayers reports', async () => {
        const result = await players.getPlayerData({ userId: '0xAliCE' })
        expect(result.data.userId).toBe('0xalice')
      })

      it('should project the cached profile onto the user data', async () => {
        const result = await players.getPlayerData({ userId: '0xAliCE' })
        expect(result.data.displayName).toBe('Alice')
      })
    })

    describe('when a scene asks whether it is running in preview mode', () => {
      describe('and the realm advertises itself as a preview', () => {
        beforeEach(() => {
          currentRealm.swap({
            baseUrl: 'https://example.org',
            connectionString: 'https://example.org',
            aboutResponse: { configurations: { isPreview: true, realmName: 'LocalPreview' } }
          })
        })

        it('should report preview mode', async () => {
          expect((await environmentApi.isPreviewMode({})).isPreview).toBe(true)
        })
      })

      describe('and the realm says nothing about it but runs on localhost', () => {
        beforeEach(() => {
          currentRealm.swap({
            baseUrl: 'http://localhost:8000',
            connectionString: 'http://localhost:8000',
            aboutResponse: { configurations: { realmName: 'LocalPreview' } }
          })
        })

        it('should fall back to reporting preview mode', async () => {
          expect((await environmentApi.isPreviewMode({})).isPreview).toBe(true)
        })
      })

      describe('and the realm is a remote production realm', () => {
        beforeEach(() => {
          currentRealm.swap({
            baseUrl: 'https://peer.decentraland.org',
            connectionString: 'https://peer.decentraland.org',
            aboutResponse: { configurations: { realmName: 'main' } }
          })
        })

        it('should not report preview mode', async () => {
          expect((await environmentApi.isPreviewMode({})).isPreview).toBe(false)
        })
      })

      describe('and no realm has been resolved yet', () => {
        it('should not report preview mode', async () => {
          expect((await environmentApi.isPreviewMode({})).isPreview).toBe(false)
        })
      })
    })

    describe('when a scene asks for the current realm', () => {
      describe('and a realm is configured', () => {
        beforeEach(() => {
          currentRealm.swap({
            baseUrl: 'https://peer.decentraland.org',
            connectionString: 'https://peer.decentraland.org',
            aboutResponse: { configurations: { realmName: 'main' }, comms: { protocol: 'v3' } }
          })
        })

        it('should report the realm name as the server name', async () => {
          expect((await environmentApi.getCurrentRealm({})).currentRealm.serverName).toBe('main')
        })

        it('should report the realm base url as the domain', async () => {
          expect((await environmentApi.getCurrentRealm({})).currentRealm.domain).toBe('https://peer.decentraland.org')
        })
      })

      describe('and the realm advertises no name', () => {
        beforeEach(() => {
          currentRealm.swap({
            baseUrl: 'https://peer.decentraland.org',
            connectionString: 'https://peer.decentraland.org',
            aboutResponse: { configurations: {}, comms: { protocol: 'v3' } }
          })
        })

        // The RealmInfo component fills the same gap with 'Unknown'; a scene
        // must not see two different names for one realm.
        it('should report the same placeholder the RealmInfo component uses', async () => {
          expect((await environmentApi.getCurrentRealm({})).currentRealm.serverName).toBe('Unknown')
        })
      })

      describe('and no realm has been resolved yet', () => {
        it('should report no realm instead of an empty placeholder', async () => {
          expect((await environmentApi.getCurrentRealm({})).currentRealm).toBeUndefined()
        })
      })
    })

    describe('when a scene asks for the explorer configuration', () => {
      describe('and a realm is configured', () => {
        beforeEach(() => {
          currentRealm.swap({
            baseUrl: 'https://peer.decentraland.org',
            connectionString: 'https://peer.decentraland.org',
            aboutResponse: { configurations: { realmName: 'main' } }
          })
        })

        it('should report the realm base url as the client uri', async () => {
          expect((await environmentApi.getExplorerConfiguration({})).clientUri).toBe('https://peer.decentraland.org')
        })
      })

      describe('and no realm has been resolved yet', () => {
        it('should report an empty client uri', async () => {
          expect((await environmentApi.getExplorerConfiguration({})).clientUri).toBe('')
        })
      })
    })

    describe('when a scene asks for the platform', () => {
      it('should report desktop', async () => {
        expect((await environmentApi.getPlatform({})).platform).toBe('desktop')
      })
    })

    describe('when a scene asks for the bootstrap data', () => {
      it('should report the scene entity id', async () => {
        expect((await environmentApi.getBootstrapData({})).id).toBe($.ctx.entityId)
      })

      it('should carry the scene metadata as json', async () => {
        const result = await environmentApi.getBootstrapData({})
        expect(JSON.parse(result.entity.metadataJson)).toEqual(SCENE_METADATA)
      })
    })

    describe('when a scene asks for the decentraland time', () => {
      // Deliberately 0, matching Runtime.getWorldTime: this server tracks no
      // in-world clock, and the two APIs must not disagree.
      it('should report zero seconds', async () => {
        expect((await environmentApi.getDecentralandTime({})).seconds).toBe(0)
      })
    })

    describe('when a scene asks whether unsafe requests are allowed', () => {
      it('should report that they are not, since the SSRF guard always applies', async () => {
        expect((await environmentApi.areUnsafeRequestAllowed({})).status).toBe(false)
      })
    })
  }
)

// A scene based at the origin makes worldToScene the identity, so an
// implementation that stored SCENE-space peer positions would pass every test
// above. This scene is based at 10,10 (world x/z in [160,176)), which is what
// actually pins the two spaces apart.
testWithEngine(
  'players api for a scene away from the origin',
  {
    baseUrl: '/',
    entity: {
      content: [],
      metadata: { scene: { base: '10,10', parcels: ['10,10'] } } as unknown as Scene,
      type: 'scene'
    },
    urn: 'players-env-offset-spec'
  },
  ($) => {
    let transport: { events: ReturnType<typeof makeEmitter> }
    let players: any

    beforeEach(async () => {
      playerEntityManager.clear()
      transport = { events: makeEmitter() }
      $.ctx.attachLivekitTransport(transport as any)
      ;({ players } = await connectModules($.ctx))
    })

    afterEach(() => {
      detachTransport($.ctx)
      playerEntityManager.clear()
    })

    describe('when a peer stands on the scene parcel in WORLD coordinates', () => {
      beforeEach(() => {
        // World (168,168) is parcel 10,10 -- this scene. Its SCENE-space value is
        // (8,8), i.e. parcel 0,0, so a scene-space implementation excludes it.
        transport.events.emit('position', { address: '0xOnParcel', data: positionPacket(168, 0, 168) })
      })

      it('should report it as being in the scene', async () => {
        const result = await players.getPlayersInScene({})
        expect(result.players.map((p: any) => p.userId)).toEqual(['0xonparcel'])
      })
    })

    describe('when a peer stands where its SCENE-space position would land on the scene parcel', () => {
      beforeEach(() => {
        // World (328,328) is parcel 20,20 -- two parcels away. Its SCENE-space
        // value is (168,168), i.e. parcel 10,10, so a scene-space implementation
        // wrongly includes it.
        transport.events.emit('position', { address: '0xTwoParcelsAway', data: positionPacket(328, 0, 328) })
      })

      it('should not report it as being in the scene', async () => {
        const result = await players.getPlayersInScene({})
        expect(result.players).toEqual([])
      })
    })
  }
)

describe('scene position containment', () => {
  // Exercised directly here because the RPC suite above shares one SceneContext
  // pinned to parcel 0,0, and a non-contiguous parcel set is the case a
  // bounding-box test would get wrong.
  const { SceneContext } = require('../../../../src/lib/babylon/scene/scene-context')
  const BABYLON = require('@babylonjs/core')

  let engine: any
  let scene: any
  let context: any

  beforeEach(() => {
    engine = new BABYLON.NullEngine()
    scene = new BABYLON.Scene(engine)
    context = new SceneContext(
      scene,
      {
        baseUrl: '/',
        urn: 'l-shaped',
        // An L shape: the rectangular hull includes 1,1 but the scene does not.
        entity: { content: [], type: 'scene', metadata: { scene: { base: '0,0', parcels: ['0,0', '1,0', '0,1'] } } }
      },
      false,
      ''
    )
  })

  afterEach(() => {
    context.dispose()
    scene.dispose()
    engine.dispose()
  })

  describe('when a position falls in a gap of a non-rectangular parcel set', () => {
    it('should not be considered inside the scene', () => {
      expect(context.isWorldPositionInsideScene(new Vector3(24, 0, 24))).toBe(false)
    })
  })

  describe('when a position falls on an occupied parcel', () => {
    it('should be considered inside the scene', () => {
      expect(context.isWorldPositionInsideScene(new Vector3(24, 0, 8))).toBe(true)
    })
  })

  describe('when a position carries a non-finite coordinate', () => {
    it('should not be considered inside the scene', () => {
      expect(context.isWorldPositionInsideScene(new Vector3(NaN, 0, 8))).toBe(false)
    })
  })
})

describe('user data projection from a peer-announced profile', () => {
  // Profiles are announced by the peer they describe, so every value here is
  // attacker-controlled. The projection must never throw out of an RPC handler
  // and must never hand a scene a value it cannot parse.
  const ADDRESS = '0xalice'

  describe('when the profile is well formed', () => {
    let data: any

    beforeEach(() => {
      data = userDataFromProfile(ADDRESS, {
        name: 'Alice',
        hasConnectedWeb3: true,
        version: 7,
        avatar: {
          bodyShape: 'urn:decentraland:off-chain:base-avatars:BaseFemale',
          skin: { color: { r: 1, g: 0.5, b: 0 } },
          hair: { color: { r: 0, g: 0, b: 0 } },
          eyes: { color: { r: 1, g: 1, b: 1 } },
          wearables: ['urn:one', 'urn:two'],
          snapshots: { face256: 'https://example.org/face.png', body: 'https://example.org/body.png' }
        }
      })
    })

    it('should report the display name', () => {
      expect(data.displayName).toBe('Alice')
    })

    it('should report the web3 connection flag', () => {
      expect(data.hasConnectedWeb3).toBe(true)
    })

    it('should render the 0..1 color floats as hex', () => {
      expect(data.avatar.skinColor).toBe('#ff8000')
    })

    it('should keep the wearable urns', () => {
      expect(data.avatar.wearables).toEqual(['urn:one', 'urn:two'])
    })

    it('should keep the snapshot urls', () => {
      expect(data.avatar.snapshots).toEqual({
        face256: 'https://example.org/face.png',
        body: 'https://example.org/body.png'
      })
    })

    it('should carry the normalized user id it was given', () => {
      expect(data.userId).toBe(ADDRESS)
    })
  })

  describe('when the profile is missing entirely', () => {
    let data: any

    beforeEach(() => {
      data = userDataFromProfile(ADDRESS, undefined)
    })

    it('should report a placeholder display name instead of throwing', () => {
      expect(data.displayName).toBe('Unknown')
    })

    it('should report the default colors', () => {
      expect(data.avatar.skinColor).toBe('#443322')
    })

    it('should report no wearables', () => {
      expect(data.avatar.wearables).toEqual([])
    })
  })

  describe('when a color channel is a string', () => {
    let data: any

    beforeEach(() => {
      data = userDataFromProfile(ADDRESS, { avatar: { skin: { color: { r: 'abc', g: 0, b: 0 } } } })
    })

    // This produced "#NaN0000" before the type check, from an input any peer
    // can announce.
    it('should fall back to the default skin color', () => {
      expect(data.avatar.skinColor).toBe('#443322')
    })
  })

  describe('when a color channel is an object', () => {
    let data: any

    beforeEach(() => {
      data = userDataFromProfile(ADDRESS, { avatar: { hair: { color: { r: {}, g: 1, b: 1 } } } })
    })

    it('should fall back to the default hair color', () => {
      expect(data.avatar.hairColor).toBe('#663322')
    })
  })

  describe('when a color channel is not finite', () => {
    let data: any

    beforeEach(() => {
      data = userDataFromProfile(ADDRESS, { avatar: { eyes: { color: { r: NaN, g: 1, b: 1 } } } })
    })

    it('should fall back to the default eye color', () => {
      expect(data.avatar.eyeColor).toBe('#332211')
    })
  })

  describe('when a color channel is out of the 0..1 range', () => {
    let data: any

    beforeEach(() => {
      data = userDataFromProfile(ADDRESS, { avatar: { skin: { color: { r: 5, g: -5, b: 0.5 } } } })
    })

    it('should clamp each channel to a byte', () => {
      expect(data.avatar.skinColor).toBe('#ff0080')
    })
  })

  describe('when the display name is not a string', () => {
    let data: any

    beforeEach(() => {
      data = userDataFromProfile(ADDRESS, { name: { toString: () => 'Alice' } })
    })

    it('should report the placeholder rather than coercing it', () => {
      expect(data.displayName).toBe('Unknown')
    })
  })

  describe('when the display name is longer than the cap', () => {
    let data: any

    beforeEach(() => {
      data = userDataFromProfile(ADDRESS, { name: 'a'.repeat(limits.maxProfileStringChars + 1) })
    })

    it('should drop it instead of copying it into the scene', () => {
      expect(data.displayName).toBe('Unknown')
    })
  })

  describe('when the body shape urn is longer than the cap', () => {
    let data: any

    beforeEach(() => {
      data = userDataFromProfile(ADDRESS, {
        avatar: { bodyShape: 'u'.repeat(limits.maxProfileStringChars + 1) }
      })
    })

    // Dropped, never truncated: half a urn is a different urn.
    it('should drop it', () => {
      expect(data.avatar.bodyShape).toBe('')
    })
  })

  describe('when the wearables list holds values that are not strings', () => {
    let data: any

    beforeEach(() => {
      data = userDataFromProfile(ADDRESS, { avatar: { wearables: ['urn:one', 42, null, { urn: 'x' }, 'urn:two'] } })
    })

    it('should keep only the string entries', () => {
      expect(data.avatar.wearables).toEqual(['urn:one', 'urn:two'])
    })
  })

  describe('when the wearables list is not an array', () => {
    let data: any

    beforeEach(() => {
      data = userDataFromProfile(ADDRESS, { avatar: { wearables: 'urn:one' } })
    })

    it('should report no wearables', () => {
      expect(data.avatar.wearables).toEqual([])
    })
  })

  describe('when the wearables list holds more entries than the cap', () => {
    let data: any

    beforeEach(() => {
      const wearables = new Array(limits.maxProfileWearables + 50).fill('urn:one')
      data = userDataFromProfile(ADDRESS, { avatar: { wearables } })
    })

    it('should project at most the capped number of them', () => {
      expect(data.avatar.wearables).toHaveLength(limits.maxProfileWearables)
    })
  })

  describe('when a single wearable urn is longer than the cap', () => {
    let data: any

    beforeEach(() => {
      data = userDataFromProfile(ADDRESS, {
        avatar: { wearables: ['urn:one', 'u'.repeat(limits.maxProfileStringChars + 1)] }
      })
    })

    it('should drop that entry and keep the rest', () => {
      expect(data.avatar.wearables).toEqual(['urn:one'])
    })
  })

  describe('when a snapshot url is longer than the cap', () => {
    let data: any

    beforeEach(() => {
      data = userDataFromProfile(ADDRESS, {
        avatar: { snapshots: { face256: 'h'.repeat(limits.maxProfileStringChars + 1), body: 'ok' } }
      })
    })

    it('should drop only the oversized one', () => {
      expect(data.avatar.snapshots).toEqual({ face256: '', body: 'ok' })
    })
  })

  describe('when the announced version is fractional', () => {
    let data: any

    beforeEach(() => {
      data = userDataFromProfile(ADDRESS, { version: 1.5 })
    })

    // `version` is an int32 on the wire: 1.5 used to survive the projection and
    // then truncate to 1 on encode, so the scene saw a version nobody announced.
    it('should report the integer the wire will carry', () => {
      expect(data.version).toBe(1)
    })
  })

  describe('when the announced version is negative', () => {
    let data: any

    beforeEach(() => {
      data = userDataFromProfile(ADDRESS, { version: -3 })
    })

    it('should report zero', () => {
      expect(data.version).toBe(0)
    })
  })

  describe('when the announced version is a numeric string', () => {
    let data: any

    beforeEach(() => {
      data = userDataFromProfile(ADDRESS, { version: '4' })
    })

    it('should report zero rather than coercing it', () => {
      expect(data.version).toBe(0)
    })
  })

  describe('when the announced version exceeds what an int32 can carry', () => {
    let data: any

    beforeEach(() => {
      data = userDataFromProfile(ADDRESS, { version: 2 ** 40 })
    })

    it('should clamp it instead of letting it wrap on the wire', () => {
      expect(data.version).toBe(0x7fffffff)
    })
  })

  describe('when the web3 flag is a truthy non-boolean', () => {
    let data: any

    beforeEach(() => {
      data = userDataFromProfile(ADDRESS, { hasConnectedWeb3: 'yes' })
    })

    it('should report false rather than coercing it', () => {
      expect(data.hasConnectedWeb3).toBe(false)
    })
  })
})
