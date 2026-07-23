/**
 * Hard requirement: Node 22 or 24.
 *
 * The runtime depends on native addons (isolated-vm) whose prebuilt binaries
 * ship only for specific Node ABIs — 127 (Node 22) and 137 (Node 24). On any
 * other Node major (23, 26, ...) the process dies at `require('isolated-vm')`
 * with a cryptic node-gyp-build error ("No native build was found ...
 * abi=147"), or `npx` silently attempts a from-source compile on the user's
 * machine. Fail fast with an actionable message instead.
 *
 * This module runs its check AT IMPORT TIME, so it must be the FIRST import of
 * every entry point (cli.ts, index.ts) — before any module that transitively
 * requires isolated-vm. It is deliberately dependency-free so nothing heavy
 * loads before the check.
 */

/** Node majors with a shipped isolated-vm prebuild. Update when prebuilds do. */
export const SUPPORTED_NODE_MAJORS: readonly number[] = [22, 24]

/**
 * Returns the error message to show when the running Node version is
 * unsupported, or null when the version is fine. Fails closed: an unparsable
 * version is treated as unsupported.
 *
 * @param nodeVersion - Version string as in `process.versions.node` (e.g. "24.16.0").
 */
export function getUnsupportedNodeMessage(nodeVersion: string): string | null {
  const major = Number(nodeVersion.split('.')[0])
  if (SUPPORTED_NODE_MAJORS.includes(major)) return null
  return (
    `❌ @dcl/hammurabi-server requires Node ${SUPPORTED_NODE_MAJORS.join(' or ')} (found v${nodeVersion}).\n` +
    `   Switch versions and retry — e.g. "fnm use 24" or "nvm use 24".`
  )
}

const message = getUnsupportedNodeMessage(process.versions.node)
if (message) {
  console.error(message)
  // 78 = sysexits EX_CONFIG, matching EXIT_CODES.CONFIG in shutdown.ts (not
  // imported here to keep this module dependency-free): a permanent config
  // fault a supervisor must not blindly respawn.
  process.exit(78)
}
