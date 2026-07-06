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
   */
  export function read(buf: ByteBuffer, peekedHeader?: CrdtMessageHeader): PutComponentMessage | null {
    let header = peekedHeader
    if (header) {
      buf.incrementReadOffset(CRDT_MESSAGE_HEADER_LENGTH)
    } else {
      const readHeader = CrdtMessageProtocol.readHeader(buf)
      if (!readHeader) {
        return null
      }
      header = readHeader
    }

    if (header.type !== CrdtMessageType.PUT_COMPONENT) {
      throw new Error('PutComponentOperation tried to read another message type.')
    }

    return {
      length: header.length,
      type: CrdtMessageType.PUT_COMPONENT,
      entityId: buf.readUint32() as Entity,
      componentId: buf.readUint32(),
      timestamp: buf.readUint32(),
      data: buf.readBuffer()
    }
  }
}
