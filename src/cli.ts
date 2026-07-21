#!/usr/bin/env node

// MUST stay the first import: checks the Node version at import time and exits
// with a clear message before anything transitively requires isolated-vm.
import './lib/misc/node-version-check'
import { main, resetEngine } from './lib/engine-main'
import { runGracefulShutdown, EXIT_CODES } from './lib/misc/shutdown'
import type { DclEnvironment } from './lib/decentraland/environment'

// Parse arguments
const args = process.argv.slice(2)
let realmUrl: string | undefined = undefined
let position: string | undefined = undefined
let sceneId: string | undefined = undefined
let privateKey: string | undefined = undefined
let environment: DclEnvironment = 'org'  // Default to 'org'
let developmentMode = true  // Default to development mode (interactive) for manual usage

for (const arg of args) {
  if (arg === '--help' || arg === '-h') {
    console.log(`
Usage: npx @dcl/hammurabi-server [--realm=<url>] [--position=<x,y>] [--scene-id=<hash>] [--private-key=<hex>] [--env=<zone|org>] [--production]

Options:
  --realm=<url>      Realm URL to connect to (default: localhost:8000 for local, peer.decentraland.org for position)
                     Can be a .dcl.eth World name (e.g., boedo.dcl.eth)
  --position=<x,y>   Fetch scene at parcel coordinates from content server (required for Genesis City)
  --scene-id=<hash>  Target scene entity hash for multi-scene worlds. When omitted, the first scene
                     in the world's about.json is loaded
  --private-key=<hex> Use a specific private key for authentication (hex string with or without 0x prefix)
                     Can also be set via PRIVATE_KEY environment variable
  --env=<zone|org>   Environment to use for Decentraland services (default: org)
                     'org' = production (decentraland.org)
                     'zone' = development (decentraland.zone)
  --production       Run in production mode without interactive controls (for process spawning)
  --help, -h         Show this help

Examples:
  npx @dcl/hammurabi-server --realm=localhost:8000
  npx @dcl/hammurabi-server --position=80,80
  npx @dcl/hammurabi-server --position=80,80 --realm=https://my.zone
  npx @dcl/hammurabi-server --realm=boedo.dcl.eth
  npx @dcl/hammurabi-server --position=0,0 --private-key=0x1234567890abcdef...
  npx @dcl/hammurabi-server --position=0,0 --env=zone
  PRIVATE_KEY=0x1234... npx @dcl/hammurabi-server --position=0,0
`)
    process.exit(0)
  }

  // Everything after the first '=' is the value: split('=')[1] would silently
  // truncate values that themselves contain '=' (e.g. realm URLs with query
  // params like ?access=abc). undefined (not the whole flag string) for
  // '='-less args, so a future branch that forgets the '=' in its prefix
  // fails loudly instead of receiving a plausible-looking wrong value.
  const equalsIndex = arg.indexOf('=')
  const argValue = equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1)

  if (arg.startsWith('--realm=')) {
    realmUrl = argValue!
  } else if (arg.startsWith('--position=')) {
    position = argValue!
    // Validate strictly: the raw string is used verbatim as the content-server
    // pointer, so a lenient parseInt check would let e.g. "80.5,80" through
    // only to fail later with a misleading "No scene found".
    if (!/^-?\d+,-?\d+$/.test(position)) {
      console.error('❌ Invalid position format. Use --position=x,y (e.g., --position=80,80)')
      process.exit(EXIT_CODES.CONFIG)
    }
  } else if (arg.startsWith('--scene-id=')) {
    sceneId = argValue!
  } else if (arg.startsWith('--private-key=')) {
    privateKey = argValue!
  } else if (arg.startsWith('--env=')) {
    if (argValue === 'zone' || argValue === 'org') {
      environment = argValue
    } else {
      console.error('❌ Invalid --env value. Use --env=zone or --env=org')
      process.exit(EXIT_CODES.CONFIG)
    }
  } else if (arg === '--production') {
    developmentMode = false
  } else if (arg.startsWith('--')) {
    // A typoed flag silently falling through to defaults is confusing; warn.
    console.warn(`⚠️ Unrecognized argument "${arg}" ignored. See --help for supported options.`)
  }
}

// Set default realm based on whether position is provided
if (!realmUrl) {
  realmUrl = position ? 'https://peer.decentraland.org' : 'http://localhost:8000'
}

// Check for private key from environment variable if not provided via CLI
if (!privateKey && process.env.PRIVATE_KEY) {
  privateKey = process.env.PRIVATE_KEY
  console.log('🔑 Using private key from PRIVATE_KEY environment variable')
}

// Global error handlers. Always print the stack: a message-only line hides
// where the failure happened, which matters because an uncaught exception here
// may mean a subsystem (not protected by its own try/catch) just died.
process.on('uncaughtException', (error) => {
  console.error('❌ Error:', error.stack || error.message)
  if (developmentMode) {
    console.log('Type "r" + Enter to restart or [Ctrl+C] to exit')
  }
})

process.on('unhandledRejection', (reason: any) => {
  console.error('❌ Error:', reason?.stack || reason?.message || reason)
  if (developmentMode) {
    console.log('Type "r" + Enter to restart or [Ctrl+C] to exit')
  }
})

// Supervised (production) shutdown: a parent server signals us to stop. Tear down
// gracefully — dispose the scene so its isolate reaches idle and the process exits
// cleanly — instead of the OS killing us mid-turn (which would leave the LiveKit
// participant dangling until the SFU times it out). Dev mode keeps the default
// signal behavior so Ctrl+C exits immediately.
if (!developmentMode) {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      console.log(`↩️  Received ${signal}, shutting down gracefully…`)
      void runGracefulShutdown(0, signal)
    })
  }
}

// Simple restart mechanism
let isRestarting = false

async function start() {
  try {
    const scene = await main({ realmUrl, position, sceneId, privateKey, environment, restartOnCommsLoss: !developmentMode })
    if (developmentMode) {
      console.log('✅ Server running - Type "r" + Enter to restart or [Ctrl+C] to exit')
    } else {
      console.log('✅ Server running in production mode')
    }
    return scene
  } catch (error: any) {
    console.error('❌ Failed to start:', error.message)
    if (developmentMode) {
      console.log('Type "r" + Enter to retry or [Ctrl+C] to exit')
    }
    throw error
  }
}

async function restart() {
  if (isRestarting) return

  isRestarting = true
  console.log('🔄 Restarting...')

  try {
    resetEngine()
    await new Promise(resolve => setTimeout(resolve, 100))
    await start()
  } catch (error) {
    console.error('❌ Restart failed')
  }

  isRestarting = false
}

// Key listener - only in development mode
if (developmentMode && process.stdin.setRawMode) {
  console.log('📋 Development mode - restart listener enabled')
  process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  process.stdin.resume()

  process.stdin.on('data', (data: string) => {
    const input = data.toString().trim().toLowerCase()
    if (input === 'r') {
      console.log('🔄 Restarting...')
      restart()
    }
    if (input === '\u0003') { // Ctrl+C
      process.exit(0)
    }
  })
}

// Start server
start().catch(() => {
  // Error already logged. In development the user can retry with 'r', but in
  // production nothing can recover: the render loop started by main() keeps the
  // event loop alive, so without an explicit exit a supervisor would see a
  // healthy-looking process that will never serve.
  if (!developmentMode) {
    process.exit(EXIT_CODES.STARTUP)
  }
})
