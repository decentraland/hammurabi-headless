// NOTE: this project's jest transformer (esbuild) does not hoist `jest.mock`
// above imports, so we register the mock first and then `require` the module
// under test.
jest.mock('../../../../src/lib/misc/network', () => ({
  robustFetch: jest.fn(),
  readBodyCapped: jest.fn(),
  readBodyCappedBytes: jest.fn(),
  drainResponse: jest.fn(),
  DEFAULT_MAX_BODY_BYTES: 10 * 1024 * 1024
}))

const { getLoadableSceneFromLocalContext } = require('../../../../src/lib/babylon/scene/load')
const { robustFetch, readBodyCapped } = require('../../../../src/lib/misc/network')

const robustFetchMock = robustFetch as jest.Mock
const readBodyCappedMock = readBodyCapped as jest.Mock

describe('getLoadableSceneFromLocalContext', () => {
  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when the scene spans many parcels', () => {
    beforeEach(() => {
      robustFetchMock.mockResolvedValue({ ok: true })
      readBodyCappedMock
        // scene.json: a multi-parcel scene
        .mockResolvedValueOnce(JSON.stringify({ scene: { parcels: ['0,0', '0,1', '1,0', '1,1'], base: '1,0' } }))
        // entities/active response
        .mockResolvedValueOnce(JSON.stringify([{ id: 'b64-entity', content: [], metadata: {} }]))
    })

    it('should request entities/active with ONLY the base pointer (the preview replies once per requested pointer)', async () => {
      await getLoadableSceneFromLocalContext('http://localhost:8000')

      const post = robustFetchMock.mock.calls.find((call) => String(call[0]).includes('entities/active'))
      expect(JSON.parse(post[1].body)).toEqual({ pointers: ['1,0'] })
    })

    it('should build the loadable scene from the returned entity', async () => {
      const loadable = await getLoadableSceneFromLocalContext('http://localhost:8000')

      expect(loadable.urn).toBe('b64-entity')
      expect(loadable.baseUrl).toBe('http://localhost:8000/content/contents/')
    })
  })

  describe('when scene.json declares a base parcel that is not in its parcels list', () => {
    beforeEach(() => {
      robustFetchMock.mockResolvedValue({ ok: true })
      readBodyCappedMock
        // Inconsistent scene.json: base outside the parcels list.
        .mockResolvedValueOnce(JSON.stringify({ scene: { parcels: ['5,5', '5,6'], base: '99,99' } }))
        .mockResolvedValueOnce(JSON.stringify([{ id: 'b64-entity', content: [], metadata: {} }]))
    })

    it('should ignore the inconsistent base and request the first parcel', async () => {
      await getLoadableSceneFromLocalContext('http://localhost:8000')

      const post = robustFetchMock.mock.calls.find((call) => String(call[0]).includes('entities/active'))
      expect(JSON.parse(post[1].body)).toEqual({ pointers: ['5,5'] })
    })
  })

  describe('when scene.json declares no base parcel', () => {
    beforeEach(() => {
      robustFetchMock.mockResolvedValue({ ok: true })
      readBodyCappedMock
        .mockResolvedValueOnce(JSON.stringify({ scene: { parcels: ['5,5', '5,6'] } }))
        .mockResolvedValueOnce(JSON.stringify([{ id: 'b64-entity', content: [], metadata: {} }]))
    })

    it('should fall back to the first parcel', async () => {
      await getLoadableSceneFromLocalContext('http://localhost:8000')

      const post = robustFetchMock.mock.calls.find((call) => String(call[0]).includes('entities/active'))
      expect(JSON.parse(post[1].body)).toEqual({ pointers: ['5,5'] })
    })
  })

  describe('when scene.json has no parcels', () => {
    beforeEach(() => {
      robustFetchMock.mockResolvedValue({ ok: true })
      readBodyCappedMock.mockResolvedValueOnce(JSON.stringify({ scene: { parcels: [] } }))
    })

    it('should reject with the missing-pointers error', async () => {
      await expect(getLoadableSceneFromLocalContext('http://localhost:8000')).rejects.toThrow(/No pointers found/)
    })
  })
})
