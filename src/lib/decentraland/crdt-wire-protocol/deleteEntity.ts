import { CrdtMessageProtocol } from './crdtMessageProtocol'
import { ByteBuffer } from '../ByteBuffer'
import {
  CrdtMessageType,
  CrdtMessageHeader,
  CRDT_MESSAGE_HEADER_LENGTH,
  DeleteEntityMessage,
  DeleteEntityMessageBody
} from './types'
import { Entity } from '../types'

/**
 * @public
 */
export namespace DeleteEntity {
  export const MESSAGE_HEADER_LENGTH = 4

  export function write(message: Omit<DeleteEntityMessageBody, 'type'>, buf: ByteBuffer) {
    // Write CrdtMessage header
    buf.writeUint32(CRDT_MESSAGE_HEADER_LENGTH + MESSAGE_HEADER_LENGTH)
    buf.writeUint32(CrdtMessageType.DELETE_ENTITY)

    // body
    buf.writeUint32(message.entityId)
  }

  /** See PutComponentOperation.read for the peekedHeader contract. */
  export function read(buf: ByteBuffer, peekedHeader?: CrdtMessageHeader): DeleteEntityMessage | null {
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

    if (header.type !== CrdtMessageType.DELETE_ENTITY) {
      throw new Error('DeleteEntity tried to read another message type.')
    }

    return {
      length: header.length,
      type: CrdtMessageType.DELETE_ENTITY,
      entityId: buf.readUint32() as Entity
    }
  }
}
