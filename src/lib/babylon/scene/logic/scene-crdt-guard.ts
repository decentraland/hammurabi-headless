import { ByteBuffer, ReadWriteByteBuffer } from '../../../decentraland/ByteBuffer'
import {
  CrdtMessage,
  CrdtMessageType,
  readAllMessages,
  PutComponentOperation,
  AppendValueOperation,
  DeleteComponent,
  DeleteEntity
} from '../../../decentraland/crdt-wire-protocol'
import { AVATAR_ENTITY_RANGE, RESERVED_ENTITY_RANGE, entityIsInRange } from './static-entities'

/**
 * Write-guard policy for CRDT that originates from the untrusted scene runtime
 * (`crdtSendToRenderer`, `main.crdt`). Two different denials, because the two
 * kinds of op carry different risk:
 *
 * - Component ops (PUT_COMPONENT / APPEND_VALUE / DELETE_COMPONENT) are denied
 *   only on the avatar range. Scenes legitimately write components to the static
 *   entities (e.g. InputModifier on PlayerEntity, camera components), so those
 *   stay allowed; but a component write on an avatar entity fights the avatar
 *   communication system (independent LWW timestamp domain) and can pre-create
 *   avatar slots.
 * - DELETE_ENTITY is denied on the WHOLE reserved range. The rationale for
 *   allowing scene component writes to static entities does not extend to
 *   deleting the entity itself — a scene DELETE_ENTITY on PlayerEntity/CameraEntity
 *   or an avatar slot would tear down a host-owned entity or a live player.
 *
 * Messages from trusted host subscriptions (the avatar system, virtual scenes)
 * do NOT go through this — they legitimately create and delete entities in their
 * own reserved range.
 */
export function isDeniedSceneCrdtOp(msg: CrdtMessage): boolean {
  if (msg.type === CrdtMessageType.DELETE_ENTITY) {
    return entityIsInRange(msg.entityId, RESERVED_ENTITY_RANGE)
  }
  // PUT_COMPONENT | APPEND_VALUE | DELETE_COMPONENT
  return entityIsInRange(msg.entityId, AVATAR_ENTITY_RANGE)
}

function writeMessage(msg: CrdtMessage, out: ByteBuffer): void {
  switch (msg.type) {
    case CrdtMessageType.PUT_COMPONENT:
      PutComponentOperation.write(msg, out)
      break
    case CrdtMessageType.APPEND_VALUE:
      AppendValueOperation.write(msg, out)
      break
    case CrdtMessageType.DELETE_COMPONENT:
      DeleteComponent.write(msg, out)
      break
    case CrdtMessageType.DELETE_ENTITY:
      DeleteEntity.write(msg, out)
      break
  }
}

/**
 * Return a copy of `bytes` with every op denied by {@link isDeniedSceneCrdtOp}
 * removed. Used to sanitize `main.crdt` (scene-authored initial state) ONCE at
 * load, so the host and the scene runtime observe the SAME initial CRDT state:
 * the host applies main.crdt with the guard active, and `crdtGetState` echoes
 * main.crdt back to the scene — echoing the raw (unfiltered) bytes would hand the
 * scene avatar/reserved ops the host rejected. Recognized, non-denied messages
 * are re-serialized byte-for-byte-equivalent; unrecognized messages are dropped
 * (the host does not apply them either), so both sides stay in agreement.
 *
 * `changed` lets the caller keep the original buffer when nothing was stripped.
 */
export function sanitizeSceneCrdt(bytes: Uint8Array): { bytes: Uint8Array; changed: boolean } {
  if (bytes.byteLength === 0) return { bytes, changed: false }
  const out = new ReadWriteByteBuffer()
  let changed = false
  for (const msg of readAllMessages(new ReadWriteByteBuffer(bytes))) {
    if (isDeniedSceneCrdtOp(msg)) {
      changed = true
      continue
    }
    writeMessage(msg, out)
  }
  // readAllMessages silently skips unrecognized messages, so a buffer that
  // contained any also counts as changed even if no recognized op was denied.
  const result = out.toBinary()
  if (result.byteLength !== bytes.byteLength) changed = true
  return changed ? { bytes: result, changed: true } : { bytes, changed: false }
}
