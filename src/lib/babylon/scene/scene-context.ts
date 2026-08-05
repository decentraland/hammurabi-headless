import * as BABYLON from '@babylonjs/core'
import future, { IFuture } from 'fp-future'
import { Transport as RpcTransport } from '@dcl/rpc'
import { Entity } from '../../decentraland/types'

import { EngineApiInterface } from '../../decentraland/scene/types'
import { CrdtMessageType, readAllMessages } from '../../decentraland/crdt-wire-protocol'
import { ByteBuffer, ReadWriteByteBuffer } from '../../decentraland/ByteBuffer'
import { LoadableScene, resolveFile, resolveFileAbsolute } from '../../decentraland/scene/content-server-entity'
import { BabylonEntity } from './BabylonEntity'
import { transformComponent } from '../../decentraland/sdk-components/transform-component'
import { createLwwStore } from '../../decentraland/crdt-internal/last-write-win-element-set'
import { ComponentDefinition } from '../../decentraland/crdt-internal/components'
import { resolveCyclicParenting } from './logic/cyclic-transform'
import { Vector3 } from '@babylonjs/core'
import { Scene } from '@dcl/schemas'
import { billboardComponent } from '../../decentraland/sdk-components/billboard-component'
import { raycastComponent, raycastResultComponent } from '../../decentraland/sdk-components/raycast-component'
import { meshRendererComponent } from '../../decentraland/sdk-components/mesh-renderer-component'
import { processRaycasts } from './logic/raycasts'
import { meshColliderComponent } from '../../decentraland/sdk-components/mesh-collider-component'
import { PARCEL_SIZE_METERS, gridToWorld, parseParcelPosition } from '../../decentraland/positions'
import { createParcelOutline } from '../visual/parcelOutline'
import {
  CrdtGetStateResponse,
  CrdtSendToRendererRequest,
  CrdtSendToResponse
} from '@dcl/protocol/out-js/decentraland/kernel/apis/engine_api.gen'
import { gltfContainerComponent } from '../../decentraland/sdk-components/gltf-component'
import { AssetManager } from './AssetManager'
import { pointerEventsComponent } from '../../decentraland/sdk-components/pointer-events'
import {
  StaticEntities,
  MAX_RESERVED_ENTITY,
  AVATAR_ENTITY_RANGE,
  entityIsInRange,
  updateStaticEntities
} from './logic/static-entities'
import { disposeAvatarCapsules, updateAvatarColliders } from './logic/avatar-colliders'
import { enforceColliderBounds } from './logic/scene-bounds'
import { updateProximityInteractions } from './logic/proximity-interaction'
import { isDeniedSceneCrdtOp, sanitizeSceneCrdt } from './logic/scene-crdt-guard'
import { globalCoordinatesToSceneCoordinates } from './coordinates'
import { animatorComponent } from '../../decentraland/sdk-components/animator-component'
import { engineInfoComponent } from '../../decentraland/sdk-components/engine-info'
import { gltfContainerLoadingStateComponent } from '../../decentraland/sdk-components/gltf-loading-state'
import { LoadingState } from '@dcl/protocol/out-js/decentraland/sdk/components/common/loading_state.gen'
import { pointerEventsResultComponent } from '../../decentraland/sdk-components/pointer-events-result'
import { createValueSetComponentStore } from '../../decentraland/crdt-internal/grow-only-set'
import { VirtualSceneSubscription } from '../../decentraland/virtual-scene'
import { MAX_ENTITY_NUMBER } from '../../decentraland/crdt-internal/generational-index-pool'
import { avatarShapeComponent } from '../../decentraland/sdk-components/avatar-shape'
import { avatarBaseComponent } from '../../decentraland/sdk-components/avatar-base'
// import { delayedInterpolationComponent } from '../../decentraland/sdk-components/delayed-interpolation'
import { tweenComponent } from '../../decentraland/sdk-components/tween'
import { materialComponent } from '../../decentraland/sdk-components/material-component'
import { realmInfoComponent } from '../../decentraland/sdk-components/realm-info'
import { CommsTransportWrapper } from '../../decentraland/communications/CommsTransportWrapper'
import {
  createAvatarCommunicationSystem,
  AvatarCommunicationSystem
} from '../../decentraland/communications/avatar-communication-system'
import { limits } from '../../misc/limits'
import { limitLogger } from '../../misc/limit-logger'
import { createRateLimitedErrorLogger } from '../../misc/logger'

const SCENE_ENTITY_RANGE: [number, number] = [1, MAX_ENTITY_NUMBER]

// Untrusted-input bounds. Scene CRDT is fully attacker-controlled and is applied
// in HOST code, outside the isolate's memory/execution limits — so these caps
// are what keep a hostile scene from exhausting the worker's heap. The drop itself
// stays per-drop-silent (no cost on the hot path); a hit is reported to the
// THROTTLED limitLogger, which emits at most once per interval so a scene can't
// amplify the log — the operator still gets a signal that the cap is being hit.
const MAX_LIVE_ENTITIES = limits.maxLiveEntities // concurrent host BabylonEntity objects per scene (HAMMURABI_MAX_LIVE_ENTITIES)
const MAX_DELETED_TOMBSTONES = limits.maxDeletedTombstones // retained delete tombstones per scene (HAMMURABI_MAX_DELETED_TOMBSTONES)
const MAX_CRDT_PAYLOAD_BYTES = limits.maxCrdtPayloadBytes // per crdtSendToRenderer call (HAMMURABI_MAX_CRDT_PAYLOAD_BYTES)

// DEBUG-only entity-provenance tracer (opt-in). Scans CRDT crossing the
// scene<->host boundary and logs component ops on RESERVED entities (<512) and
// any DELETE_ENTITY, so a scene component appearing on an avatar/reserved slot
// (or a scene-range entity being deleted by the host) is caught red-handed.
// Matches the HAMMURABI_XHR_DEBUG convention: only 1/true/yes/on enable it, so
// HAMMURABI_DEBUG_ENTITY_PROVENANCE=0 / =false read as "off".
const DEBUG_ENTITY_PROVENANCE = ['1', 'true', 'yes', 'on'].includes(
  (process.env.HAMMURABI_DEBUG_ENTITY_PROVENANCE ?? '').toLowerCase()
)
// Exported for tests. Scene entities are always >= RESERVED_STATIC_ENTITIES (512);
// avatar/reserved entities live in 32..255. A scene component op on a reserved
// entity, or a DELETE_ENTITY targeting a scene-range entity, is anomalous and the
// signal we want to surface. Logging only — never mutates state.
export function debugScanCrdt(dir: string, buffers: Uint8Array[]) {
  for (const buf of buffers) {
    if (!buf || !buf.byteLength) continue
    for (const m of readAllMessages(new ReadWriteByteBuffer(buf))) {
      const eid = (m as { entityId: number }).entityId
      const num = eid & 0xffff
      const ver = (eid >>> 16) & 0xffff
      const isCompOp =
        m.type === CrdtMessageType.PUT_COMPONENT ||
        m.type === CrdtMessageType.DELETE_COMPONENT ||
        m.type === CrdtMessageType.APPEND_VALUE
      if (isCompOp && num < 512) {
        const componentId = (m as { componentId?: number }).componentId
        console.log(`[ENTITY-PROVENANCE] ${dir} compOp type=${m.type} comp=${componentId} entity=${num}v${ver} (id=${eid}) RESERVED`)
      }
      if (m.type === CrdtMessageType.DELETE_ENTITY) {
        console.log(`[ENTITY-PROVENANCE] ${dir} DELETE_ENTITY entity=${num}v${ver} (id=${eid})${num >= 512 ? ' SCENE-RANGE!' : ''}`)
      }
    }
  }
}
const MAX_INCOMING_QUEUE = limits.maxIncomingQueue // queued CRDT buffers awaiting processing (HAMMURABI_MAX_INCOMING_QUEUE)
// Inbound ADR-104 scene-bus messages from remote peers, awaiting the scene to
// drain them via CommunicationsController.sendBinary. A scene that never uses the
// MessageBus never drains this, so it must be bounded or a peer can drive the
// worker's heap up with scene-cased packets (drop-oldest). (HAMMURABI_MAX_NETWORK_MESSAGE_QUEUE)
const MAX_NETWORK_MESSAGE_QUEUE = limits.maxNetworkMessageQueue

let incrementalId = 0

export class SceneContext implements EngineApiInterface {
  entities = new Map<Entity, BabylonEntity>()
  #ref = new WeakRef(this)
  rootNode: BabylonEntity

  readonly entityId: string

  private _transport?: CommsTransportWrapper
  private _avatarSystem?: AvatarCommunicationSystem
  // this future is resolved when the scene is disposed
  readonly stopped = future<void>()
  // RPC transports owned by this scene (registered by the runtime connector,
  // e.g. the isolated-vm memory transport). Unlike the shared comms transport
  // below, these die with the scene: dispose() closes them, which flips the
  // scene runtime's port to 'closed' and ends its update loop. Owning this
  // here (not at each connector call site) means every runtime flavor gets
  // hot-reload shutdown for free.
  private readonly rpcTransports: RpcTransport[] = []

  readonly metadata: Scene

  // after the "tick" is completed, resolving the futures will send back the CRDT
  // updates to the scripting scene
  nextFrameFutures: Array<IFuture<{ data: Array<Uint8Array> }>> = []
  // stash of incoming CRDT messages from the scripting scene, processed using a
  // quota each renderer frame. ByteBuffer reading is continuable using iterators.
  // the incoming messages also include the range of allowe entities that the origin
  // transports had access to
  incomingMessages: {
    buffer: ByteBuffer
    readonly allowedEntityRange: readonly [number, number]
    // True when the buffer originates from the untrusted scene runtime
    // (crdtSendToRenderer / main.crdt) rather than a trusted host subscription
    // (avatar system, virtual scenes). Scene-sourced ops are subject to the
    // write guard (see scene-crdt-guard.ts): component ops are denied on the
    // avatar range, DELETE_ENTITY on the whole reserved range.
    readonly sceneSourced?: boolean
  }[] = []

  // stash of outgoing messages ready to be sent to back to the scripting scene
  outgoingMessagesBuffer: ByteBuffer = new ReadWriteByteBuffer()

  // when we finish to process all the income messages of a tick,
  // set finishedProcessingFrame to true to send the outgoing messages, then to false.
  finishedProcessingIncomingMessagesOfTick: boolean = false

  // the follwing set contains a list of pending raycast queries. if a query is continous,
  // it won't be removed from the set
  pendingRaycastOperations = new Set<Entity>()

  // Where processRaycasts resumes next frame. The per-frame budget used to be
  // spent from the head of this set every time, and a Set iterates in insertion
  // order — so once a scene had more raycasts than one frame can afford, the same
  // prefix won forever and the tail NEVER ran. Measured: 3 identical continuous
  // raycasts against a budget fitting one, and raycasts 2 and 3 produced no result
  // across 20 frames. Advancing this each frame turns that into round-robin.
  raycastRotationCursor = 0

  /**
   * Live entities in the avatar-comms range (32..255), maintained as they are
   * created and removed so `updateAvatarColliders` does not have to find them.
   *
   * It cannot find them by probing raw ids: `PlayerEntityManager` VERSION-PACKS them
   * (`toEntityId(number, version + 1)` on slot reuse), so a slot's second occupant is
   * `32 | (1 << 16)` and a `32..255` loop never reaches it — every player after the
   * first join/leave cycle on a slot was invisible to CL_PLAYER raycasts. Scanning
   * all of `entities` instead would be O(entity cap) every frame per scene.
   *
   * Membership is tested with `entityIsInRange`, which UNPACKS the version.
   */
  playerEntities = new Set<Entity>()

  // log function for tests
  log: (...args: any[]) => void = (...args) => console.log(this.rootNode.name, ...args)

  // Throttled sink for the per-frame catch blocks in lateUpdate. A failure caused
  // by untrusted data (a peer profile, a scene value) recurs at tick rate, so an
  // unthrottled console.error would itself be the amplification vector. One
  // instance per scene so a noisy scene cannot suppress another scene's errors.
  private readonly logFrameError = createRateLimitedErrorLogger()

  // tick counter for EngineInfo
  currentTick = 0

  // start time for EngineInfo
  readonly startTime = performance.now()
  // start frame for EngineInfo
  readonly startFrame = this.babylonScene.getEngine().frameId

  // contents of the main.crdt file
  mainCrdt: Uint8Array = Uint8Array.of()

  components = {
    [transformComponent.componentId]: createLwwStore(transformComponent),
    [billboardComponent.componentId]: createLwwStore(billboardComponent),
    [raycastComponent.componentId]: createLwwStore(raycastComponent),
    [raycastResultComponent.componentId]: createLwwStore(raycastResultComponent),
    [meshRendererComponent.componentId]: createLwwStore(meshRendererComponent),
    [meshColliderComponent.componentId]: createLwwStore(meshColliderComponent),
    [gltfContainerComponent.componentId]: createLwwStore(gltfContainerComponent),
    [pointerEventsComponent.componentId]: createLwwStore(pointerEventsComponent),
    [pointerEventsResultComponent.componentId]: createValueSetComponentStore(pointerEventsResultComponent, {
      maxElements: 10,
      timestampFunction(value) {
        return value.tickNumber
      }
    }),
    [animatorComponent.componentId]: createLwwStore(animatorComponent),
    [gltfContainerLoadingStateComponent.componentId]: createLwwStore(gltfContainerLoadingStateComponent),
    [engineInfoComponent.componentId]: createLwwStore(engineInfoComponent),
    [avatarShapeComponent.componentId]: createLwwStore(avatarShapeComponent),
    [avatarBaseComponent.componentId]: createLwwStore(avatarBaseComponent),
    [tweenComponent.componentId]: createLwwStore(tweenComponent),
    // [delayedInterpolationComponent.componentId]: createLwwStore(delayedInterpolationComponent),
    [materialComponent.componentId]: createLwwStore(materialComponent),
    [realmInfoComponent.componentId]: createLwwStore(realmInfoComponent)
  } as const

  // cached because lateUpdate iterates the components every frame and
  // Object.values allocates a fresh array per call
  private readonly componentList = Object.values(this.components)

  // this flag is changed every time an entity changed its parent. the change
  // in the hierarchy is not immediately applied, instead, it should be queued
  // in the unparentedEntities set. Once there, at the end of the "tick", the
  // scene will perform all possible acyclic updates of entities to prevent
  // breaking the Babylon's hierarcy and generating stack overflows while calculating
  // the world matrix of the entitiesg
  hierarchyChanged: boolean = false
  unparentedEntities = new Set<Entity>()

  // the assetmanager is used to centralize all the loading/unloading of assets
  // of this scene.
  assetManager = new AssetManager(this.loadableScene, this.babylonScene)

  // bounding vectors to calculate the distance to the outer bounds of the scene
  // for the throttling mechanism
  boundingBox?: BABYLON.BoundingBox

  // subscriptions to other scene's CRDT updates
  subscriptions: VirtualSceneSubscription[] = []

  subscriptionsBuffer = new ReadWriteByteBuffer()

  // TODO: this should be the optimized data structure to keep track of deleted entities
  // instead of a set
  deletedEntities = new Set<Entity>()
  id: number = incrementalId++

  constructor(
    public babylonScene: BABYLON.Scene,
    public loadableScene: LoadableScene,
    public isGlobalScene: boolean,
    entityId: string
  ) {
    this.entityId = entityId
    this.rootNode = this.getOrCreateEntity(StaticEntities.RootEntity)
    // the rootNode must be positioned according to the value of the "scenes.base" of the scene metadata (scene.json)
    this.metadata = loadableScene.entity.metadata as Scene
    if (this.metadata.scene?.base) {
      const base = parseParcelPosition(this.metadata.scene.base)
      this.rootNode.name = this.metadata.scene.base
      gridToWorld(base.x, base.y, this.rootNode.position)

      const r = createParcelOutline(babylonScene, this.metadata.scene.base, this.metadata.scene.parcels)
      r.result.parent = this.rootNode
    }

    // calculate a naive bounding box for the scene to calculate the distance to the outer bounds
    // and use that distance to prioritize the message quota for ADR-148
    if (this.metadata.scene?.parcels) {
      let minX: number | null = null
      let minZ: number | null = null
      let maxX: number | null = null
      let maxZ: number | null = null
      for (const position of this.metadata.scene.parcels) {
        const vec = parseParcelPosition(position)
        if (minX == null || vec.x < minX) minX = vec.x
        if (minZ == null || vec.y < minZ) minZ = vec.y
        if (maxX == null || vec.x > maxX) maxX = vec.x
        if (maxZ == null || vec.y > maxZ) maxZ = vec.y
      }

      // as per https://docs.decentraland.org/creator/development-guide/scene-limitations/
      const height = Math.log2(this.metadata.scene.parcels.length + 1) * 20

      // `minX !== null`, not `if (minX)`. A parcel coordinate of 0 is falsy, so a
      // scene whose leftmost parcel sits on x=0 built NO bounding box at all — it
      // was never frustum-culled, and now would never have its colliders
      // bounds-checked either. raycast-stale-bounds.spec.ts picks parcel 1,1
      // specifically to dodge this.
      if (minX !== null) {
        this.boundingBox = new BABYLON.BoundingBox(
          new Vector3(minX! * PARCEL_SIZE_METERS, -1, minZ! * PARCEL_SIZE_METERS),
          new Vector3((maxX! + 1) * PARCEL_SIZE_METERS, height, (maxZ! + 1) * PARCEL_SIZE_METERS)
        )
      }
    }
  }

  async initAsyncJobs() {
    // load the main.crdt as specified by ADR-133 and ADR-148. the tick number zero
    // is always completed by either the contents of main.crdt or by an empty array
    try {
      const file = 'main.crdt'
      if (resolveFileAbsolute(this.loadableScene, file)) {
        const { content } = await this.readFile(file)
        // main.crdt is scene-authored (untrusted) initial state. Sanitize it ONCE
        // here so it obeys the same write guard as runtime scene CRDT, and store
        // the sanitized bytes — crdtGetState echoes this.mainCrdt back to the
        // scene, so echoing the raw bytes would hand the scene avatar/reserved ops
        // the host itself rejected (host/scene initial-state divergence).
        this.mainCrdt = sanitizeSceneCrdt(content).bytes
        this.incomingMessages.push({ buffer: new ReadWriteByteBuffer(this.mainCrdt), allowedEntityRange: SCENE_ENTITY_RANGE, sceneSourced: true })
      }
    } catch (err: any) {
      this.log(err)
    }
  }

  // this function returns the total elapsed time in seconds since the SceneContext was created
  getElapsedTime() {
    return (performance.now() - this.startTime) / 1000
  }

  // naivest implementation of the distance to the outer bounds of the scene
  distanceToPoint(point: BABYLON.Vector3) {
    if (!this.boundingBox) return 0
    if (this.boundingBox?.intersectsPoint(point)) return 0
    return this.boundingBox?.centerWorld.subtract(point).length()
  }

  removeEntity(entityId: Entity) {
    this.deletedEntities.add(entityId)
    // Bound the tombstone set: a scene can DELETE_ENTITY unbounded distinct ids.
    // Evict the oldest tombstone once over the cap (insertion order).
    if (this.deletedEntities.size > MAX_DELETED_TOMBSTONES) {
      const oldest = this.deletedEntities.values().next().value
      if (oldest !== undefined) this.deletedEntities.delete(oldest)
      limitLogger.hit('maxDeletedTombstones')
    }
    const entity = this.getEntityOrNull(entityId)
    if (entity) {
      // Babylon's dispose(doNotRecurse=true) detaches children to parent=null —
      // the WORLD root, not this scene's rootNode — which silently drops the
      // scene offset (entities teleport toward world origin for scenes off
      // parcel 0,0) and removes them from the rootNode subtree that raycasts
      // and culling traverse. Schedule them for reparenting instead: their
      // expectedParentEntityId now points at a tombstoned entity, so the
      // deleted-parent branch of resolveCyclicParenting re-roots them.
      for (const child of entity.childrenEntities()) {
        this.unparentedEntities.add(child.entityId)
      }
      this.hierarchyChanged = true
      // Before dispose: TransformNode.dispose(doNotRecurse) DETACHES children rather
      // than disposing them, so an avatar capsule would be orphaned into scene.meshes
      // and re-evaluated every frame for the life of the process.
      disposeAvatarCapsules(entity)
      entity.dispose()
      // dispose() only clears the component VALUES (entityDeleted). The CRDT
      // bookkeeping (LWW timestamps / updatedAtTick) must be purged explicitly
      // or it grows one entry per component per deleted id forever — outside
      // every documented cap, over 2^32 generational ids of untrusted input.
      // TRADE-OFF: while the id remains in deletedEntities, its updates are
      // dropped by the guard in update() and the purged timestamps are never
      // consulted. Once the tombstone itself is evicted (past
      // MAX_DELETED_TOMBSTONES, i.e. 100k+ subsequent deletions), a stale PUT
      // for this id would be accepted as fresh — a ghost bounded by
      // MAX_LIVE_ENTITIES. Deliberately accepted: retaining timestamps past
      // tombstone eviction is exactly the unbounded growth this purge fixes.
      for (const component of this.componentList) {
        component.purgeEntity(entityId)
      }
      this.entities.delete(entityId)
      this.unparentedEntities.delete(entityId)
      this.playerEntities.delete(entityId)
    }
  }

  /**
   * UNCAPPED creation — private so no future CRDT-input path can reach it and
   * silently bypass MAX_LIVE_ENTITIES; scene/CRDT-driven code must go through
   * tryGetOrCreateEntity, host-initiated static entities through
   * getOrCreateStaticEntity.
   */
  private getOrCreateEntity(entityId: Entity): BabylonEntity {
    let entity = this.entities.get(entityId)
    if (!entity) {
      entity = new BabylonEntity(entityId, this.#ref)
      // every new entity is parented to the scene's rootEntity by default
      entity.parent = this.rootNode
      this.entities.set(entityId, entity)
      if (entityIsInRange(entityId, AVATAR_ENTITY_RANGE)) this.playerEntities.add(entityId)
    }
    return entity
  }

  /**
   * Host-initiated entities in the reserved static range only (root, player,
   * camera). The range guard keeps this narrow accessor from becoming a
   * general uncapped-creation backdoor.
   */
  getOrCreateStaticEntity(entityId: Entity): BabylonEntity {
    if (entityId >= MAX_RESERVED_ENTITY) {
      throw new Error(`getOrCreateStaticEntity is reserved for static entities (< ${MAX_RESERVED_ENTITY}), got ${entityId}`)
    }
    return this.getOrCreateEntity(entityId)
  }

  /**
   * Cap-aware variant for untrusted CRDT input: never creates a NEW entity past
   * MAX_LIVE_ENTITIES (already-live entities are always returned). Every path
   * that materializes entities from scene messages must go through this, or the
   * cap can be amplified (e.g. transforms referencing nonexistent parents).
   */
  tryGetOrCreateEntity(entityId: Entity): BabylonEntity | null {
    if (!this.entities.has(entityId) && this.entities.size >= MAX_LIVE_ENTITIES) {
      limitLogger.hit('maxLiveEntities')
      return null
    }
    return this.getOrCreateEntity(entityId)
  }

  // Throttle state for the scene write-guard log: a scene bug (or a hostile
  // scene) hitting the guard every frame must not flood stdout. Same reasoning
  // as limitLogger, but this is not a configurable resource cap, so it keeps a
  // local 1s throttle with a suppressed-count on the next emission.
  private lastBlockedSceneWriteLogMs = 0
  private blockedSceneWritesSuppressed = 0

  private logBlockedSceneWrite(crdtMessage: { entityId: number; type: number; componentId?: number }) {
    const now = Date.now()
    if (now - this.lastBlockedSceneWriteLogMs < 1000) {
      this.blockedSceneWritesSuppressed++
      return
    }
    const suppressed = this.blockedSceneWritesSuppressed
    this.blockedSceneWritesSuppressed = 0
    this.lastBlockedSceneWriteLogMs = now
    console.warn(
      `[SceneContext] Blocked scene CRDT op on reserved entity: type=${crdtMessage.type} entity=${crdtMessage.entityId}` +
      (crdtMessage.componentId !== undefined ? ` component=${crdtMessage.componentId}` : '') +
      (suppressed > 0 ? ` (+${suppressed} suppressed since last log)` : '')
    )
  }

  getEntityOrNull(entityId: Entity): BabylonEntity | null {
    return this.entities.get(entityId) || null
  }

  /**
   * The "update" function handles all the incoming messages from the scene and
   * applies the changes to the renderer entities.
   *
   * This function is declared as a property to be added and removed to the
   * rendering engine without binding the SceneContext object.
   *
   * Returns false if the quota was exceeded. True if there is still time to continue
   * processing more messages, similar to cooperative scheduling.
   */
  update(hasQuota: () => boolean) {
    let rollingOperationCounter = 0

    // Resume any reparenting work a previous quota-bounded frame left pending
    // (resolveCyclicParenting re-flags hierarchyChanged when it yields early);
    // without this, leftover work would only resume when a NEW message arrives.
    if (this.hierarchyChanged) {
      resolveCyclicParenting(this, hasQuota)
    }

    // process all the incoming messages
    while (this.incomingMessages.length) {
      const message = this.incomingMessages[0]

      for (const crdtMessage of readAllMessages(message.buffer)) {
        // Structured as fall-through (no `continue`) so EVERY parsed message
        // reaches the quota check below — including ones skipped here
        // (already-deleted, guard-denied, out-of-range, or dropped at the entity
        // cap). Otherwise a scene could pack a large buffer with denied/no-op ops
        // and make the host parse/log/drop the whole thing in one update turn
        // instead of yielding every 10 ops.
        if (!this.deletedEntities.has(crdtMessage.entityId)) {
          if (message.sceneSourced && isDeniedSceneCrdtOp(crdtMessage)) {
            // Scene write guard: drop ops the untrusted scene runtime must not
            // perform — component ops on the avatar range, DELETE_ENTITY on the
            // whole reserved range (see scene-crdt-guard.ts). Trusted host
            // subscriptions (avatar system, virtual scenes) are not scene-sourced
            // and pass through, so avatar removal still works.
            this.logBlockedSceneWrite(crdtMessage)
          } else if (
            crdtMessage.type === CrdtMessageType.APPEND_VALUE ||
            crdtMessage.type === CrdtMessageType.DELETE_COMPONENT ||
            crdtMessage.type === CrdtMessageType.PUT_COMPONENT
          ) {
            // NOTE: the historical allowed-range check stays disabled for component
            // ops — scenes legitimately write to static entities (InputModifier on
            // PlayerEntity, camera components) and possibly RootEntity, so a
            // positive allowlist here would need protocol archaeology.

            // Bound host memory: a scene can stream PUT/APPEND for unbounded
            // distinct entity ids (entity number + generational version), each
            // allocating a host BabylonEntity. Refuse to create NEW entities past
            // a hard ceiling; updates to already-live entities still apply.
            const entity = this.tryGetOrCreateEntity(crdtMessage.entityId)
            if (entity) {
              const component = (this.components as any)[crdtMessage.componentId] as ComponentDefinition<any> | void

              // if the change is accepted, then we instruct the entity to update its internal state
              // via putComponent or deleteComponent calls
              if (component && component.updateFromCrdt(crdtMessage, this.outgoingMessagesBuffer)) {
                if (
                  crdtMessage.type === CrdtMessageType.PUT_COMPONENT ||
                  crdtMessage.type === CrdtMessageType.APPEND_VALUE
                ) {
                  entity.putComponent(component)
                } else {
                  entity.deleteComponent(component)
                }
              }
            }
          } else if (crdtMessage.type === CrdtMessageType.DELETE_ENTITY) {
            // ignore updates of entities outside range
            if (entityIsInRange(crdtMessage.entityId, message.allowedEntityRange)) {
              this.removeEntity(crdtMessage.entityId)
            }
          }
        }

        // If we exceeded the quota, finish processing this "message" and yield
        // control back to the event loop. The message just handled is already
        // behind the read cursor, so resuming re-reads from the next one.
        if (++rollingOperationCounter % 10 == 0 && !hasQuota()) {
          return false
        }
      }

      // at this point, the whole "message" was consumed, we proceed to its removal
      this.incomingMessages.shift()

      // this process resolves the re parenting of all entities preventing cycles
      resolveCyclicParenting(this, hasQuota)
    }

    // Update avatar system if it exists
    if (this._avatarSystem) {
      this._avatarSystem.update()
    }

    // mark the frame as processed. this signals the lateUpdate to respond to the scene with updates
    this.finishedProcessingIncomingMessagesOfTick = true
    return true
  }

  /**
   * lateUpdate should run in each frame AFTER the physics are processed. This is described
   * in ADR-148.
   *
   * The lateUpdate function is declared as a property to be added and removed to the
   * rendering engine without binding the SceneContext object.
   *
   * EXCEPTION SAFETY: everything after the early returns runs inside try/finally.
   * Component serializers CAN throw on untrusted data (e.g.
   * `PBAvatarEquippedData.encode` iterates `profile.avatar?.wearables`, which
   * comes straight from a peer-announced profile: a non-iterable value throws
   * TypeError). That throw is swallowed upstream (per-system try/catch in
   * `addSystems`, per-scene try/catch in the tick system), so before this the
   * process survived with damaged state: both shared buffers kept their residue
   * (re-delivered AND re-ingested as stale messages, growing by a frame's worth
   * of messages every frame while the bad value persisted) and `nextFrameFutures`
   * stayed unresolved, so the scene's `crdtSendToRenderer` never returned and its
   * turn hung until the async-turn watchdog disposed the isolate.
   */
  lateUpdate() {
    // only emit messages if there are receiver promises
    if (!this.nextFrameFutures.length) return

    // only finalize the frame once the incoming messages were cleared
    if (!this.finishedProcessingIncomingMessagesOfTick) return

    // on the first frame, as per ADR-148, the crdtSendToRenderer should only respond
    // if and only if all assets finished loading to properly process the raycasts
    //
    // to compy with that statement, we early-finalize this procedure if a component is in
    // LOADING state. the engine will catch up and finish the crdtSendToRenderer on the
    // next renderer frame
    if (this.currentTick === 0) {
      const loadingComponents = this.components[gltfContainerLoadingStateComponent.componentId]
      let has = false
      for (const [_entity, component] of loadingComponents.iterator()) {
        has = true
        if (component.currentState === LoadingState.LOADING) {
          return
        }
      }
      this.log('\n\n\n\n======================= Starting Scene Logs: ======================= \n\n')
    }

    const outMessages: Uint8Array[] = []

    try {
      // BEFORE the raycasts: they read collider enabled-state and avatar capsules that
      // this pass creates, moves and disables. See updateInteractionSystems.
      this.updateInteractionSystems()

      processRaycasts(this)

      // TODO: Execute queries into this.outgoingMessages
      // TODO: Collect events into this.outgoingMessages

      // update the components of the static entities to be sent to the scene
      this.updateStaticEntities()

      // write all the CRDT updates in the outgoingMessagesBuffer. Contained per
      // component: one component whose value fails to serialize drops only ITS
      // updates for this frame instead of aborting the whole frame.
      for (const component of this.componentList) {
        try {
          component.dumpCrdtUpdates(this.outgoingMessagesBuffer)
        } catch (err: any) {
          this.logFrameError(`Scene ${this.entityId}: dumpCrdtUpdates failed for component ${component.componentId}`, err)
        }
      }

      // forward all messages from all subscriptions
      for (const subscription of this.subscriptions) {
        try {
          try {
            subscription.getUpdates(this.subscriptionsBuffer)
          } catch (err: any) {
            // Contained per subscription: a failing subscription must not cost
            // the other subscriptions (or the frame) their updates. Whatever it
            // managed to write is still forwarded below, and a SERIALIZER throw
            // cannot leave a half-written message there: each value is serialized
            // into the scratch buffer (an argument, fully evaluated) before the
            // first byte of its CRDT message is emitted.
            this.logFrameError(`Scene ${this.entityId}: subscription.getUpdates failed`, err)
          }

          if (this.subscriptionsBuffer.currentWriteOffset()) {
            // COPY, not a view: subscriptionsBuffer is shared across subscriptions and
            // reset+rewritten in place on the NEXT loop iteration, which would clobber
            // this subscription's still-referenced bytes (both the outMessages entry
            // and the incomingMessages buffer below) before they are consumed. Unlike
            // outgoingMessagesBuffer (a single view consumed on a microtask), this one
            // is reused synchronously within the same frame.
            const binary = this.subscriptionsBuffer.toCopiedBinary()
            // send the messages from the subscriptions to the scenes
            outMessages.push(binary)
            // auto process the messages from the subscriptions
            this.incomingMessages.push({ buffer: new ReadWriteByteBuffer(binary), allowedEntityRange: subscription.range })
          }
        } finally {
          // reset the buffer — ALWAYS, even if the block above threw. Residue
          // here is re-delivered to the scene AND re-ingested as incoming
          // messages on every later frame, and the buffer never shrinks.
          this.subscriptionsBuffer.incrementWriteOffset(-this.subscriptionsBuffer.currentWriteOffset())
          this.subscriptionsBuffer.incrementReadOffset(-this.subscriptionsBuffer.currentReadOffset())
        }
      }

      try {
        if (this.outgoingMessagesBuffer.currentWriteOffset()) {
          outMessages.push(this.outgoingMessagesBuffer.toBinary())
        }
      } finally {
        // Same rationale as above: an unreset outgoing buffer re-sends every
        // message it still holds on each subsequent frame, forever.
        this.outgoingMessagesBuffer.incrementWriteOffset(-this.outgoingMessagesBuffer.currentWriteOffset())
        this.outgoingMessagesBuffer.incrementReadOffset(-this.outgoingMessagesBuffer.currentReadOffset())
      }
    } finally {
      // BACKSTOP: reset both shared buffers unconditionally, whatever threw and
      // wherever. The inner `finally` blocks above only run once their `try` has
      // been entered, so a throw from an EARLIER step in this method —
      // processRaycasts, updateStaticEntities, or the component dump loop — would
      // otherwise skip them and leave residue that is re-sent to the scene AND
      // re-ingested as incoming messages on every later frame, in a buffer that
      // never shrinks. Resetting twice on the happy path is free: the offsets are
      // already zero, so both calls are no-ops.
      //
      // Ordering is safe with respect to the TIMING HAZARD below: resetting a write
      // offset does not zero the bytes, and the views in `outMessages` are copied by
      // the RPC layer on a microtask before the next frame can overwrite them.
      this.subscriptionsBuffer.incrementWriteOffset(-this.subscriptionsBuffer.currentWriteOffset())
      this.subscriptionsBuffer.incrementReadOffset(-this.subscriptionsBuffer.currentReadOffset())
      this.outgoingMessagesBuffer.incrementWriteOffset(-this.outgoingMessagesBuffer.currentWriteOffset())
      this.outgoingMessagesBuffer.incrementReadOffset(-this.outgoingMessagesBuffer.currentReadOffset())

      // TIMING HAZARD: outMessages holds toBinary() VIEWS into subscriptionsBuffer
      // and outgoingMessagesBuffer, whose write offsets were just reset for reuse.
      // This is safe ONLY because the futures resolved below are consumed (RPC
      // protobuf-encodes, i.e. copies, the bytes) on a microtask before the next
      // frame writes into these buffers. If that scheduling ever changes, switch
      // to toCopiedBinary() here.
      // finally resolve the future so the function "receiveBatch" is unblocked
      // and the next scripting frame is allowed to happen.
      // This MUST run even when something above threw: an unresolved future
      // leaves the scene's crdtSendToRenderer awaiting forever, hanging its turn
      // until the async-turn watchdog disposes the isolate.
      this.nextFrameFutures.forEach((fut) => fut.resolve({ data: outMessages }))
      // finally clean the futures
      this.nextFrameFutures.length = 0

      // increment the tick number, as per ADR-148
      this.currentTick++
      this.finishedProcessingIncomingMessagesOfTick = false
    }
  }

  /**
   * Registers an RPC transport owned by this scene; dispose() will close it,
   * which ends the scene runtime's update loop on hot reload. If the scene was
   * already disposed (a dispose racing runtime setup), the transport is closed
   * on the spot instead of leaking a runtime nothing would ever shut down.
   */
  registerRpcTransport(transport: RpcTransport) {
    if (!this.stopped.isPending) {
      transport.close()
      return
    }
    this.rpcTransports.push(transport)
  }

  dispose() {
    try {
      // Close scene-owned RPC transports first: the scene runtime's port flips
      // to 'closed' (ending its update loop) and in-flight scene RPCs reject
      // with 'RPC Transport closed' instead of hanging on a disposed scene.
      for (const transport of this.rpcTransports) {
        try {
          transport.close()
        } catch (err) {
          console.error(`Error closing RPC transport of scene ${this.entityId}:`, err)
        }
      }
      this.rpcTransports.length = 0

      for (const [entityId] of this.entities) {
        this.removeEntity(entityId)
      }
      for (const s of this.subscriptions) {
        s.dispose()
      }
      this.subscriptions.length = 0

      // Dispose avatar system if it exists
      if (this._avatarSystem) {
        this._avatarSystem.dispose()
        this._avatarSystem = undefined
      }

      // Unsubscribe this context's message-bus handler BEFORE dropping the
      // transport reference (the transport itself outlives this scene).
      if (this._transport && this.sceneMessageBusHandler) {
        this._transport.events.off('sceneMessageBus', this.sceneMessageBusHandler)
        this.sceneMessageBusHandler = undefined
      }

      // Clear transport reference but DON'T disconnect it.
      // The transport is shared and its lifecycle is managed by the caller (engine-main.ts).
      // This allows the transport to stay connected during hot-reload.
      this._transport = undefined

      this.assetManager.dispose()
      this.rootNode.parent = null
      this.rootNode.dispose(false)
    } finally {
      // The runtime shutdown hangs off this future: resolve it even when a
      // teardown step above throws (Babylon entity disposal runs real scene
      // teardown), or a hot reload would leave the old VM running forever
      // against a disposed scene.
      this.stopped.resolve()
    }
  }

  // this method exists to be a wrapper of the function. so it can be mocked for tests without wizzardy
  updateStaticEntities() {
    updateStaticEntities(this)
  }

  /**
   * Per-frame interaction systems, which MUST run before `processRaycasts`.
   *
   * They used to hang off `updateStaticEntities()`, which `lateUpdate` calls AFTER the
   * raycasts — so every raycast in a frame resolved against the previous frame's
   * collider state. That is not a cosmetic frame of lag in either direction:
   *
   *   frame 2  scene moves a collider OUT of its parcels   -> hit, position honoured
   *   frame 4  scene moves it BACK in, legally             -> no hit, collider dead
   *
   * A scene alternating every tick had its out-of-bounds geometry honoured on about
   * half of all frames, which is verbatim the griefing vector `scene-bounds.ts` exists
   * to close, while a legitimately moving platform re-entering its own parcel was
   * unhittable for a frame. The same ordering made a `CL_PLAYER` raycast miss on the
   * frame a capsule was first created.
   *
   * Order within the block matters too: capsules are created and placed first so the
   * bounds pass sees them, and proximity runs last so it reads post-bounds state.
   */
  updateInteractionSystems() {
    // Player entities exist as ordinary entities in this scene's CRDT (1 for the
    // local player, 32-255 for remote ones), but nothing gave them collision
    // geometry — so a CL_PLAYER raycast found nothing here while the client
    // reported hits.
    updateAvatarColliders(this)
    // Colliders that have left this scene's parcels stop existing for raycasts and
    // for avatar movement, matching the client. Runs after the avatar capsules so a
    // player who steps outside is not itself disabled — see scene-bounds.ts.
    enforceColliderBounds(this)
    // InteractionType.PROXIMITY pointer events fire on player nearness rather than
    // pointing, and had no implementation at all — a scene using proximity triggers
    // got nothing here while they worked for every real player.
    updateProximityInteractions(this)
  }

  // impl RuntimeApi {
  async readFile(file: string): Promise<{ content: Uint8Array; hash: string }> {
    return this.assetManager.readFile(file)
  }
  // }

  // returns a future that will be resolved when the next frame is processed
  async nextTick() {
    const fut = future<CrdtSendToResponse>()
    this.nextFrameFutures.push(fut)
    return fut
  }

  private async _crdtSendToRenderer(data: Uint8Array) {
    // Drop oversized batches and shed load when the queue is saturated so a scene
    // cannot exhaust host memory via huge or high-frequency CRDT payloads. The drop
    // itself is still silent (no per-drop cost); the throttled limitLogger below
    // surfaces WHICH cap is being hit at most once per interval.
    if (
      data.byteLength &&
      data.byteLength <= MAX_CRDT_PAYLOAD_BYTES &&
      this.incomingMessages.length < MAX_INCOMING_QUEUE
    ) {
      this.incomingMessages.push({ buffer: new ReadWriteByteBuffer(data), allowedEntityRange: SCENE_ENTITY_RANGE, sceneSourced: true })
    } else if (data.byteLength > MAX_CRDT_PAYLOAD_BYTES) {
      limitLogger.hit('maxCrdtPayloadBytes', `${data.byteLength} bytes`)
    } else if (data.byteLength && this.incomingMessages.length >= MAX_INCOMING_QUEUE) {
      limitLogger.hit('maxIncomingQueue')
    }

    // create a future to wait until all the messages are processed. even if there
    // are no updates, we must return the future for CRDT updates like the camera
    // position
    return this.nextTick()
  }

  // impl EngineApiInterface {
  async crdtGetState(): Promise<CrdtGetStateResponse> {
    const result = await this._crdtSendToRenderer(new Uint8Array(0))
    const hasEntities = this.mainCrdt.byteLength > 0

    // prepend the main.crdt to the response (if not empty). crdt messages are
    // processed sequentially, so the main.crdt will be processed first.
    // if the renderer has any modifications to the main.crdt, they will be
    // applied because they will be processed after.
    //
    // NEW ARRAY, never `result.data.unshift(...)`: lateUpdate resolves EVERY
    // pending future with the SAME array instance, so mutating it in place leaked
    // main.crdt into the response of any crdtSendToRenderer awaiting the same
    // frame (and into every later crdtGetState, once per call).
    const data = hasEntities ? [this.mainCrdt, ...result.data] : result.data

    return { hasEntities, data }
  }

  async crdtSendToRenderer(payload: CrdtSendToRendererRequest): Promise<CrdtSendToResponse> {
    // DEBUG (opt-in via HAMMURABI_DEBUG_ENTITY_PROVENANCE): trace the entity
    // provenance of scene components. Catches the smoking gun for the flagtag
    // "Component ctf-player-flag-hold-time for <id> not found" case — a scene
    // component op landing on a RESERVED/avatar entity (<512), or a DELETE_ENTITY
    // wiping a SCENE-range (>=512) entity. Off by default; zero cost when unset.
    if (DEBUG_ENTITY_PROVENANCE) debugScanCrdt('scene→host', [payload.data])
    const res = await this._crdtSendToRenderer(payload.data)
    if (DEBUG_ENTITY_PROVENANCE) debugScanCrdt('host→scene', res.data)
    return res
  }

  get transport(): CommsTransportWrapper | undefined {
    return this._transport
  }

  private incomingNetworkMessages: Uint8Array[] = []
  // kept so dispose() can unsubscribe it — without this, every hot reload leaked
  // a handler that kept filling its dead context's queue (same entityId check
  // passes for the reloaded scene)
  private sceneMessageBusHandler?: (event: { address: string; data: { sceneId: string; data: Uint8Array } }) => void

  getNetworkMessages(): Uint8Array[] {
    // hand over the array and start a fresh one instead of copying + truncating
    const messages = this.incomingNetworkMessages
    this.incomingNetworkMessages = []
    return messages
  }

  attachLivekitTransport(transport: CommsTransportWrapper) {
    this._transport = transport

    // Create avatar communication system for this scene
    this._avatarSystem = createAvatarCommunicationSystem(transport, (position) => globalCoordinatesToSceneCoordinates(this, position))

    // Add the avatar system subscription to this scene's subscriptions
    this.subscriptions.push(this._avatarSystem.createSubscription())

    this.sceneMessageBusHandler = (event) => {
      if (event.data.sceneId === this.entityId) {
        if (event.data.data.byteLength) {
          const [_, data] = decodeMessage(event.data.data)
          const senderBytes = textEncoder.encode(event.address)
          // The sender length is framed in a single byte; a peer-controlled
          // identity longer than that would wrap and corrupt the framing scene
          // code parses, so drop it.
          if (senderBytes.byteLength > 255) return
          const messageLength = senderBytes.byteLength + data.byteLength + 1
          const serializedMessage = new Uint8Array(messageLength)
          serializedMessage.set(new Uint8Array([senderBytes.byteLength]), 0)
          serializedMessage.set(senderBytes, 1)
          serializedMessage.set(data, senderBytes.byteLength + 1)
          this.incomingNetworkMessages.push(serializedMessage)
          // Bound the queue: if the scene never drains it (doesn't use the
          // MessageBus), a peer could otherwise grow it without limit.
          if (this.incomingNetworkMessages.length > MAX_NETWORK_MESSAGE_QUEUE) {
            this.incomingNetworkMessages.shift()
            limitLogger.hit('maxNetworkMessageQueue')
          }
        }
      }
    }
    transport.events.on('sceneMessageBus', this.sceneMessageBusHandler)
  }
}

const textEncoder = new TextEncoder()

/**
 * MsgType utils to diff between old string messages, and new uint8Array messages.
 */
export enum MsgType {
  String = 1,
  Uint8Array = 2
}

function decodeMessage(value: Uint8Array): [MsgType, Uint8Array] {
  const msgType = value.at(0) as MsgType
  const data = value.subarray(1)
  return [msgType, data]
}

export function encodeMessage(data: Uint8Array, type: MsgType) {
  const message = new Uint8Array(data.byteLength + 1)
  message.set([type])
  message.set(data, 1)
  return message
}
