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
// MessageEncodingSettings.asset: seconds per timestamp tick.
const TIMESTAMP_QUANTUM = 0.02
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

// The seven packed fields of movementData, in wire order. Used to index the
// per-tier shift/mask table below.
const enum PackedField {
  ParcelIndex = 0,
  X = 1,
  Z = 2,
  Y = 3,
  VelocityX = 4,
  VelocityY = 5,
  VelocityZ = 6
}

type BitWindow = { shift: bigint; mask: bigint }

/**
 * Shifts and masks for every packed field, precomputed per tier.
 *
 * The layout is fixed by the tier config, so building `BigInt(offset)` and
 * `(1n << BigInt(bits)) - 1n` inside the decode path allocated two BigInts per
 * field on every packet, at ~30Hz per peer. Hoisting them is a ~2.6x saving on
 * the extraction (295ns -> 113ns for the six field reads) and, just as usefully,
 * keeps the layout derived from TIER_CONFIGS so the two cannot drift apart.
 */
const TIER_BIT_WINDOWS: readonly (readonly BitWindow[])[] = TIER_CONFIGS.map(
  ({ xzBits, yBits, velocityBits }): readonly BitWindow[] => {
    let offset = 0
    // Accumulated in the same order the reference lays the fields out, so the
    // offsets here are the ones NetworkMessageEncoder.CompressMovementData used.
    const window = (bits: number): BitWindow => {
      const result = { shift: BigInt(offset), mask: (1n << BigInt(bits)) - 1n }
      offset += bits
      return result
    }
    return [
      window(PARCEL_BITS),
      window(xzBits),
      window(xzBits),
      window(yBits),
      window(velocityBits),
      window(velocityBits),
      window(velocityBits)
    ]
  }
)

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
  const windows = TIER_BIT_WINDOWS[tier] ?? TIER_BIT_WINDOWS[0]

  const { xzBits, yBits, yMax, maxVelocity, velocityBits } = config

  // Every field is masked immediately after its shift, which makes an unsigned
  // BigInt shift equivalent to C#'s arithmetic shift on a signed long — the
  // sign-extended high bits are masked away either way. That equivalence is
  // what lets this read the top field (velocityZ occupies bits 58-63 on tiers
  // 2 and 3) without caring how the varint's sign bit was interpreted.
  const readField = (field: PackedField): number => {
    const { shift, mask } = windows[field]
    return Number((movementData >> shift) & mask)
  }

  const parcelIndex = readField(PackedField.ParcelIndex)
  // ParcelEncoder.Decode: a row-major index over the padded Genesis City grid.
  const parcelX = (parcelIndex % PARCEL_GRID_WIDTH) + MIN_PARCEL_X
  const parcelY = Math.floor(parcelIndex / PARCEL_GRID_WIDTH) + MIN_PARCEL_Y

  const rawX = readField(PackedField.X)
  const rawZ = readField(PackedField.Z)
  const rawY = readField(PackedField.Y)
  const rawVelocityX = readField(PackedField.VelocityX)
  const rawVelocityY = readField(PackedField.VelocityY)
  const rawVelocityZ = readField(PackedField.VelocityZ)

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
    // The circular-buffer timestamp in SECONDS. TimestampEncoder.Decompress
    // multiplies the tick count by TIMESTAMP_QUANTUM, and the uncompressed rfc4
    // `Movement.timestamp` is seconds too — emitting raw ticks here would make
    // the same field mean different things depending on which branch decoded it.
    // (The reference's `% BufferSize` is a no-op: the mask already keeps the
    // tick count below 2^TIMESTAMP_BITS.)
    //
    // What is deliberately NOT reproduced is the wraparound correction: that
    // correction is stateful and, upstream, the state is shared across every
    // peer on the bus rather than kept per sender, so its output depends on peer
    // interleaving. Nothing here consumes the timestamp (the avatar system reads
    // position and rotation only), so a plain in-buffer value beats reproducing
    // shared mutable state — a consumer that needs monotonic time must add its
    // own per-peer correction.
    timestamp: ((temporalData | 0) & ((1 << TIMESTAMP_BITS) - 1)) * TIMESTAMP_QUANTUM,
    velocityX: dequantizeVelocity(rawVelocityX, maxVelocity, velocityBits),
    velocityY: dequantizeVelocity(rawVelocityY, maxVelocity, velocityBits),
    velocityZ: dequantizeVelocity(rawVelocityZ, maxVelocity, velocityBits),
    rotationY: dequantize(compressedRotation, 0, 360, ROTATION_Y_BITS)
  }
}

// Packet.message oneof field number for MovementCompressed (comms.proto).
const PACKET_FIELD_MOVEMENT_COMPRESSED = 12
/**
 * Every member of `Packet.message` (comms.proto). Field 11 is `protocol_version`,
 * a plain scalar OUTSIDE the oneof, so it never displaces a message — which is
 * why the set is enumerated rather than expressed as a range.
 *
 * Only these displace field 12: protobuf oneofs are last-wins, and ts-proto's
 * generated decoder implements that by overwriting `message.message` on each
 * hit. An UNKNOWN field number is deliberately not treated as a winner — a
 * newer @dcl/protocol (resolved at user-install time) or an SFU appending its
 * own framing must not make a real compressed packet fall through to a decoder
 * that cannot read it.
 */
const PACKET_ONEOF_FIELDS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15])
// MovementCompressed field numbers.
const FIELD_TEMPORAL_DATA = 1
const FIELD_MOVEMENT_DATA = 2
const FIELD_HEAD_SYNC_DATA = 3
const FIELD_POINT_AT_DATA = 4

const WIRE_TYPE_VARINT = 0
const WIRE_TYPE_LENGTH_DELIMITED = 2
const WIRE_TYPE_END_GROUP = 4

/**
 * Raised when protobufjs hands back something other than a Long for an int64.
 *
 * protobufjs binds `Reader.int64` to `readLongVarint` (a `{low, high}` int32
 * pair) only when `util.Long` is configured, which it discovers through
 * `util.inquire` — an `eval("require")` that does NOT survive bundling. Without
 * it the binding is `read_int64_number`, which returns a plain JS number that
 * has already dropped the low bits of anything above 2^53. Reading `.low`/`.high`
 * off that number yields `undefined`, `undefined >>> 0` is 0, and every peer
 * decodes at parcel index 0 — pinned at world (-2432, 0, -2432) with no error at
 * all. THIS PROJECT SHIPS AN ESBUILD BUNDLE, so the binding is a build-time
 * property: it is either right for every packet or wrong for every packet, and
 * being wrong must be loud.
 */
export class Int64DecodingUnavailableError extends Error {
  constructor(received: unknown) {
    // The `typeof` only — the value itself is remote-peer data and has no place
    // in a log line.
    super(
      `protobufjs decoded an int64 as ${typeof received} instead of a Long: ` +
        'util.Long is not configured, so 64-bit movement data cannot be read losslessly'
    )
    this.name = 'Int64DecodingUnavailableError'
  }
}

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
 * only the top level, and reads nothing but field 12's payload.
 *
 * A PRE-FILTER MUST NEVER BE STRICTER THAN THE PARSER IT PRECEDES. This runs
 * ahead of `Packet.decode` on every inbound packet, so anything it rejects that
 * `Packet.decode` would have accepted is a packet the server drops and every
 * reference client renders. Two consequences, both load-bearing:
 *
 *  - it mirrors ts-proto's `if ((tag & 7) === 4 || tag === 0) break`, which ends
 *    a message cleanly on a trailing end-group or zero tag where protobufjs's
 *    `skipType` throws `invalid wire type 4`;
 *  - any OTHER parse failure returns null rather than throwing, so the caller
 *    falls through to `Packet.decode` and the packet gets exactly the handling
 *    it had before this decoder existed.
 *
 * The one error that does propagate is Int64DecodingUnavailableError, which is a
 * fault in this build rather than in the packet.
 */
export function readCompressedMovement(bytes: Uint8Array): CompressedMovementWords | null {
  const reader = new Reader(bytes)
  // `Packet.message` is a oneof and protobuf oneofs are LAST-WINS, so finding
  // field 12 is not enough: a later oneof member displaces it, exactly as it
  // does in the generated decoder. Scan the whole top level and keep the last
  // field-12 payload, then take the compressed path only if field 12 won.
  let lastOneofField = 0
  let movementCompressedBytes: Uint8Array | undefined

  try {
    while (reader.pos < reader.len) {
      const tag = reader.uint32()
      const wireType = tag & 7

      // Mirrors ts-proto's terminator check (see the note above).
      if (wireType === WIRE_TYPE_END_GROUP || tag === 0) break

      const fieldNumber = tag >>> 3
      // A oneof member only wins if its wire type is the one the generated
      // decoder accepts; every member of this oneof is a message, so that is
      // length-delimited. Anything else it skips without touching `message`.
      if (wireType === WIRE_TYPE_LENGTH_DELIMITED && PACKET_ONEOF_FIELDS.has(fieldNumber)) {
        lastOneofField = fieldNumber
        if (fieldNumber === PACKET_FIELD_MOVEMENT_COMPRESSED) {
          // A subarray of `bytes`, not a copy.
          movementCompressedBytes = reader.bytes()
          continue
        }
      }

      reader.skipType(wireType)
    }

    if (lastOneofField !== PACKET_FIELD_MOVEMENT_COMPRESSED || !movementCompressedBytes) return null

    return readWords(movementCompressedBytes)
  } catch (error) {
    if (error instanceof Int64DecodingUnavailableError) throw error
    return null
  }
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
    const wireType = tag & 7

    // MovementCompressed.decode ends on the same two tag shapes as Packet.decode.
    if (wireType === WIRE_TYPE_END_GROUP || tag === 0) break

    const fieldNumber = tag >>> 3

    if (wireType !== WIRE_TYPE_VARINT) {
      reader.skipType(wireType)
      continue
    }

    switch (fieldNumber) {
      case FIELD_TEMPORAL_DATA:
        words.temporalData = reader.int32()
        break
      case FIELD_MOVEMENT_DATA:
        words.movementData = toUnsigned64(reader.int64())
        break
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

/**
 * Widens protobufjs's Long (a high/low int32 pair) into the 64 raw bits the
 * field layout is defined over, or throws if it is not a Long at all — see
 * Int64DecodingUnavailableError for why that has to be checked rather than cast.
 */
function toUnsigned64(value: unknown): bigint {
  if (typeof value === 'object' && value !== null) {
    const { low, high } = value as { low: unknown; high: unknown }
    if (typeof low === 'number' && typeof high === 'number') {
      // `>>> 0` makes each half unsigned before it is combined, otherwise a half
      // with bit 31 set would contribute a negative value. Roughly half of all
      // real positions set bit 31 of the low half.
      return (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0)
    }
  }
  throw new Int64DecodingUnavailableError(value)
}
