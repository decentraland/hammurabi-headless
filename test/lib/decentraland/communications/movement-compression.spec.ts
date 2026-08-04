import mitt from 'mitt'
import { Reader, Writer } from 'protobufjs/minimal'
import {
  decodeCompressedMovement,
  decodeVelocityTier,
  readCompressedMovement
} from '../../../../src/lib/decentraland/communications/movement-compression'
import { CommsTransportWrapper } from '../../../../src/lib/decentraland/communications/CommsTransportWrapper'

// The decoder mirrors unity-explorer's NetworkMessageEncoder bit for bit, so the
// tests carry a matching ENCODER and round-trip through it. Encoding by hand is
// the only way to prove the layout: a decoder tested against its own output
// would agree with itself no matter which bits it read. For the same reason the
// bit offsets below are written out as literals rather than imported from the
// module under test — a mutation to either side has to break a test.

const PARCEL_SIZE = 16
const PARCEL_BITS = 17
const MIN_PARCEL = -152
const GRID_WIDTH = 165 - MIN_PARCEL + 1
const TIMESTAMP_BITS = 15
const TIMESTAMP_QUANTUM = 0.02
const SLIDING_BIT = 17
const STUNNED_BIT = 18
const GROUNDED_BIT = 19
const JUMP_COUNT_BIT = 20
const LONG_JUMP_BIT = 22
const FALLING_BIT = 23
const LONG_FALL_BIT = 24
const ROTATION_START_BIT = 25
const ROTATION_Y_BITS = 6
const TIER_START_BIT = 31
const HEAD_ROTATION_BITS = 6
const HEAD_PITCH_ENABLED_BIT = HEAD_ROTATION_BITS * 2
const HEAD_YAW_ENABLED_BIT = HEAD_ROTATION_BITS * 2 + 1
const POINT_AT_AXIS_BITS = 10
const POINT_AT_MAX_DISTANCE = 1000
const POINT_AT_FLAG_BIT = 30

const TIER_CONFIGS = [
  { xzBits: 10, yMax: 200, yBits: 13, maxVelocity: 4, velocityBits: 4 },
  { xzBits: 10, yMax: 200, yBits: 13, maxVelocity: 4, velocityBits: 4 },
  { xzBits: 8, yMax: 200, yBits: 13, maxVelocity: 12, velocityBits: 6 },
  { xzBits: 8, yMax: 200, yBits: 13, maxVelocity: 50, velocityBits: 6 }
]

/** Mathf.RoundToInt is banker's rounding, not Math.round's half-away-from-zero. */
function roundToInt(value: number): number {
  const floor = Math.floor(value)
  const fraction = value - floor
  if (fraction > 0.5) return floor + 1
  if (fraction < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

function quantize(value: number, minValue: number, maxValue: number, sizeInBits: number): number {
  const maxStep = (1 << sizeInBits) - 1
  const normalized = (value - minValue) / (maxValue - minValue)
  return roundToInt(Math.min(Math.max(normalized, 0), 1) * maxStep)
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

  // The sender zeroes a velocity below the safe zone before quantizing it, so a
  // decoder tested with a tiny velocity must be tested against zero, not against
  // the value that was passed in. SAFE_ZONE is compared against the SQUARED
  // magnitude upstream.
  const SAFE_ZONE = 0.05
  const sqrMagnitude = velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z
  const effective = sqrMagnitude < SAFE_ZONE ? { x: 0, y: 0, z: 0 } : velocity

  const vx = quantizeVelocity(effective.x, maxVelocity, velocityBits)
  const vy = quantizeVelocity(effective.y, maxVelocity, velocityBits)
  const vz = quantizeVelocity(effective.z, maxVelocity, velocityBits)

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

type TemporalOptions = {
  timestampTicks?: number
  rotationY?: number
  tier?: number
  sliding?: boolean
  stunned?: boolean
  grounded?: boolean
  jumpCount?: number
  longJump?: boolean
  falling?: boolean
  longFall?: boolean
}

/** Mirrors NetworkMessageEncoder.CompressTemporalData, overflow included. */
function encodeTemporalData(options: TemporalOptions = {}): number {
  let temporal = (options.timestampTicks ?? 0) & ((1 << TIMESTAMP_BITS) - 1)
  if (options.sliding) temporal |= 1 << SLIDING_BIT
  if (options.stunned) temporal |= 1 << STUNNED_BIT
  if (options.grounded) temporal |= 1 << GROUNDED_BIT
  temporal |= ((options.jumpCount ?? 0) & 0b11) << JUMP_COUNT_BIT
  if (options.longJump) temporal |= 1 << LONG_JUMP_BIT
  if (options.falling) temporal |= 1 << FALLING_BIT
  if (options.longFall) temporal |= 1 << LONG_FALL_BIT
  temporal |= quantize(options.rotationY ?? 0, 0, 360, ROTATION_Y_BITS) << ROTATION_START_BIT
  // `<< 31` on an int32 is exactly what upstream does, high bit and all.
  temporal |= ((options.tier ?? 0) & 0b11) << TIER_START_BIT
  return temporal | 0
}

/** Mirrors NetworkMessageEncoder.CompressHeadSyncData. */
function encodeHeadSyncData(options: {
  yawEnabled?: boolean
  pitchEnabled?: boolean
  yaw?: number
  pitch?: number
}): number {
  if (!options.yawEnabled && !options.pitchEnabled) return 0
  const yaw = quantize(options.yaw ?? 0, 0, 360, HEAD_ROTATION_BITS)
  const pitch = quantize(options.pitch ?? 0, 0, 360, HEAD_ROTATION_BITS)
  let value = pitch
  value |= yaw << HEAD_ROTATION_BITS
  if (options.pitchEnabled) value |= 1 << HEAD_PITCH_ENABLED_BIT
  if (options.yawEnabled) value |= 1 << HEAD_YAW_ENABLED_BIT
  return value
}

/** Mirrors NetworkMessageEncoder.CompressPointAtAxis: sqrt-companded, sign in bit 0. */
function encodePointAtAxis(value: number): number {
  const maxStep = (1 << (POINT_AT_AXIS_BITS - 1)) - 1
  const absNormalized = Math.min(Math.abs(value) / POINT_AT_MAX_DISTANCE, 1)
  const compressed = roundToInt(Math.sqrt(absNormalized) * maxStep)
  return (compressed << 1) | (value < 0 ? 1 : 0)
}

/**
 * The point-at step size at a given distance. The axes are sqrt-companded, so
 * resolution is finest up close and coarsens with distance: asserting a fixed
 * tolerance would either be unachievable far out or slack close in.
 */
function pointAtQuantizationStep(distance: number): number {
  const maxStep = (1 << (POINT_AT_AXIS_BITS - 1)) - 1
  return (2 * Math.sqrt(Math.abs(distance) * POINT_AT_MAX_DISTANCE)) / maxStep
}

/** Mirrors NetworkMessageEncoder.CompressPointAtData. The axes are RELATIVE to the player. */
function encodePointAtData(relative: { x: number; y: number; z: number } | null): number {
  if (!relative) return 0
  let value = encodePointAtAxis(relative.x)
  value |= encodePointAtAxis(relative.y) << POINT_AT_AXIS_BITS
  value |= encodePointAtAxis(relative.z) << (POINT_AT_AXIS_BITS * 2)
  value |= 1 << POINT_AT_FLAG_BIT
  return value
}

type Words = {
  temporalData: number
  movementData: bigint
  headSyncData?: number
  pointAtData?: number
}

/** The MovementCompressed submessage body (the payload of Packet field 12). */
function encodeMovementCompressed(words: Words): Uint8Array {
  const inner = new Writer()
  inner.uint32(8).int32(words.temporalData)
  inner.uint32(16).int64(words.movementData.toString())
  inner.uint32(24).int32(words.headSyncData ?? 0)
  inner.uint32(32).int32(words.pointAtData ?? 0)
  return inner.finish()
}

/** Builds a full rfc4 Packet carrying a MovementCompressed (field 12). */
function encodePacket(words: Words): Uint8Array {
  const outer = new Writer()
  // field 12, wire type 2
  outer.uint32((12 << 3) | 2).bytes(encodeMovementCompressed(words))
  return outer.finish()
}

/** A Packet field 1 (Position) carrying only `index = 1`. */
function writePositionField(writer: Writer): Writer {
  return writer.uint32((1 << 3) | 2).bytes(new Uint8Array([8, 1]))
}

function writeMovementCompressedField(writer: Writer, words: Words): Writer {
  return writer.uint32((12 << 3) | 2).bytes(encodeMovementCompressed(words))
}

/** A packet whose words are all zero except the parcel index, for identity checks. */
function wordsWithParcel(parcelIndex: number): Words {
  return { temporalData: encodeTemporalData({ tier: 0 }), movementData: BigInt(parcelIndex) }
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
    let decoded: ReturnType<typeof decodeCompressedMovement>

    beforeEach(() => {
      decoded = decodeCompressedMovement(
        encodeTemporalData({ rotationY: 180, tier: 0 }),
        encodeMovementData({ x: 8, y: 0, z: 8 }, { x: 0, y: 0, z: 0 }, 0),
        0,
        0
      )
    })

    // ROTATION_Y_BITS is 6, so yaw lands on a 360/63 ~ 5.71 degree grid.
    it('should recover the yaw within the 6-bit quantization step', () => {
      expect(Math.abs(decoded.rotationY - 180)).toBeLessThan(360 / 63)
    })
  })

  describe('when decoding the animation bits', () => {
    describe('and the peer is grounded, stunned and mid double jump', () => {
      let decoded: ReturnType<typeof decodeCompressedMovement>

      beforeEach(() => {
        decoded = decodeCompressedMovement(
          encodeTemporalData({
            tier: 0,
            grounded: true,
            stunned: true,
            jumpCount: 2,
            longJump: true,
            falling: true,
            longFall: false
          }),
          encodeMovementData({ x: 8, y: 0, z: 8 }, { x: 0, y: 0, z: 0 }, 0),
          0,
          0
        )
      })

      it('should recover the grounded flag', () => {
        expect(decoded.isGrounded).toBe(true)
      })

      it('should recover the stunned flag', () => {
        expect(decoded.isStunned).toBe(true)
      })

      it('should recover the jump count', () => {
        expect(decoded.jumpCount).toBe(2)
      })

      it('should recover the long jump flag', () => {
        expect(decoded.isLongJump).toBe(true)
      })

      it('should recover the falling flag', () => {
        expect(decoded.isFalling).toBe(true)
      })

      // Set apart from `isFalling`: the two live in adjacent bits, so a test
      // that only ever sees them agree cannot tell them apart.
      it('should report the peer as not in a long fall', () => {
        expect(decoded.isLongFall).toBe(false)
      })
    })

    describe('and the peer is in a long fall but not falling', () => {
      let decoded: ReturnType<typeof decodeCompressedMovement>

      beforeEach(() => {
        decoded = decodeCompressedMovement(
          encodeTemporalData({ tier: 0, falling: false, longFall: true }),
          encodeMovementData({ x: 8, y: 0, z: 8 }, { x: 0, y: 0, z: 0 }, 0),
          0,
          0
        )
      })

      it('should recover the long fall flag', () => {
        expect(decoded.isLongFall).toBe(true)
      })

      it('should report the peer as not falling', () => {
        expect(decoded.isFalling).toBe(false)
      })
    })

    describe('and no animation bit is set', () => {
      let decoded: ReturnType<typeof decodeCompressedMovement>

      beforeEach(() => {
        decoded = decodeCompressedMovement(
          encodeTemporalData({ tier: 0 }),
          encodeMovementData({ x: 8, y: 0, z: 8 }, { x: 0, y: 0, z: 0 }, 0),
          0,
          0
        )
      })

      it('should report the peer as not grounded', () => {
        expect(decoded.isGrounded).toBe(false)
      })

      it('should report a jump count of zero', () => {
        expect(decoded.jumpCount).toBe(0)
      })
    })
  })

  // TimestampEncoder.Decompress scales the tick count by TIMESTAMP_QUANTUM, and
  // the uncompressed rfc4 Movement carries seconds, so raw ticks here would make
  // one protobuf field mean two different things.
  describe('when decoding the timestamp', () => {
    let decoded: ReturnType<typeof decodeCompressedMovement>

    beforeEach(() => {
      decoded = decodeCompressedMovement(
        encodeTemporalData({ tier: 0, timestampTicks: 1000 }),
        encodeMovementData({ x: 8, y: 0, z: 8 }, { x: 0, y: 0, z: 0 }, 0),
        0,
        0
      )
    })

    it('should report the tick count scaled into seconds', () => {
      expect(decoded.timestamp).toBeCloseTo(1000 * TIMESTAMP_QUANTUM, 6)
    })
  })

  describe('when decoding head sync data', () => {
    describe('and only yaw is enabled', () => {
      let decoded: ReturnType<typeof decodeCompressedMovement>

      beforeEach(() => {
        // Yaw and pitch differ so that reading one for the other is visible, and
        // the two enable flags differ for the same reason.
        decoded = decodeCompressedMovement(
          encodeTemporalData({ tier: 0 }),
          encodeMovementData({ x: 8, y: 0, z: 8 }, { x: 0, y: 0, z: 0 }, 0),
          encodeHeadSyncData({ yawEnabled: true, pitchEnabled: false, yaw: 180, pitch: 90 }),
          0
        )
      })

      // HEAD_ROTATION_BITS is 6, so head angles land on the same 360/63 grid as
      // the body yaw.
      it('should recover the head yaw within the 6-bit quantization step', () => {
        expect(Math.abs(decoded.headYaw - 180)).toBeLessThan(360 / 63)
      })

      it('should recover the head pitch within the 6-bit quantization step', () => {
        expect(Math.abs(decoded.headPitch - 90)).toBeLessThan(360 / 63)
      })

      it('should report yaw IK as enabled', () => {
        expect(decoded.headIkYawEnabled).toBe(true)
      })

      it('should report pitch IK as disabled', () => {
        expect(decoded.headIkPitchEnabled).toBe(false)
      })
    })

    describe('and only pitch is enabled', () => {
      let decoded: ReturnType<typeof decodeCompressedMovement>

      beforeEach(() => {
        decoded = decodeCompressedMovement(
          encodeTemporalData({ tier: 0 }),
          encodeMovementData({ x: 8, y: 0, z: 8 }, { x: 0, y: 0, z: 0 }, 0),
          encodeHeadSyncData({ yawEnabled: false, pitchEnabled: true, yaw: 180, pitch: 90 }),
          0
        )
      })

      it('should report pitch IK as enabled', () => {
        expect(decoded.headIkPitchEnabled).toBe(true)
      })

      it('should report yaw IK as disabled', () => {
        expect(decoded.headIkYawEnabled).toBe(false)
      })
    })

    describe('and head sync is disabled', () => {
      let decoded: ReturnType<typeof decodeCompressedMovement>

      beforeEach(() => {
        // The sender sends a zero word when neither axis is enabled.
        decoded = decodeCompressedMovement(
          encodeTemporalData({ tier: 0 }),
          encodeMovementData({ x: 8, y: 0, z: 8 }, { x: 0, y: 0, z: 0 }, 0),
          encodeHeadSyncData({}),
          0
        )
      })

      it('should report yaw IK as disabled', () => {
        expect(decoded.headIkYawEnabled).toBe(false)
      })

      it('should report pitch IK as disabled', () => {
        expect(decoded.headIkPitchEnabled).toBe(false)
      })
    })
  })

  describe('when decoding point-at data', () => {
    describe('and the peer is pointing at something', () => {
      let decoded: ReturnType<typeof decodeCompressedMovement>

      beforeEach(() => {
        // The wire carries the hit point RELATIVE to the player, so the
        // assertions below subtract the decoded position back out. The three
        // axes differ in magnitude and sign so that a swapped or mis-shifted
        // axis cannot pass.
        decoded = decodeCompressedMovement(
          encodeTemporalData({ tier: 0 }),
          encodeMovementData({ x: 40, y: 10, z: 72 }, { x: 0, y: 0, z: 0 }, 0),
          0,
          encodePointAtData({ x: 100, y: -20, z: 250 })
        )
      })

      it('should report the peer as pointing', () => {
        expect(decoded.isPointingAt).toBe(true)
      })

      // 10 bits per axis, one of them the sign, sqrt-companded against a 1000m
      // range: ~1.2m of resolution at 100m out.
      it('should recover the x offset of the hit point', () => {
        expect(Math.abs(decoded.pointAtX - decoded.positionX - 100)).toBeLessThan(pointAtQuantizationStep(100))
      })

      it('should recover the negative y offset of the hit point', () => {
        expect(Math.abs(decoded.pointAtY - decoded.positionY + 20)).toBeLessThan(pointAtQuantizationStep(20))
      })

      it('should recover the far z offset of the hit point', () => {
        expect(Math.abs(decoded.pointAtZ - decoded.positionZ - 250)).toBeLessThan(pointAtQuantizationStep(250))
      })
    })

    describe('and the peer is not pointing at anything', () => {
      let decoded: ReturnType<typeof decodeCompressedMovement>

      beforeEach(() => {
        decoded = decodeCompressedMovement(
          encodeTemporalData({ tier: 0 }),
          encodeMovementData({ x: 40, y: 10, z: 72 }, { x: 0, y: 0, z: 0 }, 0),
          0,
          encodePointAtData(null)
        )
      })

      it('should report the peer as not pointing', () => {
        expect(decoded.isPointingAt).toBe(false)
      })

      it('should collapse the hit point onto the player position', () => {
        expect(decoded.pointAtX).toBe(decoded.positionX)
      })
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
    // A literal rather than an encoded position, because the value has to have
    // BIT 31 OF ITS LOW HALF SET: that is the bit protobufjs hands back as a
    // negative int32, and the only thing that catches a missing `>>> 0`.
    // Roughly half of all real positions set it.
    const movementData = 2928077808352636985n
    let words: ReturnType<typeof readCompressedMovement>

    beforeEach(() => {
      words = readCompressedMovement(encodePacket({ temporalData: encodeTemporalData({ tier: 3 }), movementData }))
    })

    // The generated ts-proto decoder throws here (longToNumber rejects anything
    // above MAX_SAFE_INTEGER), which is why the words are read off the wire.
    it('should be a value the generated decoder could not represent', () => {
      expect(movementData).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))
    })

    it('should have bit 31 set in its low half', () => {
      expect((movementData & 0xffffffffn) >> 31n).toBe(1n)
    })

    it('should read the full 64-bit value without losing precision', () => {
      expect(words!.movementData).toBe(movementData)
    })
  })

  describe('when protobufjs decodes int64 as a plain number instead of a Long', () => {
    let read: () => unknown

    beforeEach(() => {
      // This is what an esbuild bundle does to protobufjs: `util.Long` is
      // discovered through `util.inquire`'s eval'd require, and without it
      // `int64` returns a number whose low bits are already gone.
      jest.spyOn(Reader.prototype, 'int64').mockReturnValue(1234 as any)
      read = () => readCompressedMovement(encodePacket({ temporalData: 0, movementData: 1234n }))
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    // The alternative is `undefined >>> 0`, which is 0: every peer decodes at
    // parcel index 0 and stands at world (-2432, 0, -2432) forever, silently.
    it('should throw rather than decode every peer to the world origin', () => {
      expect(read).toThrow(/util.Long is not configured/)
    })
  })

  describe('when reading a packet that carries something other than compressed movement', () => {
    let bytes: Uint8Array

    beforeEach(() => {
      bytes = writePositionField(new Writer()).finish()
    })

    it('should report no compressed movement', () => {
      expect(readCompressedMovement(bytes)).toBeNull()
    })
  })

  // A pre-filter that rejects what the parser behind it accepts silently drops
  // packets every reference client renders. These are the two tag shapes that
  // end ts-proto's decode loop cleanly but make protobufjs's skipType throw.
  describe('when reading a packet that ends with an end-group tag', () => {
    let bytes: Uint8Array

    beforeEach(() => {
      const writer = writePositionField(new Writer())
      writer.uint32((3 << 3) | 4)
      bytes = writer.finish()
    })

    it('should report no compressed movement instead of throwing', () => {
      expect(readCompressedMovement(bytes)).toBeNull()
    })
  })

  describe('when reading a packet that ends with a zero tag', () => {
    let bytes: Uint8Array

    beforeEach(() => {
      const writer = writePositionField(new Writer())
      writer.uint32(0)
      // Anything after a zero tag is unreachable for the generated decoder, so
      // it must be unreachable here too.
      writeMovementCompressedField(writer, wordsWithParcel(7))
      bytes = writer.finish()
    })

    it('should report no compressed movement, stopping where the generated decoder stops', () => {
      expect(readCompressedMovement(bytes)).toBeNull()
    })
  })

  describe('when reading a truncated packet', () => {
    let bytes: Uint8Array

    beforeEach(() => {
      // Field 12 declared as length-delimited, but the length runs past the end.
      bytes = new Uint8Array([(12 << 3) | 2, 40, 1, 2])
    })

    it('should report no compressed movement instead of throwing', () => {
      expect(readCompressedMovement(bytes)).toBeNull()
    })
  })

  // `Packet.message` is a oneof, and protobuf oneofs are last-wins.
  describe('when a packet carries compressed movement followed by another oneof field', () => {
    let bytes: Uint8Array

    beforeEach(() => {
      const writer = new Writer()
      writeMovementCompressedField(writer, wordsWithParcel(7))
      writePositionField(writer)
      bytes = writer.finish()
    })

    it('should report no compressed movement, because the later field wins', () => {
      expect(readCompressedMovement(bytes)).toBeNull()
    })
  })

  describe('when a packet carries another oneof field followed by compressed movement', () => {
    let bytes: Uint8Array

    beforeEach(() => {
      const writer = writePositionField(new Writer())
      writeMovementCompressedField(writer, wordsWithParcel(7))
      bytes = writer.finish()
    })

    it('should read the compressed movement, because it is the later field', () => {
      expect(readCompressedMovement(bytes)!.movementData).toBe(7n)
    })
  })

  describe('when a packet repeats the compressed movement field', () => {
    let bytes: Uint8Array

    beforeEach(() => {
      const writer = new Writer()
      writeMovementCompressedField(writer, wordsWithParcel(7))
      writeMovementCompressedField(writer, wordsWithParcel(9))
      bytes = writer.finish()
    })

    it('should read the last occurrence, as the generated decoder does', () => {
      expect(readCompressedMovement(bytes)!.movementData).toBe(9n)
    })
  })

  describe('when a packet carries compressed movement followed by a non-oneof field', () => {
    let bytes: Uint8Array

    beforeEach(() => {
      const writer = new Writer()
      writeMovementCompressedField(writer, wordsWithParcel(7))
      // Field 11 is `protocol_version`, outside the oneof: it cannot displace a
      // message, so the compressed movement still wins.
      writer.uint32((11 << 3) | 0).uint32(100)
      bytes = writer.finish()
    })

    it('should still read the compressed movement', () => {
      expect(readCompressedMovement(bytes)!.movementData).toBe(7n)
    })
  })
})

type TransportStub = {
  events: ReturnType<typeof mitt<any>>
  send: jest.Mock
  connect: jest.Mock
  disconnect: jest.Mock
  setVoicePosition: jest.Mock
}

function createTransportStub(): TransportStub {
  return {
    events: mitt<any>(),
    send: jest.fn(),
    connect: jest.fn(),
    disconnect: jest.fn(),
    setVoicePosition: jest.fn()
  }
}

describe('comms transport compressed movement handling', () => {
  let transport: TransportStub
  let wrapper: CommsTransportWrapper
  let received: Array<{ address: string; data: any }>
  let positions: Array<{ address: string; data: any }>

  beforeEach(() => {
    transport = createTransportStub()
    wrapper = new CommsTransportWrapper(transport as any, 'test-scene')
    received = []
    positions = []
    wrapper.events.on('movement', (event: any) => received.push(event))
    wrapper.events.on('position', (event: any) => positions.push(event))
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
    let errorSpy: jest.SpyInstance

    beforeEach(() => {
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
      // Field 12 declared as length-delimited, but the length runs past the end.
      transport.events.emit('message', { address: '0xpeer', data: new Uint8Array([(12 << 3) | 2, 40, 1, 2]) })
    })

    it('should not emit a movement event', () => {
      expect(received).toHaveLength(0)
    })

    // The pre-scan hands the packet back to Packet.decode, which reports it.
    it('should report it as a packet decode failure', () => {
      expect(errorSpy).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Failed to decode packet'))
    })
  })

  // REGRESSION: the pre-scan used to walk every field with skipType, which
  // throws on the two tag shapes that end the generated decoder cleanly. The
  // catch returned, so Packet.decode never ran and a packet every reference
  // client renders became invisible -- at the cost of a log line each.
  describe('when a peer sends a position packet ending with an end-group tag', () => {
    beforeEach(() => {
      const writer = writePositionField(new Writer())
      writer.uint32((3 << 3) | 4)
      transport.events.emit('message', { address: '0xpeer', data: writer.finish() })
    })

    it('should still emit the position event', () => {
      expect(positions).toHaveLength(1)
    })
  })

  describe('when a peer sends a position packet containing a zero tag', () => {
    beforeEach(() => {
      const writer = writePositionField(new Writer())
      writer.uint32(0)
      writeMovementCompressedField(writer, wordsWithParcel(7))
      transport.events.emit('message', { address: '0xpeer', data: writer.finish() })
    })

    it('should still emit the position event', () => {
      expect(positions).toHaveLength(1)
    })

    it('should not emit a movement event for the unreachable field', () => {
      expect(received).toHaveLength(0)
    })
  })

  // A packet whose compressed movement is displaced by a later oneof field must
  // be rendered the way every other client renders it.
  describe('when a peer sends compressed movement displaced by a later position field', () => {
    beforeEach(() => {
      const writer = new Writer()
      writeMovementCompressedField(writer, wordsWithParcel(7))
      writePositionField(writer)
      transport.events.emit('message', { address: '0xpeer', data: writer.finish() })
    })

    it('should emit the position event that the generated decoder produces', () => {
      expect(positions).toHaveLength(1)
    })

    it('should not emit a movement event', () => {
      expect(received).toHaveLength(0)
    })
  })

  describe('when a movement listener throws', () => {
    let throwingTransport: TransportStub
    let throwingWrapper: CommsTransportWrapper
    let errorSpy: jest.SpyInstance
    let secondListener: jest.Mock
    let packet: Uint8Array

    beforeEach(() => {
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
      throwingTransport = createTransportStub()
      throwingWrapper = new CommsTransportWrapper(throwingTransport as any, 'test-scene')
      secondListener = jest.fn()
      throwingWrapper.events.on('movement', () => {
        throw new Error('listener boom')
      })
      throwingWrapper.events.on('movement', secondListener)
      packet = encodePacket({
        temporalData: encodeTemporalData({ tier: 3 }),
        movementData: encodeMovementData({ x: 200, y: 30, z: 200 }, { x: 0, y: 0, z: 0 }, 3)
      })
    })

    it('should not let the throw escape the transport dispatch', () => {
      expect(() => throwingTransport.events.emit('message', { address: '0xpeer', data: packet })).not.toThrow()
    })

    // mitt calls listeners synchronously, so the remaining ones ARE aborted --
    // exactly like the pre-existing dispatch path. Pinned so the comment above
    // the catch cannot drift back into claiming otherwise.
    it('should abort the remaining movement listeners for that packet', () => {
      throwingTransport.events.emit('message', { address: '0xpeer', data: packet })
      expect(secondListener).not.toHaveBeenCalled()
    })

    // A listener bug reported as a decoder failure sends whoever reads the log
    // to the wrong file.
    it('should report it as a dispatch failure rather than a decode failure', () => {
      throwingTransport.events.emit('message', { address: '0xpeer', data: packet })
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to dispatch compressed movement from 0xpeer'),
        expect.anything()
      )
    })

    // The whole point of decoding these packets was to stop one peer costing a
    // log line per packet; a peer-driven error path must not reintroduce it.
    it('should log at most once for a burst from the same peer', () => {
      for (let index = 0; index < 50; index++) {
        throwingTransport.events.emit('message', { address: '0xpeer', data: packet })
      }
      expect(errorSpy).toHaveBeenCalledTimes(1)
    })
  })
})
