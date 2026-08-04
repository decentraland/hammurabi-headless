import * as BABYLON from '@babylonjs/core'
import { declareComponentUsingProtobufJs } from "./pb-based-component-helper";
import { PBMeshRenderer } from "@dcl/protocol/out-js/decentraland/sdk/components/mesh_renderer.gen";
import { ComponentType } from "../crdt-internal/components";
import { memoize } from "../../misc/memoize";
import { baseMaterial } from '../../babylon/scene/BabylonEntity';
import {
  createBoxMesh,
  createCylinderMesh,
  createPlaneMesh,
  createSphereMesh
} from '../../babylon/scene/logic/primitive-meshes';
import { setMeshRendererMaterial } from './material-component';

// Geometry comes from primitive-meshes, the single place that owns every primitive's
// size, tessellation and side orientation. The collider component builds from the
// same functions on purpose: a renderer that drifts from the collider standing in
// for it reports hits at coordinates the picture disagrees with, and sharing only a
// unit-size constant left `segments`/`sideOrientation` free to diverge.
//
// Templates are built disabled and cloned per entity; `clone()` inherits the
// disabled flag, so each branch below re-enables its clone.
const baseBox = memoize((scene: BABYLON.Scene) => {
  const ret = createBoxMesh(scene, 'base-box')
  ret.material = baseMaterial(scene)
  ret.setEnabled(false)
  return ret
})

const baseSphere = memoize((scene: BABYLON.Scene) => {
  const ret = createSphereMesh(scene, 'base-sphere')
  ret.material = baseMaterial(scene)
  ret.setEnabled(false)
  return ret
})

export const planeMaterial = memoize((scene: BABYLON.Scene) => {
  const material = new BABYLON.StandardMaterial(
    'plane-material',
    scene
  )
  material.specularColor.set(0, 0, 0)
  material.specularPower = 0

  material.diffuseTexture = new BABYLON.Texture('images/UV_checker_Map_byValle.jpg')

  return material
})

// TODO: this component is a stub that will be replaced by the real implementation later in a dedicated PR
export const meshRendererComponent = declareComponentUsingProtobufJs(PBMeshRenderer, 1018, (entity, component) => {
  // this function is called when we receive the component and a change needs to be applied to the entity
  if (component.componentType !== ComponentType.LastWriteWinElementSet) return

  // create a box and attach it to an entity

  // Gate on the ENTRY, not on `?.mesh`: an unsupported mesh $case (e.g.
  // cylinder) stores { mesh: null, info }, and a mesh-gated clear would leave
  // that stale entry attached after DELETE_COMPONENT forever.
  if (entity.appliedComponents.meshRenderer) {
    const previousMesh = entity.appliedComponents.meshRenderer.mesh
    if (previousMesh) {
      previousMesh.parent = null
      previousMesh.dispose()
    }
    // Clear eagerly: on DELETE_COMPONENT nothing below reassigns this, and a
    // stale entry would hand the disposed mesh to setMeshRendererMaterial on a
    // later Material PUT.
    entity.appliedComponents.meshRenderer = undefined
  }

  const info = component.get(entity.entityId)

  if (info) {
    let mesh: BABYLON.AbstractMesh | null = null

    if (info.mesh?.$case === 'box') {
      mesh = baseBox(entity.getScene()).clone()
      mesh.parent = entity
      mesh.setEnabled(true)
    } else if (info.mesh?.$case === 'sphere') {
      mesh = baseSphere(entity.getScene()).clone()
      mesh.parent = entity
      mesh.setEnabled(true)
    } else if (info.mesh?.$case === 'cylinder') {
      // Built per entity rather than cloned from a template: radiusTop/
      // radiusBottom are part of the component value, so the geometry differs
      // between entities. Shares createCylinderMesh with the collider so a
      // cylinder's collider cannot drift from the shape it stands in for.
      const { radiusTop, radiusBottom } = info.mesh.cylinder
      // No `mesh.material = ...` here, unlike the cloned templates above: those
      // inherit their template's material, whereas setMeshRendererMaterial below
      // assigns this one unconditionally (the Material component's material, or
      // baseMaterial). Setting it here too was dead code — overwritten on the very
      // next statement by the same value.
      mesh = createCylinderMesh(entity.getScene(), 'cylinder-shape', radiusTop, radiusBottom)
      mesh.parent = entity
      // Redundant today (MeshBuilder returns an enabled mesh) and kept for
      // uniformity with the cloned branches, which genuinely need it.
      mesh.setEnabled(true)
    } else if (info.mesh?.$case === 'plane') {
      // Double-sided here, unlike the collider's single-sided quad: this one is
      // DRAWN, a PlaneMesh is visible from both sides, and the protocol's UV map is
      // sized for it ("2D * 1 face * 2 sides * 4 vertices" = 16 values). Built fresh
      // rather than cloned from a template because the UVs below are per entity.
      mesh = createPlaneMesh(entity.getScene(), 'plane-shape', { doubleSided: true, updatable: true })
      mesh.parent = entity
      mesh.setEnabled(true)

      // Only the scene-supplied case writes anything. There used to be an `else`
      // filling in a default 16-value map; measured, it wrote exactly the UVs
      // Babylon already generates for a DOUBLESIDE plane
      // ([0,0, 1,0, 1,1, 0,1] twice), so it was a no-op duplicating a Babylon
      // internal — the kind of second copy that drifts. The renderer plane spec
      // pins those default UVs instead, so a Babylon change surfaces as a failing
      // test rather than as geometry silently disagreeing with a hard-coded table.
      const uvs = info.mesh.plane.uvs
      if (uvs && uvs.length) {
        mesh.updateVerticesData(BABYLON.VertexBuffer.UVKind, uvs)
      }

      mesh.material = planeMaterial(entity.getScene())
    }

    entity.appliedComponents.meshRenderer = {
      mesh,
      info
    }

    setMeshRendererMaterial(entity)
  }
})
