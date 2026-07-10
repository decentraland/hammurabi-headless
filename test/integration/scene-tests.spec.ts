import { existsSync, readdirSync } from 'fs'
import path from 'path'
import { itExecutes } from './testing-framework/run-command'
import { runSnapshotTest } from './testing-framework/runner'

const sceneDir = 'testing-realm/scene-0_0'
const baseDir = path.join(sceneDir, 'src/tests')

// The testing-realm fixture scenes came from the upstream decentraland/hammurabi
// repo and were never committed to this fork, so a clean clone has nothing to
// run here. Skip visibly instead of failing: drop the fixture in place (or add
// it to the repo) and the suite runs again.
if (!existsSync(baseDir)) {
  describe('scene snapshots tests', () => {
    it.skip(`skipped: fixture directory ${baseDir} is not present in this checkout`, () => {})
  })
} else {
  describe('scene snapshots tests', () => {
    itExecutes(`npm run build-tests`, sceneDir, process.env)

    readdirSync(baseDir).forEach((file) => {
      if (file.endsWith('.test.ts')) {
        const sourceFile = path.join(baseDir, file)
        const bundle = sourceFile.replace(/\.ts$/, '.js')
        runSnapshotTest(sourceFile, bundle)
      }
    })
  })
}
