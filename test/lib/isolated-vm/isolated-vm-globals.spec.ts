import ivm from 'isolated-vm'
import { allowListES2020 } from '../../../src/lib/isolated-vm/es2020-globals'

// Ported from test/lib/runtime/quick-js-globals.spec.ts. The old harness drove the
// QuickJS WASM module directly; this one drives a fresh isolated-vm isolate. Every
// name in allowListES2020 must be a real global inside the sandbox so scene code
// has a complete standard library WITHOUT any host (Node) globals.
async function findMissingGlobals(names: string[]): Promise<string[]> {
  const isolate = new ivm.Isolate()
  try {
    const context = isolate.createContextSync()
    // Mirror the runtime bootstrap so `globalThis`/`global` resolve the same way.
    context.global.setSync('global', context.global.derefInto())
    // Use the `in` operator (not typeof) so value globals like `undefined`, `NaN`
    // and `Infinity` — whose typeof is legitimately their own value — still count
    // as present when they exist as global properties.
    return context.evalSync(
      `(() => {
        const checks = ${JSON.stringify(names)}
        const missing = []
        for (const name of checks) { if (!(name in globalThis)) missing.push(name) }
        return missing
      })()`,
      { copy: true }
    )
  } finally {
    if (!isolate.isDisposed) isolate.dispose()
  }
}

describe('es2020 globals against the isolated-vm sandbox', () => {
  describe('when checking every name in the ES2020 allow list inside a fresh isolate', () => {
    it('should expose all of them as sandbox globals', async () => {
      const missing = await findMissingGlobals(allowListES2020)

      expect(missing).toEqual([])
    })
  })
})
