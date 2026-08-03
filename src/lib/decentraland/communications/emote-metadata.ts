import { getAssetBundleRegistryUrl } from '../environment'
import { robustFetch, drainResponse, readBodyCapped, DEFAULT_MAX_BODY_BYTES } from '../../misc/network'
import { limits } from '../../misc/limits'
import { limitLogger, sanitizeLogDetail } from '../../misc/limit-logger'
import { createRateLimitedErrorLogger } from '../../misc/logger'

/**
 * Resolves the `loop` flag for an emote urn, mirroring how the reference (Unity)
 * client does it, because rfc4's `PlayerEmote` packet does NOT carry the flag —
 * it lives in the emote's deployed entity metadata (`emoteDataADR74.loop`).
 *
 * The client resolves it in three tiers, and so do we:
 *  1. SCENE emotes encode loop in the urn itself, so no lookup is needed.
 *  2. Emotes the client SHIPS (its embedded emote table) never hit the network;
 *     we carry the same id -> loop table so those stay lookup-free here too.
 *  3. Everything else is a pointer lookup against the asset-bundle registry —
 *     the same host used for `/profiles`, and the same endpoint the client uses
 *     (`{registry}/entities/active`, `POST {"pointers":[...]}`).
 *
 * Every input is a REMOTE PEER's string, so this module is bounded on all sides:
 * cache size, in-flight lookups, and an outbound-fetch debounce per peer. A
 * definitive "no such emote" IS cached — otherwise an unknown urn would be
 * re-fetched on every single packet — but a server error or a transport failure is
 * NOT, since caching those would make one blip permanent for the process.
 *
 * NOTE: lookups are keyed case-INSENSITIVELY, matching the client's
 * OrdinalIgnoreCase emote lookups. Without that, `wave`/`Wave`/`WAVE` are three
 * cache entries and three outbound requests for one emote.
 */

const SCENE_EMOTE_PREFIX = 'urn:decentraland:off-chain:scene-emote:'
const BASE_EMOTE_PREFIX = 'urn:decentraland:off-chain:base-emotes:'
const THIRD_PARTY_PART_ID = 'collections-thirdparty'

/**
 * The client's embedded emote table (`EmbeddedEmotes.asset`), keyed by the bare id it
 * stores them under. Only the sitting animations loop. These are the emotes the client
 * resolves WITHOUT a network request, so a lookup here is not a shortcut — it is what
 * parity requires.
 *
 * A `Map` rather than an object: an object literal inherits `Object.prototype`, so a
 * peer sending `urn: "constructor"` (or `toString`, `__proto__`, …) would read a
 * FUNCTION out of the table instead of `undefined`.
 */
const EMBEDDED_EMOTE_LOOP = new Map<string, boolean>(
  (
    [
      ['crafting', false],
      ['handsintheair', false],
      ['Victory', false],
      ['Waving', false],
      ['buttonDown', false],
      ['buttonFront', false],
      ['getHit', false],
      ['knockOut', false],
      ['lever', false],
      ['openChest', false],
      ['openDoor', false],
      ['punch', false],
      ['push', false],
      ['sittingChair1', true],
      ['sittingChair2', true],
      ['sittingGround1', true],
      ['sittingGround2', true],
      ['swingWeaponOneHand', false],
      ['swingWeaponTwoHands', false],
      ['throw', false],
      ['fistpump_short', false]
    ] as const
  ).map(([id, loop]) => [id.toLowerCase(), loop])
)

/**
 * Base emote urns the client is configured with. Used exactly as the client uses
 * them: to map a LEGACY bare name ("wave") onto its on-chain urn before the
 * lookup, since old clients/SDK calls still emit the short form.
 */
const BASE_EMOTE_NAMES: readonly string[] = [
  'clap',
  'cry',
  'dab',
  'dance',
  'disco',
  'dontsee',
  'fistpump',
  'hammer',
  'handsair',
  'wave',
  'raiseHand',
  'money',
  'kiss',
  'shrug',
  'headexplode',
  'hohoho',
  'robot',
  'snowfall',
  'tektonik',
  'tik',
  'confettipopper'
]

const LEGACY_TO_BASE_EMOTE_URN = new Map<string, string>(
  BASE_EMOTE_NAMES.map((name) => [name.toLowerCase(), `${BASE_EMOTE_PREFIX}${name}`])
)

const MAX_CACHE_ENTRIES = limits.maxEmoteMetadataCacheEntries // HAMMURABI_MAX_EMOTE_METADATA_CACHE_ENTRIES
const MAX_INFLIGHT = limits.maxEmoteMetadataInflight // HAMMURABI_MAX_EMOTE_METADATA_INFLIGHT
const FETCH_COOLDOWN_MS = limits.emoteMetadataFetchCooldownMs // HAMMURABI_EMOTE_METADATA_FETCH_COOLDOWN_MS
const LOOKUP_TIMEOUT_MS = limits.emoteMetadataLookupTimeoutMs // HAMMURABI_EMOTE_METADATA_LOOKUP_TIMEOUT_MS
const MAX_WAITERS_PER_LOOKUP = limits.maxEmoteMetadataWaiters // HAMMURABI_MAX_EMOTE_METADATA_WAITERS

// Number of colon-separated parts a non-extended urn has; anything longer carries a
// tokenId tail that the client strips before using the urn as a pointer/key.
const SHORTEN_URN_PARTS = 6
// A third-party v2 urn is 10 parts, the last 3 being the tokenId, so its item is
// addressed by the first 7.
const THIRD_PARTY_SHORTEN_URN_PARTS = 7

/**
 * Drop the tokenId tail of an extended urn, mirroring the client's `URN.Shorten()`:
 * third-party urns keep their first 7 parts, every other urn loses only its LAST part
 * (that is where a regular NFT's tokenId sits), and a urn of 6 parts or fewer is
 * already short.
 */
export function shortenEmoteUrn(urn: string): string {
  const parts = urn.split(':')
  if (parts.length <= SHORTEN_URN_PARTS) return urn
  // Anchored to the collection-type position rather than searched for anywhere in the
  // string: a peer could otherwise append `:collections-thirdparty` to an ordinary urn and
  // take this branch, which returns the urn unshortened and so mints a fresh cache key per
  // crafted tail.
  if (parts[3] === THIRD_PARTY_PART_ID) {
    return parts.slice(0, THIRD_PARTY_SHORTEN_URN_PARTS).join(':')
  }
  return parts.slice(0, parts.length - 1).join(':')
}

/**
 * A scene emote urn ends in `-<sceneId>-<hash>-<loop>`, so the flag is the segment
 * after the LAST dash — not merely a `-true` suffix, which a hash ending in "-true"
 * would also satisfy.
 */
function sceneEmoteLoop(urn: string): boolean {
  return urn.slice(urn.lastIndexOf('-') + 1).toLowerCase() === 'true'
}

export type EmoteMetadataResolver = {
  /**
   * Resolve the `loop` flag for an emote urn. Returns a boolean synchronously when
   * the answer needs no lookup (scene emote, embedded emote, cached urn) so the
   * common case never defers, and a promise only when a fetch is required.
   *
   * `peerAddress` is used ONLY for the per-peer outbound-fetch debounce.
   */
  resolveLoop(urn: string, peerAddress: string): boolean | Promise<boolean>
  /** Test/diagnostic seam: how many urns are cached. */
  readonly cacheSize: number
  /** Test/diagnostic seam: how many lookups are in flight. */
  readonly inFlightSize: number
}

export function createEmoteMetadataResolver(): EmoteMetadataResolver {
  // lowercased key -> loop. Holds definitive misses as well, so a bogus urn costs at
  // most one lookup. Insertion-ordered, oldest evicted first.
  const cache = new Map<string, boolean>()
  // Lookups in flight, so N packets for the same urn share one request.
  const inFlight = new Map<string, Promise<boolean>>()
  // How many callers are already waiting on each in-flight lookup. Cleared with the
  // lookup, so this map is bounded by `inFlight` and needs no cap of its own.
  const pendingWaiters = new Map<string, number>()
  // peer address -> when we last started a lookup for it.
  const lastFetchAt = new Map<string, number>()

  const logError = createRateLimitedErrorLogger()

  function remember(key: string, loop: boolean): boolean {
    cache.set(key, loop)
    if (cache.size > MAX_CACHE_ENTRIES) {
      limitLogger.hit('maxEmoteMetadataCacheEntries')
      while (cache.size > MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value
        if (oldest === undefined) break
        cache.delete(oldest)
      }
    }
    return loop
  }

  // Bound the per-peer debounce map alongside the cache: it grows one entry per
  // distinct peer that ever emoted, and peers churn over a long session.
  function noteFetchStarted(peerAddress: string, now: number) {
    // delete-then-set so an active peer's record moves to the back: `Map.set` on an existing
    // key keeps its original insertion position, which would let churn from other addresses
    // evict the record of the very peer this debounce exists to slow down.
    lastFetchAt.delete(peerAddress)
    lastFetchAt.set(peerAddress, now)
    while (lastFetchAt.size > MAX_CACHE_ENTRIES) {
      const oldest = lastFetchAt.keys().next().value
      if (oldest === undefined) break
      lastFetchAt.delete(oldest)
    }
  }

  /**
   * Resolves the loop flag, or `undefined` when the lookup produced no answer worth
   * remembering (server error / transport failure).
   */
  async function fetchLoop(pointer: string, key: string): Promise<boolean | undefined> {
    // Deadline for the header phase. The BODY phase gets the remaining budget passed to
    // readBodyCapped instead: robustFetch replaces our signal with its internal
    // controller's and unbridges the two in the same `finally` that returns the response,
    // so this signal stops mattering the moment we hold the response.
    //
    // An explicit controller rather than `AbortSignal.timeout`, matching robustFetch's own
    // pattern: that helper's timer cannot be cancelled, so it stays live for the full
    // deadline even when the request settled in 50ms — at a sustained lookup rate that is
    // one timer per lookup (measured ~1KB each), peer-driven state OUTSIDE the in-flight
    // ceiling declared just above. Clearing it in `finally` bounds live timers by that
    // ceiling instead, and unref keeps a pending one from holding the event loop open
    // during shutdown.
    const startedAt = Date.now()
    const deadline = new AbortController()
    const timer = setTimeout(
      () => deadline.abort(new Error(`emote metadata lookup exceeded ${LOOKUP_TIMEOUT_MS}ms`)),
      LOOKUP_TIMEOUT_MS
    )
    timer.unref?.()
    try {
      const response = await robustFetch(
        `${getAssetBundleRegistryUrl()}/entities/active`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pointers: [pointer] }),
          signal: deadline.signal
        },
        { label: 'emote-metadata' }
      )
      if (!response.ok) {
        await drainResponse(response) // release the socket before discarding
        // robustFetch RETURNS a 5xx/429 once it has exhausted its retries, so this
        // branch sees server errors as well as "no". Only a definitive client-side
        // answer may be cached: caching a 503 (or the 429 our own load provoked)
        // would pin `loop=false` on a real emote for the life of the process.
        if (response.status >= 500 || response.status === 429) return undefined
        return remember(key, false)
      }
      // Capped in SIZE like every other host fetch here, and additionally in TIME with
      // whatever is left of the lookup budget. The request signal cannot do this — see the
      // note on readBodyCappedBytes — and the reader has to own the deadline so that
      // giving up releases the socket and the chunks, not just our in-flight slot.
      const entities: any = JSON.parse(
        await readBodyCapped(response, DEFAULT_MAX_BODY_BYTES, {
          timeoutMs: Math.max(1, LOOKUP_TIMEOUT_MS - (Date.now() - startedAt))
        })
      )
      const metadata = entities?.[0]?.metadata
      // Entities fetched from a realm use `emoteDataADR74`; the builder API shape uses
      // `data`. The client accepts either, so we do too. An unknown pointer comes back
      // as `200 []`, which lands here as `undefined` metadata and is cached as a miss.
      const loop = metadata?.emoteDataADR74?.loop ?? metadata?.data?.loop
      return remember(key, loop === true)
    } catch (error: any) {
      // The pointer is a remote peer's string. It is length-capped upstream, but this is an
      // ORDINARY error log, not limitLogger, so nothing else would collapse control
      // characters — a crafted urn could otherwise forge extra log lines.
      logError(`Failed to resolve emote metadata for ${sanitizeLogDetail(pointer)}`, error)
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    get cacheSize() {
      return cache.size
    },
    get inFlightSize() {
      return inFlight.size
    },
    resolveLoop(urn: string, peerAddress: string): boolean | Promise<boolean> {
      // Scene emotes: `...scene-emote:<scene>-<hash>-<loop>` — the flag is right there.
      if (urn.startsWith(SCENE_EMOTE_PREFIX)) return sceneEmoteLoop(urn)

      const shortened = shortenEmoteUrn(urn)
      const key = shortened.toLowerCase()

      const cached = cache.get(key)
      if (cached !== undefined) return cached

      // Emotes the client ships: resolved from the embedded table, never fetched.
      const embedded = EMBEDDED_EMOTE_LOOP.get(key)
      if (embedded !== undefined) return embedded

      const pending = inFlight.get(key)
      if (pending) {
        // Coalescing is deliberate — a repeat should get the real answer rather than the
        // default — but handing the shared promise out is not free to the CALLER: each one
        // attaches a continuation that lives until the lookup settles. That is bounded by
        // the peer's packet rate times the lookup deadline, i.e. by nothing either
        // maxEmoteMetadataInflight (which counts lookups, not waiters) or maxEmoteAppendLog
        // (which counts queued appends, not pending ones) constrains. So cap the waiters and
        // degrade the excess to the default, exactly as the cooldown does.
        const waiters = (pendingWaiters.get(key) ?? 0) + 1
        if (waiters > MAX_WAITERS_PER_LOOKUP) {
          limitLogger.hit('maxEmoteMetadataWaiters', peerAddress)
          return false
        }
        pendingWaiters.set(key, waiters)
        return pending
      }

      // A legacy bare name ("wave") is mapped onto its on-chain urn before the lookup,
      // exactly as the client does. The pointer keeps its original casing — only our
      // own keying is case-insensitive.
      const pointer = LEGACY_TO_BASE_EMOTE_URN.get(key) ?? shortened

      const now = Date.now()
      const last = lastFetchAt.get(peerAddress)
      if (last !== undefined && now - last < FETCH_COOLDOWN_MS) {
        // Cooling down. Answer with the safe default rather than queueing work a peer
        // can trigger at its full packet rate. Deliberately NOT cached, so the real
        // value is still resolved once the debounce elapses — but DO report it: unlike
        // an ordinary debounce this substitutes a possibly-wrong `loop` into what the
        // scene observes, and the logger is throttled per key anyway.
        limitLogger.hit('emoteMetadataFetchCooldownMs', peerAddress)
        return false
      }
      // Global concurrency bound. The debounce above is PER PEER, so it does not
      // aggregate: a swarm of peers each emoting fresh urns would otherwise hold one
      // outbound request per peer per second, each living as long as robustFetch's
      // retries allow.
      if (inFlight.size >= MAX_INFLIGHT) {
        limitLogger.hit('maxEmoteMetadataInflight', peerAddress)
        return false
      }
      noteFetchStarted(peerAddress, now)

      const promise = fetchLoop(pointer, key)
        // A lookup that produced no answer resolves to the default WITHOUT caching, so
        // a later packet retries it.
        .then((loop) => loop ?? false)
        // Cleared HERE, keyed by `key`, because that is what the map is keyed by — a
        // legacy name and the pointer it maps to are different strings.
        .finally(() => {
          inFlight.delete(key)
          pendingWaiters.delete(key)
        })
      inFlight.set(key, promise)
      return promise
    }
  }
}

/**
 * Process-wide resolver. Shared deliberately: there is one avatar system per scene,
 * and emote urns repeat heavily across peers, so a per-system cache would multiply
 * identical lookups. Tests build their own instance instead of reaching for this.
 */
export const emoteMetadataResolver = createEmoteMetadataResolver()
