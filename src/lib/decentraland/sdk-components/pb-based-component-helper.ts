import { Writer } from "protobufjs/minimal"
import { ApplyComponentOperation, ComponentDeclaration } from "../crdt-internal/components"

// One writer reused for every component serialization (single-threaded). It is
// recreated if an encode throws (see serialize) — do NOT make this `const`.
let sharedWriter = new Writer()

/**
 * This function creates a serializer and deserializer based on a Protobufjs type
 */
export function declareComponentUsingProtobufJs<T, Num extends number>(protobufType: {
  decode(bytes: Uint8Array): T
  encode(value: T, writer: Writer): void
}, componentId: Num, applyChanges: ApplyComponentOperation<T>): ComponentDeclaration<T, Num> {
  return {
    componentId,
    applyChanges,
    deserialize(buffer) {
      return protobufType.decode(buffer.toBinary())
    },
    serialize(value, buffer) {
      try {
        sharedWriter.reset()
        protobufType.encode(value, sharedWriter)
        buffer.writeBuffer(sharedWriter.finish(), false)
      } catch (e) {
        // A throw mid-encode (e.g. a malformed value from an untrusted peer
        // profile) can leave protobufjs's fork-state stack non-empty; the next
        // reset() would then RESTORE that aborted op-chain instead of clearing
        // it (writer.js), silently corrupting every subsequent component's wire
        // bytes process-wide. Discard the poisoned writer so the next call
        // starts from a clean one.
        sharedWriter = new Writer()
        throw e
      }
    },
  }
}