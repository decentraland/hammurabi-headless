import { Emote, Scene, Wearable } from "@dcl/schemas";

export type WearableContentServerEntity = {
  type: 'wearable'
  // content files of the entity
  content: Array<{ file: string; hash: string }>
  // entity metadata
  metadata: Wearable
}

export type SceneContentServerEntity = {
  type: 'scene'
  // content files of the entity
  content: Array<{ file: string; hash: string }>
  // entity metadata
  metadata: Scene
}

export type EmoteContentServerEntity = {
  type: 'emote'
  // content files of the entity
  content: Array<{ file: string; hash: string }>
  // entity metadata
  metadata: Emote
}

export type ContentServerEntity =
  | WearableContentServerEntity
  | EmoteContentServerEntity
  | SceneContentServerEntity

export type LoadableScene = Readonly<{
  // baseUrl to download all assets
  baseUrl: string
  // urn of the entity. usually the first pointer
  urn: string
  // entity file fom the content server
  entity: ContentServerEntity
}>

// A content hash is an IPFS CID (CIDv0 `Qm…` base58 / CIDv1 `bafy…` base32) — always
// alphanumeric. Reject anything else: the hash is concatenated into the fetch URL as
// a path segment (`baseUrl + hash`), so a deployer-controlled hash containing `/`,
// `..`, `?`, `@`, etc. would let WHATWG URL normalization traverse to an arbitrary
// path on the realm origin (e.g. `../../../etc/passwd`). This guards every consumer
// at the single resolution point.
function isValidContentHash(hash: string): boolean {
  return /^[A-Za-z0-9]+$/.test(hash)
}

export function resolveFile(entity: Pick<ContentServerEntity, 'content'>, src: string): string | null {
  // filenames are lower cased as per https://adr.decentraland.org/adr/ADR-80
  const normalized = src.toLowerCase()

  // and we iterate over the entity content mappings to resolve the file hash
  for (const { file, hash } of entity.content) {
    if (file.toLowerCase() == normalized) return isValidContentHash(hash) ? hash : null
  }

  return null
}

export function resolveFileAbsolute(scene: LoadableScene, src: string): string | null {
  const resolved = resolveFile(scene.entity, src)

  if (resolved) return scene.baseUrl + resolved

  return null
}
