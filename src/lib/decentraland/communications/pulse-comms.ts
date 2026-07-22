import { Authenticator } from '@dcl/crypto'
import type { ParcelCoord } from '@dcl/pulse-client'
import { ExplorerIdentity } from '../identity/types'
import { getSignedHeaders } from '../identity/signed-fetch'
import { parseParcelPosition } from '../positions'
import { CommsListenerConfig } from './config'
import { CommsTransportWrapper } from './CommsTransportWrapper'
import { PulseAdapter } from './transports/pulse'

/**
 * Scene footprint as raw parcel coordinates. scene.json parcels are "x,z" strings;
 * parseParcelPosition returns a Vector2 whose `.y` holds the DCL parcel Z. pulse-client composes
 * these into disjoint ParcelRects for the handshake, so hammurabi never computes grid indices.
 */
export function sceneParcelsToPulseCoords(parcels: string[]): ParcelCoord[] {
  return parcels.map((parcel) => {
    const vec = parseParcelPosition(parcel)
    return { x: vec.x, z: vec.y }
  })
}

/**
 * Builds an UNCONNECTED Pulse comms transport (symmetric with {@link createSceneComms}); the
 * CommsRouter owns connect ordering. The signed-fetch auth_chain is minted lazily per connect —
 * the Pulse server re-derives the payload as `connect:/:<ts>:<md>`, so the method MUST be `connect`
 * and the path `/`.
 */
export function createPulseComms(
  config: CommsListenerConfig,
  identity: ExplorerIdentity,
  sceneParcels: string[],
  sceneId: string
): CommsTransportWrapper {
  const mintAuthChain = () =>
    JSON.stringify(
      getSignedHeaders('connect', '/', {}, (payload) => Authenticator.signPayload(identity.authChain, payload))
    )

  const adapter = new PulseAdapter({
    host: config.host,
    port: config.port,
    realm: config.realm,
    parcels: sceneParcelsToPulseCoords(sceneParcels),
    mintAuthChain,
    debug: config.debug
  })
  return new CommsTransportWrapper(adapter, sceneId)
}
