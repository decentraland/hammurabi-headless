import { Atom } from "../../misc/atom"
import { ExplorerIdentity } from "../identity/types"
import { connectAdapter, connectLocalAdapter, connectGenesisAdapter } from "./connect-adapter"
import { connectTransport } from "./connect-transport"
import { Scene } from "@babylonjs/core"
import { CurrentRealm } from "../state"

/**
 * This system is in charge to handle realm connections and connect/disconnect transports accordingly.
 */
export async function createSceneComms(realm: CurrentRealm, userIdentity: Atom<ExplorerIdentity>, scene: Scene, options?: { isGenesisScene?: boolean, sceneId?: string }) {
  const identity = await userIdentity.deref()
  
  const isLocalPreview = realm.aboutResponse.configurations?.realmName === "LocalPreview"

  let newAdapter
  if (isLocalPreview) {
    newAdapter = await connectLocalAdapter(realm.baseUrl)
  } else if (options?.isGenesisScene && options?.sceneId) {
    // Use comms-gatekeeper for Genesis City scenes with realm "main"
    newAdapter = await connectGenesisAdapter(options.sceneId)
  } else {
    // Fallback to existing logic for other realms
    newAdapter = await connectAdapter(realm.aboutResponse.comms?.fixedAdapter ?? "offline:offline", identity, 'realm')
  }

  const desiredTransports = await newAdapter.desiredTransports.deref()
  const connectionString = desiredTransports[0]
  const transport = connectTransport(connectionString.url, identity, scene, connectionString.sceneId)

  transport.connect()

  return transport
}
