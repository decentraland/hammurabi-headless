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
import { resolveCyclicParening } from './logic/cyclic-transform'
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
import { StaticEntities, entityIsInRange, updateStaticEntities } from './logic/static-entities'
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

const SCENE_ENTITY_RANGE: [number, number] = [1, MAX_ENTITY_NUMBER]

// Untrusted-input bounds. Scene CRDT is fully attacker-controlled and is applied
// in HOST code, outside the QuickJS VM's memory/interrupt limits — so these caps
// are what keep a hostile scene from exhausting the worker's heap. Drops are
// silent by design: logging per drop would let a scene amplify into log spam.
const MAX_LIVE_ENTITIES = 100_000 // concurrent host BabylonEntity objects per scene
const MAX_DELETED_TOMBSTONES = 100_000 // retained delete tombstones per scene
const MAX_CRDT_PAYLOAD_BYTES = 8 * 1024 * 1024 // per crdtSendToRenderer call
const MAX_INCOMING_QUEUE = 1024 // queued CRDT buffers awaiting processing
// Inbound ADR-104 scene-bus messages from remote peers, awaiting the scene to
// drain them via CommunicationsController.sendBinary. A scene that never uses the
// MessageBus never drains this, so it must be bounded or a peer can drive the
// worker's heap up with scene-cased packets (drop-oldest).
const MAX_NETWORK_MESSAGE_QUEUE = 1024

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
  // e.g. the QuickJS memory transport). Unlike the shared comms transport
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
  incomingMessages: { buffer: ByteBuffer; readonly allowedEntityRange: [number, number] }[] = []

  // stash of outgoing messages ready to be sent to back to the scripting scene
  outgoingMessagesBuffer: ByteBuffer = new ReadWriteByteBuffer()

  // when we finish to process all the income messages of a tick,
  // set finishedProcessingFrame to true to send the outgoing messages, then to false.
  finishedProcessingIncomingMessagesOfTick: boolean = false

  // the follwing set contains a list of pending raycast queries. if a query is continous,
  // it won't be removed from the set
  pendingRaycastOperations = new Set<Entity>()

  // log function for tests
  log: (...args: any[]) => void = (...args) => console.log(this.rootNode.name, ...args)

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

      if (minX) {
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
        this.mainCrdt = content
        this.incomingMessages.push({ buffer: new ReadWriteByteBuffer(content), allowedEntityRange: SCENE_ENTITY_RANGE })
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
    }
    const entity = this.getEntityOrNull(entityId)
    if (entity) {
      // Babylon's dispose(doNotRecurse=true) detaches children to parent=null —
      // the WORLD root, not this scene's rootNode — which silently drops the
      // scene offset (entities teleport toward world origin for scenes off
      // parcel 0,0) and removes them from the rootNode subtree that raycasts
      // and culling traverse. Schedule them for reparenting instead: their
      // expectedParentEntityId now points at a tombstoned entity, so the
      // deleted-parent branch of resolveCyclicParening re-roots them.
      for (const child of entity.childrenEntities()) {
        this.unparentedEntities.add(child.entityId)
      }
      this.hierarchyChanged = true
      entity.dispose()
      // dispose() only clears the component VALUES (entityDeleted). The CRDT
      // bookkeeping (LWW timestamps / updatedAtTick) must be purged explicitly
      // or it grows one entry per component per deleted id forever — outside
      // every documented cap, over 2^32 generational ids of untrusted input.
      // Safe: tombstoned entities drop all further CRDT updates (see the
      // deletedEntities guard in update()), so stale-update protection from a
      // retained timestamp is never exercised.
      for (const component of this.componentList) {
        component.purgeEntity(entityId)
      }
      this.entities.delete(entityId)
      this.unparentedEntities.delete(entityId)
    }
  }

  getOrCreateEntity(entityId: Entity): BabylonEntity {
    let entity = this.entities.get(entityId)
    if (!entity) {
      entity = new BabylonEntity(entityId, this.#ref)
      // every new entity is parented to the scene's rootEntity by default
      entity.parent = this.rootNode
      this.entities.set(entityId, entity)
    }
    return entity
  }

  /**
   * Cap-aware variant for untrusted CRDT input: never creates a NEW entity past
   * MAX_LIVE_ENTITIES (already-live entities are always returned). Every path
   * that materializes entities from scene messages must go through this, or the
   * cap can be amplified (e.g. transforms referencing nonexistent parents).
   */
  tryGetOrCreateEntity(entityId: Entity): BabylonEntity | null {
    if (!this.entities.has(entityId) && this.entities.size >= MAX_LIVE_ENTITIES) {
      return null
    }
    return this.getOrCreateEntity(entityId)
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
    // (resolveCyclicParening re-flags hierarchyChanged when it yields early);
    // without this, leftover work would only resume when a NEW message arrives.
    if (this.hierarchyChanged) {
      resolveCyclicParening(this, hasQuota)
    }

    // process all the incoming messages
    while (this.incomingMessages.length) {
      const message = this.incomingMessages[0]

      for (const crdtMessage of readAllMessages(message.buffer)) {
        if (this.deletedEntities.has(crdtMessage.entityId)) continue
        // STUB create or delete entities based on putComponent and deleteEntity
        switch (crdtMessage.type) {
          case CrdtMessageType.APPEND_VALUE:
          case CrdtMessageType.DELETE_COMPONENT:
          case CrdtMessageType.PUT_COMPONENT: {
            // ignore updates of entities outside range
            // if (!entityIsInRange(crdtMessage.entityId, message.allowedEntityRange)) continue

            // Bound host memory: a scene can stream PUT/APPEND for unbounded
            // distinct entity ids (entity number + generational version), each
            // allocating a host BabylonEntity. Refuse to create NEW entities past
            // a hard ceiling; updates to already-live entities still apply.
            const entity = this.tryGetOrCreateEntity(crdtMessage.entityId)
            if (!entity) continue
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

            break
          }
          case CrdtMessageType.DELETE_ENTITY: {
            // ignore updates of entities outside range
            if (!entityIsInRange(crdtMessage.entityId, message.allowedEntityRange)) continue

            this.removeEntity(crdtMessage.entityId)
            break
          }
        }

        // if we exceeded the quota, finish the processing of this "message" and yield
        // the execution control back to the event loop
        if (++rollingOperationCounter % 10 == 0 && !hasQuota()) {
          return false
        }
      }

      // at this point, the whole "message" was consumed, we proceed to its removal
      this.incomingMessages.shift()

      // this process resolves the re parenting of all entities preventing cycles
      resolveCyclicParening(this, hasQuota)
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

    processRaycasts(this)

    // TODO: Execute queries into this.outgoingMessages
    // TODO: Collect events into this.outgoingMessages

    // update the components of the static entities to be sent to the scene
    this.updateStaticEntities()

    // write all the CRDT updates in the outgoingMessagesBuffer
    for (const component of this.componentList) {
      component.dumpCrdtUpdates(this.outgoingMessagesBuffer)
    }

    // forward all messages from all subscriptions
    for (const subscription of this.subscriptions) {
      subscription.getUpdates(this.subscriptionsBuffer)

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
        // reset the buffer
        this.subscriptionsBuffer.incrementWriteOffset(-this.subscriptionsBuffer.currentWriteOffset())
        this.subscriptionsBuffer.incrementReadOffset(-this.subscriptionsBuffer.currentReadOffset())
      }
    }

    if (this.outgoingMessagesBuffer.currentWriteOffset()) {
      outMessages.push(this.outgoingMessagesBuffer.toBinary())
      this.outgoingMessagesBuffer.incrementWriteOffset(-this.outgoingMessagesBuffer.currentWriteOffset())
      this.outgoingMessagesBuffer.incrementReadOffset(-this.outgoingMessagesBuffer.currentReadOffset())
    }

    // TIMING HAZARD: outMessages holds toBinary() VIEWS into subscriptionsBuffer
    // and outgoingMessagesBuffer, whose write offsets were just reset for reuse.
    // This is safe ONLY because the futures resolved below are consumed (RPC
    // protobuf-encodes, i.e. copies, the bytes) on a microtask before the next
    // frame writes into these buffers. If that scheduling ever changes, switch
    // to toCopiedBinary() here.
    // finally resolve the future so the function "receiveBatch" is unblocked
    // and the next scripting frame is allowed to happen
    this.nextFrameFutures.forEach((fut) => fut.resolve({ data: outMessages }))
    // finally clean the futures
    this.nextFrameFutures.length = 0

    // increment the tick number, as per ADR-148
    this.currentTick++
    this.finishedProcessingIncomingMessagesOfTick = false
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
    // cannot exhaust host memory via huge or high-frequency CRDT payloads. Silent
    // by design (see the MAX_* constants) — do not log per drop.
    if (
      data.byteLength &&
      data.byteLength <= MAX_CRDT_PAYLOAD_BYTES &&
      this.incomingMessages.length < MAX_INCOMING_QUEUE
    ) {
      this.incomingMessages.push({ buffer: new ReadWriteByteBuffer(data), allowedEntityRange: SCENE_ENTITY_RANGE })
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

    if (hasEntities) {
      // prepend the main.crdt to the response (if not empty). crdt messages are
      // processed sequentially, so the main.crdt will be processed first.
      // if the renderer has any modifications to the main.crdt, they will be
      // applied because they will be processed after
      result.data.unshift(this.mainCrdt)
    }

    return { hasEntities, data: result.data }
  }

  async crdtSendToRenderer(payload: CrdtSendToRendererRequest): Promise<CrdtSendToResponse> {
    return this._crdtSendToRenderer(payload.data)
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
