// Process entrypoint for the worker bundle (`@dcl/hammurabi-server/worker`,
// built by esbuild from this file). Supervisors fork this bundle as a child
// PROCESS, so the Node-version preflight below may process.exit(78) — it must
// run BEFORE anything transitively requires isolated-vm.
//
// The plain package export (`dist/index.js`, built from index.ts) deliberately
// does NOT run the preflight: a programmatic consumer importing
// `@dcl/hammurabi-server` must never have its process terminated by a library
// import.
import './lib/misc/node-version-check'

export * from './index'
