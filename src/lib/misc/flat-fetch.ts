import { robustFetch, drainResponse } from './network'

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

// SignedFetch URLs are scene-controlled: after the SSRF guard passes (public
// host), the body size is attacker-chosen, and .text()/.json() would buffer it
// all into host memory (the 15s per-attempt timeout doesn't bound volume on a
// fast link). The XHR asset path already caps its responses; this path must
// too. 10MB is far above any legitimate signed-fetch API response.
const MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024

async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await drainResponse(response)
    throw new Error(`response body exceeds ${maxBytes} bytes`)
  }

  // Content-Length can be absent or lie (chunked encoding), so the streamed
  // read enforces the cap regardless of the header.
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        throw new Error(`response body exceeds ${maxBytes} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    // Release the socket if the cap aborted the read mid-stream (no-op after a
    // complete drain).
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

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

  switch (responseBodyType) {
    case 'json':
      flatFetchResponse.json = JSON.parse(await readBodyCapped(response, MAX_RESPONSE_BODY_BYTES))
      break
    case 'text':
      flatFetchResponse.text = await readBodyCapped(response, MAX_RESPONSE_BODY_BYTES)
      break
  }

  return flatFetchResponse
}
