#!/usr/bin/env node

import { main, resetEngine } from './lib/engine-main'

// Parse arguments
const args = process.argv.slice(2)
let realmUrl: string | undefined = undefined
let position: string | undefined = undefined
let developmentMode = true  // Default to development mode (interactive) for manual usage

for (const arg of args) {
  if (arg === '--help' || arg === '-h') {
    console.log(`
Usage: npx @dcl/hammurabi-server [--realm=<url>] [--position=<x,y>] [--production]

Options:
  --realm=<url>      Realm URL to connect to (default: localhost:8000 for local, peer.decentraland.org for position)
  --position=<x,y>   Fetch scene at parcel coordinates from content server
  --production       Run in production mode without interactive controls (for process spawning)
  --help, -h         Show this help

Examples:
  npx @dcl/hammurabi-server --realm=localhost:8000
  npx @dcl/hammurabi-server --position=80,80
  npx @dcl/hammurabi-server --position=80,80 --realm=https://my.zone
`)
    process.exit(0)
  }
  
  if (arg.startsWith('--realm=')) {
    realmUrl = arg.split('=')[1]
  }
  
  if (arg.startsWith('--position=')) {
    position = arg.split('=')[1]
    // Validate position format
    const coords = position.split(',')
    if (coords.length !== 2 || isNaN(parseInt(coords[0])) || isNaN(parseInt(coords[1]))) {
      console.error('❌ Invalid position format. Use --position=x,y (e.g., --position=80,80)')
      process.exit(1)
    }
  }
  
  if (arg === '--production') {
    developmentMode = false
  }
}

// Set default realm based on whether position is provided
if (!realmUrl) {
  realmUrl = position ? 'https://peer.decentraland.org' : 'localhost:8000'
}

// Global error handlers
process.on('uncaughtException', (error) => {
  console.error('❌ Error:', error.message)
  if (developmentMode) {
    console.log('Type "r" + Enter to restart or [Ctrl+C] to exit')
  }
})

process.on('unhandledRejection', (reason: any) => {
  console.error('❌ Error:', reason?.message || reason)
  if (developmentMode) {
    console.log('Type "r" + Enter to restart or [Ctrl+C] to exit')
  }
})

// Simple restart mechanism
let isRestarting = false

async function start() {
  try {
    const scene = await main({ realmUrl, position })
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
if (developmentMode) {
  // Simple approach: just listen to stdin data
  process.stdin.setEncoding('utf8')
  process.stdin.resume()
  
  process.stdin.on('data', (data: string) => {
    const input = data.toString().trim().toLowerCase()
    if (input === 'r') {
      console.log('🔄 Restarting...')
      restart()
    }
  })
}

// Start server
start().catch(() => {
  // Error already logged, just setup retry listener
})