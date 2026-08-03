import { Quaternion, Vector3 } from '@babylonjs/core'
import { ReadWriteByteBuffer } from '../../../src/lib/decentraland/ByteBuffer'
import {
  CrdtMessage,
  CrdtMessageType,
  DeleteEntity,
  PutComponentOperation,
  readAllMessages
} from '../../../src/lib/decentraland/crdt-wire-protocol'
import { transformComponent } from '../../../src/lib/decentraland/sdk-components/transform-component'
import { Entity } from '../../../src/lib/decentraland/types'
import { isDeniedSceneCrdtOp, sanitizeSceneCrdt } from '../../../src/lib/babylon/scene/logic/scene-crdt-guard'

function transformData(): Uint8Array {
  const buf = new ReadWriteByteBuffer()
  transformComponent.serialize(
    { parent: 0 as Entity, position: Vector3.Zero(), scale: Vector3.One(), rotation: Quaternion.Identity() },
    buf
  )
  return buf.toBinary()
}

function put(entityId: number): Uint8Array {
  const buf = new ReadWriteByteBuffer()
  PutComponentOperation.write(
    { entityId: entityId as Entity, componentId: transformComponent.componentId, timestamp: 1, data: transformData() },
    buf
  )
  return buf.toBinary()
}

function del(entityId: number): Uint8Array {
  const buf = new ReadWriteByteBuffer()
  DeleteEntity.write({ entityId: entityId as Entity }, buf)
  return buf.toBinary()
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return out
}

function messagesOf(bytes: Uint8Array): CrdtMessage[] {
  return Array.from(readAllMessages(new ReadWriteByteBuffer(bytes)))
}

describe('scene CRDT write-guard policy', () => {
  describe('when classifying component ops', () => {
    it('denies a PUT_COMPONENT on an avatar-range entity', () => {
      expect(isDeniedSceneCrdtOp(messagesOf(put(33))[0])).toBe(true)
    })

    it('allows a PUT_COMPONENT on a static entity (PlayerEntity)', () => {
      expect(isDeniedSceneCrdtOp(messagesOf(put(1))[0])).toBe(false)
    })

    it('allows a PUT_COMPONENT on a scene-range entity', () => {
      expect(isDeniedSceneCrdtOp(messagesOf(put(600))[0])).toBe(false)
    })
  })

  describe('when classifying DELETE_ENTITY ops', () => {
    it('denies a DELETE_ENTITY on a static entity (PlayerEntity)', () => {
      expect(isDeniedSceneCrdtOp(messagesOf(del(1))[0])).toBe(true)
    })

    it('denies a DELETE_ENTITY on an avatar-range entity', () => {
      expect(isDeniedSceneCrdtOp(messagesOf(del(33))[0])).toBe(true)
    })

    it('denies a DELETE_ENTITY on a reserved non-avatar entity', () => {
      expect(isDeniedSceneCrdtOp(messagesOf(del(400))[0])).toBe(true)
    })

    it('allows a DELETE_ENTITY on a scene-range entity', () => {
      expect(isDeniedSceneCrdtOp(messagesOf(del(600))[0])).toBe(false)
    })
  })
})

describe('main.crdt sanitization', () => {
  describe('when the buffer mixes allowed and denied ops', () => {
    let sanitized: ReturnType<typeof sanitizeSceneCrdt>
    let kept: CrdtMessage[]

    beforeEach(() => {
      const bytes = concat(
        put(600), // allowed: scene component write
        put(33), // denied: avatar-range component write
        del(1), // denied: delete of a host static entity
        del(700) // allowed: delete of a scene entity
      )
      sanitized = sanitizeSceneCrdt(bytes)
      kept = messagesOf(sanitized.bytes)
    })

    it('reports that it changed the buffer', () => {
      expect(sanitized.changed).toBe(true)
    })

    it('keeps exactly the two allowed ops', () => {
      expect(kept).toHaveLength(2)
    })

    it('keeps the allowed scene PUT', () => {
      expect(kept.some(m => m.type === CrdtMessageType.PUT_COMPONENT && m.entityId === (600 as Entity))).toBe(true)
    })

    it('keeps the allowed scene DELETE_ENTITY', () => {
      expect(kept.some(m => m.type === CrdtMessageType.DELETE_ENTITY && m.entityId === (700 as Entity))).toBe(true)
    })

    it('drops the avatar-range PUT', () => {
      expect(kept.some(m => m.entityId === (33 as Entity))).toBe(false)
    })

    it('drops the static-entity DELETE', () => {
      expect(kept.some(m => m.entityId === (1 as Entity))).toBe(false)
    })
  })

  describe('when the buffer contains only allowed ops', () => {
    let bytes: Uint8Array
    let sanitized: ReturnType<typeof sanitizeSceneCrdt>

    beforeEach(() => {
      bytes = concat(put(600), del(700))
      sanitized = sanitizeSceneCrdt(bytes)
    })

    it('reports no change', () => {
      expect(sanitized.changed).toBe(false)
    })

    it('returns the original buffer reference', () => {
      expect(sanitized.bytes).toBe(bytes)
    })
  })

  describe('when the buffer is empty', () => {
    it('reports no change and returns it unchanged', () => {
      const empty = new Uint8Array(0)
      const sanitized = sanitizeSceneCrdt(empty)
      expect(sanitized.changed).toBe(false)
      expect(sanitized.bytes).toBe(empty)
    })
  })
})
