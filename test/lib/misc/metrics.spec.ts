import { createMetricsRegistry, MAX_LABEL_VALUES } from '../../../src/lib/misc/metrics'

describe('createMetricsRegistry', () => {
  describe('counter', () => {
    it('starts at zero and accumulates increments', () => {
      const registry = createMetricsRegistry()
      const c = registry.counter('test_total', 'a counter')
      expect(c.value).toBe(0)
      c.inc()
      c.inc(5)
      expect(c.value).toBe(6)
    })

    it('ignores non-finite, zero and negative deltas (counters only go up)', () => {
      const registry = createMetricsRegistry()
      const c = registry.counter('test_total', 'a counter')
      c.inc(NaN)
      c.inc(Infinity)
      c.inc(-3)
      c.inc(0)
      expect(c.value).toBe(0)
    })

    it('renders HELP, TYPE and the sample in exposition format', () => {
      const registry = createMetricsRegistry()
      registry.counter('test_total', 'a counter').inc(2)
      expect(registry.render()).toBe('# HELP test_total a counter\n# TYPE test_total counter\ntest_total 2\n')
    })

    it('returns the same handle when the same name is registered twice', () => {
      const registry = createMetricsRegistry()
      const a = registry.counter('test_total', 'a counter')
      const b = registry.counter('test_total', 'other help')
      expect(b).toBe(a)
    })
  })

  describe('labeled counter', () => {
    it('keeps one series per label value', () => {
      const registry = createMetricsRegistry()
      const c = registry.labeledCounter('hits_total', 'hits', 'limit')
      c.inc('a')
      c.inc('a')
      c.inc('b', 3)
      expect(registry.render()).toContain('hits_total{limit="a"} 2\n')
      expect(registry.render()).toContain('hits_total{limit="b"} 3\n')
    })

    it('escapes quotes, backslashes and newlines in label values', () => {
      const registry = createMetricsRegistry()
      const c = registry.labeledCounter('hits_total', 'hits', 'limit')
      c.inc('a"b\\c\nd')
      expect(registry.render()).toContain('hits_total{limit="a\\"b\\\\c\\nd"} 1\n')
    })

    it('folds label values beyond the cardinality cap into "other"', () => {
      const registry = createMetricsRegistry()
      const c = registry.labeledCounter('hits_total', 'hits', 'limit')
      for (let i = 0; i < MAX_LABEL_VALUES + 10; i++) c.inc(`label-${i}`)
      const rendered = registry.render()
      expect(rendered).toContain('hits_total{limit="other"} 10\n')
      expect(rendered.split('\n').filter((l) => l.startsWith('hits_total{'))).toHaveLength(MAX_LABEL_VALUES + 1)
    })
  })

  describe('gauge', () => {
    it('reports the last set value and ignores non-finite sets', () => {
      const registry = createMetricsRegistry()
      const g = registry.gauge('rss_bytes', 'rss')
      g.set(42)
      g.set(NaN)
      expect(g.get()).toBe(42)
      expect(registry.render()).toContain('rss_bytes 42\n')
    })

    it('samples a collector callback at read time', () => {
      const registry = createMetricsRegistry()
      let value = 7
      const g = registry.gauge('players', 'players', () => value)
      expect(g.get()).toBe(7)
      value = 9
      expect(registry.render()).toContain('players 9\n')
    })

    it('keeps the last good value when the collector throws', () => {
      const registry = createMetricsRegistry()
      let boom = false
      const g = registry.gauge('players', 'players', () => {
        if (boom) throw new Error('collector broke')
        return 3
      })
      expect(g.get()).toBe(3)
      boom = true
      expect(g.get()).toBe(3)
      expect(registry.render()).toContain('players 3\n')
    })
  })

  describe('histogram', () => {
    it('renders cumulative buckets, +Inf, sum and count', () => {
      const registry = createMetricsRegistry()
      const h = registry.histogram('dt_seconds', 'dt', [0.5, 2])
      h.observe(0.25)
      h.observe(1)
      h.observe(8)
      const rendered = registry.render()
      expect(rendered).toContain('dt_seconds_bucket{le="0.5"} 1\n')
      expect(rendered).toContain('dt_seconds_bucket{le="2"} 2\n')
      expect(rendered).toContain('dt_seconds_bucket{le="+Inf"} 3\n')
      expect(rendered).toContain('dt_seconds_sum 9.25\n')
      expect(rendered).toContain('dt_seconds_count 3\n')
    })

    it('ignores non-finite observations', () => {
      const registry = createMetricsRegistry()
      const h = registry.histogram('dt_seconds', 'dt', [1])
      h.observe(NaN)
      h.observe(Infinity)
      expect(registry.render()).toContain('dt_seconds_count 0\n')
    })
  })

  describe('render', () => {
    it('concatenates every registered metric and escapes newlines in help text', () => {
      const registry = createMetricsRegistry()
      registry.counter('a_total', 'line one\nline two')
      registry.gauge('b', 'a gauge')
      const rendered = registry.render()
      expect(rendered).toContain('# HELP a_total line one\\nline two\n')
      expect(rendered).toContain('# TYPE b gauge\n')
    })
  })
})
