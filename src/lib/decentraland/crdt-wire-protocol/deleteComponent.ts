import { CrdtMessageProtocol } from './crdtMessageProtocol'
import { ByteBuffer } from '../ByteBuffer'
import {
  CrdtMessageType,
  CrdtMessageHeader,
  CRDT_MESSAGE_HEADER_LENGTH,
  DeleteComponentMessage,
  DeleteComponentMessageBody
} from './types'
import { Entity } from '../types'

/**
 * @public
 */
export namespace DeleteComponent {
  export const MESSAGE_HEADER_LENGTH = 12

  /**
   * Write DeleteComponent message
   */
  export function write(message: Omit<DeleteComponentMessageBody, 'type'>, buf: ByteBuffer) {
    const messageLength = CRDT_MESSAGE_HEADER_LENGTH + MESSAGE_HEADER_LENGTH

    // Write CrdtMessage header
    buf.writeUint32(messageLength)
    buf.writeUint32(CrdtMessageType.DELETE_COMPONENT)

    // Write ComponentOperation header
    buf.writeUint32(message.entityId)
    buf.writeUint32(message.componentId)
    buf.writeUint32(message.timestamp)
  }

  /** See PutComponentOperation.read for the peekedHeader contract. */
  export function read(buf: ByteBuffer, peekedHeader?: CrdtMessageHeader): DeleteComponentMessage | null {
    const header = CrdtMessageProtocol.consumeOrReadHeader(buf, peekedHeader)
    if (!header) {
      return null
    }

    if (header.type !== CrdtMessageType.DELETE_COMPONENT) {
      throw new Error('DeleteComponentOperation tried to read another message type.')
    }

    // This reader consumes a FIXED body size. A frame declared shorter than that
    // (untrusted input) would make the three reads below cross into the NEXT
    // message — or past the written data, throwing out of the parser. Reject
    // instead; readAllMessages skips the declared frame and keeps going. An
    // OVER-declared frame is handled there too, by re-anchoring the cursor.
    if (header.length < CRDT_MESSAGE_HEADER_LENGTH + MESSAGE_HEADER_LENGTH) {
      return null
    }

    return {
      length: header.length,
      type: CrdtMessageType.DELETE_COMPONENT,
      entityId: buf.readUint32() as Entity,
      componentId: buf.readUint32(),
      timestamp: buf.readUint32()
    }
  }
}
