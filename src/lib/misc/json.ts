import { robustFetch, readBodyCapped, DEFAULT_MAX_BODY_BYTES } from './network'

// Cap how much of an error body we splice into the thrown Error message, so a
// large error response can't inflate the exception (which gets logged/serialized).
const MAX_ERROR_BODY_CHARS = 512

export async function json<T>(url: string, options: RequestInit = {}, attempts = 3): Promise<T> {
  const resp = await robustFetch(url, options, { retries: Math.max(1, attempts), label: 'json' })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    const snippet = body.length > MAX_ERROR_BODY_CHARS ? `${body.slice(0, MAX_ERROR_BODY_CHARS)}…` : body
    throw new Error(`${resp.status} ${resp.statusText} for ${url}: ${snippet}`)
  }
  // Cap the body before buffering/parsing (defense in depth against an oversized
  // response from a possibly-attacker-influenced endpoint), matching flatFetch/XHR.
  return JSON.parse(await readBodyCapped(resp, DEFAULT_MAX_BODY_BYTES)) as T
}
