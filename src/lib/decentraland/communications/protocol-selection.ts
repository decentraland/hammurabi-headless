/** Comms protocol selected once at startup (a flip takes effect on the next process restart). */
export type CommsProtocol = 'pulse' | 'livekit'

export interface ProtocolSelectionInput {
  /** Pre-minted comms adapter handed in by a trusted orchestrator (PROCESS_COMMS_ADAPTER). */
  commsAdapter: string | undefined
  /** Raw HAMMURABI_COMMS_PROTOCOL env value (unvalidated). */
  envProtocol: string | undefined
}

export interface ProtocolSelection {
  protocol: CommsProtocol
  /** True when an orchestrator-minted adapter is being ignored because the env var forces pulse. */
  ignoredAdapter: boolean
}

/**
 * Livekit is the default everywhere (local dev, Worlds, Genesis City, orchestrated spawns);
 * pulse is an explicit opt-in via HAMMURABI_COMMS_PROTOCOL=pulse. The env var beats a
 * handed-in comms adapter on purpose: sdk-multiplayer-server always mints
 * PROCESS_COMMS_ADAPTER and forwards HAMMURABI_* env vars to its children, so flipping a
 * fleet to pulse must not require orchestrator code changes. Unrecognized values fall back
 * to livekit (fail-safe).
 */
export function selectCommsProtocol({ commsAdapter, envProtocol }: ProtocolSelectionInput): ProtocolSelection {
  if (envProtocol === 'pulse') {
    return { protocol: 'pulse', ignoredAdapter: commsAdapter !== undefined }
  }
  return { protocol: 'livekit', ignoredAdapter: false }
}
