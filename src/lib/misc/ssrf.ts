import { lookup } from 'dns/promises'

/**
 * SSRF guard for scene-controlled outbound requests.
 *
 * Scene code can hand an arbitrary URL to `~system/SignedFetch`. Without a guard
 * it could point that request at cloud-metadata endpoints (169.254.169.254),
 * loopback admin services, or other hosts inside the worker's private network.
 * This module rejects URLs that target loopback / link-local / private ranges,
 * by literal address and by best-effort DNS resolution.
 *
 * Residual limitation: this does not defend against active DNS rebinding
 * (resolve public, then reconnect to a private IP). Full protection needs the
 * connection to pin the resolved address; that is a larger change.
 */

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p))
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false
  const [a, b] = parts
  if (a === 0) return true // 0.0.0.0/8 "this host"
  if (a === 10) return true // 10.0.0.0/8 private
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  return false
}

function isBlockedIpv6(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (v === '::1' || v === '::') return true // loopback / unspecified
  // Link-local fe80::/10 (through febf::) AND deprecated site-local fec0::/10
  // (through feff::). The old `startsWith('fe80')` covered only fe80::/16, so
  // e.g. fe90::/feb0:: slipped through. `fe8`–`fef` matches fe80::–feff::.
  if (/^fe[89a-f]/.test(v)) return true
  if (v.startsWith('fc') || v.startsWith('fd')) return true // unique-local fc00::/7

  // IPv4-mapped / -compatible in DOTTED form, e.g. ::ffff:169.254.169.254 or ::1.2.3.4
  const dotted = v.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) return isBlockedIpv4(dotted[1])

  // IPv4-mapped/-compatible in HEX form. `new URL()` normalizes the trailing 32
  // bits to two hex hextets — ::ffff:169.254.169.254 becomes ::ffff:a9fe:a9fe and
  // the IPv4-compatible ::169.254.169.254 becomes ::a9fe:a9fe. The dotted match
  // above never sees either, so decode both (`ffff:` optional) back to IPv4 and
  // apply the same block list. Without this the SSRF guard is bypassable.
  const embedded = v.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (embedded) {
    const hi = parseInt(embedded[1], 16)
    const lo = parseInt(embedded[2], 16)
    const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
    return isBlockedIpv4(ipv4)
  }
  return false
}

/**
 * True if a RESOLVED address (from DNS) is in a blocked range. Shared by the
 * upfront guard below and the connect-time pinning dispatcher (scene-egress-
 * dispatcher.ts), so both apply the exact same block list.
 */
export function isBlockedResolvedAddress(address: string, family: number): boolean {
  return family === 6 ? isBlockedIpv6(address) : isBlockedIpv4(address)
}

function isBlockedHostLiteral(host: string): boolean {
  const h = host.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h.endsWith('.local') || h.endsWith('.internal')) return true
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return isBlockedIpv4(h)
  if (h.includes(':')) return isBlockedIpv6(h)
  return false
}

/**
 * Throws if `rawUrl` is not a public http(s) URL a scene is allowed to reach.
 */
export async function assertPublicSceneUrl(rawUrl: string): Promise<void> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('Blocked scene request: invalid URL')
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Blocked scene request: unsupported protocol "${url.protocol}"`)
  }

  // Strip a trailing dot: `new URL()` keeps the FQDN root label ("localhost." /
  // "metadata.google.internal."), which would slip past the exact/suffix literal
  // matches below while still resolving to the same (blocked) host.
  const host = url.hostname.replace(/\.+$/, '')
  if (isBlockedHostLiteral(host)) {
    throw new Error(`Blocked scene request to non-public host: ${host}`)
  }

  const isIpLiteral = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')
  if (isIpLiteral) return

  try {
    const results = await lookup(host, { all: true })
    for (const { address, family } of results) {
      if (isBlockedResolvedAddress(address, family)) {
        throw new Error(`Blocked scene request: ${host} resolves to non-public address ${address}`)
      }
    }
  } catch (err: any) {
    // Surface our own block decision; a DNS failure just lets the fetch fail
    // naturally (the caller already handles fetch errors).
    if (typeof err?.message === 'string' && err.message.startsWith('Blocked scene request')) throw err
  }
}
