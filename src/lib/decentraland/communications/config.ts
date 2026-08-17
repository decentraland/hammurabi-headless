export type CommsListenerConfig = {
  /** Raw HAMMURABI_COMMS_PROTOCOL value; the routing decision lives in {@link ./comms-routing}. */
  envProtocol: string | undefined
  host: string
  port: number
  realm: string
  /** HAMMURABI_PULSE_DEBUG: log each received Pulse position. Read once here, never in the per-packet hot path. */
  debug: boolean
}

/**
 * Read the comms-listener configuration from the environment ONCE, at this boundary
 * (no scattered `process.env` reads). The protocol value is passed raw to the routing
 * resolver; the port is bounds-checked. Pulse host/port/realm default to the .zone server.
 * All vars share the `HAMMURABI_` prefix so the orchestrator (sdk-multiplayer-server) forwards
 * them to spawned workers. `env` is injectable for tests.
 */
export function readCommsListenerConfig(env: Record<string, string | undefined> = process.env): CommsListenerConfig {
  const envProtocol = env.HAMMURABI_COMMS_PROTOCOL

  const envHost = env.HAMMURABI_PULSE_HOST
  const host = envHost && envHost.length > 0 ? envHost : 'pulse-server.decentraland.zone'

  const parsedPort = Number(env.HAMMURABI_PULSE_PORT)
  const port = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : 7777

  const envRealm = env.HAMMURABI_PULSE_REALM
  const realm = envRealm && envRealm.length > 0 ? envRealm : 'main'

  const debug = (env.HAMMURABI_PULSE_DEBUG ?? '').length > 0

  return { envProtocol, host, port, realm, debug }
}
