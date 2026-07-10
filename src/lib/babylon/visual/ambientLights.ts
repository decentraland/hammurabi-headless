import * as BABYLON from '@babylonjs/core'
import { addFloorMesh, setColliderMask } from '../scene/logic/colliders'
import { ColliderLayer } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen'

const PARCEL_SIZE = 16

export async function setupEnvironment(scene: BABYLON.Scene) {
  // Headless environment setup - minimal visual elements
  const groundColor = new BABYLON.Color3(0.1, 0.1, 0.1)
  
  // Simple hemispheric light for basic lighting
  const hemiLight = new BABYLON.HemisphericLight('default light', new BABYLON.Vector3(0, 1, 0), scene)
  hemiLight.diffuse = BABYLON.Color3.White()
  hemiLight.groundColor = groundColor.clone()
  hemiLight.specular = BABYLON.Color3.White()

  // Create a simple ground plane for collisions
  const ground = BABYLON.MeshBuilder.CreateGround('ground', { width: 1024, height: 1024 }, scene)
  ground.position.y = 0
  ground.checkCollisions = true
  
  // Simple material without textures
  const groundMaterial = new BABYLON.StandardMaterial('groundMaterial', scene)
  groundMaterial.diffuseColor = groundColor
  groundMaterial.specularColor = new BABYLON.Color3(0, 0, 0)
  ground.material = groundMaterial

  setColliderMask(ground, ColliderLayer.CL_PHYSICS)
  // Through addFloorMesh (not a direct push): it registers the dispose
  // observer that removes the mesh from the module-level array — without it,
  // every engine reset ('r' restart disposes the Babylon scene) would leave
  // one more disposed ground accumulating in floorMeshes.
  addFloorMesh(ground)

  function repositionCamera() {
    if (!scene.activeCamera) return
    // Follow the camera in ABSOLUTE world coordinates, snapped to the parcel
    // grid, with the ground plane always at y=0. The upstream browser client
    // used camera-relative offsets here because its ground was a child of a
    // rootMesh moved to the camera every frame; this port has no such parent,
    // so the relative math put the ground at world y = -cameraY — a free-fall
    // trap for any scene without its own floor colliders the moment player
    // movement is driven.
    ground.position.set(
      Math.floor(scene.activeCamera.globalPosition.x / PARCEL_SIZE) * PARCEL_SIZE,
      0,
      Math.floor(scene.activeCamera.globalPosition.z / PARCEL_SIZE) * PARCEL_SIZE
    )
  }

  scene.onBeforeRenderObservable.add(repositionCamera)

  // add some variables to the global context to debug
  Object.assign(globalThis, { hemiLight, ground, groundMaterial })

  return {
    repositionCamera,
    ground
  }
}

