// Global state atoms for the application

import { AboutResponse } from "@dcl/protocol/out-js/decentraland/realm/about.gen"
import { SceneContext } from "../babylon/scene/scene-context"
import { ExplorerIdentity } from "./identity/types"
import { Atom } from "../misc/atom"
import { TransformNode } from "@babylonjs/core"

// Note: DclEnvironment type is inlined here to avoid circular dependency with environment.ts

export type CurrentRealm = {
  baseUrl: string
  connectionString: string
  aboutResponse: AboutResponse
}

// A short-lived, WORLD-SCOPED storage credential minted by a trusted parent
// orchestrator (never derived in this untrusted worker). The worker signs
// `storage.decentraland.*` requests with `ephemeral` and forwards the root-signed
// `scope` claim; the world-storage-service authorizes it only for `world`, so a
// worker compromise leaks at most this one world's ephemeral until `expiration`.
// The worker renews it on demand over IPC before it lapses, so it keeps a valid
// one for its whole life.
export type StorageDelegation = {
  v: number
  world: string
  ephemeral: { privateKey: string; publicKey: string; address: string }
  scope: { payload: string; signature: string }
  expiration: number
}

// The server's own identity. When the server runs with a private key (an
// authoritative multiplayer server) this is a PRIVILEGED identity used only for
// host operations (e.g. obtaining a comms token). It must never be exposed to
// scene code.
export const userIdentity = Atom<ExplorerIdentity>()

// A separate, unprivileged guest identity used to satisfy scene-facing APIs
// (`~system/SignedFetch`, `~system/UserIdentity`). Signing scene requests with
// this instead of `userIdentity` prevents untrusted scene code from making
// requests that impersonate the authoritative server.
export const sceneIdentity = Atom<ExplorerIdentity>()

export const currentRealm = Atom<CurrentRealm>()
// Optional: set only for authoritative world workers that received a storage
// delegation. Read with getOrNull() — it is legitimately absent for Genesis City
// scenes and for workers spawned without one.
export const storageDelegation = Atom<StorageDelegation>()
export const selectedInputVoiceDevice = Atom<string>()
export const voiceChatAvailable = Atom<boolean>()
export const mutedMicrophone = Atom<boolean>(true)
export const userDidInteract = Atom<boolean>(false)
export const playerEntityAtom = Atom<TransformNode>()
export const loadedScenesByEntityId = new Map<string /* EntityID, not URN */, SceneContext>()
export const realmErrors = Atom<string[]>()
export const loadingState = Atom<{ pending: number, total: number }>()
export const currentEnvironment = Atom<'zone' | 'org'>('org')