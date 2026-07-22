// Node.js 18+ has native fetch
import * as BABYLON from '@babylonjs/core'
import { setupXMLHttpRequestPolyfill } from './polyfills/xmlhttprequest'
import { robustFetch, readBodyCapped, DEFAULT_MAX_BODY_BYTES } from './misc/network'
import { Scene } from '@dcl/schemas'
import { initEngine } from './babylon'
import { loadSceneContextFromLocal, loadSceneContextFromPosition, loadSceneContextFromWorld } from './babylon/scene/load'
import { PLAYER_HEIGHT } from './babylon/scene/logic/static-entities'
import { createSceneCullingSystem } from './babylon/scene/scene-culling'
import { createSceneTickSystem } from './babylon/scene/update-scheduler'
import { createCharacterControllerSystem } from './babylon/avatars/CharacterController'
import { createCameraFollowsPlayerSystem } from './babylon/scene/logic/camera-follows-player'
import { createLocalAvatarSceneSystem } from './babylon/scene/logic/local-avatar-scene'
import { createSceneComms } from './decentraland/communications/scene-comms'
import { commsLogger } from './decentraland/communications/types'
import { SceneContext } from './babylon/scene/scene-context'
import { generateRandomAvatar, downloadAvatar } from './decentraland/identity/avatar'
import { pickWorldSpawnpoint } from './decentraland/scene/spawn-points'
import { addSystems } from './decentraland/system'
import { Atom } from './misc/atom'
import { registerShutdownHook, runGracefulShutdown, EXIT_CODES } from './misc/shutdown'
import { limits } from './misc/limits'
import { metrics } from './misc/metrics'
import { startMetricsServer } from './misc/metrics-server'
import { userIdentity, sceneIdentity, loadedScenesByEntityId, currentRealm, playerEntityAtom, CurrentRealm, currentEnvironment, storageDelegation } from './decentraland/state'
import { createGuestIdentity, createIdentityFromPrivateKey } from './decentraland/identity/login'
import { parseStorageDelegation } from './decentraland/identity/storage-delegation'
import { resolveRealmBaseUrl, isDclEns, isLocalhostRealm } from './decentraland/realm/resolution'

// per-frame budget for processing messages from scenes. headless there is no
// GPU work to prioritize, so scenes get a generous slice of the frame
// (HAMMURABI_MS_PER_FRAME_PROCESSING_SCENE_MESSAGES)
const MS_PER_FRAME_PROCESSING_SCENE_MESSAGES = limits.msPerFrameProcessingSceneMessages

const commsDisconnections = metrics.counter(
  'hammurabi_comms_disconnections_total',
  'Unexpected comms transport losses (client-initiated closes excluded)'
)

import { DclEnvironment } from './decentraland/environment'
export { DclEnvironment }

export interface EngineOptions {
  canvas?: HTMLCanvasElement
  realmUrl?: string
  position?: string
  sceneId?: string
  privateKey?: string
  environment?: DclEnvironment
  // A pre-minted comms adapter string (e.g. "livekit:wss://…?access_token=…")
  // supplied by a trusted parent/orchestrator. When present, this (untrusted)
  // worker connects comms directly with it and NEVER holds or signs with the
  // authoritative private key — no signed handshake happens in this process.
  commsAdapter?: string
  // When true (default), the process exits on an unexpected comms loss so a
  // supervisor can restart it with a fresh connection. Interactive/dev usage
  // sets this to false to keep the manual "press R to restart" flow.
  restartOnCommsLoss?: boolean
  // Base64-encoded, world-scoped storage delegation minted by a trusted parent
  // (see StorageDelegation). When present, the worker signs `storage.decentraland.*`
  // requests with the enclosed ephemeral so the authoritative world storage
  // authorizes them — WITHOUT this worker ever holding the authoritative key.
  storageDelegation?: string
}

let initialized = false

// Everything one main() run creates that outlives a scene: without disposing
// these on reset, every restart leaks a live engine whose render loop keeps
// running and whose systems keep ticking the SHARED loadedScenesByEntityId map
// (N restarts ⇒ N+1 updates per scene per frame), plus a still-connected
// LiveKit room. Owned per-run (not as loose module globals): resetEngine() can
// fire while a main() is still awaiting (dev-mode 'r' during a slow startup),
// and the superseded run must then abort and dispose only ITS resources —
// letting it keep writing module state would silently clobber the replacement
// session's engine/transport and reintroduce the leak this exists to prevent.
type EngineSession = {
  babylonScene?: BABYLON.Scene
  transport?: { disconnect(): Promise<void> }
  sceneContext?: SceneContext
}
let activeSession: EngineSession | undefined

// The graceful-shutdown hook reads the CURRENT session (via `activeSession`), which
// resetEngine() clears — so after a hot reload it never disposes a stale/disposed
// scene or misses the live one.
let shutdownHookRegistered = false

function disposeSession(session: EngineSession) {
  // Tear down comms: the DISCONNECTION handler ignores client-initiated closes,
  // so this won't trigger the restart-on-comms-loss exit.
  if (session.transport) {
    session.transport.disconnect().catch((e) => console.error('Error disconnecting comms transport:', e))
    session.transport = undefined
  }

  // Stop the old render loop before disposing: engine.dispose() alone leaves
  // the queued setTimeout frame chain alive.
  if (session.babylonScene) {
    try {
      const engine = session.babylonScene.getEngine()
      engine.stopRenderLoop()
      session.babylonScene.dispose()
      engine.dispose()
    } catch (e) {
      console.error('Error disposing engine:', e)
    }
    session.babylonScene = undefined
  }
}

export function resetEngine() {
  // Properly dispose all loaded scenes first
  for (const [entityId, scene] of loadedScenesByEntityId.entries()) {
    try {
      scene.dispose()
    } catch (e) {
      console.error(`Error disposing scene ${entityId}:`, e)
    }
  }

  // Clear the map
  loadedScenesByEntityId.clear()

  if (activeSession) {
    disposeSession(activeSession)
    activeSession = undefined
  }

  // Reset the initialization flag
  initialized = false
}

export async function main(options: EngineOptions = {}): Promise<BABYLON.Scene> {
  if (initialized) {
    throw new Error('The engine cannot be initialized twice')
  }

  // Setup XMLHttpRequest polyfill for GLTF loading before initializing Babylon.js
  setupXMLHttpRequestPolyfill()

  startMetricsServer()

  // Set eagerly so a concurrent call fails fast, but roll back on failure —
  // otherwise a failed startup poisons every retry with "cannot be initialized
  // twice" unless the caller knows to call resetEngine() first.
  initialized = true
  const session: EngineSession = {}
  activeSession = session
  try {
    return await initializeEngine(options, session)
  } catch (err) {
    if (activeSession === session) {
      resetEngine()
    } else {
      // A restart superseded this run mid-startup: the shared state (loaded
      // scenes, initialized flag) now belongs to the NEW session — tear down
      // only what this run created.
      disposeSession(session)
    }
    throw err
  }
}

/**
 * Throws when a resetEngine() superseded this startup while it was awaiting.
 * Called after each await cluster and BEFORE every mutation of shared state
 * (identity atoms, realm atom, scene loading, transport attach): between the
 * check and the mutation there is no await, so on a single-threaded event loop
 * the pair is atomic and a stale run can never clobber the new session.
 */
function assertSessionCurrent(session: EngineSession) {
  if (activeSession !== session) {
    throw new Error('Engine was reset while starting up; this startup was aborted')
  }
}

async function initializeEngine(options: EngineOptions, session: EngineSession): Promise<BABYLON.Scene> {
  const { scene } = await initEngine(options.canvas)
  session.babylonScene = scene
  assertSessionCurrent(session)

  // Create identity based on private key or as guest. When a parent supplies a
  // pre-minted commsAdapter, the worker never needs the authoritative identity,
  // so it always runs as a guest even if a private key were somehow passed.
  const identity = options.privateKey && !options.commsAdapter
    ? await createIdentityFromPrivateKey(options.privateKey)
    : await createGuestIdentity()

  assertSessionCurrent(session)
  userIdentity.swap(identity)

  // Scene-facing APIs get a SEPARATE, always-unprivileged guest identity so that
  // untrusted scene code (via ~system/SignedFetch / ~system/UserIdentity) can
  // never sign requests as — or leak the address of — the authoritative server
  // identity above.
  const unprivilegedSceneIdentity = await createGuestIdentity()
  assertSessionCurrent(session)
  sceneIdentity.swap(unprivilegedSceneIdentity)

  // Optional world-scoped storage delegation. Kept separate from both identities
  // above and used ONLY for storage.decentraland.* requests (see connect-context-rpc).
  if (options.storageDelegation) {
    const delegation = parseStorageDelegation(options.storageDelegation)
    if (delegation) {
      storageDelegation.swap(delegation)
    }
  }

  // Environment defaults to 'org'
  const environment: DclEnvironment = options.environment ?? 'org'
  currentEnvironment.swap(environment)

  // Fetch realm configuration. When a position is provided without an explicit
  // realm (e.g. Genesis City spawns from the orchestrator), default to the
  // catalyst peer — matches the CLI behavior so callers don't have to hard-code
  // the peer URL.
  let realm: CurrentRealm
  const realmUrl =
    options.realmUrl ?? (options.position ? `https://peer.decentraland.${environment}` : undefined)
  if (!realmUrl) {
    throw new Error('Realm URL is required')
  }

  // Use resolveRealmBaseUrl to handle .dcl.eth domains and other URLs properly
  const baseUrl = await resolveRealmBaseUrl(realmUrl)

  console.log('🌐 Fetching realm info from:', baseUrl + '/about')
  const res = await robustFetch(baseUrl + '/about', {}, { label: 'realm/about' })
  // The realm URL is user-supplied (--realm): cap the body instead of letting
  // a hostile realm stream an unbounded /about into host memory.
  const aboutResponse = JSON.parse(await readBodyCapped(res, DEFAULT_MAX_BODY_BYTES)) as any

  assertSessionCurrent(session)
  realm = {
    baseUrl,
    connectionString: realmUrl,
    aboutResponse
  }
  currentRealm.swap(realm)

  const isLocalhost = isLocalhostRealm(baseUrl)
  const isWorld = isDclEns(realmUrl)
  const isGenesisCity = !isLocalhost && !isWorld

  // An sdk-commands preview server reached through a non-localhost hostname
  // (e.g. --realm=http://192.168.x.x:8000 copied from the preview's LAN URL)
  // would silently fall into the Genesis City branch and die much later with
  // misleading errors ("Position parameter is required", a gatekeeper 401).
  // Preview realms identify themselves in /about — fail right here with the
  // actual problem instead.
  if (!isLocalhost && aboutResponse?.configurations?.realmName === 'LocalPreview') {
    throw new Error(
      `Realm "${realmUrl}" is an sdk-commands preview server, but only localhost/127.0.0.1 hostnames ` +
        `are treated as local preview. Use --realm=http://localhost:<port> instead. ` +
        `(Realms are classified as: localhost → local preview, *.dcl.eth → world, anything else → Genesis City.)`
    )
  }

  // Create identity atom for sceneComms
  const identityAtom = Atom(identity)

  // init the character controller and input system
  const characterControllerSystem = await createCharacterControllerSystem(scene)

  // then init all the rendering systems
  const avatar = identity.isGuest ? await generateRandomAvatar(identity.address) : await downloadAvatar(identity.address)
  const sceneCullingSystem = createSceneCullingSystem(scene, () => loadedScenesByEntityId.values())
  const sceneTickSystem = createSceneTickSystem(scene, () => loadedScenesByEntityId.values(), MS_PER_FRAME_PROCESSING_SCENE_MESSAGES)
  const localAvatarSceneSystem = await createLocalAvatarSceneSystem(scene, avatar)
  const cameraFollowsPlayerSystem = createCameraFollowsPlayerSystem(characterControllerSystem.camera, localAvatarSceneSystem.playerEntity, characterControllerSystem)
  // NOTE: no camera-obstruction system on the headless server. It ran a
  // multiPickWithRay over every physics collider every frame to "elastically"
  // move a camera that nobody renders — its only observable effect was a
  // slightly different camera transform reported to scenes.

  // Use player entity atom if it exists
  if (typeof playerEntityAtom !== 'undefined') {
    playerEntityAtom.swap(characterControllerSystem.capsule)
  }

  addSystems(scene,
    sceneTickSystem,
    sceneCullingSystem,
    characterControllerSystem,
    localAvatarSceneSystem,
    cameraFollowsPlayerSystem
  )

  const sceneContext: Atom<SceneContext> = Atom()

  let ctx: Atom<SceneContext>

  // The load functions register the scene in the SHARED loadedScenesByEntityId
  // map — a superseded run must not add to the new session's map.
  assertSessionCurrent(session)

  if (isLocalhost) {
    // Load local scene
    ctx = await loadSceneContextFromLocal(sceneContext, scene, { baseUrl: realm.baseUrl, isGlobal: false })
  } else if (isWorld) {
    // Load World scene
    ctx = await loadSceneContextFromWorld(sceneContext, scene, {
      worldName: realmUrl,
      realmBaseUrl: realm.baseUrl,
      sceneId: options.sceneId
    })
  } else if (isGenesisCity) {
    // Load scene from Genesis City position
    if (!options.position) {
      throw new Error('Position parameter is required for Genesis City realms. Use --position=x,y')
    }
    ctx = await loadSceneContextFromPosition(sceneContext, scene, {
      realmBaseUrl: realm.baseUrl,
      position: options.position
    })
  } else {
    throw new Error('Unknown realm type')
  }

  // Get scene info from loaded context
  const loadedSceneContext = await ctx.deref()
  const sceneId = loadedSceneContext.loadableScene.urn

  // Enable scene comms with Node.js compatible LiveKit
  const sceneTransport = await createSceneComms(realm, identityAtom, scene, {
    isGenesisScene: isGenesisCity,
    sceneId,
    isWorld,
    isLocalhost,
    commsAdapter: options.commsAdapter
  })

  session.transport = sceneTransport
  assertSessionCurrent(session)

  sceneContext.pipe(async (ctx) => {
    ctx.attachLivekitTransport(sceneTransport)
  })

  // Record this session's scene so the (single) shutdown hook tears down cleanly:
  // disposing the scene closes its RPC transport, so the scene's update loop exits
  // between turns and the isolate disposes IDLE (disposing/exiting mid-turn
  // SIGSEGVs the process). Reading through `activeSession` means resetEngine()
  // clearing it makes the hook track the current session (or no-op post-reset).
  session.sceneContext = loadedSceneContext
  if (!shutdownHookRegistered) {
    shutdownHookRegistered = true
    registerShutdownHook(async () => {
      try { activeSession?.sceneContext?.dispose() } catch { /* best-effort */ }
      try { await activeSession?.transport?.disconnect() } catch { /* best-effort */ }
    })
  }

  // A headless server is useless without comms. If the transport is lost
  // unexpectedly (i.e. not a clean local disconnect), exit so the supervising
  // process restarts us with a fresh connection and token. LiveKit already
  // retries internally before emitting this, so reconnecting in-process would
  // just repeat what it already gave up on.
  const restartOnCommsLoss = options.restartOnCommsLoss ?? true
  sceneTransport.events.on('DISCONNECTION', (event) => {
    if (event.clientInitiated) return
    commsDisconnections.inc()
    commsLogger.error(`🔌 Comms transport lost (kicked=${event.kicked})`)
    if (event.kicked) {
      // A kick is LiveKit's DuplicateIdentity rule: rooms hold exactly one
      // 'authoritative-server' participant, so another server instance for this
      // same scene just took the room over (locally: usually a second preview
      // of the same project). Without this message the losing instance looks
      // healthy while silently serving nobody.
      commsLogger.error(
        '🥊 Another authoritative server took over this scene\'s comms room — you probably have a second ' +
          'preview/server of this project running. This instance is no longer serving clients.'
      )
    }
    if (restartOnCommsLoss) {
      commsLogger.error('Shutting down so the supervisor can restart us with a fresh connection')
      // Graceful (dispose scene → isolate goes idle → clean exit); a bare
      // process.exit() here would SIGSEGV whenever a scene turn is mid-flight.
      void runGracefulShutdown(EXIT_CODES.COMMS_LOST)
    }
  })

  const { position } = pickWorldSpawnpoint((await ctx.deref()).loadableScene.entity.metadata as Scene)
  assertSessionCurrent(session)
  characterControllerSystem.teleport(position)
  characterControllerSystem.capsule.position.y += PLAYER_HEIGHT

  // this is for debugging purposes
  Object.assign(globalThis, { scene })

  return scene
}
