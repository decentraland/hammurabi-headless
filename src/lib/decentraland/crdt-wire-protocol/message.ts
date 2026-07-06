import { CrdtMessageProtocol } from './crdtMessageProtocol'
import { ByteBuffer } from '../ByteBuffer'
import { CrdtMessageType, CrdtMessage } from './types'
import { PutComponentOperation } from './putComponent'
import { DeleteComponent } from './deleteComponent'
import { DeleteEntity } from './deleteEntity'
import { AppendValueOperation } from './appendValue'

/**
 * Read the initial message of a ByteBuffer and moves the reading head.
 * 
 * Returns a CrdtMessage when it recognizes a valid message.
 * Returns null if it is an unrecognizable message
 * Returns undefined if it cannot read a valid CRDT header
 */
export function readMessage(buf: ByteBuffer): CrdtMessage | null | undefined {
  const header = CrdtMessageProtocol.peekHeader(buf)
  if (!header) return undefined

  if (header.type === CrdtMessageType.PUT_COMPONENT) {
    return PutComponentOperation.read(buf)
  } else if (header.type === CrdtMessageType.DELETE_COMPONENT) {
    return DeleteComponent.read(buf)
  } else if (header.type === CrdtMessageType.APPEND_VALUE) {
    return AppendValueOperation.read(buf)
  } else if (header.type === CrdtMessageType.DELETE_ENTITY) {
    return DeleteEntity.read(buf)
  }

  return null
}

/**
 * Reads CRDT messages and consumes them from the byteBuffer.
 *
 * Once it finishes, the ByteBuffer can be considered fully read.
 *
 * SECURITY: the buffer is untrusted (scene-controlled) and this runs in host
 * code, outside the QuickJS interrupt/memory limits. A well-formed header with
 * an unrecognized `type` makes `readMessage` return `null` WITHOUT consuming any
 * bytes; naively looping on that spins forever and hangs the worker. So we skip
 * an unrecognized message by its declared length and, as a hard backstop, stop
 * the moment an iteration fails to advance the read offset.
 */
export function* readAllMessages(buf: ByteBuffer): Iterable<CrdtMessage> {
  while (true) {
    const offsetBefore = buf.currentReadOffset()
    const msg = readMessage(buf)
    if (msg === undefined) return // no complete header left

    if (msg) {
      yield msg
    } else {
      // Unrecognized message type: skip it (by its declared length) so later
      // valid messages can still be processed.
      CrdtMessageProtocol.consumeMessage(buf)
    }

    if (buf.currentReadOffset() <= offsetBefore) return // no forward progress → stop
  }
}