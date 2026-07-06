/**
 * This function will register the EngineApi and EnvironmentApi services
 * to the RPC server, so that the scene can call them.
 */

import { RpcServerPort } from '@dcl/rpc'
import * as codegen from '@dcl/rpc/dist/codegen'
import { EngineApiServiceDefinition } from '@dcl/protocol/out-js/decentraland/kernel/apis/engine_api.gen'
import { RuntimeServiceDefinition } from '@dcl/protocol/out-js/decentraland/kernel/apis/runtime.gen'
import { UserIdentityServiceDefinition } from '@dcl/protocol/out-js/decentraland/kernel/apis/user_identity.gen'
import { CommunicationsControllerServiceDefinition } from '@dcl/protocol/out-js/decentraland/kernel/apis/communications_controller.gen'
import { CommsApiServiceDefinition } from '@dcl/protocol/out-js/decentraland/kernel/apis/comms_api.gen'
import { UserActionModuleServiceDefinition } from '@dcl/protocol/out-js/decentraland/kernel/apis/user_action_module.gen'
import { RestrictedActionsServiceDefinition } from '@dcl/protocol/out-js/decentraland/kernel/apis/restricted_actions.gen'
import { SignedFetchServiceDefinition } from '@dcl/protocol/out-js/decentraland/kernel/apis/signed_fetch.gen'
import { Scene } from '@dcl/schemas'
import { Authenticator } from '@dcl/crypto'
import { sceneIdentity, currentRealm } from '../../decentraland/state'
import { signedFetch, getSignedHeaders } from '../../decentraland/identity/signed-fetch'
import { assertPublicSceneUrl } from '../../misc/ssrf'
import { encodeMessage, MsgType, SceneContext } from './scene-context'
import { realmInfoComponent } from '../../decentraland/sdk-components/realm-info'
import { StaticEntities } from './logic/static-entities'

// Per-call caps on scene→LiveKit publishing (CommunicationsController.sendBinary).
// The request is fully scene-controlled; without caps a scene could flood the room.
const MAX_SEND_PEERS = 256
const MAX_SEND_MESSAGES = 512
const MAX_COMMS_MESSAGE_BYTES = 30_000 // matches the transport's network message limit

// Max redirects a scene SignedFetch will follow. Each hop is re-validated by the
// SSRF guard so a public host can't 3xx-redirect the request onto a private
// address (metadata endpoint, loopback admin) — the single-shot guard alone was
// bypassable because the underlying fetch follows redirects transparently.
const MAX_SIGNED_FETCH_REDIRECTS = 5

export function connectContextToRpcServer(port: RpcServerPort<SceneContext>) {
  codegen.registerService(port, UserActionModuleServiceDefinition, async () => ({
    async requestTeleport() {
      return {}
    }
  }))
  codegen.registerService(port, RestrictedActionsServiceDefinition, async () => ({
    async movePlayerTo() {
      return { success: true }
    },
    async teleportTo() {
      return { success: true }
    },
    async triggerEmote() {
      return { success: true }
    },
    async changeRealm() {
      return { success: true }
    },
    async requestTeleport() {
      return { success: true }
    },
    async triggerSceneEmote() {
      return { success: true }
    },
    async showAvatarEmoteWheel() {
      return { success: true }
    },
    async showAvatarExpressionsWheel() {
      return { success: true }
    },
    async openExternalUrl() {
      return { success: true }
    },
    async openNftDialog() {
      return { success: true }
    },
    async setCommunicationsAdapter() {
      return { success: true }
    },
    async copyToClipboard() {
      return {}
    }
  }))
  codegen.registerService(port, RuntimeServiceDefinition, async () => ({
    async getSceneInformation(_payload, context) {
      return {
        baseUrl: context.loadableScene.baseUrl!,
        content: context.loadableScene.entity.content,
        metadataJson: JSON.stringify(context.loadableScene.entity.metadata),
        urn: context.loadableScene.urn
      }
    },
    async getRealm(_req, context) {
      // Read RealmInfo from the CRDT component (populated by updateStaticEntities)
      const RealmInfo = context.components[realmInfoComponent.componentId]
      const realmInfo = RealmInfo.getOrNull(StaticEntities.RootEntity)

      return { realmInfo: realmInfo ?? undefined }
    },
    async getWorldTime() {
      return { seconds: 0 }
    },
    async readFile(req, context) {
      return context.readFile(req.fileName)
    },
    async getExplorerInformation() {
      return {
        previewMode: true,
        agent: 'desktop',
        platform: 'desktop',
        configurations: {}
      }
    }
  }))

  codegen.registerService(port, EngineApiServiceDefinition, async () => ({
    async subscribe() {
      throw new Error('not implemented')
    },
    async unsubscribe() {
      throw new Error('not implemented')
    },
    async sendBatch() {
      return { events: [] }
    },
    async crdtGetMessageFromRenderer() {
      throw new Error('not implemented')
    },
    async isServer() {
      return { isServer: true }
    },
    async crdtGetState(_req, context) {
      return context.crdtGetState()
    },
    async crdtSendToRenderer(req, context) {
      return context.crdtSendToRenderer(req)
    }
  }))

  codegen.registerService(port, CommunicationsControllerServiceDefinition, async () => ({
    async send() {
      return {
        data: []
      }
    },
    async sendBinary(req, context) {
      if (context.transport) {
        // Bound scene→LiveKit amplification: cap the peers, the total messages,
        // and per-message size a single call can publish. Everything in `req` is
        // scene-controlled and would otherwise publish unbounded outbound traffic.
        // Count every ENTRY examined (including oversized ones we skip) against the
        // cap so a scene can't force unbounded host iteration with oversized spam.
        let processed = 0
        for (const peerData of req.peerData.slice(0, MAX_SEND_PEERS)) {
          for (const data of peerData.data) {
            if (processed >= MAX_SEND_MESSAGES) break
            processed++
            if (data.length > MAX_COMMS_MESSAGE_BYTES) continue
            void context.transport.sendParcelSceneMessage(
              { sceneId: context.entityId, data: encodeMessage(data, MsgType.Uint8Array) },
              peerData.address
            )
          }
          if (processed >= MAX_SEND_MESSAGES) break
        }
      }
      return {
        data: context.getNetworkMessages()
      }
    }
  }))

  codegen.registerService(port, CommsApiServiceDefinition, async () => ({
    async getActiveVideoStreams() {
      // Return list of active video streams
      return {
        streams: []
      }
    },
    async getConnectedPeers() {
      // Return list of connected peers from the transport
      return {
        peers: []
      }
    },
    async getRoomInfo() {
      // Return information about the current communication room
      return {
        roomId: '',
        maxPeers: 100,
        currentPeers: 0
      }
    }
  }))

  codegen.registerService(port, UserIdentityServiceDefinition, async () => ({
    async getUserData() {
      // Scene-facing: report the unprivileged guest identity, never the server's.
      const identity = await sceneIdentity.deref()

      return {
        data: {
          displayName: 'Guest',
          hasConnectedWeb3: false,
          userId: identity.address,
          version: 1,
          avatar: {
            bodyShape: 'urn:decentraland:off-chain:base-avatars:BaseFemale',
            skinColor: '#443322',
            hairColor: '#663322',
            eyeColor: '#332211',
            wearables: [
              'urn:decentraland:off-chain:base-avatars:f_sweater',
              'urn:decentraland:off-chain:base-avatars:f_jeans',
              'urn:decentraland:off-chain:base-avatars:bun_shoes',
              'urn:decentraland:off-chain:base-avatars:standard_hair',
              'urn:decentraland:off-chain:base-avatars:f_eyes_00',
              'urn:decentraland:off-chain:base-avatars:f_eyebrows_00',
              'urn:decentraland:off-chain:base-avatars:f_mouth_00'
            ],
            snapshots: {
              face256: `not-found`,
              body: `not-found`
            }
          }
        }
      }
    },
    async getUserPublicKey() {
      const identity = await sceneIdentity.deref()
      return {
        address: identity.address
      }
    }
  }))

  codegen.registerService(port, SignedFetchServiceDefinition, async () => ({
    async signedFetch(req, context) {
      // Sign with the unprivileged scene identity (never the authoritative
      // server), and refuse requests to non-public hosts to prevent SSRF.
      const identity = await sceneIdentity.deref()
      const realm = await currentRealm.deref()

      const metadata = {
        origin: 'hammurabi-server//',
        signer: 'dcl:scene-guest',
        isGuest: true,
        realm: { serverName: realm.aboutResponse.configurations?.realmName, hostname: realm.baseUrl },
        realmName: realm.aboutResponse.configurations?.realmName,
        sceneId: context.loadableScene.urn,
        parcel: (context.loadableScene.entity.metadata as Scene).scene.base
      }

      try {
        // Follow redirects manually so the SSRF guard runs on EVERY hop and each
        // hop is re-signed for its own path. Letting fetch auto-follow would skip
        // the guard on the redirected target.
        const originalOrigin = new URL(req.url).origin
        let currentUrl = req.url
        let result

        for (let hop = 0; ; hop++) {
          await assertPublicSceneUrl(currentUrl)

          // Only forward scene-supplied headers while on the original origin. On a
          // cross-origin redirect, drop them (as browsers strip Authorization etc.)
          // so a redirect can't leak a scene's own header to a third-party host.
          // The identity/auth headers are re-signed per hop inside signedFetch.
          const sameOrigin = new URL(currentUrl).origin === originalOrigin

          result = await signedFetch(
            currentUrl,
            identity.authChain,
            {
              method: req.init?.method || 'GET',
              headers: sameOrigin ? req.init?.headers || {} : {},
              body: req.init?.body,
              responseBodyType: 'text',
              redirect: 'manual'
            },
            metadata
          )

          const isRedirect = result.status >= 300 && result.status < 400
          const location = result.headers?.location
          if (!isRedirect || !location) break

          if (hop >= MAX_SIGNED_FETCH_REDIRECTS) {
            throw new Error('Blocked scene request: too many redirects')
          }
          // Resolve relative Location values against the current URL.
          currentUrl = new URL(location, currentUrl).toString()
        }

        return {
          ok: result.ok,
          status: result.status,
          statusText: result.statusText || '',
          headers: result.headers || {},
          body: result.text || '{}'
        }
      } catch (error) {
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Error',
          headers: {},
          body: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' })
        }
      }
    },

    async getHeaders(req) {
      // Scene-facing: sign with the unprivileged guest identity.
      const identity = await sceneIdentity.deref()

      try {
        const headers = getSignedHeaders(
          req.init?.method || 'GET',
          new URL(req.url).pathname,
          {
            origin: 'hammurabi-server://',
            ...req.init
          },
          (payload) => Authenticator.signPayload(identity.authChain, payload)
        )

        return { headers }
      } catch (error) {
        throw new Error(
          `Failed to generate signed headers: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
      }
    }
  }))
}
