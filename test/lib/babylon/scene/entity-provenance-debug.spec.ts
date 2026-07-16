import { debugScanCrdt } from '../../../../src/lib/babylon/scene/scene-context'
import { ReadWriteByteBuffer } from '../../../../src/lib/decentraland/ByteBuffer'
import { DeleteEntity, PutComponentOperation } from '../../../../src/lib/decentraland/crdt-wire-protocol'
import { Entity } from '../../../../src/lib/decentraland/types'

// RESERVED_STATIC_ENTITIES is 512: scene entities are >= 512, avatar/reserved
// entities are 32..255. The tracer surfaces scene component ops that land on a
// reserved entity, and DELETE_ENTITY messages that target a scene-range entity.
const RESERVED_ENTITY = 32 as Entity // number 32, version 0
const SCENE_ENTITY = 600 as Entity // number 600 (>= 512), version 0
const COMPONENT_ID = 4242

function putComponent(entityId: Entity): Uint8Array {
  const buf = new ReadWriteByteBuffer()
  PutComponentOperation.write({ componentId: COMPONENT_ID, entityId, timestamp: 1, data: new Uint8Array([1, 2, 3]) }, buf)
  return buf.toBinary()
}

function deleteEntity(entityId: Entity): Uint8Array {
  const buf = new ReadWriteByteBuffer()
  DeleteEntity.write({ entityId }, buf)
  return buf.toBinary()
}

describe('debugScanCrdt entity-provenance tracer', () => {
  let logSpy: jest.SpyInstance

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => void 0)
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  describe('when a component op targets a reserved entity (< 512)', () => {
    beforeEach(() => {
      debugScanCrdt('scene→host', [putComponent(RESERVED_ENTITY)])
    })

    it('should log the op flagged as RESERVED', () => {
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(logSpy.mock.calls[0][0]).toContain('RESERVED')
      expect(logSpy.mock.calls[0][0]).toContain('entity=32v0')
    })
  })

  describe('when a component op targets a scene entity (>= 512)', () => {
    beforeEach(() => {
      debugScanCrdt('scene→host', [putComponent(SCENE_ENTITY)])
    })

    it('should not log anything', () => {
      expect(logSpy).not.toHaveBeenCalled()
    })
  })

  describe('when a DELETE_ENTITY targets a scene-range entity (>= 512)', () => {
    beforeEach(() => {
      debugScanCrdt('host→scene', [deleteEntity(SCENE_ENTITY)])
    })

    it('should flag it as SCENE-RANGE', () => {
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(logSpy.mock.calls[0][0]).toContain('DELETE_ENTITY')
      expect(logSpy.mock.calls[0][0]).toContain('SCENE-RANGE!')
    })
  })

  describe('when a DELETE_ENTITY targets a reserved avatar entity (< 512)', () => {
    beforeEach(() => {
      debugScanCrdt('host→scene', [deleteEntity(RESERVED_ENTITY)])
    })

    it('should log it without the SCENE-RANGE flag', () => {
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(logSpy.mock.calls[0][0]).toContain('DELETE_ENTITY')
      expect(logSpy.mock.calls[0][0]).not.toContain('SCENE-RANGE')
    })
  })

  describe('when the buffer is empty', () => {
    beforeEach(() => {
      debugScanCrdt('scene→host', [new Uint8Array(0)])
    })

    it('should not log anything', () => {
      expect(logSpy).not.toHaveBeenCalled()
    })
  })
})
