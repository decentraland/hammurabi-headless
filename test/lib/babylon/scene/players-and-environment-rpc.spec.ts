import type { RpcClientPort } from '@dcl/rpc'
import { Vector3 } from '@babylonjs/core'
import { Scene } from '@dcl/schemas'
import mitt from 'mitt'
import { testWithEngine } from '../babylon-test-helper'

// NOTE: this project's jest transformer (esbuild) does not hoist `jest.mock`
// above imports, so the RPC pieces are `require`d rather than imported.
const { createRpcClient, createRpcServer } = require('@dcl/rpc')
const { MemoryTransport } = require('@dcl/rpc/dist/transports/Memory')
const { connectContextToRpcServer } = require('../../../../src/lib/babylon/scene/connect-context-rpc')
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

      const rpcServer = createRpcServer({})
      rpcServer.setHandler(async (port: any) => connectContextToRpcServer(port))
      const { client: clientSocket, server: serverSocket } = MemoryTransport()
      const clientPromise = createRpcClient(clientSocket)
      rpcServer.attachTransport(serverSocket, $.ctx)
      const client = await clientPromise
      const port: RpcClientPort = await client.createPort('players-env-test')
      players = loadModuleForPort(port, '~system/Players')
      environmentApi = loadModuleForPort(port, '~system/EnvironmentApi')
    })

    afterEach(() => {
      currentRealm.swap(undefined)
      playerEntityManager.clear()
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
        // A profile announcement adopts the peer without placing it.
        transport.events.emit('profileMessage', { address: '0xGhost', data: { profileVersion: 1 } })
      })

      // Being unable to place a peer must not be reported as "standing in the
      // scene" -- that is the assertion a scene would act on.
      it('should not claim it is inside the scene', async () => {
        const result = await players.getPlayersInScene({})
        expect(result.players.map((p: any) => p.userId)).not.toContain('0xghost')
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

      describe('and no realm has been resolved yet', () => {
        it('should report no realm instead of an empty placeholder', async () => {
          expect((await environmentApi.getCurrentRealm({})).currentRealm).toBeUndefined()
        })
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
