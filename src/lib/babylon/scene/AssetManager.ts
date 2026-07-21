// the assetManager class enable scenes to pre-fetch assets and instance them in world
// one of the main features of the assetManager is the ability to load assets in parallel
// and reuse meshes, it is common in decentraland scenes that a single model is reused
// many times inside the same scene. the associated cost of loading, parsing and generating
// buffers for each model requies us to find a reusable solution

import * as BABYLON from '@babylonjs/core'
import { robustFetch, drainResponse, readBodyCappedBytes } from '../../misc/network'
import { limits } from '../../misc/limits'

// Cap an asset/file body before buffering it whole. A large deployed file (or the
// scene-reachable `~system/Runtime.readFile` RPC) would otherwise drive an
// unbounded host allocation → worker OOM. Matches the glTF/XHR ceiling. (HAMMURABI_MAX_ASSET_BYTES)
const MAX_ASSET_BYTES = limits.maxAssetBytes
import { LoadableScene, WearableContentServerEntity, resolveFile, resolveFileAbsolute } from '../../decentraland/scene/content-server-entity'
import { GLTFFileLoader, GLTFLoaderAnimationStartMode } from '@babylonjs/loaders/glTF/glTFFileLoader'
import { GLTFLoader } from '@babylonjs/loaders/glTF/2.0'
import { setColliderMask } from './logic/colliders'
import { ColliderLayer } from '@dcl/protocol/out-js/decentraland/sdk/components/mesh_collider.gen'
import { BabylonEntity } from './BabylonEntity'

const sceneContextMap = new Map<string /*sceneId*/, WeakRef<LoadableScene>>()

export class AssetManager {
  models = new Map<string, Promise<BABYLON.AssetContainer>>()

  get wearableEntity() {
    if (this.loadableScene.entity.type !== 'wearable') throw new Error('The entity of this AssetManager is not a wearable')
    return this.loadableScene.entity as WearableContentServerEntity
  }

  constructor(public loadableScene: LoadableScene, public babylonScene: BABYLON.Scene) { }

  getContainerFuture(_src: string): Promise<BABYLON.AssetContainer> {
    const normalizedSrc = _src.toLowerCase()
    let fileHash = resolveFile(this.loadableScene.entity, normalizedSrc)

    if (!fileHash) {
      return Promise.reject(`‼️ The file ${normalizedSrc} is not present in the deployed entity.`)
    }

    if (!this.models.has(fileHash)) {
      // store a WeakRef to the sceneContext to enable file resolver
      sceneContextMap.set(this.loadableScene.urn, new WeakRef(this.loadableScene))

      const extension = normalizedSrc.endsWith('.gltf') ? '.gltf' : '.glb'

      // calculate the base path for the model
      const base = normalizedSrc.split('/').slice(0, -1).join('/')

      const ret = BABYLON.SceneLoader.LoadAssetContainerAsync(
        this.loadableScene.baseUrl,
        fileHash + '?sceneId=' + encodeURIComponent(this.loadableScene.urn) + '&base=' + encodeURIComponent(base),
        this.babylonScene,
        null,
        extension
      ).then((container) => {
        // consumers expect a fully-processed container
        processAssetContainer(container)
        return container
      })

      // sentinel handler so a load failure is never an unhandled rejection (would crash the process).
      // Consumers still observe the rejection via their own handlers on the stored promise.
      ret.catch((err) => {
        console.error(`‼️ Failed to load model ${normalizedSrc}: ${err?.message || err}`)
      })

      // store the promise in the map, it will be reused for the whole scene
      this.models.set(fileHash, ret)
    }

    return this.models.get(fileHash)!
  }

  async readFile(file: string): Promise<{ content: Uint8Array, hash: string }> {
    // this method resolves a file deployed with the entity. it returns the content of the file and its hash
    const hash = resolveFile(this.loadableScene.entity, file)
    if (!hash) throw new Error(`File not found: ${file}`)

    const absoluteLocation = resolveFileAbsolute(this.loadableScene, file)
    if (!absoluteLocation) throw new Error(`File not found: ${file}`)
    // `redirect: 'manual'` — do NOT auto-follow 3xx. This fetch is scene-reachable
    // (`~system/Runtime.readFile` → readFile, plus the auto-read of main.crdt) and
    // its body is handed to untrusted scene code. A content-addressed store has no
    // legitimate reason to redirect (the glTF/texture path already rejects 3xx via
    // the XHR polyfill), so following one would only let a compromised/malicious
    // content server bounce the request from THIS worker's network position onto a
    // loopback / private / cloud-metadata host and relay the response back to the
    // scene (SSRF). undici surfaces a 3xx here as an opaqueredirect (status 0, !ok).
    const res = await robustFetch(absoluteLocation, { redirect: 'manual' }, { label: 'asset' })

    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      await drainResponse(res)
      throw new Error(`Asset fetch refused to follow a redirect: ${absoluteLocation}`)
    }

    if (!res.ok) {
      await drainResponse(res) // release the socket before discarding the response
      throw new Error(`Error loading URL: ${absoluteLocation}`)
    }

    return { content: new Uint8Array(await readBodyCappedBytes(res, MAX_ASSET_BYTES, 'maxAssetBytes')), hash }
  }

  async loadTexture(file: string) {
    return new Promise<BABYLON.Texture>((resolve, reject) => {
      const hash = resolveFile(this.loadableScene.entity, file)
      if (!hash) throw new Error(`File not found: ${file}`)

      const absoluteLocation = resolveFileAbsolute(this.loadableScene, file)
      if (!absoluteLocation) throw new Error(`File not found: ${file}`)

      const task = new BABYLON.TextureAssetTask(file, absoluteLocation, false, false)
      task.onError = () => reject(task.errorObject)
      task.onSuccess = () => {
        resolve(task.texture)
      }
      task.run(this.babylonScene, () => resolve(task.texture), reject)
    })
  }

  dispose() {
    for (const [hash, model] of Array.from(this.models.entries())) {
      // Containers MUST be disposed: their constructor registers observers on the
      // long-lived scene AND engine (onDispose / onContextRestored) that close
      // over the container, so an undisposed container — with all its template
      // meshes, CPU vertex data, materials and textures — is pinned for the life
      // of the process. Every hot reload / scene switch leaked a full copy of
      // every model. Safe to dispose here because SceneContext.dispose() removes
      // all entities (and their instantiated entries) BEFORE disposing this
      // AssetManager, so no live instance references container resources anymore.
      model
        .then((container) => container.dispose())
        .catch(() => {
          // the load failed; there is nothing to dispose (the failure was
          // already logged by the sentinel handler at load time)
        })
      this.models.delete(hash)
    }
    // Drop this scene's file-resolver entry so the map doesn't grow one key per
    // scene load for the life of the process. Guarded so a hot reload that
    // already registered a NEW context under the same urn is not clobbered.
    const registered = sceneContextMap.get(this.loadableScene.urn)
    if (registered?.deref() === this.loadableScene) {
      sceneContextMap.delete(this.loadableScene.urn)
    }
  }
}

BABYLON.SceneLoader.OnPluginActivatedObservable.add(function (plugin) {
  if (plugin instanceof GLTFFileLoader) {
    plugin.animationStartMode = GLTFLoaderAnimationStartMode.NONE
    // no shader compilation on a NullEngine: effects are stubs, so
    // forceCompilationAsync per material x mesh is pure load-time overhead
    plugin.compileMaterials = false
    plugin.validate = false
    plugin.createInstances = true
    plugin.animationStartMode = 0
    plugin.preprocessUrlAsync = async function (url: string) {
      // HERE BE DRAGONS 🐉:
      //  To hack the GLTF loader to use Decentraland's file system, we must
      //  access private properties to get the parent context to resolve individual
      //  files.
      //
      //  This Hack prevents the engine from caching the entire GLB/GLTF because
      //  query parameters are added to them. it is RECOMMENDED that the engine
      //  caches all the files by their name (CIDv1)
      const loader: GLTFLoader = (plugin as any)._loader
      const file: string = (loader as any)._fileName
      const [_gltfFilename, strParams] = file.split('?')
      if (strParams) {
        const params = new URLSearchParams(strParams)
        const base = params.get('base') || ''
        const sceneId = params.get('sceneId')!
        const ctx = sceneContextMap.get(sceneId)?.deref()
        if (ctx) {
          const relative = url.replace(ctx.baseUrl, base ? base + '/' : '')

          const ret = resolveFileAbsolute(ctx, relative)

          if (ret) {
            return ret!
          }
        }
      }
      console.error('‼️ ‼️ ‼️ Cannot resolve file ' + url)
      return '/images/UV_checker_Map_byValle.jpg'
    }
  }
})

function processAssetContainer(assetContainer: BABYLON.AssetContainer) {
  // by default, the models will be added to the scene at 0,0,0. We will remove that instance
  assetContainer.removeAllFromScene()

  // Set-based dedupe: Array.includes inside the per-mesh/per-submesh loops was
  // O(n²) on large models (load-time only, but large scenes have thousands of
  // submeshes)
  const knownGeometries = new Set(assetContainer.geometries)
  const knownMaterials = new Set(assetContainer.materials)

  function registerGeometry(geometry: BABYLON.Geometry) {
    if (!knownGeometries.has(geometry)) {
      knownGeometries.add(geometry)
      assetContainer.geometries.push(geometry)
    }
  }

  // keep track of every generated mes and submesh
  assetContainer.meshes.forEach((mesh) => {
    if (mesh instanceof BABYLON.Mesh) {
      if (mesh.geometry) registerGeometry(mesh.geometry)
    }

    if (mesh.subMeshes) {
      mesh.subMeshes.forEach((subMesh) => {
        // this fixes a bug with meshes not correctly disposed
        subMesh.refreshBoundingInfo()

        const mesh = subMesh.getMesh()
        if (mesh instanceof BABYLON.Mesh) {
          if (mesh.geometry) registerGeometry(mesh.geometry)
        }
      })
    }

    // Find all the materials from all the meshes and add to $.materials
    mesh.cullingStrategy = BABYLON.AbstractMesh.CULLINGSTRATEGY_BOUNDINGSPHERE_ONLY

    if (mesh.material && !knownMaterials.has(mesh.material)) {
      knownMaterials.add(mesh.material)
      assetContainer.materials.push(mesh.material)
    }

    if (mesh.name.endsWith('_collider')) {
      setColliderMask(mesh, ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER)
    } else {
      setColliderMask(mesh, ColliderLayer.CL_NONE)
    }
  })

  // Find the textures in the materials that share the same domain as the context
  // then add the textures to the $.textures
  const knownTextures = new Set(assetContainer.textures)
  assetContainer.materials.forEach((material: BABYLON.Material | BABYLON.PBRMaterial) => {
    // register all textures for the scene
    for (let i in material) {
      const t = (material as any)[i]

      if (i.endsWith('Texture') && t instanceof BABYLON.Texture) {
        if (!knownTextures.has(t)) {
          knownTextures.add(t)
          assetContainer.textures.push(t)
        }
      }
    }

    if (material instanceof BABYLON.PBRMaterial) {
      // static materials for the moment
      material.freeze();

      // then replace the reflection probe of the materials when needed
      material.reflectionTexture = assetContainer.scene.reflectionProbes?.find($ => $.name === 'skyReflection')?.cubeTexture || null

      if (material.alphaMode === 2) {
        if (material.albedoTexture) {
          material.albedoTexture.hasAlpha = true
          material.useAlphaFromAlbedoTexture = true
        }
      }
    }

    material.freeze()
  })
}

const tmpVector = new BABYLON.Vector3()

export function instantiateAssetContainer(assetContainer: BABYLON.AssetContainer, parentNode: BABYLON.TransformNode, entity: BabylonEntity): BABYLON.InstantiatedEntries {
  // cloneMaterials MUST stay false: with true, every instantiation clones every
  // material into scene.materials, and InstantiatedEntries.dispose() does NOT
  // dispose materials — a scene spawning/despawning GltfContainers grew host
  // memory and the scene.materials array without bound. Headless there is no
  // per-instance visual state, so instances share the container's (frozen)
  // source materials, which are disposed with the container.
  const instances = assetContainer.instantiateModelsToScene(name => name, false)

  for (let node of instances.rootNodes) {
    // reparent the root node inside the entity
    node.parent = parentNode

    node.getChildMeshes(false).forEach(mesh => {
      // this override makes all meshes not renderable if the rootNode is not enabled.
      // it cascades the effect of the culling of the rootNode down to each mesh to lighten the CPU work
      // of calculating every bounding box
      Object.defineProperty(mesh, 'isBlocked', {
        enumerable: true,
        configurable: true,
        get() {
          // isEnabled is a METHOD — referencing it as a property is always
          // truthy, which made this override (and the isInFrustum early-out
          // below) never cull anything when the scene root was disabled.
          return !entity.context.deref()?.rootNode.isEnabled() || (mesh._masterMesh !== null && mesh._masterMesh !== undefined)
        },
      })

      const originalF = mesh.isInFrustum

      /**
       * Returns `true` if the mesh is within the frustum defined by the passed array of planes.
       * A mesh is in the frustum if its bounding box intersects the frustum
       * @param frustumPlanes defines the frustum to test
       * @returns true if the mesh is in the frustum planes
       * 
       * In this case, we are monkey patching the isInFrustum method to cull out meshes that are too far away
       * or are too small based on the distance to the camera.
       */
      mesh.isInFrustum = function (this: BABYLON.AbstractMesh, frustumPlanes: BABYLON.Plane[]): boolean {
        if (!entity.context.deref()?.rootNode.isEnabled()) return false

        if (this.absolutePosition) {
          // subtractInPlace: .subtract() allocated a fresh Vector3 per mesh per
          // frame, defeating the tmpVector reuse
          const distanceToObject = tmpVector.copyFrom(this.absolutePosition).subtractInPlace(this.getScene().activeCamera!.position).length()

          // cull out elements farther than 300meters
          if (distanceToObject > 300)
            return false

          if (this._boundingInfo) {
            if (this._boundingInfo.diagonalLength < 0.50 && distanceToObject > 30)
              return false
            // cull elements smaller than 20cm at 40meters
            if (this._boundingInfo.diagonalLength < 0.20 && distanceToObject > 20)
              return false
            // cull elements smaller than 10cm at 10meters
            if (this._boundingInfo.diagonalLength < 0.10 && distanceToObject > 10)
              return false
          }
        }

        return originalF.call(this, frustumPlanes)
      }
    })
  }

  // by default animations will be configured with weight 0
  for (let animationGroup of instances.animationGroups) {
    animationGroup.stop()
    for (let animatable of animationGroup.animatables) {
      animatable.weight = 0
    }
  }

  return instances
}