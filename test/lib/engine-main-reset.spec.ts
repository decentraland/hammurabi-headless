// resetEngine is the owner boundary for the process-global remote-player entity
// allocator. Per-system teardown deliberately leaves the allocator alone, because every
// scene on a transport shares it and clearing it from one scene would drop live
// siblings' mappings and reset entity versions underneath them. That makes the session
// owner responsible: without this, stale address->entity mappings and version state
// survived into the NEXT engine session, eroding the 224-slot remote-player pool across
// restarts and letting a fresh session adopt a mapping minted for the previous room.
import { resetEngine } from '../../src/lib/engine-main'
import { playerEntityManager } from '../../src/lib/decentraland/communications/player-entity-manager'

describe('resetEngine', () => {
  afterEach(() => {
    playerEntityManager.clear()
  })

  describe('when the engine session is torn down', () => {
    it('should release the process-global remote-player entity allocator', () => {
      expect(playerEntityManager.allocateEntityForPlayer('0xpeer', false)).not.toBeNull()

      // No scenes and no active session: this exercises the session-owner cleanup on
      // its own, without standing up an engine.
      resetEngine()

      expect(playerEntityManager.getEntityForAddress('0xpeer')).toBeNull()
    })

    it('should hand the next session a pool that starts from the first slot again', () => {
      const first = playerEntityManager.allocateEntityForPlayer('0xpeer', false)!

      resetEngine()

      // A fresh session must not inherit the previous room's numbering: same address or
      // not, the next allocation starts the pool over.
      expect(playerEntityManager.allocateEntityForPlayer('0xsomeone-else', false)).toEqual(first)
    })
  })
})
