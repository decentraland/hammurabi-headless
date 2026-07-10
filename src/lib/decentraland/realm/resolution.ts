// This file implements https://adr.decentraland.org/adr/ADR-144

import { getEnvironment, getWorldsContentServerUrl } from '../environment'

export function isDclEns(str: string | undefined): str is `${string}.dcl.eth` {
  return !!str?.match(/^[a-zA-Z0-9]+\.dcl\.eth$/)?.length
}

function isEns(str: string | undefined): str is `${string}.dcl.eth` {
  return !!str?.match(/^[a-zA-Z0-9]+\.eth$/)?.length
}

export function dclWorldUrl(dclName: string) {
  return `${getWorldsContentServerUrl()}/world/${encodeURIComponent(dclName.toLowerCase())}`
}

/**
 * Whether a realm base URL points at a local-development server. Exact
 * hostname match — a substring check misclassifies domains like
 * "mylocalhost.io" — and shared so every consumer (realm-type routing,
 * RealmInfo's isPreview) classifies identically.
 */
export function isLocalhostRealm(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname
    return hostname === 'localhost' || hostname === '127.0.0.1'
  } catch {
    return false
  }
}

// This file came from a browser client where "://host" meant "the page's
// current protocol" and "/path" resolved against the page origin. Headless
// there is no page: default protocol-less forms to https, and resolve
// path-only static routes against the canonical play host.
function normalizeUrl(url: string) {
  return url.replace(/^:\/\//, 'https:' + '//')
}

function urlWithProtocol(urlOrHostname: string) {
  if (urlOrHostname.startsWith('/')) {
    return new URL(urlOrHostname, 'https://play.decentraland.org').toString()
  }

  if (!urlOrHostname.startsWith('http://') && !urlOrHostname.startsWith('https://') && !urlOrHostname.startsWith('://'))
    return normalizeUrl(`https://${urlOrHostname}`)

  return normalizeUrl(urlOrHostname)
}

export async function resolveRealmBaseUrl(realmString: string): Promise<string> {
  if (isEns(realmString)) {
    // TODO: implement the rest of ADR-144
    // if (await ens.resolve(realmString, 'dcl.realm')) {
    //   return ens.resolve(realmString, 'dcl.realm')
    // }
  }

  if (isDclEns(realmString)) {
    return dclWorldUrl(realmString)
  }

  return urlWithProtocol(realmString)
}
