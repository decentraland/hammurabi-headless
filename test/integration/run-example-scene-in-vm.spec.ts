import { existsSync } from 'fs'
import { runSnapshotTest } from './testing-framework/runner'

const sourceFile = 'testing-realm/scene-0_1/src/index.ts'
const bundle = 'testing-realm/scene-0_1/bin/index.js'

// The testing-realm fixture scenes came from the upstream decentraland/hammurabi
// repo and were never committed to this fork, so a clean clone has nothing to
// run here. Skip visibly instead of failing: drop the fixture in place (or add
// it to the repo) and the suite runs again.
if (!existsSync(bundle)) {
  describe(`snapshot test for ${bundle}`, () => {
    it.skip(`skipped: fixture ${bundle} is not present in this checkout`, () => {})
  })
} else {
  runSnapshotTest(sourceFile, bundle, `test/integration/run-example-scene-in-vm.spec.ts.snapshot.md`)
}
