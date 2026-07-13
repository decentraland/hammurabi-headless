import { Agent } from 'undici'
import { lookup as dnsLookup } from 'dns'
import { isBlockedResolvedAddress } from './ssrf'

/**
 * undici dispatcher for scene-controlled egress (`~system/SignedFetch`).
 *
 * `assertPublicSceneUrl` resolves and checks the hostname UP FRONT, but Node's
 * global `fetch` (undici) resolves the hostname AGAIN at connect time, leaving a
 * DNS-rebinding window: an attacker-controlled resolver answers the guard with a
 * public IP, then answers the connect-time query with a private one (cloud
 * metadata, loopback admin). This Agent closes that window.
 *
 * Its custom `lookup` runs at CONNECT time and is the SAME resolution undici uses
 * for the socket. It verifies EVERY resolved address is public and hands undici
 * only vetted addresses, so the address the socket connects to IS the address
 * that was checked — there is no second, unchecked resolution. The original
 * hostname is preserved for TLS SNI / certificate validation (we only constrain
 * which IPs the connection may use, not the SNI). The guard re-runs on every
 * redirect hop because each hop is a fresh `fetch` on this same agent.
 *
 * undici calls `lookup(hostname, { hints, all: true }, cb)` and, with `all`,
 * expects `cb(null, addresses[])`.
 */
export function pinningLookup(hostname: string, options: any, callback: any) {
  dnsLookup(
    hostname,
    { all: true, hints: options?.hints, family: options?.family },
    (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => {
      if (err) return callback(err, undefined as any, undefined as any)
      if (!addresses || addresses.length === 0) {
        return callback(new Error(`Blocked scene request: ${hostname} did not resolve`), undefined as any, undefined as any)
      }
      for (const { address, family } of addresses) {
        if (isBlockedResolvedAddress(address, family)) {
          return callback(
            new Error(`Blocked scene request: ${hostname} resolves to non-public address ${address}`),
            undefined as any,
            undefined as any
          )
        }
      }
      // Every candidate is public; undici may connect to any of them.
      if (options?.all) return callback(null, addresses as any, undefined as any)
      callback(null, addresses[0].address, addresses[0].family)
    }
  )
}

export const sceneEgressAgent = new Agent({ connect: { lookup: pinningLookup } })
