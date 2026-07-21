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

/** 127.0.0.0/8 — the only IPv4 range the local-preview relaxation may admit. */
function isLoopbackIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p))
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false
  return parts[0] === 127
}

// Fully expand a (possibly ::-compressed, possibly IPv4-tailed) IPv6 literal to
// its 8 16-bit hextets. Returns null if it is not a well-formed 8-group address.
function expandIpv6Hextets(v: string): number[] | null {
  let s = v
  // Fold a trailing dotted-IPv4 (e.g. ::ffff:1.2.3.4) into two hextets first.
  const dotted = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (dotted) {
    const b = [dotted[1], dotted[2], dotted[3], dotted[4]].map(Number)
    if (b.some((n) => n > 255)) return null
    s = s.slice(0, dotted.index) + ((b[0] << 8) | b[1]).toString(16) + ':' + ((b[2] << 8) | b[3]).toString(16)
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] === '' ? [] : halves[0].split(':')
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : null
  let groups: string[]
  if (tail === null) {
    groups = head
  } else {
    const fill = 8 - head.length - tail.length
    if (fill < 0) return null
    groups = [...head, ...new Array(fill).fill('0'), ...tail]
  }
  if (groups.length !== 8) return null
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN))
  if (nums.some((n) => Number.isNaN(n))) return null
  return nums
}

function isBlockedIpv6(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (v === '::1' || v === '::') return true // loopback / unspecified
  if (v.startsWith('fe80')) return true // link-local
  if (v.startsWith('fc') || v.startsWith('fd')) return true // unique-local fc00::/7

  // IPv6 forms that carry an IPv4 address inside the literal. `new URL()`
  // normalizes these to hex, so a naive `::ffff:1.2.3.4` string match misses them;
  // expand the address and apply the IPv4 block list to the embedded IPv4. Covers
  // IPv4-mapped (::ffff:/96), IPv4-compatible (::/96, deprecated), NAT64
  // (64:ff9b::/96), and 6to4 (2002::/16) — without this a loopback / cloud-metadata
  // / private IPv4 tunnels past the guard through any of these prefixes.
  const h = expandIpv6Hextets(v)
  if (h) {
    const low32 = `${(h[6] >> 8) & 0xff}.${h[6] & 0xff}.${(h[7] >> 8) & 0xff}.${h[7] & 0xff}`
    // 6to4: 2002:AABB:CCDD::/48 embeds the IPv4 AA.BB.CC.DD in hextets 1-2.
    if (h[0] === 0x2002) {
      const ipv4 = `${(h[1] >> 8) & 0xff}.${h[1] & 0xff}.${(h[2] >> 8) & 0xff}.${h[2] & 0xff}`
      if (isBlockedIpv4(ipv4)) return true
    }
    // NAT64 well-known prefix embeds the IPv4 in the low 32 bits.
    if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
      if (isBlockedIpv4(low32)) return true
    }
    // IPv4-mapped / -compatible: first five hextets zero, sixth 0xffff or 0.
    if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && (h[5] === 0xffff || h[5] === 0)) {
      if (isBlockedIpv4(low32)) return true
    }
  }
  return false
}

function isBlockedHostLiteral(host: string, allowLoopback: boolean): boolean {
  const h = host.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost')) return !allowLoopback
  if (h.endsWith('.local') || h.endsWith('.internal')) return true
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    if (allowLoopback && isLoopbackIpv4(h)) return false
    return isBlockedIpv4(h)
  }
  if (h.includes(':')) {
    const v = h.replace(/^\[/, '').replace(/\]$/, '')
    if (allowLoopback && v === '::1') return false
    // Exotic loopback spellings (IPv4-mapped ::ffff:127.0.0.1, 6to4/NAT64
    // embeddings) stay blocked even with the relaxation: no dev tool needs
    // them, and admitting only the plain literals keeps the carve-out auditable.
    return isBlockedIpv6(h)
  }
  return false
}

export type PublicUrlGuardOptions = {
  /**
   * Admit LOOPBACK destinations only: hostname `localhost`/`*.localhost`,
   * IPv4 127.0.0.0/8, IPv6 `::1`, and names that RESOLVE to those. Enabled by
   * callers exactly when the realm itself is a localhost preview server
   * (sdk-commands local development), where the scene developer's own machine
   * is the point: the same scene code running in a browser client can reach
   * `http://localhost:*` freely, so the server side blocking it only breaks
   * local development. Private LAN (RFC1918), CGNAT, link-local / cloud
   * metadata (169.254.*) and `.local`/`.internal` names stay blocked even
   * with this on. Production supervisors always run scenes with world or
   * catalyst realm URLs, so this can never activate there.
   */
  allowLoopback?: boolean
}

/**
 * Throws if `rawUrl` is not a public http(s) URL a scene is allowed to reach.
 */
export async function assertPublicSceneUrl(rawUrl: string, options: PublicUrlGuardOptions = {}): Promise<void> {
  const allowLoopback = options.allowLoopback === true
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('Blocked scene request: invalid URL')
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Blocked scene request: unsupported protocol "${url.protocol}"`)
  }

  const host = url.hostname
  if (isBlockedHostLiteral(host, allowLoopback)) {
    // Host-side log: without it a literal-host block is invisible in the worker
    // terminal — the thrown message only reaches scene code, which may swallow
    // it (an unhandled WS onerror, an uncaught fetch rejection).
    console.warn(`SSRF guard: blocked scene request to ${host}`)
    throw new Error(
      `Blocked scene request to non-public host: ${host} ` +
        `(the scene server's SSRF guard forbids loopback/private network addresses)`
    )
  }

  const isIpLiteral = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')
  if (isIpLiteral) return

  try {
    const results = await lookup(host, { all: true })
    for (const { address, family } of results) {
      // With the local-preview relaxation, a name resolving to loopback (e.g.
      // an /etc/hosts alias or localtest.me) is as legitimate as `localhost`.
      if (allowLoopback && (family === 4 ? isLoopbackIpv4(address) : address.toLowerCase() === '::1')) {
        continue
      }
      const blocked = family === 6 ? isBlockedIpv6(address) : isBlockedIpv4(address)
      if (blocked) {
        // Log the resolved address host-side only; the thrown message (surfaced to
        // scene code via fetch rejection / WS onerror) stays generic so a scene
        // can't harvest internal DNS→IP mappings from the block.
        console.warn(`SSRF guard: ${host} resolves to non-public address ${address}`)
        throw new Error(
          `Blocked scene request to non-public host: ${host} ` +
            `(the scene server's SSRF guard forbids loopback/private network addresses)`
        )
      }
    }
  } catch (err: any) {
    // Surface our own block decision; a DNS failure just lets the fetch fail
    // naturally (the caller already handles fetch errors).
    if (typeof err?.message === 'string' && err.message.startsWith('Blocked scene request')) throw err
  }
}
