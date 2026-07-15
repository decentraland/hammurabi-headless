import { ByteBuffer, ReadWriteByteBuffer } from "../ByteBuffer"
import { PutComponentOperation, DeleteComponent, PutComponentMessageBody, DeleteComponentMessageBody, CrdtMessageType, CrdtMessageBody } from "../crdt-wire-protocol"
import { Entity } from "../types"
import { ComponentDeclaration, ComponentType, LastWriteWinElementSetComponentDefinition, SerDe } from "./components"
import { ProcessMessageResultType } from "./conflict-resolution"
import { dataCompare } from "./dataCompare"
import { limits } from "../../misc/limits"

export function incrementTimestamp(entity: Entity, timestamps: Map<Entity, number>): number {
  const newTimestamp = (timestamps.get(entity) || 0) + 1
  timestamps.set(entity, newTimestamp)
  return newTimestamp
}

// Scratch buffer shared by every per-entity serialization in this module.
// Allocating a fresh ReadWriteByteBuffer (10KB) per dirty entity per frame was
// the dominant source of GC churn on the CRDT flush path. Safe to share because
// this code is single-threaded and every serialize below is immediately
// consumed (copied into the out buffer or byte-compared) before the next reuse;
// component serializers never re-enter this module.
const serializationScratch = new ReadWriteByteBuffer()

/**
 * Serializes `value` into the shared scratch buffer and returns a VIEW over the
 * bytes. The view is only valid until the NEXT call to this function (which
 * resets and overwrites the same buffer): callers must copy or fully consume the
 * bytes synchronously before serializing anything else. Every current caller
 * does — PutComponentOperation.write copies into the out buffer, dataCompare
 * reads immediately — do NOT stash the return value.
 *
 * INVARIANT: this relies on single-threaded, synchronous consumption. Never
 * `await` between calling this and consuming its result — an interleaved
 * serializeToScratch (from another resumed task) would reset the shared buffer
 * and silently corrupt the bytes this view points at.
 */
function serializeToScratch<T>(serde: SerDe<T>, value: T): Uint8Array {
  serializationScratch.resetBuffer()
  serde.serialize(value, serializationScratch)
  return serializationScratch.toBinary()
}

// Bound for the echo-dedupe map below. Overflow evicts ONE oldest entry per
// insert (Map preserves insertion order) — clearing the whole map made it
// thrash (fill→clear→refill) once stale PUTs spanned more than this many
// entities, re-enabling the echo amplification the map exists to prevent at
// exactly the scale where it matters. Eviction only ever costs a redundant
// corrective message, never correctness.
const MAX_ECHO_DEDUPE_ENTRIES = limits.maxEchoDedupeEntries // HAMMURABI_MAX_ECHO_DEDUPE_ENTRIES

export function createUpdateLwwFromCrdt<T>(
  componentId: number,
  timestamps: Map<Entity, number>,
  schema: SerDe<T>,
  data: Map<Entity, T>,
  // Echo amplification guard: a stale ~24-byte PUT makes us serialize our FULL
  // stored value (up to MAX_CRDT_PAYLOAD_BYTES) into the outgoing buffer as a
  // corrective message. A scene streaming tiny stale PUTs against one large
  // component would pin tens of MB in the (never-shrinking) outgoing buffer.
  // Repeats are byte-identical while our state is unchanged, so one echo per
  // (entity, stored timestamp) is enough. Owned by the caller (createLwwStore
  // passes its own map) so purgeEntity can clear deleted entities' entries.
  echoedAtTimestamp: Map<Entity, number> = new Map()
) {
  /**
   * Process the received message only if the lamport number recieved is higher
   * than the stored one. If its lower, we spread it to the network to correct the peer.
   * If they are equal, the bigger raw data wins.

    * Returns the recieved data if the lamport number was bigger than ours.
    * If it was an outdated message, then we return void
    * @public
    */
  function crdtRuleForCurrentState(
    message: PutComponentMessageBody | DeleteComponentMessageBody
  ): ProcessMessageResultType {
    const { entityId, timestamp } = message
    const currentTimestamp = timestamps.get(entityId as Entity)

    // The received message is > than our current value, update our state.components.
    if (currentTimestamp === undefined || currentTimestamp < timestamp) {
      return ProcessMessageResultType.StateUpdatedTimestamp
    }

    // Outdated Message. Resend our state message through the wire.
    if (currentTimestamp > timestamp) {
      return ProcessMessageResultType.StateOutdatedTimestamp
    }

    // Deletes are idempotent
    if (message.type === CrdtMessageType.DELETE_COMPONENT && !data.has(entityId)) {
      return ProcessMessageResultType.NoChanges
    }

    let currentDataGreater = 0

    if (data.has(entityId)) {
      currentDataGreater = dataCompare(serializeToScratch(schema, data.get(entityId)!), (message as any).data || null)
    } else {
      currentDataGreater = dataCompare(null, (message as any).data)
    }

    if (currentDataGreater === 0) {
      // Same data, same timestamp.
      return ProcessMessageResultType.NoChanges
    } else if (currentDataGreater > 0) {
      // Current data is greater
      return ProcessMessageResultType.StateOutdatedData
    } else {
      // Curent data is lower
      return ProcessMessageResultType.StateUpdatedData
    }
  }

  return (msg: CrdtMessageBody, conflictResolutionByteBuffer: ByteBuffer): boolean => {
    if (msg.type !== CrdtMessageType.PUT_COMPONENT && msg.type !== CrdtMessageType.DELETE_COMPONENT)
      return true

    const action = crdtRuleForCurrentState(msg)
    const entityId = msg.entityId as Entity
    switch (action) {
      case ProcessMessageResultType.StateUpdatedData:
      case ProcessMessageResultType.StateUpdatedTimestamp: {
        if (msg.type === CrdtMessageType.PUT_COMPONENT) {
          // Deserialize BEFORE advancing the timestamp / mutating state. A peer
          // can send malformed component bytes; if deserialize throws after we've
          // bumped the timestamp, our state would claim the new version while
          // still holding the old value (and reject the correct resend). Commit
          // the timestamp and value together, only on success.
          const buf = new ReadWriteByteBuffer(msg.data!)
          const value = schema.deserialize(buf)
          timestamps.set(entityId, msg.timestamp)
          data.set(entityId, value)
        } else {
          timestamps.set(entityId, msg.timestamp)
          data.delete(entityId)
        }

        // Stored state changed, so the next conflict needs a fresh correction —
        // this also covers the equal-timestamp/greater-data accept, where the
        // VALUE changes while the timestamp doesn't (a timestamp-only dedupe key
        // would wrongly suppress the new echo bytes there).
        echoedAtTimestamp.delete(entityId)

        return true // change accepted
      }
      case ProcessMessageResultType.StateOutdatedTimestamp:
      case ProcessMessageResultType.StateOutdatedData: {
        const timestamp = timestamps.get(entityId)!

        // Already echoed our state at this timestamp — a repeat would be
        // byte-identical; skip the redundant serialization/buffer append.
        if (echoedAtTimestamp.get(entityId) === timestamp) {
          return false // change not accepted
        }
        if (echoedAtTimestamp.size >= MAX_ECHO_DEDUPE_ENTRIES) {
          const oldest = echoedAtTimestamp.keys().next().value
          if (oldest !== undefined) echoedAtTimestamp.delete(oldest)
        }
        echoedAtTimestamp.set(entityId, timestamp)

        if (data.has(entityId)) {
          // post conflict resolution update
          PutComponentOperation.write({ entityId, componentId, timestamp, data: serializeToScratch(schema, data.get(entityId)!), }, conflictResolutionByteBuffer)

          return false // change not accepted
        } else {
          // post conflict resolution update
          DeleteComponent.write({ entityId, componentId, timestamp }, conflictResolutionByteBuffer)

          return false // change not accepted
        }
      }
    }

    return true // change accepted
  }
}

export function createGetCrdtMessagesForLww<T>(
  componentId: number,
  updatedAtTick: Map<Entity, number>,
  timestamps: Map<Entity, number>,
  dirtyIterator: Set<Entity>,
  serde: SerDe<T>,
  data: Map<Entity, T>,
  // plain mutable counter shared with commitDirtyState: an Atom (observable)
  // here cost a getOrNull + swap + observer notification per component per
  // frame just to bump an integer
  tickState: { tick: number }
) {
  return function (outBuffer: ByteBuffer) {
    const tick = ++tickState.tick

    for (const entityId of dirtyIterator) {
      const timestamp = incrementTimestamp(entityId, timestamps)
      updatedAtTick.set(entityId, tick)
      if (data.has(entityId)) {
        PutComponentOperation.write({ entityId, componentId, timestamp, data: serializeToScratch(serde, data.get(entityId)!), }, outBuffer)
      } else {
        DeleteComponent.write({ entityId, componentId, timestamp }, outBuffer)
      }
    }
    dirtyIterator.clear()
  }
}

// this function writes the updates for the LWW component to the outBuffer using
// the entities that were updated after the fromTick value.
export function createGetCrdtMessagesForLwwWithTick<T>(
  componentId: number,
  updatedAtTick: Map<Entity, number>,
  timestamps: Map<Entity, number>,
  serde: SerDe<T>,
  data: Map<Entity, T>
) {
  return function (outBuffer: ByteBuffer, fromTick: number) {
    let biggestTick = fromTick

    for (const [entityId, tick] of updatedAtTick) {
      if (tick <= fromTick) continue
      if (biggestTick < tick) biggestTick = tick
      const timestamp = timestamps.get(entityId) ?? 0
      if (data.has(entityId)) {
        PutComponentOperation.write({ entityId, componentId, timestamp, data: serializeToScratch(serde, data.get(entityId)!), }, outBuffer)
      } else {
        DeleteComponent.write({ entityId, componentId, timestamp }, outBuffer)
      }
    }

    return biggestTick
  }
}

export function createLwwStore<T, Num extends number>(componentDeclaration: ComponentDeclaration<T, Num>): LastWriteWinElementSetComponentDefinition<T> {
  const data = new Map<Entity, T>()
  const dirtyIterator = new Set<Entity>()
  const timestamps = new Map<Entity, number>()
  const updatedAtTick = new Map<Entity, number>()
  const echoedAtTimestamp = new Map<Entity, number>()
  const tickState = { tick: 0 }

  return {
    get componentId() {
      return componentDeclaration.componentId
    },
    get componentType() {
      // a getter is used here to prevent accidental changes
      return ComponentType.LastWriteWinElementSet as const
    },
    declaration: componentDeclaration,
    has(entity: Entity): boolean {
      return data.has(entity)
    },
    deleteFrom(entity: Entity, markAsDirty = true): T | null {
      const component = data.get(entity)
      if (data.delete(entity) && markAsDirty) {
        dirtyIterator.add(entity)
      }
      return component || null
    },
    entityDeleted(entity: Entity, markAsDirty: boolean): void {
      if (data.delete(entity) && markAsDirty) {
        dirtyIterator.add(entity)
      }
    },
    purgeEntity(entity: Entity): void {
      data.delete(entity)
      dirtyIterator.delete(entity)
      timestamps.delete(entity)
      updatedAtTick.delete(entity)
      echoedAtTimestamp.delete(entity)
    },
    getOrNull(entity: Entity): Readonly<T> | null {
      return data.get(entity) ?? null
    },
    get(entity: Entity): Readonly<T> | undefined {
      return data.get(entity)
    },
    create(entity: Entity, value: T): T {
      const component = data.get(entity)
      if (component) {
        throw new Error(`[create] Component ${componentDeclaration.componentId} for ${entity} already exists`)
      }
      data.set(entity, value)
      dirtyIterator.add(entity)
      return value
    },
    createOrReplace(entity: Entity, value: T): T {
      data.set(entity, value)
      dirtyIterator.add(entity)
      return value
    },
    getMutableOrNull(entity: Entity): T | null {
      const component = data.get(entity)
      if (!component) {
        return null
      }
      dirtyIterator.add(entity)
      return component
    },
    getMutable(entity: Entity): T {
      const component = this.getMutableOrNull(entity)
      if (component === null) {
        throw new Error(`[mutable] Component ${componentDeclaration.componentId} for ${entity} not found`)
      }
      return component
    },
    *iterator(): Iterable<[Entity, T]> {
      for (const [entity, component] of data) {
        yield [entity, component]
      }
    },
    dirtyIterator(): Iterable<Entity> {
      return Array.from(dirtyIterator)
    },
    commitDirtyState(): void {
      // same bookkeeping as dumpCrdtUpdates without serializing any value
      const tick = ++tickState.tick
      for (const entityId of dirtyIterator) {
        incrementTimestamp(entityId, timestamps)
        updatedAtTick.set(entityId, tick)
      }
      dirtyIterator.clear()
    },
    dumpCrdtDeltas: createGetCrdtMessagesForLwwWithTick(componentDeclaration.componentId, updatedAtTick, timestamps, componentDeclaration, data),
    dumpCrdtUpdates: createGetCrdtMessagesForLww(componentDeclaration.componentId, updatedAtTick, timestamps, dirtyIterator, componentDeclaration, data, tickState),
    updateFromCrdt: createUpdateLwwFromCrdt(componentDeclaration.componentId, timestamps, componentDeclaration, data, echoedAtTimestamp),
  }
}
