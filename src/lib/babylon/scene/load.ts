import * as BABYLON from '@babylonjs/core'
import { parseEntityUrn } from '../../decentraland/identifiers'
import { LoadableScene } from '../../decentraland/scene/content-server-entity'
import { SceneContext } from "./scene-context"
import { connectSceneContextUsingNodeJs } from './nodejs-runtime'
import { loadedScenesByEntityId } from '../../decentraland/state'
import { VirtualScene } from '../../decentraland/virtual-scene'
import { json } from '../../misc/json'
import { Entity } from '@dcl/schemas'
import { initHotReload } from './hot-reload'
import { sleep } from '../../misc/promises'
import { Atom } from '../../misc/atom'

/**
 * Creates and initializes a scene context from a loadable scene
 */
async function createSceneContext(engineScene: BABYLON.Scene, loadableScene: LoadableScene, entityId: string, isGlobal: boolean, virtualScene?: VirtualScene): Promise<SceneContext> {
  if ((loadableScene.entity.metadata as any).runtimeVersion !== '7') throw new Error('The scene is not compatible with the current runtime version. It may be using SDK6')

  const ctx = new SceneContext(engineScene, loadableScene, isGlobal, entityId)

  if (virtualScene) {
    ctx.subscriptions.push(virtualScene.createSubscription())
  }

  await ctx.initAsyncJobs()

  // Node.js environment - use in-process WebWorker runtime with MemoryTransport
  connectSceneContextUsingNodeJs(ctx, loadableScene)

  loadedScenesByEntityId.set(entityId, ctx)

  return ctx
}

/**
 * Loads a remote scene. The baseUrl will be prepended to every request to resolve
 * the scene assets as per https://docs.decentraland.org/contributor/content/filesystem/
 */
export async function loadSceneContext(engineScene: BABYLON.Scene, options: { urn: string, isGlobal: boolean }, virtualScene?: VirtualScene) {
  const parsed = parseEntityUrn(options.urn)

  if (!parsed.baseUrl) throw new Error('Only URNs with baseUrl are supported at this time.')

  // cancel early if the scene is already loaded
  if (loadedScenesByEntityId.has(parsed.entityId)) return loadedScenesByEntityId.get(parsed.entityId)!

  const loadableScene = await getLoadableSceneFromUrl(parsed.entityId, parsed.baseUrl)

  return await createSceneContext(engineScene, loadableScene, parsed.entityId, options.isGlobal, virtualScene)
}

/**
 * Loads a scene from a local context environment
 */
export async function loadSceneContextFromLocal(sceneContext: Atom<SceneContext>, engineScene: BABYLON.Scene, options: { baseUrl: string, isGlobal: boolean, withoutHotReload?: boolean }, virtualScene?: VirtualScene): Promise<Atom<SceneContext>> {
  const loadableScene = await getLoadableSceneFromLocalContext(options.baseUrl)
  const entityId = loadableScene.urn

  sceneContext.swap(await createSceneContext(engineScene, loadableScene, entityId, options.isGlobal, virtualScene))

  async function reloadScene() {
    unloadScene(entityId)
    await sleep(100)
    options.withoutHotReload = true
    loadSceneContextFromLocal(sceneContext, engineScene, options)
  }

  if (!options.withoutHotReload) {
    // Initialize hot reload for local development
    initHotReload(options.baseUrl, entityId, reloadScene)
  }

  return sceneContext
}

/**
 * Unloads the scene from memory. It should also trigger all the operations to
 * release all the resources, including the runtime of the scene.
 * @param {string} entityId - The entity ID of the entity holding the scene.
 */
export function unloadScene(entityId: string) {
  const scene = loadedScenesByEntityId.get(entityId)
  if (scene) {
    scene.dispose()
    loadedScenesByEntityId.delete(entityId)
  }
}

/**
 * Build a `LoadableScene` pointing at a scene entity served under `baseUrl`.
 *
 * When `entity` is omitted the entity is fetched from `${baseUrl}${entityId}`.
 * Callers that already have the entity in hand (e.g. from a `/scenes`
 * response) can pass it in to skip the extra HTTP round-trip.
 */
export async function getLoadableSceneFromUrl(
  entityId: string,
  baseUrl: string,
  entity?: any
): Promise<LoadableScene> {
  const resolvedEntity = entity ?? (await (await fetch(`${baseUrl}${entityId}`)).json())

  return {
    urn: entityId,
    entity: resolvedEntity,
    baseUrl
  }
}

/**
 * Fetches scene.json from baseUrl to get the pointers
 * @param baseUrl The base URL of the local context
 * @returns Scene configuration with pointers
 */
export async function fetchSceneJson(baseUrl: string) {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'
  const result = await fetch(`${normalizedBaseUrl}scene.json`)
  return await result.json()
}

/**
 * Loads scene content from local context environment
 * @param baseUrl The base URL of the local context
 * @returns Object containing scene entities and metadata
 */
export async function getLoadableSceneFromLocalContext(baseUrl: string) {
  // First, fetch scene.json to get the pointers
  const sceneConfig: any = await fetchSceneJson(baseUrl)
  const pointers = sceneConfig.scene?.parcels || []
  if (pointers.length === 0) {
    throw new Error('No pointers found in scene.json')
  }
  // Then post to /content/entities/active with the pointers
  const entitiesResponse = await fetch(`${baseUrl}/content/entities/active`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pointers })
  })

  const entity = (await entitiesResponse.json() as any)[0]

  return {
    baseUrl: baseUrl + '/content/contents/',
    entity,
    urn: entity.id
  }
}

/**
  * Fetches the entities that represent the given pointers.
  * @param pointers List of pointers
  * @param peerUrl The url of a catalyst
  * @returns List of active entities for given pointers
  */
export async function fetchEntitiesByPointers(pointers: string[], contentServerBaseUrl: string) {
  if (pointers.length === 0) {
    return []
  }
  // TODO: add here support for custom ?baseUrl query param in URN
  const entities = await json<Entity[]>(`${contentServerBaseUrl}/entities/active`, {
    method: 'post',
    body: JSON.stringify({ pointers }),
    headers: { 'Content-Type': 'application/json' },
  })
  return entities
}

export async function getLoadableSceneFromPointers(pointers: string[], contentServerBaseUrl: string): Promise<LoadableScene[]> {
  const entities = await fetchEntitiesByPointers(pointers, contentServerBaseUrl)

  return entities.map($ => ({
    urn: $.pointers[0] || $.id,
    entity: {
      type: $.type as any,
      content: $.content,
      metadata: $.metadata,
    },
    baseUrl: contentServerBaseUrl + '/contents/',
  }))
}

/**
 * Loads a scene from a remote position (parcel coordinates)
 * @param sceneContext The scene context atom to populate
 * @param engineScene The Babylon.js scene
 * @param options Configuration including realm URL and position
 * @returns Promise resolving to the scene context atom
 */
export async function loadSceneContextFromPosition(
  sceneContext: Atom<SceneContext>,
  engineScene: BABYLON.Scene,
  options: { realmBaseUrl: string, position: string }
): Promise<Atom<SceneContext>> {
  const contentServerUrl = `${options.realmBaseUrl}/content`
  const pointer = options.position // e.g., "80,80"

  console.log(`🌐 Fetching scene at position ${pointer} from ${contentServerUrl}`)

  const entities = await fetchEntitiesByPointers([pointer], contentServerUrl)

  if (entities.length === 0) {
    throw new Error(`No scene found at position ${pointer}`)
  }

  const entity = entities[0]
  const entityId = entity.id
  const loadableScene: LoadableScene = {
    urn: entityId,
    entity: {
      type: entity.type as any,
      content: entity.content,
      metadata: entity.metadata
    },
    baseUrl: `${contentServerUrl}/contents/`
  }

  console.log(`📦 Loading scene: ${(loadableScene.entity.metadata as any)?.display?.title || entityId}`)

  sceneContext.swap(await createSceneContext(engineScene, loadableScene, entityId, false))

  return sceneContext
}

/**
 * Shape of each entry returned by `GET /world/:name/scenes` on
 * worlds-content-server. Full entity metadata is inlined so there's no need
 * for a follow-up fetch per scene.
 */
interface WorldSceneEntry {
  entityId: string
  parcels?: string[]
  entity: {
    content?: { file: string; hash: string }[]
    metadata?: unknown
  }
}

/**
 * Loads a scene from a Decentraland World.
 *
 * Scene discovery uses the worlds-content-server `/world/:name/scenes`
 * endpoint, which is the canonical source for the full list of scenes in a
 * world
 *
 * When `sceneId` is provided, the function picks the matching scene from the
 * list (multi-scene worlds). When omitted, it falls back to the first scene in
 * the list — correct for single-scene worlds.
 *
 * @param sceneContext The scene context atom to populate
 * @param engineScene The Babylon.js scene
 * @param options Configuration including world name, realm base URL and
 *   optional target scene entity hash to load
 * @returns Promise resolving to the scene context atom
 */
export async function loadSceneContextFromWorld(
  sceneContext: Atom<SceneContext>,
  engineScene: BABYLON.Scene,
  options: { worldName: string, realmBaseUrl: string, sceneId?: string }
): Promise<Atom<SceneContext>> {
  console.log(`🌍 Loading World: ${options.worldName}`)

  const scenesUrl = `${options.realmBaseUrl}/scenes`
  const scenesRes = await fetch(scenesUrl)
  const scenesBody = await scenesRes.json() as { scenes?: WorldSceneEntry[] }
  const scenes = scenesBody.scenes ?? []

  if (scenes.length === 0) {
    throw new Error(`No scenes found in world ${options.worldName}`)
  }

  const targetScene = pickScene(scenes, options.sceneId)

  if (!targetScene) {
    throw new Error(
      `Scene "${options.sceneId}" not found in world "${options.worldName}"`
    )
  }

  const entityId = targetScene.entityId

  // `realmBaseUrl` points at the world-scoped URL (e.g.
  // `https://worlds-content-server.decentraland.zone/world/<worldName>`), but
  // content files are served from the content-server root (`<host>/contents/`).
  // Strip the `/world/<worldName>` suffix to reach that root.
  const contentBaseUrl = `${options.realmBaseUrl.replace(/\/world\/[^/]+\/?$/, '')}/contents/`

  console.log(`📦 Loading World scene: ${entityId}`)

  // The /scenes response inlines the entity metadata + content, so we can reuse
  // `getLoadableSceneFromUrl` with the pre-fetched entity and skip an HTTP hop.
  const loadableScene = await getLoadableSceneFromUrl(entityId, contentBaseUrl, {
    ...targetScene.entity,
    type: 'scene'
  })

  console.log(`✨ Loading: ${(loadableScene.entity.metadata as any)?.display?.title || entityId}`)

  sceneContext.swap(await createSceneContext(engineScene, loadableScene, entityId, false))

  return sceneContext
}

/**
 * Pick the scene entry that matches the requested target. When no target is
 * given, returns the first scene (single-scene worlds). When a target is given
 * and a scene matches, return it. Otherwise return undefined.
 */
function pickScene(scenes: WorldSceneEntry[], sceneId: string | undefined): WorldSceneEntry | undefined {
  if (!sceneId) {
    return scenes[0]
  }
  return scenes.find((scene) => scene.entityId === sceneId)
}
