import { AbstractMesh, Scene } from '@babylonjs/core'
import { GridMaterial } from '@babylonjs/materials'
import { memoize } from '../../../misc/memoize'
import { ColliderLayer } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen'
import { BabylonEntity } from '../BabylonEntity'
import { bitIntersectsAndContainsAny } from '../../../misc/bit-operations'

export const floorMeshes: AbstractMesh[] = []

const colliderSymbol = Symbol('isCollider')

export const colliderMaterial = memoize((scene: Scene) => {
  const m = new GridMaterial('collider-material', scene)
  m.opacity = 0
  m.sideOrientation = 0
  m.disableColorWrite = true
  m.disableDepthWrite = true
  m.mainColor.set(0, 0, 0)
  m.lineColor.set(0, 1, 0)
  m.zOffset = -1
  m.fogEnabled = false
  m.depthFunction = 2
  m.gridRatio = .1
  m.freeze()

  return m
})


export function setColliderMask(mesh: AbstractMesh, layers: number) {
  (mesh as any)[colliderSymbol] = layers

  if (mesh.name.endsWith('_collider')) {
    mesh.material = colliderMaterial(mesh.getScene())
    addFloorMesh(mesh)
  }

  mesh.checkCollisions = (layers & ColliderLayer.CL_PHYSICS) != 0
  mesh.isPickable = (layers & ColliderLayer.CL_POINTER) != 0
}

function addFloorMesh(mesh: AbstractMesh) {
  // add only when NOT already present (the previous inverted check meant no
  // collider mesh was ever added — only the ambient ground reached the list)
  const ix = floorMeshes.indexOf(mesh)
  if (ix === -1) {
    floorMeshes.push(mesh)
    // Registered on first add only: setColliderMask runs on EVERY accepted
    // GltfContainer PUT, and an unconditional addOnce there grew each mesh's
    // observer array by one closure per PUT for the mesh's lifetime.
    mesh.onDisposeObservable.addOnce(() => {
      const i = floorMeshes.indexOf(mesh)
      if (i != -1) {
        floorMeshes.splice(i, 1)
      }
    })
  }
}

export function getColliderLayers(mesh: AbstractMesh): number {
  return (mesh as any)[colliderSymbol] || 0
}

// this function returns the meshes that match the provided mask
export function pickMeshesForMask(entity: BabylonEntity, mask: number): Iterable<AbstractMesh> {
  if (!mask) return []
  return entity.getChildMeshes(false, (mesh) => {
    if (mesh instanceof AbstractMesh) {
      return bitIntersectsAndContainsAny(getColliderLayers(mesh), mask)
    }
    return true
  })
}