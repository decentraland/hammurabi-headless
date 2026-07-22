
export interface Counter {
  inc(delta?: number): void
  readonly value: number
}

export interface LabeledCounter {
  inc(label: string, delta?: number): void
}

export interface Gauge {
  set(value: number): void
  get(): number
}

export interface Histogram {
  observe(value: number): void
}

export interface MetricsRegistry {
  counter(name: string, help: string): Counter
  labeledCounter(name: string, help: string, labelName: string): LabeledCounter
  gauge(name: string, help: string, collect?: () => number): Gauge
  histogram(name: string, help: string, buckets: number[]): Histogram
  render(): string
}

export const MAX_LABEL_VALUES = 64

function escapeHelp(help: string): string {
  return help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function header(name: string, help: string, type: 'counter' | 'gauge' | 'histogram'): string {
  return `# HELP ${name} ${escapeHelp(help)}\n# TYPE ${name} ${type}\n`
}

type Kind = 'counter' | 'gauge' | 'histogram'

export function createMetricsRegistry(): MetricsRegistry {
  const registered = new Map<string, { kind: Kind; handle: unknown; render(): string }>()

  function register<T>(name: string, kind: Kind, create: () => { handle: T; render(): string }): T {
    const existing = registered.get(name)
    if (existing && existing.kind === kind) return existing.handle as T
    const made = create()
    if (!existing) registered.set(name, { kind, handle: made.handle, render: made.render })
    return made.handle
  }

  return {
    counter(name, help) {
      return register<Counter>(name, 'counter', () => {
        let value = 0
        const handle: Counter = {
          inc(delta = 1) {
            if (Number.isFinite(delta) && delta > 0) value += delta
          },
          get value() {
            return value
          }
        }
        return { handle, render: () => `${header(name, help, 'counter')}${name} ${value}\n` }
      })
    },

    labeledCounter(name, help, labelName) {
      return register<LabeledCounter>(name, 'counter', () => {
        const values = new Map<string, number>()
        const handle: LabeledCounter = {
          inc(label, delta = 1) {
            if (!Number.isFinite(delta) || delta <= 0) return
            let key = String(label)
            if (!values.has(key) && values.size >= MAX_LABEL_VALUES) key = 'other'
            values.set(key, (values.get(key) ?? 0) + delta)
          }
        }
        const render = () => {
          let out = header(name, help, 'counter')
          for (const [label, value] of values) out += `${name}{${labelName}="${escapeLabelValue(label)}"} ${value}\n`
          return out
        }
        return { handle, render }
      })
    },

    gauge(name, help, collect) {
      return register<Gauge>(name, 'gauge', () => {
        let value = 0
        const handle: Gauge = {
          set(v) {
            if (Number.isFinite(v)) value = v
          },
          get() {
            if (collect) {
              try {
                const v = collect()
                if (Number.isFinite(v)) value = v
              } catch {
              }
            }
            return value
          }
        }
        return { handle, render: () => `${header(name, help, 'gauge')}${name} ${handle.get()}\n` }
      })
    },

    histogram(name, help, buckets) {
      return register<Histogram>(name, 'histogram', () => {
        const bounds = buckets.filter((b) => Number.isFinite(b)).sort((a, b) => a - b)
        const counts = new Array<number>(bounds.length).fill(0)
        let sum = 0
        let count = 0
        const handle: Histogram = {
          observe(v) {
            if (!Number.isFinite(v)) return
            for (let i = 0; i < bounds.length; i++) if (v <= bounds[i]) counts[i]++
            sum += v
            count++
          }
        }
        const render = () => {
          let out = header(name, help, 'histogram')
          for (let i = 0; i < bounds.length; i++) out += `${name}_bucket{le="${bounds[i]}"} ${counts[i]}\n`
          out += `${name}_bucket{le="+Inf"} ${count}\n${name}_sum ${sum}\n${name}_count ${count}\n`
          return out
        }
        return { handle, render }
      })
    },

    render() {
      let out = ''
      for (const metric of registered.values()) {
        try {
          out += metric.render()
        } catch {
        }
      }
      return out
    }
  }
}

export const metrics: MetricsRegistry = createMetricsRegistry()
