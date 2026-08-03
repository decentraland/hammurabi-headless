import mitt from 'mitt'
import { Writer } from 'protobufjs/minimal'
import {
  decodeCompressedMovement,
  decodeVelocityTier,
  readCompressedMovement,
  TIER_START_BIT
} from '../../../../src/lib/decentraland/communications/movement-compression'
import { CommsTransportWrapper } from '../../../../src/lib/decentraland/communications/CommsTransportWrapper'

// The decoder mirrors unity-explorer's NetworkMessageEncoder bit for bit, so the
// tests carry a matching ENCODER and round-trip through it. Encoding by hand is
// the only way to prove the layout: a decoder tested against its own output
// would agree with itself no matter which bits it read.

const PARCEL_SIZE = 16
const PARCEL_BITS = 17
const MIN_PARCEL = -152
const GRID_WIDTH = 165 - MIN_PARCEL + 1
const ROTATION_START_BIT = 25
const ROTATION_Y_BITS = 6
const TIMESTAMP_BITS = 15

const TIER_CONFIGS = [
  { xzBits: 10, yMax: 200, yBits: 13, maxVelocity: 4, velocityBits: 4 },
  { xzBits: 10, yMax: 200, yBits: 13, maxVelocity: 4, velocityBits: 4 },
  { xzBits: 8, yMax: 200, yBits: 13, maxVelocity: 12, velocityBits: 6 },
  { xzBits: 8, yMax: 200, yBits: 13, maxVelocity: 50, velocityBits: 6 }
]

function quantize(value: number, minValue: number, maxValue: number, sizeInBits: number): number {
  const maxStep = (1 << sizeInBits) - 1
  const normalized = (value - minValue) / (maxValue - minValue)
  return Math.round(Math.min(Math.max(normalized, 0), 1) * maxStep)
}

function quantizeVelocity(value: number, range: number, sizeInBits: number): number {
  const compressed = quantize(Math.abs(value), 0, range, sizeInBits - 1)
  return (compressed << 1) | (value < 0 ? 1 : 0)
}

/** Mirrors NetworkMessageEncoder.CompressMovementData. */
function encodeMovementData(
  position: { x: number; y: number; z: number },
  velocity: { x: number; y: number; z: number },
  tier: number
): bigint {
  const config = TIER_CONFIGS[tier]
  const parcelX = Math.floor(position.x / PARCEL_SIZE)
  const parcelY = Math.floor(position.z / PARCEL_SIZE)
  const parcelIndex = parcelX - MIN_PARCEL + (parcelY - MIN_PARCEL) * GRID_WIDTH

  const relativeX = position.x - parcelX * PARCEL_SIZE
  const relativeZ = position.z - parcelY * PARCEL_SIZE

  const { xzBits, yBits, yMax, maxVelocity, velocityBits } = config
  const compressedX = quantize(relativeX, 0, PARCEL_SIZE, xzBits)
  const compressedZ = quantize(relativeZ, 0, PARCEL_SIZE, xzBits)
  const compressedY = quantize(position.y, 0, yMax, yBits)
  const vx = quantizeVelocity(velocity.x, maxVelocity, velocityBits)
  const vy = quantizeVelocity(velocity.y, maxVelocity, velocityBits)
  const vz = quantizeVelocity(velocity.z, maxVelocity, velocityBits)

  let offset = BigInt(PARCEL_BITS)
  let result = BigInt(parcelIndex)
  result |= BigInt(compressedX) << offset
  offset += BigInt(xzBits)
  result |= BigInt(compressedZ) << offset
  offset += BigInt(xzBits)
  result |= BigInt(compressedY) << offset
  offset += BigInt(yBits)
  result |= BigInt(vx) << offset
  offset += BigInt(velocityBits)
  result |= BigInt(vy) << offset
  offset += BigInt(velocityBits)
  result |= BigInt(vz) << offset
  return result
}

/** Mirrors NetworkMessageEncoder.CompressTemporalData, overflow included. */
function encodeTemporalData(options: { rotationY?: number; tier?: number; grounded?: boolean } = {}): number {
  let temporal = 0
  if (options.grounded) temporal |= 1 << 19
  temporal |= quantize(options.rotationY ?? 0, 0, 360, ROTATION_Y_BITS) << ROTATION_START_BIT
  // `<< 31` on an int32 is exactly what upstream does, high bit and all.
  temporal |= ((options.tier ?? 0) & 0b11) << TIER_START_BIT
  return temporal | 0
}

/** Builds a full rfc4 Packet carrying a MovementCompressed (field 12). */
function encodePacket(words: {
  temporalData: number
  movementData: bigint
  headSyncData?: number
  pointAtData?: number
}): Uint8Array {
  const inner = new Writer()
  inner.uint32(8).int32(words.temporalData)
  inner.uint32(16).int64(words.movementData.toString())
  inner.uint32(24).int32(words.headSyncData ?? 0)
  inner.uint32(32).int32(words.pointAtData ?? 0)
  const innerBytes = inner.finish()

  const outer = new Writer()
  // field 12, wire type 2
  outer.uint32((12 << 3) | 2).bytes(innerBytes)
  return outer.finish()
}

describe('compressed movement decoding', () => {
  describe('when decoding a packet encoded at tier 0', () => {
    let decoded: ReturnType<typeof decodeCompressedMovement>

    beforeEach(() => {
      decoded = decodeCompressedMovement(
        encodeTemporalData({ tier: 0 }),
        encodeMovementData({ x: 40, y: 10, z: 72 }, { x: 0, y: 0, z: 0 }, 0),
        0,
        0
      )
    })

    it('should recover the x position within the tier quantization step', () => {
      expect(decoded.positionX).toBeCloseTo(40, 1)
    })

    it('should recover the z position within the tier quantization step', () => {
      expect(decoded.positionZ).toBeCloseTo(72, 1)
    })

    it('should recover the height within the tier quantization step', () => {
      expect(decoded.positionY).toBeCloseTo(10, 1)
    })
  })

  describe('when decoding a position on a negative parcel', () => {
    let decoded: ReturnType<typeof decodeCompressedMovement>

    beforeEach(() => {
      decoded = decodeCompressedMovement(
        encodeTemporalData({ tier: 0 }),
        encodeMovementData({ x: -100, y: 5, z: -260 }, { x: 0, y: 0, z: 0 }, 0),
        0,
        0
      )
    })

    it('should recover the negative x position', () => {
      expect(decoded.positionX).toBeCloseTo(-100, 1)
    })

    it('should recover the negative z position', () => {
      expect(decoded.positionZ).toBeCloseTo(-260, 1)
    })
  })

  describe('when decoding a packet encoded at tier 3', () => {
    let decoded: ReturnType<typeof decodeCompressedMovement>

    beforeEach(() => {
      decoded = decodeCompressedMovement(
        encodeTemporalData({ tier: 3 }),
        encodeMovementData({ x: 200, y: 30, z: 200 }, { x: 20, y: 0, z: -20 }, 3),
        0,
        0
      )
    })

    // Tier 3 is one of the two tiers that survive the wire, so this is the case
    // where sender and receiver genuinely agree.
    it('should recover the position with the tier-3 layout', () => {
      expect(decoded.positionX).toBeCloseTo(200, 0)
    })

    // Tier 3 spends 6 bits per axis, one of them the sign, so the magnitude
    // resolution is 50/31 ~ 1.61 per step. Asserting tighter than the format
    // can represent would be asserting against the codec, not the decoder.
    it('should recover a positive velocity component within one quantization step', () => {
      expect(Math.abs(decoded.velocityX - 20)).toBeLessThan(50 / 31)
    })

    it('should recover the sign of a negative velocity component', () => {
      expect(decoded.velocityZ).toBeLessThan(0)
    })
  })

  describe('when decoding a rotation', () => {
    // ROTATION_Y_BITS is 6, so yaw lands on a 360/63 ~ 5.71 degree grid.
    it('should recover the yaw within the 6-bit quantization step', () => {
      const decoded = decodeCompressedMovement(
        encodeTemporalData({ rotationY: 180, tier: 0 }),
        encodeMovementData({ x: 8, y: 0, z: 8 }, { x: 0, y: 0, z: 0 }, 0),
        0,
        0
      )
      expect(Math.abs(decoded.rotationY - 180)).toBeLessThan(360 / 63)
    })
  })

  describe('when decoding the animation bits', () => {
    it('should recover the grounded flag', () => {
      const decoded = decodeCompressedMovement(
        encodeTemporalData({ grounded: true, tier: 0 }),
        encodeMovementData({ x: 8, y: 0, z: 8 }, { x: 0, y: 0, z: 0 }, 0),
        0,
        0
      )
      expect(decoded.isGrounded).toBe(true)
    })
  })

  // These pin the upstream int32 overflow. They are NOT describing desirable
  // behaviour -- they exist so that if unity-explorer fixes the bit layout, this
  // decoder fails loudly here instead of silently producing wrong positions.
  describe('when the sender encodes a velocity tier', () => {
    describe('and the tier is 0', () => {
      it('should round-trip as tier 0', () => {
        expect(decodeVelocityTier(encodeTemporalData({ tier: 0 }))).toBe(0)
      })
    })

    describe('and the tier is 3', () => {
      it('should round-trip as tier 3', () => {
        expect(decodeVelocityTier(encodeTemporalData({ tier: 3 }))).toBe(3)
      })
    })

    describe('and the tier is 1', () => {
      // UPSTREAM BUG: tier occupies bits 31-32 of an int32, so the high bit is
      // lost on encode and C#'s arithmetic >> reads back 3.
      it('should decode as 3, reproducing the upstream overflow', () => {
        expect(decodeVelocityTier(encodeTemporalData({ tier: 1 }))).toBe(3)
      })
    })

    describe('and the tier is 2', () => {
      // UPSTREAM BUG: 2 << 31 overflows to 0, so this reads back as tier 0 --
      // and tier 2 is the ordinary moving case.
      it('should decode as 0, reproducing the upstream overflow', () => {
        expect(decodeVelocityTier(encodeTemporalData({ tier: 2 }))).toBe(0)
      })
    })
  })

  describe('when reading a packet whose movement data exceeds MAX_SAFE_INTEGER', () => {
    let movementData: bigint
    let words: ReturnType<typeof readCompressedMovement>

    beforeEach(() => {
      movementData = encodeMovementData({ x: 200, y: 150, z: 200 }, { x: 40, y: 40, z: 40 }, 3)
      words = readCompressedMovement(encodePacket({ temporalData: encodeTemporalData({ tier: 3 }), movementData }))
    })

    // The generated ts-proto decoder throws here (longToNumber rejects anything
    // above MAX_SAFE_INTEGER), which is why the words are read off the wire.
    it('should produce a value the generated decoder could not represent', () => {
      expect(movementData).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))
    })

    it('should read the full 64-bit value without losing precision', () => {
      expect(words!.movementData).toBe(movementData)
    })
  })

  describe('when reading a packet that carries something other than compressed movement', () => {
    it('should report no compressed movement', () => {
      // A Position packet (field 1).
      const writer = new Writer()
      writer.uint32((1 << 3) | 2).bytes(new Uint8Array([8, 1]))
      expect(readCompressedMovement(writer.finish())).toBeNull()
    })
  })
})

describe('comms transport compressed movement handling', () => {
  let transport: { events: ReturnType<typeof mitt<any>>; send: jest.Mock; connect: jest.Mock; disconnect: jest.Mock; setVoicePosition: jest.Mock }
  let wrapper: CommsTransportWrapper
  let received: Array<{ address: string; data: any }>

  beforeEach(() => {
    transport = {
      events: mitt<any>(),
      send: jest.fn(),
      connect: jest.fn(),
      disconnect: jest.fn(),
      setVoicePosition: jest.fn()
    }
    wrapper = new CommsTransportWrapper(transport as any, 'test-scene')
    received = []
    wrapper.events.on('movement', (event: any) => received.push(event))
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('when a peer sends a compressed movement packet', () => {
    beforeEach(() => {
      const packet = encodePacket({
        temporalData: encodeTemporalData({ tier: 3, rotationY: 90 }),
        movementData: encodeMovementData({ x: 200, y: 30, z: 200 }, { x: 0, y: 0, z: 0 }, 3)
      })
      transport.events.emit('message', { address: '0xpeer', data: packet })
    })

    // Before this, the packet failed to decode entirely (int64 over
    // MAX_SAFE_INTEGER) and the peer was invisible.
    it('should emit it as a movement event', () => {
      expect(received).toHaveLength(1)
    })

    it('should carry the decoded position', () => {
      expect(received[0].data.positionX).toBeCloseTo(200, 0)
    })

    it('should attribute it to the sending peer', () => {
      expect(received[0].address).toBe('0xpeer')
    })
  })

  describe('when a peer sends a malformed compressed movement packet', () => {
    beforeEach(() => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined)
      // Field 12 declared as length-delimited, but the length runs past the end.
      transport.events.emit('message', { address: '0xpeer', data: new Uint8Array([(12 << 3) | 2, 40, 1, 2]) })
    })

    it('should not emit a movement event', () => {
      expect(received).toHaveLength(0)
    })
  })
})
