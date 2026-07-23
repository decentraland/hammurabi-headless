// Unit coverage for the orderly-shutdown contract. The end-to-end crash-freeness
// (no SIGSEGV when exiting mid scene-turn) is proven by process-level PoCs; here we
// pin the module mechanics with process.exit / process.kill mocked so the test
// runner survives.
describe('runGracefulShutdown', () => {
  let exitSpy: jest.SpyInstance
  let killSpy: jest.SpyInstance
  let mod: typeof import('../../../src/lib/misc/shutdown')

  beforeEach(() => {
    jest.resetModules() // fresh module state (the `shuttingDown` guard is module-level)
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any)
    killSpy = jest.spyOn(process, 'kill').mockImplementation((() => true) as any)
    mod = require('../../../src/lib/misc/shutdown')
  })

  afterEach(() => {
    exitSpy.mockRestore()
    killSpy.mockRestore()
  })

  it('should run registered hooks then exit with the given code when there is no signal', async () => {
    const order: string[] = []
    mod.registerShutdownHook(() => { order.push('a') })
    mod.registerShutdownHook(async () => { order.push('b') })

    await mod.runGracefulShutdown(mod.EXIT_CODES.COMMS_LOST, undefined, { hookTimeoutMs: 50, drainMs: 0 })

    expect(order).toEqual(['a', 'b'])
    expect(exitSpy).toHaveBeenCalledWith(mod.EXIT_CODES.COMMS_LOST)
    expect(killSpy).not.toHaveBeenCalled()
  })

  it('should re-raise the signal (crash-free OS termination) instead of process.exit when a signal triggered it', async () => {
    const removeSpy = jest.spyOn(process, 'removeAllListeners').mockReturnValue(process)
    await mod.runGracefulShutdown(0, 'SIGTERM', { hookTimeoutMs: 50, drainMs: 0 })

    expect(removeSpy).toHaveBeenCalledWith('SIGTERM')
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM')
    expect(exitSpy).not.toHaveBeenCalled()
    removeSpy.mockRestore()
  })

  it('should be idempotent — a second call does nothing', async () => {
    const hook = jest.fn()
    mod.registerShutdownHook(hook)

    await mod.runGracefulShutdown(1, undefined, { hookTimeoutMs: 50, drainMs: 0 })
    await mod.runGracefulShutdown(1, undefined, { hookTimeoutMs: 50, drainMs: 0 })

    expect(hook).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledTimes(1)
  })

  it('should not let a throwing hook abort the shutdown', async () => {
    const later = jest.fn()
    mod.registerShutdownHook(() => { throw new Error('boom') })
    mod.registerShutdownHook(later)

    await mod.runGracefulShutdown(1, undefined, { hookTimeoutMs: 50, drainMs: 0 })

    expect(later).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
