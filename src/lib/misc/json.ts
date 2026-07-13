import { robustFetch, readBodyCapped, DEFAULT_MAX_BODY_BYTES } from './network'

// Cap how much of an error body we splice into the thrown Error message, so a
// large error response can't inflate the exception (which gets logged/serialized).
const MAX_ERROR_BODY_CHARS = 512

export async function json<T>(url: string, options: RequestInit = {}, attempts = 3): Promise<T> {
  const resp = await robustFetch(url, options, { retries: Math.max(1, attempts), label: 'json' })
  // The URL is realm-/content-server-derived (operator-supplied), so a hostile or
  // compromised realm could otherwise stream an unbounded body into host memory.
  // Enforce the same body ceiling as the /about path on BOTH branches.
  if (!resp.ok) {
    // Best-effort snippet for the thrown error; a read failure here is not itself
    // interesting (the status already tells the story).
    const body = await readBodyCapped(resp, DEFAULT_MAX_BODY_BYTES).catch(() => '')
    const snippet = body.length > MAX_ERROR_BODY_CHARS ? `${body.slice(0, MAX_ERROR_BODY_CHARS)}…` : body
    throw new Error(`${resp.status} ${resp.statusText} for ${url}: ${snippet}`)
  }
  // Let a cap-exceeded error propagate with its clear "exceeds N bytes" message.
  return JSON.parse(await readBodyCapped(resp, DEFAULT_MAX_BODY_BYTES)) as T
}
