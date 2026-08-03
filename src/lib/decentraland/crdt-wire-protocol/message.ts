import { CrdtMessageProtocol } from './crdtMessageProtocol'
import { ByteBuffer } from '../ByteBuffer'
import { CrdtMessageType, CrdtMessage, CrdtMessageHeader } from './types'
import { PutComponentOperation } from './putComponent'
import { DeleteComponent } from './deleteComponent'
import { DeleteEntity } from './deleteEntity'
import { AppendValueOperation } from './appendValue'

/**
 * Read the initial message of a ByteBuffer and moves the reading head.
 *
 * Returns a CrdtMessage when it recognizes a valid message.
 * Returns null if it is an unrecognizable message, or one whose contents
 *   disagree with its declared frame (see PutComponentOperation.read)
 * Returns undefined if it cannot read a valid CRDT header
 *
 * NON-RESUMABLE, and this is the whole reason {@link readAllMessages} exists.
 * On `null` the read cursor has ALREADY advanced part-way into the rejected
 * message — to just past the header for an unrecognized type, or past the fixed
 * fields for a frame-length disagreement — so it does NOT sit on a message
 * boundary and a caller cannot simply call this again. It is `readAllMessages`
 * that re-anchors the cursor on `offsetBefore + header.length` after every
 * message; resuming a raw `readMessage` loop instead would parse the rejected
 * frame's tail as a fresh header and shift every message after it, pairing one
 * entity's header with another entity's component data.
 *
 * Treat this and the per-type readers (`PutComponentOperation.read` and friends)
 * as low-level primitives for a caller that owns its own framing.
 * `readAllMessages` is the only resumable entry point.
 *
 * @param peekedHeader - a header already peeked (validated, not consumed) by the
 * caller, so the hot read loop validates each message exactly once.
 */
export function readMessage(buf: ByteBuffer, peekedHeader?: CrdtMessageHeader): CrdtMessage | null | undefined {
  const header = peekedHeader ?? CrdtMessageProtocol.peekHeader(buf)
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
 * code, outside the isolate's memory/execution limits. A well-formed header with
 * an unrecognized `type` makes `readMessage` return `null` WITHOUT consuming any
 * bytes; naively looping on that spins forever and hangs the worker. So we skip
 * an unrecognized message by its declared length and, as a hard backstop, stop
 * the moment an iteration fails to advance the read offset.
 *
 * FRAMING: the declared `header.length` is the ONLY authority on where a message
 * ends, so the cursor is re-anchored on it after every message. Per-type readers
 * can otherwise leave the cursor short of the frame (fixed-size DELETE_* readers
 * ignore the declared length; a rejected PUT/APPEND stops before its body), and
 * resuming from there would parse the frame's tail as a fresh header and shift
 * every subsequent message — pairing one entity's header with another entity's
 * component data. An over-read means the stream is already misaligned and cannot
 * be re-framed, so iteration stops there.
 */
export function* readAllMessages(buf: ByteBuffer): Iterable<CrdtMessage> {
  while (true) {
    const offsetBefore = buf.currentReadOffset()
    // Peek ONCE per message: the frame is needed both to read the message and to
    // re-anchor the cursor afterwards, and peekHeader is what validates that the
    // whole declared frame is actually present.
    const header = CrdtMessageProtocol.peekHeader(buf)
    if (!header) return // no complete/valid header left

    // validateFullMessageAvailable (inside peekHeader) guarantees
    // remainingBytes >= header.length, so frameEnd is within the written data.
    const frameEnd = offsetBefore + header.length

    const msg = readMessage(buf, header)
    const offsetAfter = buf.currentReadOffset()

    if (offsetAfter > frameEnd) {
      // The reader consumed MORE than the frame declared: `msg` was assembled
      // from bytes of at least two frames, and nothing after it can be framed.
      // Drop it and stop instead of emitting cross-wired messages.
      return
    }

    if (offsetAfter < frameEnd) {
      // Under-read: unrecognized type (nothing consumed past the header) or a
      // message the reader rejected. Skip to the end of the declared frame so
      // the next header is read exactly where the producer put it.
      buf.incrementReadOffset(frameEnd - offsetAfter)
    }

    // Hard backstop, kept even though the re-anchor above already guarantees
    // progress (header.length >= CRDT_MESSAGE_HEADER_LENGTH): never loop without
    // consuming bytes, whatever a future reader does.
    if (buf.currentReadOffset() <= offsetBefore) return

    // Yield only once the cursor sits on the next frame boundary, so a consumer
    // that abandons this generator mid-stream (e.g. SceneContext.update running
    // out of frame quota) leaves the buffer resumable at a message boundary.
    if (msg) yield msg
  }
}