import { robustFetch, readBodyCapped, DEFAULT_MAX_BODY_BYTES } from './network'

type FlatFetchResponse = {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  json?: any
  text?: string
}

type BodyType = 'json' | 'text'

export type FlatFetchInit = RequestInit & { responseBodyType?: BodyType }

export async function flatFetch(url: string, init?: FlatFetchInit): Promise<FlatFetchResponse> {
  const response = await robustFetch(url, init, { label: 'signedFetch' })
  const responseBodyType = init?.responseBodyType || 'text'
  const headers: Record<string, string> = {}

  response.headers.forEach((value, key) => (headers[key] = value))

  const flatFetchResponse: FlatFetchResponse = {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers
  }

  // SignedFetch URLs are scene-controlled: after the SSRF guard passes (public
  // host), the body size is attacker-chosen, so it must be capped. The XHR
  // asset path enforces its own cap; this path shares the network.ts one.
  switch (responseBodyType) {
    case 'json':
      flatFetchResponse.json = JSON.parse(await readBodyCapped(response, DEFAULT_MAX_BODY_BYTES))
      break
    case 'text':
      flatFetchResponse.text = await readBodyCapped(response, DEFAULT_MAX_BODY_BYTES)
      break
  }

  return flatFetchResponse
}
