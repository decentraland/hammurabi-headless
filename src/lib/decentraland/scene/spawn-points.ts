import { Vector3 } from "@babylonjs/core";
import { Scene } from "@dcl/schemas"
import { gridToWorld } from "../positions";

export type InstancedSpawnPoint = { position: Vector3; cameraTarget?: Vector3 }

/**
 * Computes the spawn point based on a scene.
 *
 * The computation takes the spawning points defined in the scene document and computes the spawning point in the world based on the base parcel position.
 *
 * @param scene Scene on which the player is spawning
 * @param loadPosition Parcel position on which the player is teleporting to
 */
export function pickWorldSpawnpoint(scene: Scene): InstancedSpawnPoint {
  const baseParcel = scene.scene?.base ?? ''
  const [bx, by] = baseParcel.split(',')
  const baseX = parseInt(bx, 10)
  const baseY = parseInt(by, 10)
  const basePosition = new Vector3()
  // `base` is untrusted scene metadata: a malformed value ("garbage" / missing)
  // yields NaN, which would propagate into a NaN teleport. Fall back to 0,0.
  gridToWorld(Number.isFinite(baseX) ? baseX : 0, Number.isFinite(baseY) ? baseY : 0, basePosition)

  const spawnpoint = pickSpawnpoint(scene)
  const { position, cameraTarget } = spawnpoint

  return {
    position: basePosition.add(position),
    cameraTarget: cameraTarget ? basePosition.add(cameraTarget) : undefined
  }
}

function pickSpawnpoint(land: Scene): InstancedSpawnPoint {
  let spawnPoints = land.spawnPoints
  if (!spawnPoints || !Array.isArray(spawnPoints) || spawnPoints.length === 0) {
    spawnPoints = [
      {
        position: {
          x: 8,
          y: 0,
          z: 8
        }
      }
    ]
  }

  // 1 - default spawn points
  const defaults = spawnPoints.filter(($) => $.default)

  // 2 - if no default spawn points => all existing spawn points
  const eligiblePoints = defaults.length === 0 ? spawnPoints : defaults

  // 3 - get a random spawn point
  const index = Math.floor(Math.random() * eligiblePoints.length)

  const chosen = eligiblePoints[index]
  const position = chosen?.position
  const cameraTarget = chosen?.cameraTarget

  // 4 - generate random x, y, z components when in arrays. A spawn point may omit
  // `position` entirely (untrusted scene metadata); fall back to the scene-center
  // default rather than throwing on `position.x`.
  const finalPosition = position
    ? new Vector3(
        computeComponentValue(position.x),
        computeComponentValue(position.y),
        computeComponentValue(position.z)
      )
    : new Vector3(8, 0, 8)

  return {
    position: finalPosition,
    cameraTarget: new Vector3(cameraTarget?.x ?? 0, cameraTarget?.y ?? 0, cameraTarget?.z ?? 0)
  }
}

function computeComponentValue(x: number | number[]) {
  return sanitizeFinite(rawComponentValue(x))
}

// Untrusted scene metadata: guarantee the spawn component is a finite number so a
// NaN/Infinity (from a bad scalar OR array element) can't reach the teleport.
function sanitizeFinite(value: number) {
  return Number.isFinite(value) ? value : 0
}

function rawComponentValue(x: number | number[]) {
  if (typeof x === 'number') {
    return x
  }

  // anything that isn't a number or an array is unusable.
  if (!Array.isArray(x)) {
    return 0
  }

  const length = x.length
  if (length === 0) {
    return 0
  } else if (length < 2) {
    return x[0]
  } else if (length > 2) {
    x = [x[0], x[1]]
  }

  let [min, max] = x

  if (min === max) return max

  if (min > max) {
    const aux = min
    min = max
    max = aux
  }

  return Math.random() * (max - min) + min
}