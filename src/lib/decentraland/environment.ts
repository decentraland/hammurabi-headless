// Environment configuration for Decentraland services
// Uses a centralized getter pattern to read from global state

import { currentEnvironment } from './state'

export type DclEnvironment = 'zone' | 'org'

/**
 * Get the current environment from global state.
 * This is the centralized way to access the environment setting.
 * The environment is set once at startup in engine-main.ts.
 */
export function getEnvironment(): DclEnvironment {
  return currentEnvironment.getOrNull() ?? 'org'
}

export function getPeerContentUrl(): string {
  const domain = getEnvironment() === 'org' ? 'decentraland.org' : 'decentraland.zone'
  return `https://peer.${domain}/content`
}

export function getAssetBundleRegistryUrl(): string {
  const domain = getEnvironment() === 'org' ? 'decentraland.org' : 'decentraland.zone'
  return `https://asset-bundle-registry.${domain}`
}

export function getWorldsContentServerUrl(): string {
  const domain = getEnvironment() === 'org' ? 'decentraland.org' : 'decentraland.zone'
  return `https://worlds-content-server.${domain}`
}

export function getCommsGatekeeperUrl(): string {
  const domain = getEnvironment() === 'org' ? 'decentraland.org' : 'decentraland.zone'
  return `https://comms-gatekeeper.${domain}/get-server-scene-adapter`
}
