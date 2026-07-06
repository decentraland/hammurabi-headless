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
export const selectedInputVoiceDevice = Atom<string>()
export const voiceChatAvailable = Atom<boolean>()
export const mutedMicrophone = Atom<boolean>(true)
export const userDidInteract = Atom<boolean>(false)
export const playerEntityAtom = Atom<TransformNode>()
export const loadedScenesByEntityId = new Map<string /* EntityID, not URN */, SceneContext>()
export const realmErrors = Atom<string[]>()
export const loadingState = Atom<{ pending: number, total: number }>()
export const currentEnvironment = Atom<'zone' | 'org'>('org')