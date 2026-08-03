import { CrdtMessageProtocol } from './crdtMessageProtocol'
import { ByteBuffer } from '../ByteBuffer'
import {
  CrdtMessageType,
  CrdtMessageHeader,
  CRDT_MESSAGE_HEADER_LENGTH,
  PutComponentMessage,
  PutComponentMessageBody
} from './types'
import { Entity } from '../types'

/**
 * @public
 */
export namespace PutComponentOperation {
  export const MESSAGE_HEADER_LENGTH = 16

  /**
   * Call this function for an optimal writing data passing the ByteBuffer
   *  already allocated
   */
  export function write(message: Omit<PutComponentMessageBody, 'type'>, buf: ByteBuffer) {
    const messageLength = CRDT_MESSAGE_HEADER_LENGTH + MESSAGE_HEADER_LENGTH + message.data.byteLength

    // Write CrdtMessage header
    buf.writeUint32(messageLength)
    buf.writeUint32(CrdtMessageType.PUT_COMPONENT)

    // Write ComponentOperation header
    buf.writeUint32(message.entityId)
    buf.writeUint32(message.componentId)
    buf.writeUint32(message.timestamp)
    buf.writeUint32(message.data.byteLength)

    // write body
    buf.writeBuffer(message.data, false)
  }

  /**
   * @param peekedHeader - a header already peeked (validated, not consumed) by
   * the caller, so the hot read loop validates each message exactly once.
   *
   * Returns null when the message cannot be framed: no complete/valid CRDT
   * header, or a payload length declared INSIDE the message that disagrees with
   * the framed message length.
   *
   * SECURITY (untrusted input): `buf.readBuffer()` reads its OWN uint32 length
   * and is bounded by the buffer's WRITE offset, never by this message's frame.
   * Without the cross-check below, a message whose inner `dataLength` disagrees
   * with `header.length` swallows bytes belonging to the NEXT message and every
   * subsequent message is parsed at a shifted offset — pairing one entity's
   * header with another entity's component data. The framed length is the only
   * authority on where this message ends, so a disagreement is rejected outright
   * (readAllMessages then re-anchors on the frame and keeps going).
   */
  export function read(buf: ByteBuffer, peekedHeader?: CrdtMessageHeader): PutComponentMessage | null {
    const header = CrdtMessageProtocol.consumeOrReadHeader(buf, peekedHeader)
    if (!header) {
      return null
    }

    if (header.type !== CrdtMessageType.PUT_COMPONENT) {
      throw new Error('PutComponentOperation tried to read another message type.')
    }

    // Mirror of `write`: the frame holds the CRDT header, this message's fixed
    // header (entity + component + timestamp + payload length) and the payload.
    const expectedDataLength = header.length - CRDT_MESSAGE_HEADER_LENGTH - MESSAGE_HEADER_LENGTH
    if (expectedDataLength < 0) {
      // The frame cannot even hold the fixed header: reject before reading a
      // single body byte, so nothing outside the frame is ever touched.
      return null
    }

    const entityId = buf.readUint32() as Entity
    const componentId = buf.readUint32()
    const timestamp = buf.readUint32()

    // Peek (do NOT consume) the length prefix readBuffer() would obey, and
    // compare it against the frame before letting it move the read cursor.
    if (buf.getUint32(buf.currentReadOffset()) !== expectedDataLength) {
      return null
    }

    return {
      length: header.length,
      type: CrdtMessageType.PUT_COMPONENT,
      entityId,
      componentId,
      timestamp,
      data: buf.readBuffer()
    }
  }
}
