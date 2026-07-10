import * as BABYLON from '@babylonjs/core'
import { gridToParcel, PARCEL_SIZE_METERS, parseParcelPosition } from "../../decentraland/positions"

// The outline loop covers the full bounding box of the declared parcels, and
// scene.json parcels are deployer-controlled input parsed in host code:
// declaring "0,0" and "100000,100000" would make the naive double loop spin
// ~1e10 iterations before any VM limit applies. Genesis deployments are
// validated for contiguity upstream, but worlds/local scenes are not — skip
// the (purely cosmetic on a headless server) outline instead of stalling.
const MAX_OUTLINE_BOUNDING_BOX_CELLS = 65536

export function createParcelOutline(scene: BABYLON.Scene, basePosition: string, positions: string[]) {
  const decoded = positions.map(parseParcelPosition)
  const parcels = decoded.map($ => new BABYLON.Vector2($.x, $.y))
  const base = parseParcelPosition(basePosition)

  // Set-based lookup: the linear find allocated 3 Vector2 per visited cell and
  // made the loop O(area × parcel count).
  const parcelSet = new Set(parcels.map($ => `${$.x},${$.y}`))
  const contains = (x: number, y: number): boolean => parcelSet.has(`${x},${y}`)

  const points: BABYLON.Vector3[][] = []

  const minX = Math.min(...parcels.map($ => $.x)) - 1
  const minY = Math.min(...parcels.map($ => $.y)) - 1
  const maxX = Math.max(...parcels.map($ => $.x)) + 1
  const maxY = Math.max(...parcels.map($ => $.y)) + 1

  const boundingBoxCells = (maxX - minX + 2) * (maxY - minY + 2)
  if (!Number.isFinite(boundingBoxCells) || boundingBoxCells > MAX_OUTLINE_BOUNDING_BOX_CELLS) {
    // An empty parcels list (global/static scenes) yields a non-finite box —
    // that was always a silent no-op outline; only warn on a real oversized box.
    if (parcels.length > 0 && Number.isFinite(boundingBoxCells)) {
      console.error(`parcel outline skipped: bounding box of ${boundingBoxCells} cells exceeds ${MAX_OUTLINE_BOUNDING_BOX_CELLS}`)
    }
    const lines = BABYLON.MeshBuilder.CreateLineSystem('lines', { lines: [] }, scene)
    lines.isPickable = false
    return { result: lines }
  }

  /*
   * Iterate over all the parcels in the bounding box surrounding this
   * parcel, and draw a border whenever we change state from inside
   * the parcel to outside the parcel.
   */
  for (let x = minX; x < maxX + 1; x++) {
    for (let y = minY; y < maxY + 1; y++) {
      const p = contains(x, y)
      const northern = contains(x, y - 1)
      const western = contains(x - 1, y)
      if (p !== western) {
        const p1 = new BABYLON.Vector3(0, 0, 0)
        gridToParcel(base, x, y, p1)
        p1.z = p1.z
        const p2 = p1.clone()
        p2.z = p2.z + PARCEL_SIZE_METERS
        points.push([p1, p2])
      }
      if (p !== northern) {
        const p1 = new BABYLON.Vector3(0, 0, 0)
        gridToParcel(base, x, y, p1)
        p1.x = p1.x
        const p2 = p1.clone()
        p2.x = p2.x + PARCEL_SIZE_METERS
        points.push([p1, p2])
      }
    }
  }

  const lines = BABYLON.MeshBuilder.CreateLineSystem('lines', { lines: points }, scene)
  lines.color = BABYLON.Color3.FromHexString('#ff004f')
  lines.isPickable = false

  return { result: lines }
}
