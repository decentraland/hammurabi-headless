import { Atom } from "../../misc/atom"
import { ExplorerIdentity } from "../identity/types"
import { connectAdapter, connectLocalAdapter, connectGenesisAdapter, connectWorldsAdapter } from "./connect-adapter"
import { connectTransport } from "./connect-transport"
import { CommsTransportWrapper } from "./CommsTransportWrapper"
import { createOfflineTransport } from "./transports/offline"
import { Scene } from "@babylonjs/core"
import { CurrentRealm } from "../state"

/**
 * This system is in charge to handle realm connections and connect/disconnect transports accordingly.
 */
export async function createSceneComms(
  realm: CurrentRealm,
  userIdentity: Atom<ExplorerIdentity>,
  scene: Scene,
  options?: {
    isGenesisScene?: boolean
    sceneId?: string
    isWorld?: boolean
    isLocalhost?: boolean
    // Pre-minted comms adapter from a trusted parent (authoritative-server flow).
    commsAdapter?: string
  }
) {
  const identity = await userIdentity.deref()

  // Fast path: a trusted parent already performed the comms-gatekeeper handshake
  // and handed us the adapter. Connect directly — no signed handshake and no
  // privileged identity is used in this (untrusted) worker.
  if (options?.commsAdapter) {
    const transport = connectTransport(options.commsAdapter, identity, scene, options.sceneId ?? 'realm')
    transport.connect()
    return transport
  }

  let newAdapter
  if (options?.isLocalhost) {
    // Local development
    try {
      newAdapter = await connectLocalAdapter(realm.baseUrl)
    } catch (error) {
      // LOCAL PREVIEW ONLY: the handshake needs internet (comms gatekeeper +
      // LiveKit cloud). When it fails, a dead server helps nobody — boot in
      // offline single-player mode instead so the scene's isServer() code still
      // runs, and say so loudly. Production paths (worlds, Genesis, supervisor
      // pre-minted adapters) keep failing hard: there a comms-less
      // authoritative server must be restarted, not silently isolated.
      const message = error instanceof Error ? error.message : String(error)
      console.warn(
        `⚠️  Comms handshake failed (${message}); starting in OFFLINE single-player mode — ` +
          `no clients will connect to this server until it is restarted with working comms.`
      )
      newAdapter = await connectAdapter('offline:offline', identity, options.sceneId ?? 'realm')
    }
  } else if (options?.isWorld && options?.sceneId) {
    // Decentraland Worlds
    newAdapter = await connectWorldsAdapter(options.sceneId, realm.connectionString)
  } else if (options?.isGenesisScene && options?.sceneId) {
    // Genesis City scenes
    newAdapter = await connectGenesisAdapter(options.sceneId)
  } else {
    // Fallback for other realms
    newAdapter = await connectAdapter(realm.aboutResponse.comms?.fixedAdapter ?? "offline:offline", identity, 'realm')
  }

  const desiredTransports = await newAdapter.desiredTransports.deref()
  const connectionString = desiredTransports[0]
  // The offline adapter yields an empty url, which used to be a dead end
  // (connectTransport throws on any non-livekit string). Give it a real no-op
  // transport so offline realms — and the local-preview fallback above — boot.
  const transport = connectionString.url
    ? connectTransport(connectionString.url, identity, scene, connectionString.sceneId)
    : new CommsTransportWrapper(createOfflineTransport(), connectionString.sceneId)

  transport.connect()

  return transport
}
