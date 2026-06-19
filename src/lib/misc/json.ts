import { robustFetch } from './network'

export async function json<T>(url: string, options: RequestInit = {}, attempts = 3): Promise<T> {
  const resp = await robustFetch(url, options, { retries: Math.max(1, attempts), label: 'json' })
  if (!resp.ok) {
    throw new Error(await resp.text())
  }
  return resp.json() as Promise<T>
}
