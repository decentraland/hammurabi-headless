import { Reader } from 'protobufjs/minimal'
import { Movement, Movement_GlideState } from '@dcl/protocol/out-js/decentraland/kernel/comms/rfc4/comms.gen'

/**
 * Decoder for rfc4 `MovementCompressed`, the bit-packed movement format the
 * reference client sends when the `multiplayer-compression-*` feature flag is
 * on. Without this, every peer on a compressed build is invisible: the packet
 * is not just unhandled, it fails to decode at all (see readCompressedMovement).
 *
 * Everything here mirrors `NetworkMessageEncoder` + `MessageEncodingSettings`
 * in unity-explorer, including the constants that live in a ScriptableObject
 * asset rather than in code. Those are configuration on the sending side, so
 * they are duplicated here by necessity — if the shipped asset changes, this
 * decoder silently produces wrong positions and must be updated with it.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ UPSTREAM BUG — DELIBERATELY REPRODUCED                                     │
 * │                                                                            │
 * │ temporalData is an int32 and the field layout runs one bit past it:        │
 * │                                                                            │
 * │   timestamp 0-14 | movementKind 15-16 | sliding 17 | stunned 18 |          │
 * │   grounded 19 | jumpCount 20-21 | longJump 22 | falling 23 |               │
 * │   longFall 24 | rotationY 25-30 | tier 31-32   <-- 33 bits                 │
 * │                                                                            │
 * │ So `tier << 31` loses its high bit on encode, and C#'s ARITHMETIC `>>`     │
 * │ makes `(temporalData >> 31) & 0b11` yield only 0 or 3. With                │
 * │ VelocityTiers = [0.001, 2, 12], tier 2 is the ordinary "moving" case and   │
 * │ it decodes as tier 0 — packed with XZ_BITS 8 / MAX_VELOCITY 12, unpacked   │
 * │ with XZ_BITS 10 / MAX_VELOCITY 4.                                          │
 * │                                                                            │
 * │ We reproduce it exactly. Agreeing with what the sender actually put on the │
 * │ wire beats being independently correct: a "fixed" decoder here would       │
 * │ disagree with every real client instead of matching them. When upstream    │
 * │ fixes the layout this decoder MUST change with it — `decodeVelocityTier`   │
 * │ is where, and its spec pins the current behaviour so the break is loud.    │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

// --- MessageEncodingSettings (code constants) ---
const PARCEL_BITS = 17
const TWO_BITS_MASK = 0b11
const TIMESTAMP_BITS = 15
const ROTATION_Y_BITS = 6
const MOVEMENT_KIND_BITS = 2

// Derived bit offsets, in the same order the reference computes them.
const MOVEMENT_KIND_START_BIT = TIMESTAMP_BITS
const SLIDING_BIT = MOVEMENT_KIND_START_BIT + MOVEMENT_KIND_BITS
const STUNNED_BIT = SLIDING_BIT + 1
const GROUNDED_BIT = STUNNED_BIT + 1
const JUMP_COUNT_BIT = GROUNDED_BIT + 1
const LONG_JUMP_BIT = JUMP_COUNT_BIT + 2
const FALLING_BIT = LONG_JUMP_BIT + 1
const LONG_FALL_BIT = FALLING_BIT + 1
const ROTATION_START_BIT = LONG_FALL_BIT + 1
export const TIER_START_BIT = ROTATION_START_BIT + ROTATION_Y_BITS // 31 — see the note above

// --- MessageEncodingSettings.asset (serialized values) ---
type TierConfig = { xzBits: number; yMax: number; yBits: number; maxVelocity: number; velocityBits: number }

const TIER_CONFIGS: readonly TierConfig[] = [
  { xzBits: 10, yMax: 200, yBits: 13, maxVelocity: 4, velocityBits: 4 },
  { xzBits: 10, yMax: 200, yBits: 13, maxVelocity: 4, velocityBits: 4 },
  { xzBits: 8, yMax: 200, yBits: 13, maxVelocity: 12, velocityBits: 6 },
  { xzBits: 8, yMax: 200, yBits: 13, maxVelocity: 50, velocityBits: 6 }
]

// --- ParcelEncoder (GenesisCityData + TerrainData.asset borderPadding) ---
const PARCEL_SIZE = 16
const BORDER_PADDING = 2
const MIN_PARCEL_X = -150 - BORDER_PADDING
const MIN_PARCEL_Y = -150 - BORDER_PADDING
const MAX_PARCEL_X = 163 + BORDER_PADDING
const PARCEL_GRID_WIDTH = MAX_PARCEL_X - MIN_PARCEL_X + 1

/** FloatQuantizer.Decompress: a fixed-point value back to its float range. */
function dequantize(compressed: number, minValue: number, maxValue: number, sizeInBits: number): number {
  const maxStep = (1 << sizeInBits) - 1
  return (compressed / maxStep) * (maxValue - minValue) + minValue
}

/** The velocity codec keeps the sign in bit 0 and the magnitude above it. */
function dequantizeVelocity(compressed: number, range: number, sizeInBits: number): number {
  const negative = (compressed & 1) === 1
  const magnitude = dequantize(compressed >> 1, 0, range, sizeInBits - 1)
  return negative ? -magnitude : magnitude
}

/**
 * The tier the SENDER's config cannot survive the wire. Reproduces the upstream
 * overflow exactly — see the module header.
 *
 * `| 0` forces int32 semantics so JS's `>>` sign-extends the way C#'s does on an
 * `int`; without it a value decoded as a positive number above 2^31 would shift
 * as an unsigned quantity and yield a different tier.
 */
export function decodeVelocityTier(temporalData: number): number {
  return ((temporalData | 0) >> TIER_START_BIT) & TWO_BITS_MASK
}

const HEAD_ROTATION_BITS = 6
const POINT_AT_AXIS_BITS = 10
const POINT_AT_MAX_DISTANCE = 1000

/** Point-at axes are stored sqrt-companded, so precision is finest up close. */
function dequantizePointAtAxis(compressed: number): number {
  const negative = (compressed & 1) === 1
  const maxStep = (1 << (POINT_AT_AXIS_BITS - 1)) - 1
  const sqrtNormalized = (compressed >> 1) / maxStep
  const value = sqrtNormalized * sqrtNormalized * POINT_AT_MAX_DISTANCE
  return negative ? -value : value
}

export type DecodedMovement = Movement

/**
 * Decodes the four packed words into the same shape the uncompressed rfc4
 * `Movement` carries, so both formats feed one code path downstream.
 *
 * `movementData` is a BigInt because the packed value occupies up to 64 bits —
 * see readCompressedMovement for why it never arrives as a JS number.
 */
export function decodeCompressedMovement(
  temporalData: number,
  movementData: bigint,
  headSyncData: number,
  pointAtData: number
): DecodedMovement {
  const tier = decodeVelocityTier(temporalData)
  const config = TIER_CONFIGS[tier] ?? TIER_CONFIGS[0]

  const { xzBits, yBits, yMax, maxVelocity, velocityBits } = config

  // Every field is masked immediately after its shift, which makes an unsigned
  // BigInt shift equivalent to C#'s arithmetic shift on a signed long — the
  // sign-extended high bits are masked away either way. That equivalence is
  // what lets this read the top field (velocityZ occupies bits 58-63 on tiers
  // 2 and 3) without caring how the varint's sign bit was interpreted.
  const readField = (offset: number, bits: number): number =>
    Number((movementData >> BigInt(offset)) & ((1n << BigInt(bits)) - 1n))

  const parcelIndex = readField(0, PARCEL_BITS)
  // ParcelEncoder.Decode: a row-major index over the padded Genesis City grid.
  const parcelX = (parcelIndex % PARCEL_GRID_WIDTH) + MIN_PARCEL_X
  const parcelY = Math.floor(parcelIndex / PARCEL_GRID_WIDTH) + MIN_PARCEL_Y

  let offset = PARCEL_BITS
  const rawX = readField(offset, xzBits)
  offset += xzBits
  const rawZ = readField(offset, xzBits)
  offset += xzBits
  const rawY = readField(offset, yBits)
  offset += yBits
  const rawVelocityX = readField(offset, velocityBits)
  offset += velocityBits
  const rawVelocityY = readField(offset, velocityBits)
  offset += velocityBits
  const rawVelocityZ = readField(offset, velocityBits)

  // X/Z are stored relative to the parcel origin; Y is absolute.
  const localX = dequantize(rawX, 0, PARCEL_SIZE, xzBits)
  const localZ = dequantize(rawZ, 0, PARCEL_SIZE, xzBits)

  const rotationMask = (1 << ROTATION_Y_BITS) - 1
  const compressedRotation = ((temporalData | 0) >> ROTATION_START_BIT) & rotationMask

  const temporal = temporalData | 0
  const bit = (offset: number) => (temporal & (1 << offset)) !== 0

  // Head sync: pitch in the low bits, then yaw, then the two enable flags.
  const headRotationMask = (1 << HEAD_ROTATION_BITS) - 1
  const headSync = headSyncData | 0
  const headPitchRaw = headSync & headRotationMask
  const headYawRaw = (headSync >> HEAD_ROTATION_BITS) & headRotationMask
  const headIkPitchEnabled = ((headSync >> (HEAD_ROTATION_BITS * 2)) & 1) !== 0
  const headIkYawEnabled = ((headSync >> (HEAD_ROTATION_BITS * 2 + 1)) & 1) !== 0

  // Point-at: three sqrt-companded axes RELATIVE to the player, plus a flag in
  // bit 30. The reference re-adds the player position on decode, so the wire
  // values are offsets and the absolute point is derived below.
  const pointAt = pointAtData | 0
  const isPointingAt = (pointAt & (1 << 30)) !== 0
  const pointAtAxisMask = (1 << POINT_AT_AXIS_BITS) - 1
  const relativePointAtX = isPointingAt ? dequantizePointAtAxis(pointAt & pointAtAxisMask) : 0
  const relativePointAtY = isPointingAt ? dequantizePointAtAxis((pointAt >> POINT_AT_AXIS_BITS) & pointAtAxisMask) : 0
  const relativePointAtZ = isPointingAt
    ? dequantizePointAtAxis((pointAt >> (POINT_AT_AXIS_BITS * 2)) & pointAtAxisMask)
    : 0

  const positionX = parcelX * PARCEL_SIZE + localX
  const positionY = dequantize(rawY, 0, yMax, yBits)
  const positionZ = parcelY * PARCEL_SIZE + localZ

  return {
    positionX,
    positionY,
    positionZ,
    isGrounded: bit(GROUNDED_BIT),
    jumpCount: (temporal >> JUMP_COUNT_BIT) & TWO_BITS_MASK,
    isLongJump: bit(LONG_JUMP_BIT),
    isFalling: bit(FALLING_BIT),
    isLongFall: bit(LONG_FALL_BIT),
    isStunned: bit(STUNNED_BIT),
    // Blend values are deliberately not on the wire; the reference resets them
    // to 0 on decode and derives the blend locally from the velocity.
    movementBlendValue: 0,
    slideBlendValue: 0,
    // Not carried by the compressed format at all.
    isJumping: false,
    glideState: Movement_GlideState.PROP_CLOSED,
    isInstant: false,
    isEmoting: false,
    headIkYawEnabled,
    headIkPitchEnabled,
    headYaw: dequantize(headYawRaw, 0, 360, HEAD_ROTATION_BITS),
    headPitch: dequantize(headPitchRaw, 0, 360, HEAD_ROTATION_BITS),
    pointAtX: positionX + relativePointAtX,
    pointAtY: positionY + relativePointAtY,
    pointAtZ: positionZ + relativePointAtZ,
    isPointingAt,
    // The raw circular-buffer timestamp, WITHOUT the reference's wraparound
    // correction: that correction is stateful and, upstream, the state is shared
    // across every peer on the bus rather than kept per sender. Nothing here
    // consumes the timestamp (the avatar system reads position and rotation
    // only), so carrying the uncorrected value beats reproducing shared mutable
    // state whose behaviour depends on peer interleaving.
    timestamp: (temporalData | 0) & ((1 << TIMESTAMP_BITS) - 1),
    velocityX: dequantizeVelocity(rawVelocityX, maxVelocity, velocityBits),
    velocityY: dequantizeVelocity(rawVelocityY, maxVelocity, velocityBits),
    velocityZ: dequantizeVelocity(rawVelocityZ, maxVelocity, velocityBits),
    rotationY: dequantize(compressedRotation, 0, 360, ROTATION_Y_BITS)
  }
}

// Packet.message oneof field number for MovementCompressed (comms.proto).
const PACKET_FIELD_MOVEMENT_COMPRESSED = 12
// MovementCompressed field numbers.
const FIELD_TEMPORAL_DATA = 1
const FIELD_MOVEMENT_DATA = 2
const FIELD_HEAD_SYNC_DATA = 3
const FIELD_POINT_AT_DATA = 4

const WIRE_TYPE_VARINT = 0
const WIRE_TYPE_LENGTH_DELIMITED = 2

export type CompressedMovementWords = {
  temporalData: number
  movementData: bigint
  headSyncData: number
  pointAtData: number
}

/**
 * Extracts a MovementCompressed payload from a raw rfc4 packet, or null when the
 * packet carries something else.
 *
 * This exists because the GENERATED decoder cannot read these packets at all.
 * `movementData` is an `int64` and ts-proto maps it through `longToNumber`,
 * which THROWS above `Number.MAX_SAFE_INTEGER`:
 *
 *   if (long.gt(Number.MAX_SAFE_INTEGER)) throw new Error("Value is larger …")
 *
 * The packed value uses 62 bits on tiers 0/1 and 64 on tiers 2/3, so a real
 * packet is over 2^53 the moment a peer is anywhere but the world origin at
 * rest. `Packet.decode` therefore throws for the whole packet — which is why
 * these show up as decode failures rather than as an unhandled oneof case, and
 * why each one costs a log line. Values that DO squeak under 2^53 are worse:
 * they decode to a float64 that has silently lost its low bits.
 *
 * So the words are read straight off the wire, with `movementData` kept as a
 * BigInt. Deliberately a minimal scan rather than a general parser: it walks
 * only the top level, and only far enough to find field 12.
 */
export function readCompressedMovement(bytes: Uint8Array): CompressedMovementWords | null {
  const reader = new Reader(bytes)

  while (reader.pos < reader.len) {
    const tag = reader.uint32()
    const fieldNumber = tag >>> 3
    const wireType = tag & 7

    if (fieldNumber === PACKET_FIELD_MOVEMENT_COMPRESSED && wireType === WIRE_TYPE_LENGTH_DELIMITED) {
      return readWords(reader.bytes())
    }

    reader.skipType(wireType)
  }

  return null
}

function readWords(bytes: Uint8Array): CompressedMovementWords {
  const reader = new Reader(bytes)
  const words: CompressedMovementWords = {
    temporalData: 0,
    movementData: 0n,
    headSyncData: 0,
    pointAtData: 0
  }

  while (reader.pos < reader.len) {
    const tag = reader.uint32()
    const fieldNumber = tag >>> 3
    const wireType = tag & 7

    if (wireType !== WIRE_TYPE_VARINT) {
      reader.skipType(wireType)
      continue
    }

    switch (fieldNumber) {
      case FIELD_TEMPORAL_DATA:
        words.temporalData = reader.int32()
        break
      case FIELD_MOVEMENT_DATA: {
        // Read as a Long and widen losslessly. `int64()` returns protobufjs's
        // Long (high/low int32 pair); `>>> 0` makes the low half unsigned before
        // it is combined, otherwise a low half with bit 31 set would contribute
        // a negative value.
        const value = reader.int64() as unknown as { low: number; high: number }
        words.movementData = (BigInt(value.high >>> 0) << 32n) | BigInt(value.low >>> 0)
        break
      }
      case FIELD_HEAD_SYNC_DATA:
        words.headSyncData = reader.int32()
        break
      case FIELD_POINT_AT_DATA:
        words.pointAtData = reader.int32()
        break
      default:
        reader.skipType(wireType)
    }
  }

  return words
}
