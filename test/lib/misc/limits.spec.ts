import { readLimits } from '../../../src/lib/misc/limits'
import { REMOTE_PLAYER_ENTITY_CAPACITY } from '../../../src/lib/decentraland/communications/player-entity-manager'

describe('readLimits', () => {
  it('returns the documented defaults when no env vars are set', () => {
    const l = readLimits({})
    expect(l.isolateMemoryLimitBytes).toBe(256 * 1024 * 1024)
    expect(l.maxSyncExecutionMs).toBe(10_000)
    expect(l.maxAsyncTurnMs).toBe(60_000)
    expect(l.maxLiveEntities).toBe(100_000)
    expect(l.maxInboundPacketBytes).toBe(128 * 1024)
    expect(l.maxMessagesPerWindow).toBe(300)
    expect(l.fetchTimeoutMs).toBe(15_000)
    expect(l.maxAssetBytes).toBe(64 * 1024 * 1024)
    expect(l.maxRaycastIntersectionsPerFrame).toBe(50_000)
    // Pinned HERE rather than only in the consumers: the collider specs compare
    // against `limits.maxPrimitiveRadiusMeters`, i.e. the same value the code under
    // test reads, so they assert "code agrees with the knob" and stay green for any
    // default whatsoever. Changing these numbers should require changing a test.
    expect(l.maxPrimitiveRadiusMeters).toBe(4_096)
    expect(l.maxRaycastTrianglesPerFrame).toBe(600_000)
  })

  it('applies a valid integer override in the field native unit', () => {
    const l = readLimits({
      HAMMURABI_MAX_LIVE_ENTITIES: '5000',
      HAMMURABI_MAX_MESSAGES_PER_WINDOW: '120',
      HAMMURABI_FETCH_TIMEOUT_MS: '3000',
      HAMMURABI_MAX_ASSET_BYTES: String(10 * 1024 * 1024),
      HAMMURABI_MAX_PRIMITIVE_RADIUS_METERS: '64',
      HAMMURABI_MAX_RAYCAST_TRIANGLES_PER_FRAME: '1000'
    })
    expect(l.maxPrimitiveRadiusMeters).toBe(64)
    expect(l.maxRaycastTrianglesPerFrame).toBe(1000)
    expect(l.maxLiveEntities).toBe(5000)
    expect(l.maxMessagesPerWindow).toBe(120)
    expect(l.fetchTimeoutMs).toBe(3000)
    expect(l.maxAssetBytes).toBe(10 * 1024 * 1024)
  })

  it('reads the isolate memory ceiling in MB and converts to bytes', () => {
    const l = readLimits({ HAMMURABI_ISOLATE_MEMORY_LIMIT_MB: '512' })
    expect(l.isolateMemoryLimitBytes).toBe(512 * 1024 * 1024)
  })

  it('ignores non-numeric / non-integer / out-of-range overrides and keeps the default', () => {
    const l = readLimits({
      HAMMURABI_MAX_LIVE_ENTITIES: 'abc', // not a number
      HAMMURABI_MAX_SYNC_EXECUTION_MS: '1.5', // not an integer
      HAMMURABI_MAX_MESSAGES_PER_WINDOW: '0', // below min (1)
      HAMMURABI_ISOLATE_MEMORY_LIMIT_MB: '4' // below min (8MB)
    })
    expect(l.maxLiveEntities).toBe(100_000)
    expect(l.maxSyncExecutionMs).toBe(10_000)
    expect(l.maxMessagesPerWindow).toBe(300)
    expect(l.isolateMemoryLimitBytes).toBe(256 * 1024 * 1024)
  })

  describe('when the tracked-session cap does not exceed the remote-player capacity', () => {
    it('should keep the default so every live avatar can retain its session record', () => {
      const l = readLimits({
        HAMMURABI_MAX_TRACKED_PEER_SESSIONS: String(REMOTE_PLAYER_ENTITY_CAPACITY)
      })

      expect(l.maxTrackedPeerSessions).toBe(1_024)
    })
  })

  describe('when the tracked-session cap leaves room beyond the remote-player capacity', () => {
    it('should accept the override at the safe minimum', () => {
      const safeMinimum = REMOTE_PLAYER_ENTITY_CAPACITY + 1
      const l = readLimits({
        HAMMURABI_MAX_TRACKED_PEER_SESSIONS: String(safeMinimum)
      })

      expect(l.maxTrackedPeerSessions).toBe(safeMinimum)
    })
  })

  it('allows zero for knobs whose minimum is zero (disable semantics)', () => {
    const l = readLimits({
      HAMMURABI_PROFILE_FETCH_COOLDOWN_MS: '0',
      HAMMURABI_MAX_SIGNED_FETCH_REDIRECTS: '0',
      HAMMURABI_SHUTDOWN_DRAIN_MS: '0'
    })
    expect(l.profileFetchCooldownMs).toBe(0)
    expect(l.maxSignedFetchRedirects).toBe(0)
    expect(l.shutdownDrainMs).toBe(0)
  })

  it('treats an empty or whitespace override as unset', () => {
    const l = readLimits({ HAMMURABI_MAX_LIVE_ENTITIES: '', HAMMURABI_FETCH_TIMEOUT_MS: '   ' })
    expect(l.maxLiveEntities).toBe(100_000)
    expect(l.fetchTimeoutMs).toBe(15_000)
  })

  it('populates every declared Limits field (no undefined knobs)', () => {
    const l = readLimits({})
    for (const [key, value] of Object.entries(l)) {
      expect([key, typeof value]).toEqual([key, 'number'])
      expect([key, Number.isFinite(value) && value >= 0]).toEqual([key, true])
    }
  })
})
