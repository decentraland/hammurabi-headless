import { Entity } from '../types'
import { limits } from '../../misc/limits'
import { limitLogger } from '../../misc/limit-logger'

/**
 * A bounded, sequence-numbered log of pending APPEND_VALUE payloads, drained
 * independently by each live subscription.
 *
 * `AvatarEmoteCommand` is a GrowOnly value set, and GOS stores deliberately have no
 * delta channel (`crdt-internal/grow-only-set.ts`: `dumpCrdtDeltas` writes nothing,
 * `commitDirtyState` throws) — their only drain, `dumpCrdtUpdates`, empties ONE
 * shared queue. The avatar system can fan a single set of stores out to several
 * per-scene subscriptions, so a shared queue would let the first subscription to drain
 * swallow the appends every other scene still needs. (Production wires exactly one
 * subscription per system today; the N-subscription shape is the contract
 * `createSubscription` offers, and the tombstone machinery beside this already honours
 * it.)
 *
 * So appends live here instead, each stamped with a monotonic sequence, and every
 * subscription keeps its own cursor — the same shape as the `deletedEntities` /
 * `deletionSequence` / `tracker.emittedSeq` tombstone machinery in the avatar
 * system. Payloads are serialized ONCE at push time and shared by every
 * subscription.
 *
 * A subscription created later starts at the current sequence and receives no
 * backlog, which is correct: it begins from a state dump that never contained
 * those emotes, and emotes are events, not state to re-synchronize.
 */

export type EmoteAppendEntry = {
  readonly seq: number
  readonly entityId: Entity
  /** Pre-serialized PBAvatarEmoteCommand bytes. */
  readonly data: Uint8Array
}

export type EmoteAppendLog = {
  /** Append a serialized payload; returns the sequence it was stamped with. */
  push(entityId: Entity, data: Uint8Array): number
  /**
   * Visit entries with `afterSeq < seq <= throughSeq`, oldest first. The upper bound is
   * what keeps an append from being delivered ahead of the component PUTs of the same
   * frame: the caller only raises it once those have been committed.
   */
  forEachAfter(afterSeq: number, throughSeq: number, visit: (entry: EmoteAppendEntry) => void): void
  /** Highest sequence stamped so far. */
  readonly sequence: number
  /** Drop entries whose sequence is <= `seq` (every subscription has emitted them). */
  pruneUpTo(seq: number): void
  /**
   * Forget every pending entry for an entity that has been retired. Its id is
   * generationally versioned and never reissued, so this is not about mistaken
   * attribution — it is that an append trailing that entity's DELETE_ENTITY describes
   * an entity the scene has already been told is gone, and both the host and the scene
   * would discard it. Dropping it here keeps the log from carrying garbage a stalled
   * subscription would then count against its cap.
   */
  purgeEntity(entityId: Entity): void
  /** Pending entry count (diagnostics/tests). */
  readonly size: number
}

const MAX_ENTRIES = limits.maxEmoteAppendLog // HAMMURABI_MAX_EMOTE_APPEND_LOG

export function createEmoteAppendLog(): EmoteAppendLog {
  // Oldest first. Entries leave via pruneUpTo (all subscriptions drained them),
  // purgeEntity (id retired) or the size cap below.
  let entries: EmoteAppendEntry[] = []
  let sequence = 0

  return {
    get sequence() {
      return sequence
    },
    get size() {
      return entries.length
    },
    push(entityId: Entity, data: Uint8Array): number {
      const seq = ++sequence
      entries.push({ seq, entityId, data })
      // Hard bound. Reached when a subscription stops draining (a stalled scene VM)
      // while peers keep emoting; dropping the OLDEST keeps the newest emotes, which
      // are the ones a scene still cares about.
      if (entries.length > MAX_ENTRIES) {
        limitLogger.hit('maxEmoteAppendLog')
        entries.splice(0, entries.length - MAX_ENTRIES)
      }
      return seq
    },
    forEachAfter(afterSeq: number, throughSeq: number, visit: (entry: EmoteAppendEntry) => void): void {
      for (const entry of entries) {
        if (entry.seq > afterSeq && entry.seq <= throughSeq) visit(entry)
      }
    },
    pruneUpTo(seq: number): void {
      if (entries.length === 0) return
      let keepFrom = 0
      while (keepFrom < entries.length && entries[keepFrom].seq <= seq) keepFrom++
      if (keepFrom > 0) entries.splice(0, keepFrom)
    },
    purgeEntity(entityId: Entity): void {
      if (entries.length === 0) return
      entries = entries.filter((entry) => entry.entityId !== entityId)
    }
  }
}
