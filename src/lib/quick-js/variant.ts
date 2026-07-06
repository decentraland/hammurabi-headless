import baseVariant from '@jitl/quickjs-ng-wasmfile-release-sync'

/**
 * The quickjs-ng WASM variant used to run untrusted scene code.
 *
 * We override `importModuleLoader` to load the emscripten module via CommonJS
 * `require()` instead of the variant's default dynamic `import()`. Jest cannot
 * execute a native dynamic `import()` without `--experimental-vm-modules`, and
 * enabling that flag breaks the rest of our (esbuild-CJS-transformed) suite.
 * `require()` resolves the package's CommonJS export condition and works
 * identically in Jest and in production Node. `importFFI` already loads
 * synchronously in the base variant, so only the module loader needs overriding.
 */
export const quickJsVariant: typeof baseVariant = {
  ...baseVariant,
  importModuleLoader: () =>
    Promise.resolve(require('@jitl/quickjs-ng-wasmfile-release-sync/emscripten-module').default)
}
