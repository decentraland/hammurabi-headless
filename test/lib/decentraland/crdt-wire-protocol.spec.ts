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

describe('readAllMessages treats the declared length as authoritative for framing', () => {
  // A recognized type whose declared length disagrees with the body would
  // otherwise misframe (or over-read) every following message.
  it('skips the padding of an over-declared message and frames the next one correctly', () => {
    const buf = new ReadWriteByteBuffer()
    // DELETE_ENTITY needs 12 bytes but declares 20 (8 bytes of trailing padding).
    buf.writeUint32(20)
    buf.writeUint32(CrdtMessageType.DELETE_ENTITY)
    buf.writeUint32(7) // entityId
    buf.writeUint32(0) // padding
    buf.writeUint32(0) // padding
    // A valid DELETE_ENTITY immediately after the declared frame.
    DeleteEntity.write({ entityId: 9 as Entity }, buf)

    const messages = Array.from(readAllMessages(buf))

    expect(messages.map((m) => [m.type, m.entityId])).toEqual([
      [CrdtMessageType.DELETE_ENTITY, 7],
      [CrdtMessageType.DELETE_ENTITY, 9]
    ])
  })

  it('rejects a recognized type whose declared length is below its per-type minimum', () => {
    const buf = new ReadWriteByteBuffer()
    // PUT_COMPONENT requires 24 bytes; declaring 20 can't frame its fixed body.
    buf.writeUint32(20)
    buf.writeUint32(CrdtMessageType.PUT_COMPONENT)
    buf.writeUint32(1) // entityId
    buf.writeUint32(1) // componentId
    buf.writeUint32(0) // timestamp (fills the buffer to 20 bytes)

    expect(CrdtMessageProtocol.validateFullMessageAvailable(buf)).toBe(false)
    expect(Array.from(readAllMessages(buf))).toHaveLength(0)
  })

  it('drops a message whose internal data length overruns its declared frame', () => {
    const buf = new ReadWriteByteBuffer()
    // PUT declares length 24 (implies 0 data bytes) but its internal data-length
    // field claims 4 bytes — the body overruns the declared frame.
    buf.writeUint32(24)
    buf.writeUint32(CrdtMessageType.PUT_COMPONENT)
    buf.writeUint32(5) // entityId
    buf.writeUint32(6) // componentId
    buf.writeUint32(0) // timestamp
    buf.writeUint32(4) // internal data length (inconsistent with declared frame)
    buf.writeUint32(0) // 4 data bytes

    expect(Array.from(readAllMessages(buf))).toHaveLength(0)
  })

  it('does not throw when a PUT internal data-length overruns the BUFFER end', () => {
    const buf = new ReadWriteByteBuffer()
    // Passes the per-type minimum (length 24), but the internal data-length field
    // claims a byte that isn't present, so the ByteBuffer read would throw. That
    // throw must be contained inside readAllMessages (otherwise it escapes the
    // consumer's for-of and leaves the poison buffer un-shifted at the queue head).
    buf.writeUint32(24)
    buf.writeUint32(CrdtMessageType.PUT_COMPONENT)
    buf.writeUint32(5) // entityId
    buf.writeUint32(6) // componentId
    buf.writeUint32(0) // timestamp
    buf.writeUint32(1) // internal data length = 1, but no data byte follows

    let messages: unknown[] | undefined
    expect(() => { messages = Array.from(readAllMessages(buf)) }).not.toThrow()
    expect(messages).toHaveLength(0)
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
