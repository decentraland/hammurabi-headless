// The emote `loop` flag is not on the wire — it lives in the emote entity's metadata —
// so this resolver mirrors how the reference client obtains it: scene emotes carry it in
// the urn, embedded emotes come from a shipped table, everything else is a pointer lookup
// against the asset-bundle registry.

// NOTE: this project's jest transformer (esbuild) does not hoist `jest.mock` above
// imports, so register the mock first and then `require` the module under test.
jest.mock('../../../../src/lib/misc/network', () => ({
  robustFetch: jest.fn(),
  readBodyCapped: jest.fn(),
  readBodyCappedBytes: jest.fn(),
  drainResponse: jest.fn(),
  DEFAULT_MAX_BODY_BYTES: 10 * 1024 * 1024
}))

const {
  createEmoteMetadataResolver,
  shortenEmoteUrn
} = require('../../../../src/lib/decentraland/communications/emote-metadata')
const { robustFetch, readBodyCapped } = require('../../../../src/lib/misc/network')
const { limitLogger } = require('../../../../src/lib/misc/limit-logger')
const { limits } = require('../../../../src/lib/misc/limits')

const robustFetchMock = robustFetch as jest.Mock
const readBodyCappedMock = readBodyCapped as jest.Mock

function registryBody(metadata: unknown): string {
  return JSON.stringify([{ metadata }])
}

function requestedPointers(call: number = 0): string[] {
  const init = robustFetchMock.mock.calls[call][1]
  return JSON.parse(init.body).pointers
}

describe('emote metadata resolver', () => {
  let resolver: ReturnType<typeof createEmoteMetadataResolver>

  beforeEach(() => {
    resolver = createEmoteMetadataResolver()
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when the urn is a scene emote', () => {
    let loopingUrn: string
    let oneShotUrn: string

    beforeEach(() => {
      loopingUrn = 'urn:decentraland:off-chain:scene-emote:my-scene-QmHash-true'
      oneShotUrn = 'urn:decentraland:off-chain:scene-emote:my-scene-QmHash-false'
    })

    it('should resolve true for a urn whose trailing segment marks it as looping', () => {
      expect(resolver.resolveLoop(loopingUrn, '0xpeer')).toBe(true)
    })

    it('should resolve false for a urn whose trailing segment marks it as non-looping', () => {
      expect(resolver.resolveLoop(oneShotUrn, '0xpeer')).toBe(false)
    })

    it('should answer without requesting metadata, because the urn already carries the flag', () => {
      resolver.resolveLoop(loopingUrn, '0xpeer')

      expect(robustFetchMock).not.toHaveBeenCalled()
    })

    describe('and the hash itself ends in the text "true"', () => {
      let misleadingUrn: string

      beforeEach(() => {
        // The flag is the segment after the LAST dash, so a hash ending in "-true" must
        // not be mistaken for it.
        misleadingUrn = 'urn:decentraland:off-chain:scene-emote:my-scene-Qm-true-false'
      })

      it('should read the flag from the final segment only', () => {
        expect(resolver.resolveLoop(misleadingUrn, '0xpeer')).toBe(false)
      })
    })

    describe('and the flag is not lowercase', () => {
      it('should still read it as the boolean it is', () => {
        expect(resolver.resolveLoop('urn:decentraland:off-chain:scene-emote:s-Qm-True', '0xpeer')).toBe(true)
      })
    })
  })

  describe('when the urn is an emote the client ships embedded', () => {
    it('should resolve true for a looping embedded emote', () => {
      expect(resolver.resolveLoop('sittingChair1', '0xpeer')).toBe(true)
    })

    it('should resolve false for a non-looping embedded emote', () => {
      expect(resolver.resolveLoop('Waving', '0xpeer')).toBe(false)
    })

    it('should answer without requesting metadata, matching the client that never fetches these', () => {
      resolver.resolveLoop('sittingGround2', '0xpeer')

      expect(robustFetchMock).not.toHaveBeenCalled()
    })

    it('should match the id case-insensitively, as the client does', () => {
      expect(resolver.resolveLoop('SITTINGCHAIR1', '0xpeer')).toBe(true)
    })

    it('should not fetch a lowercased embedded id as though it were a pointer', () => {
      resolver.resolveLoop('sittingchair1', '0xpeer')

      expect(robustFetchMock).not.toHaveBeenCalled()
    })
  })

  describe('when the urn is a catalog emote', () => {
    let urn: string

    beforeEach(() => {
      urn = 'urn:decentraland:matic:collections-v2:0xc0ffee:3'
      robustFetchMock.mockResolvedValue({ ok: true })
      readBodyCappedMock.mockResolvedValue(registryBody({ emoteDataADR74: { loop: true } }))
    })

    it('should resolve the loop flag from the entity metadata', async () => {
      await expect(resolver.resolveLoop(urn, '0xpeer')).resolves.toBe(true)
    })

    it('should request the entities endpoint of the asset bundle registry', async () => {
      await resolver.resolveLoop(urn, '0xpeer')

      expect(robustFetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/^https:\/\/asset-bundle-registry\..+\/entities\/active$/),
        expect.objectContaining({ method: 'POST' }),
        expect.anything()
      )
    })

    it('should request the emote urn as the pointer', async () => {
      await resolver.resolveLoop(urn, '0xpeer')

      expect(requestedPointers()).toEqual([urn])
    })

    describe('and the metadata uses the builder `data` shape instead of emoteDataADR74', () => {
      beforeEach(() => {
        readBodyCappedMock.mockResolvedValue(registryBody({ data: { loop: true } }))
      })

      it('should resolve the loop flag from that shape too', async () => {
        await expect(resolver.resolveLoop(urn, '0xpeer')).resolves.toBe(true)
      })
    })

    describe('and the metadata declares no loop flag', () => {
      beforeEach(() => {
        readBodyCappedMock.mockResolvedValue(registryBody({ emoteDataADR74: {} }))
      })

      it('should resolve false rather than a missing value', async () => {
        await expect(resolver.resolveLoop(urn, '0xpeer')).resolves.toBe(false)
      })
    })

    describe('and the same urn is resolved again afterwards', () => {
      beforeEach(async () => {
        await resolver.resolveLoop(urn, '0xpeer')
      })

      it('should answer synchronously from cache', () => {
        expect(resolver.resolveLoop(urn, '0xotherpeer')).toBe(true)
      })

      it('should not perform a second lookup', () => {
        resolver.resolveLoop(urn, '0xotherpeer')

        expect(robustFetchMock).toHaveBeenCalledTimes(1)
      })
    })

    describe('and it is requested twice concurrently', () => {
      it('should coalesce both requests into a single lookup', async () => {
        await Promise.all([resolver.resolveLoop(urn, '0xpeer'), resolver.resolveLoop(urn, '0xother')])

        expect(robustFetchMock).toHaveBeenCalledTimes(1)
      })
    })
  })

  describe('when the registry has no entity for the pointer', () => {
    let urn: string

    beforeEach(async () => {
      // The real registry answers an unknown pointer with `200 []`, not a 404.
      urn = 'urn:decentraland:matic:collections-v2:0xdeadbeef:9'
      robustFetchMock.mockResolvedValue({ ok: true })
      readBodyCappedMock.mockResolvedValue('[]')
      await resolver.resolveLoop(urn, '0xpeer')
    })

    it('should cache the miss so a later packet performs no further lookup', () => {
      resolver.resolveLoop(urn, '0xotherpeer')

      expect(robustFetchMock).toHaveBeenCalledTimes(1)
    })

    it('should resolve false for it', () => {
      expect(resolver.resolveLoop(urn, '0xotherpeer')).toBe(false)
    })
  })

  describe('when the registry rejects the pointer outright', () => {
    let urn: string

    beforeEach(async () => {
      urn = 'urn:decentraland:matic:collections-v2:0xbadrequest:9'
      robustFetchMock.mockResolvedValue({ ok: false, status: 404 })
      await resolver.resolveLoop(urn, '0xpeer')
    })

    it('should cache that definitive answer', () => {
      resolver.resolveLoop(urn, '0xotherpeer')

      expect(robustFetchMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('when the registry is failing with a server error', () => {
    let urn: string

    beforeEach(async () => {
      // robustFetch RETURNS a 5xx once its retries are exhausted, so this arrives as a
      // response rather than a throw — and must not be mistaken for "this emote does not
      // loop", which would pin the wrong flag for the life of the process.
      urn = 'urn:decentraland:matic:collections-v2:0xflaky:9'
      robustFetchMock.mockResolvedValue({ ok: false, status: 503 })
      await resolver.resolveLoop(urn, '0xpeer')
    })

    it('should resolve the safe default for the packet at hand', async () => {
      await expect(resolver.resolveLoop(urn, '0xotherpeer')).resolves.toBe(false)
    })

    it('should not cache it, so the urn is retried once the registry recovers', async () => {
      await resolver.resolveLoop(urn, '0xotherpeer')

      expect(robustFetchMock).toHaveBeenCalledTimes(2)
    })
  })

  describe('when the registry is rate-limiting us', () => {
    let urn: string

    beforeEach(async () => {
      // Our own load can provoke this, so caching it would let a burst pin the wrong flag
      // on real emotes for the life of the process.
      urn = 'urn:decentraland:matic:collections-v2:0xthrottled:1'
      robustFetchMock.mockResolvedValue({ ok: false, status: 429 })
      await resolver.resolveLoop(urn, '0xthirdpeer')
    })

    it('should not cache it either', async () => {
      await resolver.resolveLoop(urn, '0xfourthpeer')

      expect(robustFetchMock).toHaveBeenCalledTimes(2)
    })
  })

  describe('when the lookup fails outright', () => {
    let urn: string

    beforeEach(async () => {
      urn = 'urn:decentraland:matic:collections-v2:0xbroken:1'
      robustFetchMock.mockRejectedValue(new Error('network down'))
      await resolver.resolveLoop(urn, '0xpeer')
    })

    it('should resolve false without throwing at the caller', async () => {
      await expect(resolver.resolveLoop(urn, '0xanotherpeer')).resolves.toBe(false)
    })

    it('should not cache the failure, so a later peer retries the lookup', async () => {
      await resolver.resolveLoop(urn, '0xanotherpeer')

      expect(robustFetchMock).toHaveBeenCalledTimes(2)
    })

    describe('and the urn was a legacy bare name, which is looked up under a different pointer', () => {
      beforeEach(async () => {
        await resolver.resolveLoop('dance', '0xlegacypeer')
      })

      it('should still retry it, rather than hand back the settled in-flight promise', async () => {
        await resolver.resolveLoop('dance', '0xdifferentpeer')

        // 3 = the shared setup's failure, this context's first attempt, and the retry.
        expect(robustFetchMock).toHaveBeenCalledTimes(3)
      })
    })
  })

  describe('when a legacy bare emote name is received', () => {
    beforeEach(async () => {
      robustFetchMock.mockResolvedValue({ ok: true })
      readBodyCappedMock.mockResolvedValue(registryBody({ emoteDataADR74: { loop: false } }))
      await resolver.resolveLoop('wave', '0xpeer')
    })

    it('should look up the on-chain base emote urn it maps to', () => {
      expect(requestedPointers()).toEqual(['urn:decentraland:off-chain:base-emotes:wave'])
    })

    it('should cache the answer under the name the caller used', () => {
      resolver.resolveLoop('wave', '0xotherpeer')

      expect(robustFetchMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('when a peer requests a second uncached urn inside the fetch cooldown', () => {
    let second: boolean | Promise<boolean>

    beforeEach(async () => {
      robustFetchMock.mockResolvedValue({ ok: true })
      readBodyCappedMock.mockResolvedValue(registryBody({ emoteDataADR74: { loop: true } }))
      await resolver.resolveLoop('urn:decentraland:matic:collections-v2:0xaaa:1', '0xpeer')
      second = resolver.resolveLoop('urn:decentraland:matic:collections-v2:0xbbb:2', '0xpeer')
    })

    it('should answer with the safe default instead of starting another lookup', () => {
      expect(second).toBe(false)
    })

    it('should leave the outbound request count at the first lookup', () => {
      expect(robustFetchMock).toHaveBeenCalledTimes(1)
    })

    it('should not cache that default, so the real value can still be resolved later', () => {
      expect(resolver.cacheSize).toBe(1)
    })
  })

  describe('when peers send the same emote name in different cases', () => {
    beforeEach(async () => {
      robustFetchMock.mockResolvedValue({ ok: true })
      readBodyCappedMock.mockResolvedValue(registryBody({ emoteDataADR74: { loop: true } }))
      await resolver.resolveLoop('wave', '0xpeer')
      await resolver.resolveLoop('WAVE', '0xotherpeer')
      await resolver.resolveLoop('Wave', '0xthirdpeer')
    })

    it('should look the emote up only once', () => {
      expect(robustFetchMock).toHaveBeenCalledTimes(1)
    })

    it('should keep a single cache entry for it', () => {
      expect(resolver.cacheSize).toBe(1)
    })
  })

  describe('when more lookups are wanted than the in-flight ceiling allows', () => {
    let hit: jest.SpyInstance
    let overflow: boolean | Promise<boolean>

    beforeEach(() => {
      // The per-peer debounce does not aggregate, so a swarm of peers each emoting a
      // fresh urn is bounded only by this ceiling.
      hit = jest.spyOn(limitLogger, 'hit').mockImplementation(() => void 0)
      robustFetchMock.mockReturnValue(new Promise(() => void 0)) // never settles
      for (let i = 0; i < limits.maxEmoteMetadataInflight; i++) {
        resolver.resolveLoop(`urn:decentraland:matic:collections-v2:0x${i}:1`, `0xpeer${i}`)
      }
      overflow = resolver.resolveLoop('urn:decentraland:matic:collections-v2:0xover:1', '0xlatepeer')
    })

    afterEach(() => hit.mockRestore())

    it('should hold the in-flight lookups at the ceiling', () => {
      expect(resolver.inFlightSize).toBe(limits.maxEmoteMetadataInflight)
    })

    it('should answer the overflowing packet with the safe default instead of queueing', () => {
      expect(overflow).toBe(false)
    })

    it('should report the limit hit with the peer for context', () => {
      expect(hit).toHaveBeenCalledWith('maxEmoteMetadataInflight', '0xlatepeer')
    })
  })

  describe('when a peer keeps sending urns nobody has looked up before', () => {
    let hit: jest.SpyInstance

    beforeEach(async () => {
      // The cache holds peer-controlled keys, so it must not grow with the number of
      // distinct urns a swarm invents. Distinct peers, because the debounce is per peer.
      hit = jest.spyOn(limitLogger, 'hit').mockImplementation(() => void 0)
      robustFetchMock.mockResolvedValue({ ok: true })
      readBodyCappedMock.mockResolvedValue('[]')
      for (let i = 0; i < limits.maxEmoteMetadataCacheEntries + 5; i++) {
        await resolver.resolveLoop(`urn:decentraland:matic:collections-v2:0x${i}:1`, `0xpeer${i}`)
      }
    })

    afterEach(() => hit.mockRestore())

    it('should hold the cache at its cap', () => {
      expect(resolver.cacheSize).toBe(limits.maxEmoteMetadataCacheEntries)
    })

    it('should report the limit hit', () => {
      expect(hit).toHaveBeenCalledWith('maxEmoteMetadataCacheEntries')
    })
  })

  describe('when a peer trips the fetch debounce', () => {
    let hit: jest.SpyInstance

    beforeEach(async () => {
      // Reported rather than silent: unlike an ordinary debounce, this substitutes a
      // possibly-wrong loop flag into what the scene observes.
      hit = jest.spyOn(limitLogger, 'hit').mockImplementation(() => void 0)
      robustFetchMock.mockResolvedValue({ ok: true })
      readBodyCappedMock.mockResolvedValue('[]')
      await resolver.resolveLoop('urn:decentraland:matic:collections-v2:0xfirst:1', '0xbusypeer')
      resolver.resolveLoop('urn:decentraland:matic:collections-v2:0xsecond:1', '0xbusypeer')
    })

    afterEach(() => hit.mockRestore())

    it('should report the limit hit with the peer for context', () => {
      expect(hit).toHaveBeenCalledWith('emoteMetadataFetchCooldownMs', '0xbusypeer')
    })
  })

  describe('when a lookup is issued', () => {
    beforeEach(async () => {
      robustFetchMock.mockResolvedValue({ ok: true })
      readBodyCappedMock.mockResolvedValue('[]')
      await resolver.resolveLoop('urn:decentraland:matic:collections-v2:0xdeadline:1', '0xpeer')
    })

    it('should carry a deadline for the whole request, body read included', () => {
      // robustFetch's own timeout stops covering things once the response returns, so a
      // stalled body would otherwise pin an in-flight slot for good.
      expect(robustFetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    })
  })

  describe('when the response never arrives', () => {
    let outcome: boolean

    beforeEach(async () => {
      // Header phase: robustFetch's bridge from our signal to its own controller is still
      // live here, so aborting it is what ends the request.
      jest.useFakeTimers()
      robustFetchMock.mockImplementation(
        (_url: string, init: any) =>
          new Promise((_resolve, reject) => {
            // No signal means no deadline and this never settles — the bug itself — so the
            // test hangs and fails rather than passing.
            if (!init?.signal) return
            init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')))
          })
      )
      const pending = resolver.resolveLoop('urn:decentraland:matic:collections-v2:0xhang:1', '0xpeer')
      jest.advanceTimersByTime(limits.emoteMetadataLookupTimeoutMs)
      outcome = await (pending as Promise<boolean>)
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    it('should give up at the deadline with the safe default', () => {
      expect(outcome).toBe(false)
    })

    it('should release the in-flight slot rather than wedge it', () => {
      expect(resolver.inFlightSize).toBe(0)
    })
  })

  describe('when reading the response body', () => {
    beforeEach(async () => {
      robustFetchMock.mockResolvedValue({ ok: true })
      readBodyCappedMock.mockResolvedValue('[]')
      await resolver.resolveLoop('urn:decentraland:matic:collections-v2:0xbody:1', '0xpeer')
    })

    it('should hand the reader what is left of the lookup budget', () => {
      // The request signal cannot bound the body (robustFetch unbridges it before returning
      // the response) and the stream is locked by the reader, so the deadline has to be the
      // reader's. Behaviour of that deadline is covered in test/lib/misc/network.spec.ts;
      // what belongs here is that a budget is passed at all.
      const [, , opts] = readBodyCappedMock.mock.calls[0]

      expect(opts.timeoutMs).toBeGreaterThan(0)
    })

    it('should not hand it more than the whole-lookup budget', () => {
      const [, , opts] = readBodyCappedMock.mock.calls[0]

      expect(opts.timeoutMs).toBeLessThanOrEqual(limits.emoteMetadataLookupTimeoutMs)
    })
  })

  describe('when shortening urns', () => {
    it('should drop the token id tail of an extended collection urn', () => {
      expect(shortenEmoteUrn('urn:decentraland:matic:collections-v2:0xc0ffee:3:12345')).toBe(
        'urn:decentraland:matic:collections-v2:0xc0ffee:3'
      )
    })

    it('should leave a non-extended urn untouched', () => {
      expect(shortenEmoteUrn('urn:decentraland:off-chain:base-emotes:wave')).toBe(
        'urn:decentraland:off-chain:base-emotes:wave'
      )
    })

    it('should leave a third-party urn that carries no token id untouched', () => {
      const urn = 'urn:decentraland:amoy:collections-thirdparty:back-to-the-future:amoy-eb54:tuxedo-6751'

      expect(shortenEmoteUrn(urn)).toBe(urn)
    })

    it('should not take the third-party path for a urn that merely mentions it in the tail', () => {
      // Peer-controlled: appending this to an ordinary urn used to select the branch that
      // returns the urn unshortened, minting a fresh cache key per crafted tail.
      expect(shortenEmoteUrn('urn:decentraland:matic:collections-v2:0xc0ffee:3:collections-thirdparty')).toBe(
        'urn:decentraland:matic:collections-v2:0xc0ffee:3'
      )
    })

    it('should drop the three-part token id of an extended third-party urn', () => {
      // The client keeps the first 7 parts for third-party items; the trailing
      // `<chain>:<contract>:<tokenId>` is what identifies the copy, not the item.
      const extended =
        'urn:decentraland:amoy:collections-thirdparty:back-to-the-future:amoy-eb54:tuxedo-6751:amoy:0x1d9fb685c257e74f869ba302e260c0b68f5ebb37:12'

      expect(shortenEmoteUrn(extended)).toBe(
        'urn:decentraland:amoy:collections-thirdparty:back-to-the-future:amoy-eb54:tuxedo-6751'
      )
    })
  })
})
