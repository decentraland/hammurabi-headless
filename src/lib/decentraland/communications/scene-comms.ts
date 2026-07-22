import { Atom } from "../../misc/atom"
import { ExplorerIdentity } from "../identity/types"
import { connectAdapter, connectLocalAdapter, connectGenesisAdapter, connectWorldsAdapter } from "./connect-adapter"
import { connectTransport } from "./connect-transport"
import { Scene } from "@babylonjs/core"
import { CurrentRealm } from "../state"

/**
 * Resolves the realm's comms adapter and builds an UNCONNECTED transport wrapper. The caller
 * (CommsRouter) owns connect ordering so it can attach lifecycle handlers before dialing — call
 * `.connect()` on the returned wrapper to open the connection.
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
    return connectTransport(options.commsAdapter, identity, scene, options.sceneId ?? 'realm')
  }

  let newAdapter
  if (options?.isLocalhost) {
    // Local development
    newAdapter = await connectLocalAdapter(realm.baseUrl)
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
  return connectTransport(connectionString.url, identity, scene, connectionString.sceneId)
}
