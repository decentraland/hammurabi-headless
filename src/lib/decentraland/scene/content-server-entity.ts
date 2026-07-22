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
// alphanumeric — OR, in sdk-commands local preview only, `'b64-' + base64(absolute
// file path + machine id)` using the standard (`A-Za-z0-9+/=`) or url-safe
// (`A-Za-z0-9_-`) base64 alphabet (see `b64HashingFunction` / `b64UrlHashingFunction`
// in @dcl/sdk-commands `logic/project-files.ts`; newer SDKs emit base64url). Reject
// anything else: the hash is concatenated into the fetch URL as a path segment
// (`baseUrl + hash`), so a deployer-controlled hash containing `..`, `?`, `#`, `@`,
// `%` or `\` would let WHATWG URL normalization traverse to an arbitrary path on the
// realm origin (e.g. `../../../etc/passwd`). The b64 alphabet can produce none of
// those — its `/` can only DESCEND into extra path segments below the base path,
// never ascend (that needs dots) or escape the origin, and `-`/`_` are inert in a
// path segment — so admitting both alphabets behind the mandatory `b64-` prefix
// preserves the guarantee while keeping production CID validation untouched. This
// guards every consumer at the single resolution point.
function isValidContentHash(hash: string): boolean {
  return /^[A-Za-z0-9]+$/.test(hash) || /^b64-[A-Za-z0-9+/=_-]+$/.test(hash)
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

/**
 * Encode a (validated) content hash for use as a URL path segment. A no-op for
 * CIDs (alphanumeric), but a local-preview `b64-` hash can contain `/`
 * (standard base64 of a path with e.g. non-ASCII characters), and sent raw
 * that would add an extra path segment and miss the preview server's
 * `/content/contents/:hash` route (path-to-regexp params match a single
 * segment). Encoded, the router matches one segment and decodes the param
 * back before resolving the file.
 *
 * EVERY URL built from a content hash must go through this — never concatenate
 * a raw hash into a URL.
 */
export function encodeContentHashForUrl(hash: string): string {
  return encodeURIComponent(hash)
}

export function resolveFileAbsolute(scene: LoadableScene, src: string): string | null {
  const resolved = resolveFile(scene.entity, src)

  if (resolved) return scene.baseUrl + encodeContentHashForUrl(resolved)

  return null
}
