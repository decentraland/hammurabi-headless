import { Scene } from "@babylonjs/core"
import { ExplorerIdentity } from "../identity/types"
import { CommsTransportWrapper } from "./CommsTransportWrapper"
import { LivekitAdapter } from "./transports/livekit"

// `identity` is retained in the signature for API compatibility but is unused:
// the only supported transport is LiveKit, which authenticates with the bearer
// token embedded in the adapter URL, not with the worker's identity.
export function connectTransport(connStr: string, _identity: ExplorerIdentity, scene: Scene, sceneId: string): CommsTransportWrapper {
  const ix = connStr.indexOf(':')
  const protocol = connStr.substring(0, ix)
  const url = connStr.substring(ix + 1)

  switch (protocol) {
    case 'livekit': {
      const theUrl = new URL(url)
      const token = theUrl.searchParams.get('access_token')
      if (!token) {
        throw new Error('No access token')
      }
      return new CommsTransportWrapper(
        new LivekitAdapter({
          url: theUrl.origin + theUrl.pathname,
          token,
          scene
        }),
        sceneId
      )
    }
  }
  throw new Error(`A communications transport could not be created for protocol=${protocol}`)
}