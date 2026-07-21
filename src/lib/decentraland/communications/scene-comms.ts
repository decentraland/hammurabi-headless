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
      // runs, and say so loudly. This early return is deliberately the ONLY
      // place an offline transport is created: every other path (worlds,
      // Genesis, supervisor pre-minted adapters, custom realms below) keeps
      // failing hard, so a comms-less authoritative server outside local
      // preview is restarted rather than left looking healthy while serving
      // nobody.
      const message = error instanceof Error ? error.message : String(error)
      console.warn(
        `⚠️  Comms handshake failed (${message}); starting in OFFLINE single-player mode — ` +
          `no clients will connect to this server until it is restarted with working comms.`
      )
      const transport = new CommsTransportWrapper(createOfflineTransport(), options.sceneId ?? 'realm')
      transport.connect()
      return transport
    }
  } else if (options?.isWorld && options?.sceneId) {
    // Decentraland Worlds
    newAdapter = await connectWorldsAdapter(options.sceneId, realm.connectionString)
  } else if (options?.isGenesisScene && options?.sceneId) {
    // Genesis City scenes
    newAdapter = await connectGenesisAdapter(options.sceneId)
  } else {
    // Fallback for other realms. No offline default: a realm that advertises
    // no comms adapter is a configuration error and must fail loudly here —
    // defaulting to offline would boot a server that looks healthy while
    // serving nobody.
    const fixedAdapter = realm.aboutResponse.comms?.fixedAdapter
    if (!fixedAdapter) {
      throw new Error(
        `Realm "${realm.connectionString}" advertises no comms fixedAdapter; ` +
          `refusing to start without comms outside local preview`
      )
    }
    newAdapter = await connectAdapter(fixedAdapter, identity, 'realm')
  }

  const desiredTransports = await newAdapter.desiredTransports.deref()
  const connectionString = desiredTransports[0]
  const transport = connectTransport(connectionString.url, identity, scene, connectionString.sceneId)

  transport.connect()

  return transport
}
