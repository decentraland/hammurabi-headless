import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core'
import { classifyTeardownError } from '../../../src/lib/quick-js/index'
import { quickJsVariant } from '../../../src/lib/quick-js/variant'

// The teardown recovery in withQuickJsVm rests on two facts about the WASM
// build: every Emscripten abort surfaces as a WebAssembly.RuntimeError (the
// signal used to drop the poisoned module cache), and a leaked host handle
// trips specifically the `list_empty(&rt->gc_obj_list)` assert (the signal for
// the `leaking` diagnostic). classifyTeardownError encodes the mapping; the
// contract test at the bottom pins the facts against the real library so a
// dependency bump that changes either breaks HERE instead of resurfacing as
// every-scene-load-fails in production.
describe('classifyTeardownError', () => {
  describe('when vm.dispose aborts with the gc_obj_list leak assert', () => {
    let abortError: Error

    beforeEach(() => {
      abortError = new WebAssembly.RuntimeError(
        'Aborted(Assertion failed: list_empty(&rt->gc_obj_list), at: quickjs-amalgam.c,12520,JS_FreeRuntime)'
      )
    })

    it('should mark the VM as leaking and drop the module cache', () => {
      expect(classifyTeardownError(abortError, false)).toEqual({
        dropCache: true,
        leaking: true,
        rethrow: false
      })
    })

    it('should not rethrow even when a scene failure is pending', () => {
      expect(classifyTeardownError(abortError, true).rethrow).toBe(false)
    })
  })

  describe('when vm.dispose aborts with a different assert', () => {
    let abortError: Error

    beforeEach(() => {
      // A double-disposed handle underflows a ref count: same abort class,
      // different assert wording — the cache must still be dropped.
      abortError = new WebAssembly.RuntimeError(
        'Aborted(Assertion failed: p->ref_count > 0, at: quickjs-amalgam.c,5822,gc_decref_child)'
      )
    })

    it('should still drop the module cache without marking a leak', () => {
      expect(classifyTeardownError(abortError, false)).toEqual({
        dropCache: true,
        leaking: false,
        rethrow: true
      })
    })

    it('should not rethrow when a scene failure is pending', () => {
      expect(classifyTeardownError(abortError, true).rethrow).toBe(false)
    })
  })

  describe('when vm.dispose throws a non-abort error', () => {
    let plainError: Error

    beforeEach(() => {
      plainError = new Error('Lifetime not alive')
    })

    it('should keep the module cache and rethrow when the scene did not fail', () => {
      expect(classifyTeardownError(plainError, false)).toEqual({
        dropCache: false,
        leaking: false,
        rethrow: true
      })
    })

    it('should suppress it in favor of a pending scene failure', () => {
      expect(classifyTeardownError(plainError, true).rethrow).toBe(false)
    })
  })
})

describe('WASM abort contract', () => {
  describe('when a context with a leaked handle is disposed', () => {
    let thrown: unknown
    let consoleErrorSpy: jest.SpyInstance

    afterEach(() => {
      consoleErrorSpy.mockRestore()
    })

    beforeEach(async () => {
      // the deliberate abort below prints Emscripten noise through console.error
      consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
      // A throwaway module instance: the deliberate abort below permanently
      // poisons it, so it must never be the process-shared cached one.
      const Q = await newQuickJSWASMModuleFromVariant(quickJsVariant)
      const vm = Q.newContext()
      // Deliberately leaked — never disposed. This is the production bug class
      // (a pending deferred's resolver handles at hot reload).
      vm.newObject()
      thrown = undefined
      try {
        vm.dispose()
      } catch (err) {
        thrown = err
      }
    })

    it('should abort with a WebAssembly.RuntimeError naming the gc_obj_list assert', () => {
      expect(thrown).toBeInstanceOf(WebAssembly.RuntimeError)
      expect(String(thrown)).toContain('Aborted')
      expect(String(thrown)).toContain('list_empty(&rt->gc_obj_list)')
    })

    it('should classify as a leak that drops the module cache', () => {
      expect(classifyTeardownError(thrown, false)).toEqual({
        dropCache: true,
        leaking: true,
        rethrow: false
      })
    })
  })
})
