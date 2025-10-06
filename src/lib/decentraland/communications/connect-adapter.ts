import { userIdentity } from "../state"
import { getLoadableSceneFromLocalContext } from "../../babylon/scene/load"
import { Atom } from "../../misc/atom"
import { signedFetch } from "../identity/signed-fetch"
import { ExplorerIdentity } from "../identity/types"
import { CommsAdapter } from "./types"

// TODO: this should be an env var
const COMMS_GATEKEEPER_URL =
'https://comms-gatekeeper-local.decentraland.org/get-server-scene-adapter'
// 'http://localhost:3000/get-server-scene-adapter'
const COMMS_GATEKEEPER_PROD = 'https://comms-gatekeeper.decentraland.org/get-server-scene-adapter' 
const COMMS_GATEKEEPER_ZONE = 'https://comms-gatekeeper.decentraland.zone/get-server-scene-adapter' 

export async function connectLocalAdapter(baseUrl: string) {
  const { urn } = await getLoadableSceneFromLocalContext(baseUrl)
  const identity = await userIdentity.deref()

  try {
    const result = await signedFetch(
      COMMS_GATEKEEPER_URL,
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
        sceneId: urn,
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
  return connectProductionAdapter(sceneId, 'main')
}

export async function connectWorldsAdapter(sceneId: string, worldName: string) {
  return connectProductionAdapter(sceneId, worldName)
}

export async function connectProductionAdapter(sceneId: string, realmName: string) {
  console.log('[CASLA]: connectProductionAdapter')
  const identity = await userIdentity.deref()

  try {
    const result = await signedFetch(
      COMMS_GATEKEEPER_ZONE,
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
        sceneId: sceneId,
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
export async function connectAdapter(connStr: string, identity: ExplorerIdentity, sceneId: string): Promise<CommsAdapter> {
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
    case 'ws-room': {
      return {
        desiredTransports: Atom([{ url: connStr, sceneId }]),
        reportPosition(position) {
          // stub
        },
        disconnect() {
          // stub
        }
      }
    }
    case 'signed-login': {
      // this communications protocol signals a "required handshake" to connect
      // to a server which requires a signature from part of the user in order
      // to authenticate them
      const result = await signedFetch(
        url,
        identity.authChain,
        { method: 'POST', responseBodyType: 'json' },
        {
          intent: 'dcl:explorer:comms-handshake',
          signer: 'dcl:explorer',
          isGuest: identity.isGuest
        }
      )

      const response: SignedLoginResult = result.json
      if (!result.ok || typeof response !== 'object') {
        throw new Error(
          'There was an error acquiring the communications connection. Decentraland will try to connect to another realm'
        )
      }

      type SignedLoginResult = {
        fixedAdapter?: string
        message?: string
      }

      if (typeof response.fixedAdapter === 'string' && !response.fixedAdapter.startsWith('signed-login:')) {
        return {
          desiredTransports: Atom([{ url: response.fixedAdapter, sceneId }]),
          reportPosition(position) {
            // stub
          },
          disconnect() {
            // stub
          }
        }
      }

      if (typeof response.message === 'string') {
        throw new Error(`There was an error acquiring the communications connection: ${response.message}`)
      }

      throw new Error(`An unknown error was detected while trying to connect to the selected realm.`)
    }
  }
  throw new Error(`A communications adapter could not be created for protocol=${protocol}`)
}
