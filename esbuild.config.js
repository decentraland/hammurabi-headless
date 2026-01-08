const esbuild = require("esbuild")

const isProduction = process.env.NODE_ENV === "production" || process.argv.includes("--production")

// Build configuration for CommonJS worker bundle
const buildWorkerBundle = {
  entryPoints: ["src/index.ts"],
  bundle: true,
  outfile: "dist/worker-bundle.cjs",
  format: "cjs",
  platform: "node",
  target: "node18",
  // Production optimizations
  minify: isProduction,
  sourcemap: !isProduction, // Only include source maps in development
  treeShaking: true,
  // Drop console logs and debugger statements in production
  // drop: isProduction ? ['console', 'debugger'] : [],
  // Additional size optimizations for production
  keepNames: !isProduction, // Allow name mangling in production
  legalComments: isProduction ? "none" : "inline",
  // Bundle all dependencies except Node.js built-ins and native modules
  external: [
    // Node.js built-ins
    "fs",
    "path",
    "os",
    "crypto",
    "http",
    "https",
    "url",
    "events",
    "stream",
    "buffer",
    "util",
    "worker_threads",
    "child_process",
    "net",
    "tls",
    "dns",
    // Native modules that can't be bundled
    "@livekit/rtc-node",
    "@livekit/rtc-node-*",
    // Any .node files
    "*.node",
  ],
  // Handle dynamic imports
  mainFields: ["module", "main"],
  resolveExtensions: [".ts", ".js", ".mjs"],
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  // Handle problematic imports
  plugins: [
    {
      name: "native-modules-resolver",
      setup(build) {
        // Exclude native modules from bundling
        build.onResolve({ filter: /\.node$/ }, () => {
          return { external: true }
        })

        // Exclude LiveKit native modules
        build.onResolve({ filter: /@livekit\/rtc-node/ }, () => {
          return { external: true }
        })
      },
    },
  ],
  logLevel: "info",
}

// Build for CLI (existing behavior) - let TypeScript handle this
const buildCli = null // Skip esbuild for CLI, use TypeScript output

// Build index for direct imports - let TypeScript handle this
const buildIndex = null // Skip esbuild for index, use TypeScript output

async function build() {
  try {
    console.log("🔨 Building CommonJS worker bundle...")
    await esbuild.build(buildWorkerBundle)
    console.log("✅ Worker bundle built successfully")
    console.log("ℹ️  CLI and index are built by TypeScript (tsc)")
    console.log("🎉 esbuild completed!")
  } catch (error) {
    console.error("❌ Build failed:", error)
    process.exit(1)
  }
}

if (require.main === module) {
  build()
}

module.exports = { buildWorkerBundle, buildCli, buildIndex, build }
