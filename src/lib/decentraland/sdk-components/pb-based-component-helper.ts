import { Writer } from "protobufjs/minimal"
import { ApplyComponentOperation, ComponentDeclaration } from "../crdt-internal/components"

// One writer reused for every component serialization (single-threaded; encode()
// is self-contained and finish() detaches the output before the next reset).
const sharedWriter = new Writer()

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
      sharedWriter.reset()
      protobufType.encode(value, sharedWriter)
      buffer.writeBuffer(sharedWriter.finish(), false)
    },
  }
}