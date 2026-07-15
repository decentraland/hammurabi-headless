import { withIsolatedVm } from '../../../src/lib/isolated-vm/index'

/**
 * Regression tests for the security boundary: untrusted scene code runs inside the
 * isolated-vm (V8) sandbox and MUST NOT be able to reach the Node host realm (which
 * holds the worker's private key) nor wedge / exhaust the worker.
 *
 * Ported from the QuickJS suite: same guarantees, V8 error wording.
 */
describe('isolated-vm scene sandbox isolation', () => {
  describe('when scene code probes for Node host globals', () => {
    it('should not expose the Node process object', async () => {
      const { result } = await withIsolatedVm(async (opts) => opts.eval(`typeof process`))
      expect(result).toBe('undefined')
    })

    it('should not expose a Node require on the global object', async () => {
      const { result } = await withIsolatedVm(async (opts) => opts.eval(`typeof globalThis.require`))
      expect(result).toBe('undefined')
    })
  })

  describe('when scene code attempts the classic Function("return this") realm escape', () => {
    it('should resolve to the VM global, which has no process (cannot reach the host)', async () => {
      const { result } = await withIsolatedVm(async (opts) => opts.eval(`typeof Function('return this')().process`))
      expect(result).toBe('undefined')
    })

    it('should not let the scene read a host environment variable', async () => {
      process.env.PROCESS_PRIVATE_KEY_TEST = '0xSHOULD_NOT_LEAK'
      try {
        const { result } = await withIsolatedVm(async (opts) =>
          opts.eval(`
            (function () {
              try { return String(Function('return this')().process.env.PROCESS_PRIVATE_KEY_TEST) }
              catch (e) { return 'BLOCKED' }
            })()
          `)
        )
        expect(result).toBe('BLOCKED')
      } finally {
        delete process.env.PROCESS_PRIVATE_KEY_TEST
      }
    })
  })

  describe('when scene code runs a runaway synchronous loop', () => {
    it('should interrupt it at the execution deadline instead of hanging', async () => {
      await expect(
        withIsolatedVm(async (opts) => opts.eval(`while (true) {}`), { maxSyncExecutionMs: 200 })
      ).rejects.toThrow('Script execution timed out')
    })
  })

  describe('when scene code allocates past the memory ceiling', () => {
    it('should throw out-of-memory instead of exhausting the worker heap', async () => {
      await expect(
        withIsolatedVm(async (opts) => opts.eval(`const a = []; while (true) { a.push(new Array(100000).fill(0)) }`), {
          memoryLimitBytes: 16 * 1024 * 1024,
          maxSyncExecutionMs: 5000
        })
      ).rejects.toThrow(/disposed|memory limit/i)
    })
  })
})
