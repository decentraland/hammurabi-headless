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
import { sceneIdentity, currentRealm, StorageDelegation, CurrentRealm } from '../../decentraland/state'
import { signedFetch, getSignedHeaders } from '../../decentraland/identity/signed-fetch'
import { getFreshStorageDelegation } from '../../decentraland/identity/storage-delegation'
import { assertPublicSceneUrl } from '../../misc/ssrf'
import { encodeMessage, MsgType, SceneContext } from './scene-context'
import { realmInfoComponent } from '../../decentraland/sdk-components/realm-info'
import { StaticEntities } from './logic/static-entities'
import { LIVEKIT_MAX_RELIABLE_PACKET_BYTES } from '../../decentraland/communications/types'

// Per-call caps on scene→LiveKit publishing (CommunicationsController.sendBinary).
// The request is fully scene-controlled; without caps a scene could flood the room.
const MAX_SEND_PEERS = 256
const MAX_SEND_MESSAGES = 512
// This caps the RAW scene payload. Before it reaches the transport it is grown by a
// 1-byte type marker (encodeMessage) and wrapped in a Scene/Packet protobuf (sceneId
// string + field tags/length varints), and the transport enforces
// LIVEKIT_MAX_RELIABLE_PACKET_BYTES on that FULLY-ENCODED result. Reserve headroom for
// the framing so a payload we accept here can never exceed the transport limit and get
// silently dropped downstream (the send is fire-and-forget, so the scene gets no error).
const COMMS_PACKET_FRAMING_OVERHEAD = 1024
const MAX_COMMS_MESSAGE_BYTES = LIVEKIT_MAX_RELIABLE_PACKET_BYTES - COMMS_PACKET_FRAMING_OVERHEAD
// Bounds on the scene-controlled recipient list of a single peer-to-peer message.
// The addresses flow straight into the LiveKit packet's destination_identities, so
// without these an unbounded address[] (or multi-KB identity strings) would be
// serialized and shipped to the SFU — amplification the peer/message caps don't cover.
// Real comms rooms hold ~100 peers; 256 is generous headroom. A wallet-address
// identity is 42 chars, so 128 rejects only pathological strings.
const MAX_SEND_ADDRESSES = 256
const MAX_ADDRESS_LENGTH = 128

// Max redirects a scene SignedFetch will follow. Each hop is re-validated by the
// SSRF guard so a public host can't 3xx-redirect the request onto a private
// address (metadata endpoint, loopback admin) — the single-shot guard alone was
// bypassable because the underlying fetch follows redirects transparently.
const MAX_SIGNED_FETCH_REDIRECTS = 5

// The world-storage-service. Requests to these hosts are signed with the
// world-scoped storage delegation (when present) instead of the guest identity.
// Exact host match only, so a lookalike (storage.decentraland.zone.evil.com) is
// never treated as first-party.
const STORAGE_HOSTS = new Set(['storage.decentraland.org', 'storage.decentraland.zone'])

/**
 * Decide, per redirect hop, how to sign a scene SignedFetch. Returns a privileged
 * storage-signing strategy ONLY when the hop targets the world-storage-service AND
 * a valid, unexpired world-scoped delegation exists; otherwise `null` (caller uses
 * the guest identity). Scoping the delegation to storage hosts — re-checked every
 * hop — keeps a scene from ever obtaining an authoritative-signed request for an
 * arbitrary URL (preserves the SSRF/impersonation guarantees).
 */
export function getStorageSigningStrategy(
  url: string,
  delegation: StorageDelegation | null,
  realm: CurrentRealm,
  context: SceneContext
): { metadata: Record<string, any>; options: { chainProvider: (payload: string) => any; extraHeaders: Record<string, string> } } | null {
  if (!delegation) return null

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  // HTTPS only. The scene controls this URL and `assertPublicSceneUrl` permits
  // http:, so without this gate a scene could force `http://storage.decentraland.*`
  // and the ephemeral auth-chain + root-signed scope claim would go out in
  // cleartext (before any server-side http→https redirect) for an on-path attacker
  // to capture and replay for the credential's TTL.
  if (parsed.protocol !== 'https:') return null
  if (!STORAGE_HOSTS.has(parsed.hostname.toLowerCase())) return null
  if (Date.now() >= delegation.expiration) return null

  const account = {
    privateKey: delegation.ephemeral.privateKey,
    publicKey: delegation.ephemeral.publicKey,
    address: delegation.ephemeral.address
  }

  const metadata = {
    origin: 'hammurabi-server//',
    signer: 'dcl:authoritative-server',
    isGuest: false,
    // Report the delegation's world/scene/parcel (not the worker's own context) so
    // the storage service derives exactly the placeId the scope claim is bound to
    // and can match scope.world/sceneId/parcel to the request. The parcel pins the
    // placeId (placeId = f(world, parcel)); sceneId is the explicit scene identity.
    realm: { serverName: delegation.world, hostname: realm.baseUrl },
    realmName: delegation.world,
    sceneId: delegation.sceneId,
    parcel: delegation.parcel
  }

  const scopeHeader =
    typeof Buffer !== 'undefined'
      ? Buffer.from(JSON.stringify(delegation.scope), 'utf8').toString('base64')
      : btoa(JSON.stringify(delegation.scope))

  return {
    metadata,
    options: {
      // Standalone ephemeral (owner = ephemeral address). It does NOT resolve to
      // the authoritative address, so it can't hit the broad allow-list path in
      // the storage service — only the world-scoped claim below authorizes it.
      chainProvider: (payload: string) =>
        Authenticator.createSimpleAuthChain(payload, account.address, Authenticator.createSignature(account, payload)),
      extraHeaders: { 'x-authoritative-scope': scopeHeader }
    }
  }
}

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

        // Publish one scene message to `destination` (empty = broadcast), enforcing
        // the type + size guard. A non-Uint8Array here (e.g. a byte-keyed plain
        // object) has undefined length, which would pass the cap check and then
        // publish an empty payload. Returns false once the total-message cap is hit.
        const publish = (data: unknown, destination: string[]): boolean => {
          if (processed >= MAX_SEND_MESSAGES) return false
          processed++
          if (!(data instanceof Uint8Array) || data.length > MAX_COMMS_MESSAGE_BYTES) return true
          void context.transport!.sendParcelSceneMessage(
            { sceneId: context.entityId, data: encodeMessage(data, MsgType.Uint8Array) },
            destination
          )
          return true
        }

        // Deprecated broadcast field: still emitted by older SDK builds (newer ones
        // broadcast via peerData with an empty address). Handle it so those scenes'
        // messages aren't silently dropped.
        for (const data of req.data) {
          if (!publish(data, [])) break
        }

        // Peer-to-peer messages.
        outer: for (const peerData of req.peerData.slice(0, MAX_SEND_PEERS)) {
          // Cap the scene-controlled recipient list per message and drop implausibly
          // long identity strings before they reach LiveKit's destination_identities.
          // slice() first so we never iterate an unbounded array.
          const destination = peerData.address
            .slice(0, MAX_SEND_ADDRESSES)
            .filter((addr) => typeof addr === 'string' && addr.length <= MAX_ADDRESS_LENGTH)
          // An empty destination means broadcast. If the scene DID target specific
          // peers but none survived filtering, drop the message rather than silently
          // broadcasting it to the whole room.
          if (peerData.address.length > 0 && destination.length === 0) continue
          for (const data of peerData.data) {
            if (!publish(data, destination)) break outer
          }
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

          // Re-evaluated every hop: only the world-storage host gets the scoped
          // storage delegation; anything else (including a redirect target) is
          // signed with the guest identity. Fetch a fresh delegation (renewing
          // over IPC if near expiry) only for storage hops, so non-storage
          // requests never wait on a renewal.
          let hopHost: string | undefined
          try {
            hopHost = new URL(currentUrl).hostname.toLowerCase()
          } catch {
            hopHost = undefined
          }
          const delegation = hopHost && STORAGE_HOSTS.has(hopHost) ? await getFreshStorageDelegation() : null
          const storageStrategy = getStorageSigningStrategy(currentUrl, delegation, realm, context)

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
            storageStrategy ? storageStrategy.metadata : metadata,
            storageStrategy?.options
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
