import { Atom } from "../../misc/atom"
import { ExplorerIdentity } from "../identity/types"
import { connectAdapter, connectLocalAdapter, connectGenesisAdapter, connectWorldsAdapter } from "./connect-adapter"
import { connectTransport } from "./connect-transport"
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
  const transport = connectTransport(connectionString.url, identity, scene, connectionString.sceneId)

  transport.connect()

  return transport
}
