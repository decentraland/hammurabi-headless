import { Writer } from 'protobufjs/minimal'
import { ReadWriteByteBuffer } from '../../../src/lib/decentraland/ByteBuffer'
import { declareComponentUsingProtobufJs } from '../../../src/lib/decentraland/sdk-components/pb-based-component-helper'

describe('declareComponentUsingProtobufJs', () => {
  // A schema whose encode forks a nested message and then throws before ldelim(),
  // leaving the protobufjs writer's fork-state stack non-empty. This models a
  // malformed value (e.g. from an untrusted peer profile) that throws mid-encode.
  const poisonSchema = declareComponentUsingProtobufJs<{}, 1>(
    {
      decode: () => ({}),
      encode: (_value, writer) => {
        writer.uint32(0x0a)
        writer.fork()
        writer.uint32(0x99)
        throw new Error('encode boom')
      }
    },
    1,
    () => {}
  )

  // A well-formed schema that shares the module-level writer with poisonSchema.
  const goodSchema = declareComponentUsingProtobufJs<{ v: number }, 2>(
    {
      decode: (bytes) => ({ v: bytes[0] }),
      encode: (value, writer) => {
        writer.uint32(value.v)
      }
    },
    2,
    () => {}
  )

  it('propagates an encode error', () => {
    expect(() => poisonSchema.serialize({}, new ReadWriteByteBuffer())).toThrow('encode boom')
  })

  it('does not let a thrown encode corrupt a later serialization on the shared writer', () => {
    // Poison the shared writer with a fork-then-throw encode...
    expect(() => poisonSchema.serialize({}, new ReadWriteByteBuffer())).toThrow()

    // ...then serialize a good value. Without recreating the writer on throw, the
    // next reset() would RESTORE the aborted fork state and prepend stale bytes.
    const out = new ReadWriteByteBuffer()
    goodSchema.serialize({ v: 42 }, out)

    const expected = (() => {
      const w = new Writer()
      w.uint32(42)
      return w.finish()
    })()
    expect(out.toBinary()).toEqual(expected)
  })
})
