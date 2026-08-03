import { createEmoteAppendLog } from '../../../../src/lib/decentraland/communications/emote-append-log'
import { limits } from '../../../../src/lib/misc/limits'
import { limitLogger } from '../../../../src/lib/misc/limit-logger'
import { Entity } from '../../../../src/lib/decentraland/types'

// The log exists because grow-only-set stores drain one shared queue, which the several
// per-scene subscriptions of an avatar system would fight over. Its contract is therefore:
// every subscription reads the same entries through its own cursor, nothing is delivered
// twice, and it stays bounded when a subscription stops reading.

function seqsAfter(log: ReturnType<typeof createEmoteAppendLog>, afterSeq: number, throughSeq: number): number[] {
  const seen: number[] = []
  log.forEachAfter(afterSeq, throughSeq, (entry) => seen.push(entry.seq))
  return seen
}

describe('emote append log', () => {
  let log: ReturnType<typeof createEmoteAppendLog>
  let entityA: Entity
  let entityB: Entity

  beforeEach(() => {
    log = createEmoteAppendLog()
    entityA = 32 as Entity
    entityB = 33 as Entity
  })

  describe('when entries are pushed', () => {
    beforeEach(() => {
      log.push(entityA, Uint8Array.of(1))
      log.push(entityB, Uint8Array.of(2))
    })

    it('should stamp them with increasing sequences', () => {
      expect(seqsAfter(log, 0, log.sequence)).toEqual([1, 2])
    })

    it('should report the highest sequence stamped', () => {
      expect(log.sequence).toBe(2)
    })

    it('should retain the payload bytes as given', () => {
      const payloads: Uint8Array[] = []
      log.forEachAfter(0, log.sequence, (entry) => payloads.push(entry.data))

      expect(payloads).toEqual([Uint8Array.of(1), Uint8Array.of(2)])
    })
  })

  describe('when a reader has already consumed part of the log', () => {
    beforeEach(() => {
      log.push(entityA, Uint8Array.of(1))
      log.push(entityA, Uint8Array.of(2))
      log.push(entityA, Uint8Array.of(3))
    })

    it('should return only the entries after that reader cursor', () => {
      expect(seqsAfter(log, 2, log.sequence)).toEqual([3])
    })

    it('should return nothing once the cursor has caught up', () => {
      expect(seqsAfter(log, 3, log.sequence)).toEqual([])
    })
  })

  describe('when the caller has not yet opened the newest entries for delivery', () => {
    beforeEach(() => {
      log.push(entityA, Uint8Array.of(1))
      log.push(entityA, Uint8Array.of(2))
      log.push(entityA, Uint8Array.of(3))
    })

    it('should withhold entries past the upper bound', () => {
      // The avatar system raises this bound only once the entities' component PUTs have
      // been committed, so an append can never be delivered ahead of them.
      expect(seqsAfter(log, 0, 2)).toEqual([1, 2])
    })
  })

  describe('when pruning entries every reader has consumed', () => {
    beforeEach(() => {
      log.push(entityA, Uint8Array.of(1))
      log.push(entityA, Uint8Array.of(2))
      log.push(entityA, Uint8Array.of(3))
      log.pruneUpTo(2)
    })

    it('should drop the consumed entries', () => {
      expect(log.size).toBe(1)
    })

    it('should keep the entries beyond the prune point readable', () => {
      expect(seqsAfter(log, 0, log.sequence)).toEqual([3])
    })

    it('should not rewind the sequence, so later cursors stay comparable', () => {
      expect(log.sequence).toBe(3)
    })
  })

  describe('when an entity is retired', () => {
    beforeEach(() => {
      log.push(entityA, Uint8Array.of(1))
      log.push(entityB, Uint8Array.of(2))
      log.push(entityA, Uint8Array.of(3))
      log.purgeEntity(entityA)
    })

    it('should forget every pending entry of that entity', () => {
      expect(seqsAfter(log, 0, log.sequence)).toEqual([2])
    })

    it('should leave other entities pending', () => {
      const entities: Entity[] = []
      log.forEachAfter(0, log.sequence, (entry) => entities.push(entry.entityId))

      expect(entities).toEqual([entityB])
    })

    it('should not rewind the sequence', () => {
      expect(log.sequence).toBe(3)
    })
  })

  describe('when a reader stalls while entries keep arriving', () => {
    let hit: jest.SpyInstance
    let delivered: number[]

    beforeEach(() => {
      hit = jest.spyOn(limitLogger, 'hit').mockImplementation(() => void 0)
      for (let i = 0; i < limits.maxEmoteAppendLog + 3; i++) {
        log.push(entityA, Uint8Array.of(1))
      }
      delivered = seqsAfter(log, 0, log.sequence)
    })

    afterEach(() => hit.mockRestore())

    it('should hold the pending entries at the cap', () => {
      expect(log.size).toBe(limits.maxEmoteAppendLog)
    })

    it('should drop the oldest entries rather than the newest', () => {
      expect(delivered[delivered.length - 1]).toBe(log.sequence)
    })

    it('should report the limit hit', () => {
      expect(hit).toHaveBeenCalledWith('maxEmoteAppendLog')
    })
  })
})
