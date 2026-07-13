import * as BABYLON from '@babylonjs/core'
import { SceneContext } from './scene-context'
import { Transform } from '../../decentraland/sdk-components/transform-component'
import { ComponentDefinition } from '../../decentraland/crdt-internal/components'
import { Entity } from '../../decentraland/types'
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core'
import { BillboardMode, PBBillboard } from '@dcl/protocol/out-js/decentraland/sdk/components/billboard.gen'
import { PBRaycast } from '@dcl/protocol/out-js/decentraland/sdk/components/raycast.gen'
import { PBMeshCollider } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen'
import { isValidBillboardCombination } from './logic/billboards'
import { PBGltfContainer } from '@dcl/protocol/out-js/decentraland/sdk/components/gltf_container.gen'
import { PBPointerEvents } from '@dcl/protocol/out-js/decentraland/sdk/components/pointer_events.gen'
import { PBMeshRenderer } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_renderer.gen'
import { StaticEntities } from './logic/static-entities'
// import { PBDelayedInterpolation } from '@dcl/protocol/out-js/decentraland/sdk/components/delayed_interpolation.gen'
// import { applyDelayedInterpolation } from './logic/delayed-interpolation'
import { PBTween } from '@dcl/protocol/out-js/decentraland/sdk/components/tween.gen'
import { PBMaterial } from '@dcl/protocol/out-js/decentraland/sdk/components/material.gen'
import { PBAvatarBase } from '@dcl/protocol/out-js/decentraland/sdk/components/avatar_base.gen'
import { memoize } from '../../misc/memoize'

export type TransformCommand = { value: Transform, time: number }

// the following list of components is used to store a "staging" value to compare
// against the previous applied value in the applyChanges function of each component
export type AppliedComponents = {
  transform: {
    commands: Array<TransformCommand>
    parent: Entity
  }
  billboard: PBBillboard
  raycast: {
    value: PBRaycast
    ray: BABYLON.Ray
  }
  meshCollider: {
    info: PBMeshCollider
    collider: BABYLON.AbstractMesh | null
  }
  meshRenderer: {
    info: PBMeshRenderer
    mesh: BABYLON.AbstractMesh | null
  }
  gltfContainer: {
    value: PBGltfContainer
    gltfContainer: BABYLON.AbstractMesh | null
    instancedEntries: BABYLON.InstantiatedEntries | null
  }
  pointerEvents: PBPointerEvents
  avatarBase: PBAvatarBase
  // delayedInterpolation: PBDelayedInterpolation
  tween: PBTween
  material: {
    value: PBMaterial
    material: BABYLON.Material
  }
}


export const baseMaterial = memoize((scene: BABYLON.Scene) => {
  const material = new BABYLON.StandardMaterial(
    'base-box',
    scene
  )
  material.diffuseTexture = new BABYLON.Texture('images/UV_checker_Map_byValle.jpg')
  return material
})

// Reused temporaries for the billboard math below. _afterComputeWorldMatrix runs
// per billboarded entity per frame (billboards are never world-matrix-cached by
// design, see _isSynchronized) and previously allocated ~8 objects per call.
// Single-threaded and non-reentrant: the super call never re-enters this branch.
const tmpBbPosition = new Vector3()
const tmpBbScale = new Vector3()
const tmpBbDirection = new Vector3()
const tmpBbRotation = new Quaternion()
const tmpBbEuler = new Vector3()
const tmpBbMatrix = new Matrix()
const tmpBbScalingMatrix = new Matrix()
const READONLY_VECTOR3_ZERO = Vector3.Zero()

/**
 * This class wraps a BabylonEntity and extends it with all the component-related
 * logic for the Decentraland ECS semantics.
 */
export class BabylonEntity extends BABYLON.TransformNode {
  readonly isDCLEntity = true
  usedComponents = new Map<number, ComponentDefinition<unknown>>()
  appliedComponents: Partial<AppliedComponents> = {}

  constructor(public entityId: Entity, public context: WeakRef<SceneContext>) {
    super(`ecs-${entityId.toString(16)}`)
  }

  putComponent(component: ComponentDefinition<unknown>) {
    component.declaration.applyChanges(this, component)
    this.usedComponents.set(component.componentId, component)
  }

  deleteComponent(component: ComponentDefinition<unknown>) {
    component.declaration.applyChanges(this, component)
    this.usedComponents.delete(component.componentId)
  }

  // this function chooses which value is going to be used to calculate the world
  // transform of this entity. the order of precedence is:
  // 1. if there are no user defined Transform, use an identity transform
  // 2. if the PBDelayedInterpolation component is present, interpolate a value using the time-traveling commands
  // 3. if the PBTween component is present, interpolate a value using the tweening commands
  // 4. if the PBTransform component is present, use the latest value (command)
  _setTransformParametersBeforeMatrixCalculation() {
    if (!this.rotationQuaternion) this.rotationQuaternion = Quaternion.Identity()

    // perform interpolation if needed
    const commands = this.appliedComponents.transform?.commands

    if (!commands || commands.length === 0) {
      this.position.setAll(0)
      this.scaling.setAll(1)
      this.rotationQuaternion.set(0, 0, 0, 1)
      return
    }

    if (false) {
      // applyDelayedInterpolation(this, this.appliedComponents.delayedInterpolation, commands, performance.now())
    } else /* if(BPTween) {
      applyTween(this, this.appliedComponents.tween!, commands, performance.now())
    } else */ {
      const latestCommand = commands[commands.length - 1]
      this.position.set(latestCommand.value.position.x, latestCommand.value.position.y, latestCommand.value.position.z)
      this.scaling.set(latestCommand.value.scale.x, latestCommand.value.scale.y, latestCommand.value.scale.z)
      this.rotationQuaternion.set(latestCommand.value.rotation.x, latestCommand.value.rotation.y, latestCommand.value.rotation.z, latestCommand.value.rotation.w)
    }
  }

  computeWorldMatrix(force: boolean | undefined, camera?: BABYLON.Nullable<BABYLON.Camera>) {
    if (this.entityId === StaticEntities.RootEntity) {
      return super.computeWorldMatrix(force, camera)
    }

    this._setTransformParametersBeforeMatrixCalculation()

    return super.computeWorldMatrix(force, camera)
  }

  // This function is called after Babylon calculates the world matrix of the entity
  // we hook into this lifecycle event to mutate the final _worldMatrix before it is
  // settled
  _afterComputeWorldMatrix() {
    const camera = this.getScene().activeCamera

    const billboardMode = this.appliedComponents.billboard?.billboardMode ?? BillboardMode.BM_ALL

    // BM_NONE (=0) means "no billboarding". It is NOT caught by `?? BM_ALL` (0 is
    // not nullish), so without this guard the branch below would zero all three
    // euler axes and force the entity's world rotation to identity every frame,
    // destroying the Transform rotation of the entity and its whole subtree.
    if (this.appliedComponents.billboard && billboardMode !== BillboardMode.BM_NONE && camera) {
      // save translation and scaling components of the world matrix calculated by
      // Babylon (the translation IS the entity's global position — transforming
      // the origin by the world matrix yields the same vector)
      this._worldMatrix.decompose(tmpBbScale, undefined, tmpBbPosition)

      // get the direction vector from the camera to the entity position
      camera.globalPosition.subtractToRef(tmpBbPosition, tmpBbDirection)

      // calculate the LookAt matrix from the direction vector towards zero
      Matrix.LookAtLHToRef(tmpBbDirection, READONLY_VECTOR3_ZERO, camera.upVector, tmpBbMatrix)
      tmpBbMatrix.invert()

      if (isValidBillboardCombination(billboardMode)) {
        Quaternion.FromRotationMatrixToRef(tmpBbMatrix, tmpBbRotation)
        tmpBbRotation.toEulerAnglesToRef(tmpBbEuler)

        if (!(billboardMode & BillboardMode.BM_X)) {
          tmpBbEuler.x = 0;
        }

        if (!(billboardMode & BillboardMode.BM_Y)) {
          tmpBbEuler.y = 0;
        }

        if (!(billboardMode & BillboardMode.BM_Z)) {
          tmpBbEuler.z = 0;
        }

        Matrix.RotationYawPitchRollToRef(tmpBbEuler.y, tmpBbEuler.x, tmpBbEuler.z, tmpBbMatrix);
      }

      // restore the scale to a blank scaling matrix
      Matrix.ScalingToRef(tmpBbScale.x, tmpBbScale.y, tmpBbScale.z, tmpBbScalingMatrix);

      // apply the scale to the rotation matrix, into _worldMatrix
      tmpBbScalingMatrix.multiplyToRef(tmpBbMatrix, this._worldMatrix)

      // finally restore the translation into _worldMatrix
      this._worldMatrix.setTranslation(tmpBbPosition);
    }

    return super._afterComputeWorldMatrix()
  }

  // this function should return false if the world matrix needs to be recalculated
  // it is called internally by Babylon.js internal code
  _isSynchronized() {
    // A BM_NONE billboard is inert (see _afterComputeWorldMatrix), so it must not
    // force a per-frame world-matrix recompute either.
    const billboard = this.appliedComponents.billboard
    const hasActiveBillboard = !!billboard && (billboard.billboardMode ?? BillboardMode.BM_ALL) !== BillboardMode.BM_NONE
    return !hasActiveBillboard && super._isSynchronized()
  }

  /**
   * Returns the parentEntity set by the Transform Component.
   * Defaults to ROOT_ENTITY(0)
   */
  get expectedParentEntityId() {
    return this.appliedComponents.transform?.parent ?? StaticEntities.RootEntity
  }

  /**
   * Returns the children that extends EcsEntity, filtering any other Object3D
   */
  *childrenEntities(): Iterable<BabylonEntity> {
    if (this._children)
      for (let i = 0; i < this._children.length; i++) {
        const element = this._children[i] as any
        if (element.isDCLEntity) {
          yield element
        }
      }
  }

  // NOTE: the base-class recurse/dispose-materials flags are intentionally
  // ignored. SceneContext disposes every entity individually (removeEntity loop)
  // and frees the parcel outline explicitly, so this always performs a
  // NON-recursive dispose (children are detached, not recursively disposed) to
  // avoid double-disposing entities that the loop already handled.
  dispose(_doNotRecurse?: boolean | undefined, _disposeMaterialAndTextures?: boolean | undefined): void {
    // first dispose all components
    for (const [_, component] of this.usedComponents) {
      // mark the component as deleted in the component
      component.entityDeleted(this.entityId, false)
      // then perform the final deletion
      this.deleteComponent(component)
    }

    // and then proceed with the native engine disposal
    super.dispose(true, false)
  }
}