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
    // A string throw here used to surface as "❌ Failed to start: undefined"
    // (error.message of a string is undefined) — always throw real Errors.
    throw new Error(`Comms gatekeeper rejected the local-preview handshake (HTTP ${result.status}): no adapter returned`)
  } catch (e: any) {
    const message = e instanceof Error ? e.message : String(e)
    console.error(
      `❌ Local-preview comms handshake failed against ${COMMS_GATEKEEPER_LOCAL}: ${message}\n` +
        `   Authoritative-multiplayer preview needs internet access (comms gatekeeper + LiveKit cloud).`
    )
    throw e instanceof Error ? e : new Error(message)
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

    // The gatekeeper only mints server adapters for the authoritative identity
    // on production realms, so a guest run (no --private-key / no supervisor
    // adapter) lands here with a 401. Name that instead of throwing a bare
    // string (which used to print "❌ Failed to start: undefined").
    throw new Error(
      `Comms gatekeeper rejected the handshake for realm "${realmName}" (HTTP ${result.status}). ` +
        `Non-preview realms require the authoritative server identity — ` +
        `for local development use a localhost realm; for production runs supply the server key.`
    )
  } catch (e: any) {
    const message = e instanceof Error ? e.message : String(e)
    console.error(`❌ Comms handshake failed against ${gatekeeperUrl}: ${message}`)
    throw e instanceof Error ? e : new Error(message)
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
