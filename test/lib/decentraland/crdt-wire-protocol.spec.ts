import { ReadWriteByteBuffer } from '../../../src/lib/decentraland/ByteBuffer'
import { readMessage, readAllMessages, AppendValueOperation, CrdtMessageProtocol, CrdtMessageType, CRDT_MESSAGE_HEADER_LENGTH, DeleteComponent, DeleteEntity, PutComponentMessageBody, PutComponentOperation } from '../../../src/lib/decentraland/crdt-wire-protocol'
import { Entity } from '../../../src/lib/decentraland/types'

describe('readAllMessages hardening against untrusted input', () => {
  // Regression: an unknown-but-well-formed message type used to make readAllMessages
  // spin forever (readMessage returns null without consuming), hanging the worker.
  it('terminates and skips an unknown message type, still yielding following valid messages', () => {
    const buf = new ReadWriteByteBuffer()
    // Unknown message: a complete 8-byte header (length=8) with an unknown type.
    buf.writeUint32(8)
    buf.writeUint32(99)
    // A valid APPEND_VALUE message after it.
    AppendValueOperation.write({ entityId: 1 as Entity, timestamp: 0, componentId: 1, data: Uint8Array.of(1, 2, 3) }, buf)

    const messages = Array.from(readAllMessages(buf))

    expect(messages).toHaveLength(1)
    expect(messages[0].type).toBe(CrdtMessageType.APPEND_VALUE)
  })

  it('terminates on a non-advancing (zero-length) unknown message instead of hanging', () => {
    const buf = new ReadWriteByteBuffer()
    buf.writeUint32(0) // length 0 — would never advance the read offset
    buf.writeUint32(99) // unknown type

    const messages = Array.from(readAllMessages(buf))

    expect(messages).toHaveLength(0)
  })
})

// Regression: the reader used to trust the length prefix INSIDE a message and
// never compare it with the framed `header.length`. `readBuffer()` is bounded by
// the buffer's WRITE offset, so an inconsistent inner length swallowed bytes of
// the NEXT message and every message after it was parsed at a shifted offset —
// pairing one entity's header with another entity's component data. The
// fixed-size DELETE_* readers had the mirror problem: they ignored the frame, so
// an over-declared length left the cursor INSIDE the message and its tail was
// parsed as a fresh header.
describe('framing of messages whose declared length disagrees with their contents', () => {
  const INCONSISTENT_ENTITY = 187 as Entity
  const FOLLOWING_ENTITY = 170 as Entity
  const FOLLOWING_DATA = Uint8Array.of(7, 7, 7)

  // Writes a PUT_COMPONENT by hand so the framed length and the payload length
  // prefix can disagree (PutComponentOperation.write always keeps them in sync).
  function writeInconsistentPut(buf: ReadWriteByteBuffer, payload: Uint8Array, declaredDataLength: number) {
    buf.writeUint32(CRDT_MESSAGE_HEADER_LENGTH + PutComponentOperation.MESSAGE_HEADER_LENGTH + payload.byteLength)
    buf.writeUint32(CrdtMessageType.PUT_COMPONENT)
    buf.writeUint32(INCONSISTENT_ENTITY)
    buf.writeUint32(1)
    buf.writeUint32(1)
    buf.writeUint32(declaredDataLength)
    buf.writeBuffer(payload, false)
  }

  describe('when a PUT declares MORE payload bytes than its frame can hold', () => {
    let buf: ReadWriteByteBuffer

    beforeEach(() => {
      buf = new ReadWriteByteBuffer()
      // frame holds 4 payload bytes, the message claims 8 — the extra 4 would be
      // taken from the length field of the message that follows.
      writeInconsistentPut(buf, Uint8Array.of(1, 1, 1, 1), 8)
      PutComponentOperation.write(
        { entityId: FOLLOWING_ENTITY, componentId: 1, timestamp: 1, data: FOLLOWING_DATA },
        buf
      )
    })

    it('should reject the message from PutComponentOperation.read', () => {
      expect(PutComponentOperation.read(buf)).toBe(null)
    })

    it('should skip the rejected message and read the following one from its own offset', () => {
      expect(Array.from(readAllMessages(buf))).toEqual([
        {
          length: CRDT_MESSAGE_HEADER_LENGTH + PutComponentOperation.MESSAGE_HEADER_LENGTH + FOLLOWING_DATA.byteLength,
          type: CrdtMessageType.PUT_COMPONENT,
          entityId: FOLLOWING_ENTITY,
          componentId: 1,
          timestamp: 1,
          data: FOLLOWING_DATA
        }
      ])
    })
  })

  describe('when a PUT declares FEWER payload bytes than its frame holds', () => {
    let buf: ReadWriteByteBuffer

    beforeEach(() => {
      buf = new ReadWriteByteBuffer()
      writeInconsistentPut(buf, Uint8Array.of(1, 1, 1, 1), 0)
      PutComponentOperation.write(
        { entityId: FOLLOWING_ENTITY, componentId: 1, timestamp: 1, data: FOLLOWING_DATA },
        buf
      )
    })

    it('should skip the rejected message and read the following one from its own offset', () => {
      expect(Array.from(readAllMessages(buf))).toMatchObject([
        { type: CrdtMessageType.PUT_COMPONENT, entityId: FOLLOWING_ENTITY, data: FOLLOWING_DATA }
      ])
    })
  })

  describe('when a PUT declares a frame too short to hold its own fixed header', () => {
    let buf: ReadWriteByteBuffer

    beforeEach(() => {
      buf = new ReadWriteByteBuffer()
      buf.writeUint32(CRDT_MESSAGE_HEADER_LENGTH) // no room for entity/component/timestamp/length
      buf.writeUint32(CrdtMessageType.PUT_COMPONENT)
      DeleteEntity.write({ entityId: FOLLOWING_ENTITY }, buf)
    })

    it('should skip it without reading a single byte of the following message', () => {
      expect(Array.from(readAllMessages(buf))).toMatchObject([
        { type: CrdtMessageType.DELETE_ENTITY, entityId: FOLLOWING_ENTITY }
      ])
    })
  })

  describe('when an APPEND_VALUE declares a payload length that disagrees with its frame', () => {
    let buf: ReadWriteByteBuffer

    beforeEach(() => {
      buf = new ReadWriteByteBuffer()
      buf.writeUint32(CRDT_MESSAGE_HEADER_LENGTH + AppendValueOperation.MESSAGE_HEADER_LENGTH + 4)
      buf.writeUint32(CrdtMessageType.APPEND_VALUE)
      buf.writeUint32(INCONSISTENT_ENTITY)
      buf.writeUint32(1)
      buf.writeUint32(1)
      buf.writeUint32(8) // LIES: the frame only holds 4
      buf.writeUint32(0)
      AppendValueOperation.write(
        { entityId: FOLLOWING_ENTITY, componentId: 1, timestamp: 1, data: FOLLOWING_DATA },
        buf
      )
    })

    it('should skip the rejected message and read the following one from its own offset', () => {
      expect(Array.from(readAllMessages(buf))).toMatchObject([
        { type: CrdtMessageType.APPEND_VALUE, entityId: FOLLOWING_ENTITY, data: FOLLOWING_DATA }
      ])
    })
  })

  describe('when a DELETE_COMPONENT declares a frame LONGER than the bytes its reader consumes', () => {
    let buf: ReadWriteByteBuffer

    beforeEach(() => {
      buf = new ReadWriteByteBuffer()
      // 4 bytes of padding beyond the 20 the reader consumes: without re-anchoring
      // on the frame, that padding is parsed as the next message's header.
      buf.writeUint32(CRDT_MESSAGE_HEADER_LENGTH + DeleteComponent.MESSAGE_HEADER_LENGTH + 4)
      buf.writeUint32(CrdtMessageType.DELETE_COMPONENT)
      buf.writeUint32(INCONSISTENT_ENTITY)
      buf.writeUint32(1)
      buf.writeUint32(9)
      buf.writeUint32(0)
      DeleteEntity.write({ entityId: FOLLOWING_ENTITY }, buf)
    })

    it('should yield it and still read the following message from its own offset', () => {
      expect(Array.from(readAllMessages(buf))).toMatchObject([
        { type: CrdtMessageType.DELETE_COMPONENT, entityId: INCONSISTENT_ENTITY, componentId: 1, timestamp: 9 },
        { type: CrdtMessageType.DELETE_ENTITY, entityId: FOLLOWING_ENTITY }
      ])
    })
  })

  describe('when a DELETE_COMPONENT declares a frame SHORTER than the bytes its reader consumes', () => {
    let buf: ReadWriteByteBuffer

    beforeEach(() => {
      buf = new ReadWriteByteBuffer()
      buf.writeUint32(CRDT_MESSAGE_HEADER_LENGTH) // no room for entity/component/timestamp
      buf.writeUint32(CrdtMessageType.DELETE_COMPONENT)
      DeleteEntity.write({ entityId: FOLLOWING_ENTITY }, buf)
    })

    it('should skip it instead of reading the following message as its body', () => {
      expect(Array.from(readAllMessages(buf))).toMatchObject([
        { type: CrdtMessageType.DELETE_ENTITY, entityId: FOLLOWING_ENTITY }
      ])
    })
  })

  describe('when the last message of the buffer is truncated', () => {
    let buf: ReadWriteByteBuffer

    beforeEach(() => {
      const complete = new ReadWriteByteBuffer()
      PutComponentOperation.write({ entityId: 1 as Entity, componentId: 1, timestamp: 1, data: Uint8Array.of(1, 2, 3) }, complete)
      PutComponentOperation.write({ entityId: 2 as Entity, componentId: 1, timestamp: 2, data: Uint8Array.of(4, 5, 6) }, complete)
      const bytes = complete.toBinary()
      buf = new ReadWriteByteBuffer(new Uint8Array(bytes.subarray(0, bytes.byteLength - 5)))
    })

    it('should yield the complete messages and return cleanly instead of throwing', () => {
      expect(Array.from(readAllMessages(buf))).toMatchObject([{ type: CrdtMessageType.PUT_COMPONENT, entityId: 1 }])
    })
  })
})

describe('Component operation tests', () => {
  it('validate corrupt message', () => {
    const buf = new ReadWriteByteBuffer(
      new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]),
      0
    )

    expect(CrdtMessageProtocol.validateFullMessageAvailable(buf)).toBe(false)
    expect(DeleteComponent.read(buf)).toBe(null)
    expect(PutComponentOperation.read(buf)).toBe(null)
    expect(DeleteEntity.read(buf)).toBe(null)
    expect(CrdtMessageProtocol.consumeMessage(buf)).toBe(false)
  })

  it('readMessage should return undefined if it has an invalid header', () => {
    const buf = new ReadWriteByteBuffer()
    expect(readMessage(buf)).toBe(undefined)
    expect(DeleteEntity.read(buf)).toBe(null)

    buf.writeUint32(4567)
    buf.writeUint32(1)
    expect(CrdtMessageProtocol.peekHeader(buf)).toBe(null)
  })

  it('readMessage should return null if the buffer has a valid header with unkown type', () => {
    const buf = new ReadWriteByteBuffer()

    buf.writeUint32(CRDT_MESSAGE_HEADER_LENGTH)
    buf.writeUint32(99)
    expect(CrdtMessageProtocol.peekHeader(buf)).toEqual({ length: CRDT_MESSAGE_HEADER_LENGTH, type: 99 })
    expect(readMessage(buf)).toBe(null)
  })

  it('rejects a header whose declared length is shorter than the header itself', () => {
    const buf = new ReadWriteByteBuffer()

    // length = 4 (< 8-byte header) is malformed and must not be framed as a message.
    buf.writeUint32(4)
    buf.writeUint32(99)

    expect(CrdtMessageProtocol.validateFullMessageAvailable(buf)).toBe(false)
    expect(CrdtMessageProtocol.peekHeader(buf)).toBe(null)
    expect(readMessage(buf)).toBe(undefined)
    expect(Array.from(readAllMessages(buf))).toHaveLength(0)
  })

  it('appendValue identity test', () => {
    const buf = new ReadWriteByteBuffer()
    AppendValueOperation.write({
      entityId: 1,
      timestamp: 0,
      componentId: 1,
      data: Uint8Array.of(1, 2, 3)
    }, buf)
    const msg = readMessage(buf)

    expect(msg).toEqual({
      componentId: 1,
      data: Uint8Array.of(1, 2, 3),
      entityId: 1,
      length: 27,
      timestamp: 0,
      type: CrdtMessageType.APPEND_VALUE
    })
  })

  it('putComponent identity test', () => {
    const buf = new ReadWriteByteBuffer()
    PutComponentOperation.write({
      entityId: 1,
      timestamp: 3,
      componentId: 1,
      data: Uint8Array.of(1, 2, 3)
    }, buf)
    const msg = readMessage(buf)

    expect(msg).toEqual({
      componentId: 1,
      data: Uint8Array.of(1, 2, 3),
      entityId: 1,
      length: 27,
      timestamp: 3,
      type: CrdtMessageType.PUT_COMPONENT
    })
  })

  it('deleteComponent identity test', () => {
    const buf = new ReadWriteByteBuffer()
    DeleteComponent.write({
      entityId: 1,
      timestamp: 3,
      componentId: 2,
    }, buf)
    const msg = readMessage(buf)

    expect(msg).toEqual({
      componentId: 2,
      entityId: 1,
      length: 20,
      timestamp: 3,
      type: CrdtMessageType.DELETE_COMPONENT
    })
  })

  it('deleteEntity identity test', () => {
    const buf = new ReadWriteByteBuffer()
    DeleteEntity.write({ entityId: 1 }, buf)
    const msg = readMessage(buf)

    expect(msg).toEqual({
      entityId: 1,
      length: 12,
      type: CrdtMessageType.DELETE_ENTITY
    })
  })

  it('should fail null if it has an invalid type', () => {
    const buf = new ReadWriteByteBuffer()

    function writeSomeInvalidMessage() {
      buf.writeUint32(8)
      buf.writeUint32(213)
    }

    writeSomeInvalidMessage()
    expect(() => {
      PutComponentOperation.read(buf)
    }).toThrowError()

    writeSomeInvalidMessage()
    expect(() => {
      DeleteEntity.read(buf)
    }).toThrowError()

    writeSomeInvalidMessage()
    expect(() => {
      DeleteComponent.read(buf)
    }).toThrowError()

    writeSomeInvalidMessage()
    expect(() => {
      DeleteComponent.read(buf)
    }).toThrowError()

    writeSomeInvalidMessage()
    expect(readMessage(buf)).toBeNull()

    // the header has to be read
    expect(CrdtMessageProtocol.readHeader(buf)).not.toBeNull()

    buf.writeUint32(12)
    buf.writeUint32(213)
    buf.writeUint32(22)
    expect(buf.remainingBytes()).toBe(12)
    expect(CrdtMessageProtocol.consumeMessage(buf)).toBe(true)
    expect(buf.remainingBytes()).toBe(0)
  })
})
