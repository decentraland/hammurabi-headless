import { userIdentity } from '../state'
import { getLoadableSceneFromLocalContext } from '../../babylon/scene/load'
import { Atom } from '../../misc/atom'
import { signedFetch } from '../identity/signed-fetch'
import { ExplorerIdentity } from '../identity/types'
import { CommsAdapter } from './types'
import { isDclEns } from '../realm/resolution'
import { getCommsGatekeeperUrl } from '../environment'

// Local development gatekeeper (always uses .org)
const COMMS_GATEKEEPER_LOCAL = 'https://comms-gatekeeper-local.decentraland.org/get-server-scene-adapter'

export async function connectLocalAdapter(baseUrl: string) {
  const { urn } = await getLoadableSceneFromLocalContext(baseUrl)
  const identity = await userIdentity.deref()

  try {
    const result = await signedFetch(
      COMMS_GATEKEEPER_LOCAL,
      identity.authChain,
      { method: 'POST', responseBodyType: 'json' },
      {
        intent: 'dcl:explorer:comms-handshake',
        signer: 'dcl:explorer',
        isGuest: identity.isGuest,
        realm: {
          serverName: 'LocalPreview'
        },
        realmName: 'LocalPreview',
        sceneId: urn
      }
    )
    if (result.ok && result.json.adapter) {
      return await connectAdapter(result.json.adapter, identity, urn)
    }
    throw 'Invalid livekit connection'
  } catch (e: any) {
    console.log(e)
    throw e
  }
}

export async function connectGenesisAdapter(sceneId: string) {
  // Unity hardcodes realmName="main" for Genesis regardless of which catalyst
  // (artemis on zone, hela on prod, …) is actually serving the about.json.
  // We must match that so both clients land in the same LiveKit scene-room.
  return connectProductionAdapter(sceneId, 'main')
}

export async function connectWorldsAdapter(sceneId: string, worldName: string) {
  return connectProductionAdapter(sceneId, worldName)
}

export async function connectProductionAdapter(sceneId: string, realmName: string) {
  const identity = await userIdentity.deref()
  const gatekeeperUrl = getCommsGatekeeperUrl()
  try {
    const result = await signedFetch(
      gatekeeperUrl,
      identity.authChain,
      { method: 'POST', responseBodyType: 'json' },
      {
        intent: 'dcl:explorer:comms-handshake',
        signer: 'dcl:explorer',
        isGuest: identity.isGuest,
        realm: {
          serverName: realmName
        },
        realmName,
        sceneId,
      }
    )
    if (result.ok && result.json.adapter) {
      return await connectAdapter(result.json.adapter, identity, sceneId)
    }

    throw 'Invalid livekit connection'
  } catch (e: any) {
    console.log(e)
    throw e
  }
}

// this function returns adapters for the different protocols. in case of receiving a transport instead,
// a stub adapter will be created to wrap the transport
export async function connectAdapter(
  connStr: string,
  identity: ExplorerIdentity,
  sceneId: string
): Promise<CommsAdapter> {
  const ix = connStr.indexOf(':')
  const protocol = connStr.substring(0, ix)
  const url = connStr.substring(ix + 1)

  switch (protocol) {
    case 'livekit': {
      return {
        reportPosition(position) {
          // stub
        },
        desiredTransports: Atom([{ url: connStr, sceneId }]),
        disconnect() {
          // stub
        }
      }
    }
    case 'offline': {
      return {
        reportPosition(position) {
          // stub
        },
        desiredTransports: Atom([{ url: '', sceneId }]),
        disconnect() {
          // stub
        }
      }
    }
    // NOTE: the `ws-room` and `signed-login` adapters were intentionally removed.
    // They required signing a remote-chosen challenge / arbitrary URL with the
    // authoritative identity, which must never happen in the untrusted worker.
    // Authoritative multiplayer (Genesis City + Worlds) uses LiveKit only.
  }
  throw new Error(`A communications adapter could not be created for protocol=${protocol}`)
}
