import * as BABYLON from '@babylonjs/core'
import type { SceneContext } from '../babylon/scene/scene-context'
import type { BabylonEntity } from '../babylon/scene/BabylonEntity'
import { StaticEntities, AVATAR_ENTITY_RANGE } from '../babylon/scene/logic/static-entities'
import { EntityUtils } from '../decentraland/crdt-internal/generational-index-pool'
import { resolveFileAbsolute } from '../decentraland/scene/content-server-entity'
import { gltfContainerLoadingStateComponent } from '../decentraland/sdk-components/gltf-loading-state'
import { Entity } from '../decentraland/types'

/**
 * Wire format for the debug viewer. Keys are short because a full snapshot is
 * re-sent at HZ (no deltas) and the whole point of the tool is to watch a busy
 * scene — the JSON is the only per-frame cost that scales with entity count.
 *
 * Everything here is derived READ-ONLY from state the host already computed for
 * its own simulation. The builder must never mutate scene state, never allocate
 * per entity beyond the emitted object, and never throw on malformed component
 * data — a debug tool that can perturb or crash the authoritative simulation is
 * worse than no debug tool.
 */
export type ViewerEntityKind =
  | 'root'
  | 'player'
  | 'camera'
  | 'avatar'
  | 'gltf'
  | 'box'
  | 'sphere'
  | 'plane'
  | 'cylinder'
  | 'node'

export type ViewerEntity = {
  /** entity NUMBER (low 16 bits); the version is carried separately in `v` */
  id: number
  v: number
  k: ViewerEntityKind
  /** world position / rotation quaternion / scale, already composed through the hierarchy */
  p: [number, number, number]
  q: [number, number, number, number]
  s: [number, number, number]
  /** absolute content-server URL of the glTF, when `k === 'gltf'` and it resolved */
  src?: string
  /** glTF loading state as the HOST sees it (LoadingState enum) */
  ls?: number
  /** avatar display name, when known */
  n?: string
  /** declared mesh-collider shape ($case), independent of the renderer */
  col?: string
  /**
   * True when the component declares a shape the HOST does not build a mesh for
   * (e.g. a cylinder MeshRenderer). Surfacing it is the point: it is a real
   * server behavior a client-side view would silently hide.
   */
  ghost?: boolean
}

export type ViewerScene = {
  id: string
  urn: string
  base?: string
  parcels?: string[]
  entities: ViewerEntity[]
  /** entities omitted because the per-snapshot cap was hit */
  truncated?: number
}

export type ViewerSnapshot = {
  t: 'snapshot'
  /** ms since process start, so the client can measure its own staleness */
  time: number
  scenes: ViewerScene[]
}

// Reused decomposition temporaries. buildSnapshot runs at HZ over every entity of
// every loaded scene; allocating three objects per entity would make the debug
// tool a bigger per-frame allocator than the simulation it is watching.
const tmpPosition = new BABYLON.Vector3()
const tmpScale = new BABYLON.Vector3()
const tmpRotation = new BABYLON.Quaternion()

// Millimetre precision. DCL scenes are metres-scaled, so 3 decimals is well below
// anything visible, and it roughly halves the JSON over raw float printing.
function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function classify(entity: BabylonEntity, entityNumber: number): { k: ViewerEntityKind; ghost?: boolean } {
  if (entityNumber === StaticEntities.RootEntity) return { k: 'root' }
  if (entityNumber === StaticEntities.PlayerEntity) return { k: 'player' }
  if (entityNumber === StaticEntities.CameraEntity) return { k: 'camera' }
  if (entityNumber >= AVATAR_ENTITY_RANGE[0] && entityNumber < AVATAR_ENTITY_RANGE[1]) return { k: 'avatar' }

  const applied = entity.appliedComponents

  if (applied.gltfContainer?.value?.src) return { k: 'gltf' }

  const meshCase = applied.meshRenderer?.info?.mesh?.$case
  if (meshCase === 'box' || meshCase === 'sphere' || meshCase === 'plane') {
    // `mesh: null` with a supported $case means the host failed to build it.
    return { k: meshCase, ghost: applied.meshRenderer?.mesh ? undefined : true }
  }
  if (meshCase === 'cylinder') {
    // Declared but never built headlessly (see mesh-renderer-component).
    return { k: 'cylinder', ghost: true }
  }

  return { k: 'node' }
}

function buildEntity(context: SceneContext, entityId: Entity, entity: BabylonEntity): ViewerEntity | null {
  if (entity.isDisposed()) return null

  const [entityNumber, entityVersion] = EntityUtils.fromEntityId(entityId)

  // getWorldMatrix() recomputes only when this entity was not already computed
  // for the current render id, so inside onAfterRender it is a cache read for
  // everything the frame touched and an on-demand compute for the rest. It also
  // walks parents itself, so the emitted transform is true world space
  // (including the scene's parcel offset on rootNode) regardless of map order.
  entity.getWorldMatrix().decompose(tmpScale, tmpRotation, tmpPosition)

  const { k, ghost } = classify(entity, entityNumber)

  const result: ViewerEntity = {
    id: entityNumber,
    v: entityVersion,
    k,
    p: [round(tmpPosition.x), round(tmpPosition.y), round(tmpPosition.z)],
    q: [round(tmpRotation.x), round(tmpRotation.y), round(tmpRotation.z), round(tmpRotation.w)],
    s: [round(tmpScale.x), round(tmpScale.y), round(tmpScale.z)]
  }

  if (ghost) result.ghost = true

  const src = entity.appliedComponents.gltfContainer?.value?.src
  if (src) {
    // Resolve through the scene's own content mapping — the same path the host
    // used to fetch it — so the viewer loads the identical bytes and cannot be
    // pointed at an arbitrary URL by scene content.
    const absolute = resolveFileAbsolute(context.loadableScene, src)
    if (absolute) result.src = absolute
    const loadingState = context.components[gltfContainerLoadingStateComponent.componentId]?.getOrNull(entityId) as
      | { currentState?: number }
      | null
    if (loadingState?.currentState !== undefined) result.ls = loadingState.currentState
  }

  const name = entity.appliedComponents.avatarBase?.name
  if (name) result.n = name

  const colliderCase = entity.appliedComponents.meshCollider?.info?.mesh?.$case
  if (colliderCase) result.col = colliderCase

  return result
}

/**
 * Snapshot every loaded scene's entity graph as the HOST currently holds it.
 *
 * `maxEntities` is a per-snapshot cap across all scenes: scene CRDT is untrusted
 * and `maxLiveEntities` defaults to 50k, so an uncapped snapshot would let a
 * scene turn one connected viewer into a per-frame multi-megabyte serialization
 * job on the main thread. Overflow is reported (`truncated`) rather than silently
 * dropped — a viewer showing part of a scene must say so.
 */
export function buildSnapshot(scenes: Iterable<SceneContext>, maxEntities: number): ViewerSnapshot {
  const result: ViewerSnapshot = { t: 'snapshot', time: Math.round(performance.now()), scenes: [] }

  let remaining = maxEntities

  for (const context of scenes) {
    const scene: ViewerScene = {
      id: context.entityId,
      urn: context.loadableScene.urn,
      base: context.metadata?.scene?.base,
      parcels: context.metadata?.scene?.parcels,
      entities: []
    }
    result.scenes.push(scene)

    let truncated = 0
    for (const [entityId, entity] of context.entities) {
      if (remaining <= 0) {
        truncated++
        continue
      }
      let built: ViewerEntity | null = null
      try {
        built = buildEntity(context, entityId, entity)
      } catch {
        // Per-entity isolation: a half-applied component from untrusted CRDT
        // must cost one missing box in the viewer, not the whole snapshot.
        built = null
      }
      if (built) {
        scene.entities.push(built)
        remaining--
      }
    }
    if (truncated) scene.truncated = truncated
  }

  return result
}
