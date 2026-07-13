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

  // Pass the peeked header down so the type-specific readers don't re-validate
  // and re-read it (this loop runs for every message of every frame).
  if (header.type === CrdtMessageType.PUT_COMPONENT) {
    return PutComponentOperation.read(buf, header)
  } else if (header.type === CrdtMessageType.DELETE_COMPONENT) {
    return DeleteComponent.read(buf, header)
  } else if (header.type === CrdtMessageType.APPEND_VALUE) {
    return AppendValueOperation.read(buf, header)
  } else if (header.type === CrdtMessageType.DELETE_ENTITY) {
    return DeleteEntity.read(buf, header)
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
    let msg: CrdtMessage | null | undefined
    try {
      msg = readMessage(buf)
    } catch {
      // A recognized message whose internal variable-length body (PUT/APPEND
      // data) overruns the buffer makes a ByteBuffer read throw from bounds
      // checking, BEFORE the frame reconciliation below can run. Stop the batch
      // cleanly rather than letting the throw escape to the consumer — an escaped
      // throw would skip the queue's shift() and leave the poison buffer at the
      // head to disrupt processing again.
      return
    }
    if (msg === undefined) return // no complete header left

    if (msg) {
      // Treat the declared header length as authoritative for framing. A type
      // reader consumes body fields directly, so a hostile length that disagrees
      // with the body would otherwise misframe every following message. If the
      // reader consumed MORE than the declared frame, the internal length fields
      // overran the header (malformed) — drop it and stop the batch. Otherwise
      // skip any trailing padding so the next message starts exactly at
      // messageStart + length.
      const frameEnd = offsetBefore + msg.length
      const consumed = buf.currentReadOffset()
      if (consumed > frameEnd) return
      if (consumed < frameEnd) buf.incrementReadOffset(frameEnd - consumed)
      yield msg
    } else {
      // Unrecognized message type: skip it (by its declared length) so later
      // valid messages can still be processed.
      CrdtMessageProtocol.consumeMessage(buf)
    }

    if (buf.currentReadOffset() <= offsetBefore) return // no forward progress → stop
  }
}