import { CrdtMessageProtocol } from './crdtMessageProtocol'
import { ByteBuffer } from '../ByteBuffer'
import {
  AppendValueMessage,
  AppendValueMessageBody,
  CrdtMessageType,
  CrdtMessageHeader,
  CRDT_MESSAGE_HEADER_LENGTH
} from './types'
import { Entity } from '../types'

/**
 * @public
 */
export namespace AppendValueOperation {
  export const MESSAGE_HEADER_LENGTH = 16

  /**
   * Call this function for an optimal writing data passing the ByteBuffer
   *  already allocated
   */
  export function write(message: Omit<AppendValueMessageBody, 'type'>, buf: ByteBuffer) {
    const messageLength = CRDT_MESSAGE_HEADER_LENGTH + MESSAGE_HEADER_LENGTH + message.data.byteLength

    // Write CrdtMessage header
    buf.writeUint32(messageLength)
    buf.writeUint32(CrdtMessageType.APPEND_VALUE)

    // Write ComponentOperation header
    buf.writeUint32(message.entityId)
    buf.writeUint32(message.componentId)
    buf.writeUint32(message.timestamp)
    buf.writeUint32(message.data.byteLength)

    // write body
    buf.writeBuffer(message.data, false)
  }

  /**
   * See PutComponentOperation.read for the peekedHeader contract and for why the
   * declared payload length MUST be cross-checked against the framed length
   * before readBuffer() is allowed to move the read cursor.
   */
  export function read(buf: ByteBuffer, peekedHeader?: CrdtMessageHeader): AppendValueMessage | null {
    const header = CrdtMessageProtocol.consumeOrReadHeader(buf, peekedHeader)
    /* istanbul ignore if */
    if (!header) {
      return null
    }

    /* istanbul ignore if */
    if (header.type !== CrdtMessageType.APPEND_VALUE) {
      throw new Error('AppendValueOperation tried to read another message type.')
    }

    const expectedDataLength = header.length - CRDT_MESSAGE_HEADER_LENGTH - MESSAGE_HEADER_LENGTH
    if (expectedDataLength < 0) {
      return null
    }

    const entityId = buf.readUint32() as Entity
    const componentId = buf.readUint32()
    const timestamp = buf.readUint32()

    if (buf.getUint32(buf.currentReadOffset()) !== expectedDataLength) {
      return null
    }

    return {
      length: header.length,
      type: CrdtMessageType.APPEND_VALUE,
      entityId,
      componentId,
      timestamp,
      data: buf.readBuffer()
    }
  }
}
