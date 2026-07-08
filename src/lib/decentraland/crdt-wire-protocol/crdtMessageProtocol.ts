import { ByteBuffer } from '../ByteBuffer'
import { CrdtMessageType, CrdtMessageHeader, CRDT_MESSAGE_HEADER_LENGTH } from './types'

/**
 * @public
 */
export namespace CrdtMessageProtocol {
  /**
   * Validate if the message incoming is completed
   * @param buf - ByteBuffer
   */
  export function validateFullMessageAvailable(buf: ByteBuffer) {
    const rem = buf.remainingBytes()
    if (rem < CRDT_MESSAGE_HEADER_LENGTH) {
      return false
    }

    const messageLength = buf.getUint32(buf.currentReadOffset())
    // A declared length shorter than the header itself is malformed (untrusted,
    // scene-controlled input). Reject it so the reader stops instead of trying to
    // frame a sub-header-length "message" and mis-parsing the rest of the buffer.
    if (messageLength < CRDT_MESSAGE_HEADER_LENGTH) {
      return false
    }
    if (rem < messageLength) {
      return false
    }

    return true
  }

  /**
   * Get the current header, consuming the bytes involved.
   * @param buf - ByteBuffer
   * @returns header or null if there is no validated message
   */
  export function readHeader(buf: ByteBuffer): CrdtMessageHeader | null {
    if (!validateFullMessageAvailable(buf)) {
      return null
    }

    return {
      length: buf.readUint32(),
      type: buf.readUint32() as CrdtMessageType
    }
  }

  /**
   * Resolve the header for a message `read`. If the caller already peeked (and thus
   * validated) the header, consume its bytes and reuse it — so the hot read loop
   * validates each message exactly once. Otherwise read + validate the header here.
   * Shared by every per-type reader (put/delete-component/delete-entity/append).
   * @returns the header, or null when there is no complete/valid message to read.
   */
  export function consumeOrReadHeader(buf: ByteBuffer, peekedHeader?: CrdtMessageHeader): CrdtMessageHeader | null {
    if (peekedHeader) {
      buf.incrementReadOffset(CRDT_MESSAGE_HEADER_LENGTH)
      return peekedHeader
    }
    return readHeader(buf)
  }

  /**
   * Get the current header, without consuming the bytes involved.
   * @param buf - ByteBuffer
   * @returns header or null if there is no validated message
   */
  export function peekHeader(buf: ByteBuffer): CrdtMessageHeader | null {
    if (!validateFullMessageAvailable(buf)) {
      return null
    }

    const currentOffset = buf.currentReadOffset()
    return {
      length: buf.getUint32(currentOffset),
      type: buf.getUint32(currentOffset + 4) as CrdtMessageType
    }
  }

  /**
   * Consume the incoming message without processing it.
   * @param buf - ByteBuffer
   * @returns true in case of success or false if there is no valid message.
   */
  export function consumeMessage(buf: ByteBuffer): boolean {
    const header = peekHeader(buf)
    if (!header) {
      return false
    }

    buf.incrementReadOffset(header.length)
    return true
  }
}
