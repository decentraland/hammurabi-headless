import { EasingFunction } from '@dcl/protocol/out-js/decentraland/sdk/components/tween.gen'
import { easingsFunctions } from '../../../../../src/lib/babylon/scene/logic/easings'

// `tween.proto` names https://easings.net as the normative source for these
// curves, so this spec re-transcribes all 31 of them from that reference and
// compares. The point is the CROSS-CHECK: ten of the in-out variants were absent
// from the table entirely and silently degraded to linear -- a plausible-looking
// wrong curve rather than a visible failure -- and nothing in the suite would
// have noticed a typo in any of the other twenty-one either.

const C1 = 1.70158
const C2 = C1 * 1.525
const C3 = C1 + 1
const C4 = (2 * Math.PI) / 3
const C5 = (2 * Math.PI) / 4.5

function outBounce(x: number): number {
  const n1 = 7.5625
  const d1 = 2.75

  if (x < 1 / d1) return n1 * x * x
  if (x < 2 / d1) {
    const t = x - 1.5 / d1
    return n1 * t * t + 0.75
  }
  if (x < 2.5 / d1) {
    const t = x - 2.25 / d1
    return n1 * t * t + 0.9375
  }
  const t = x - 2.625 / d1
  return n1 * t * t + 0.984375
}

type EasingCase = {
  name: string
  value: EasingFunction
  reference: (x: number) => number
}

const EASING_CASES: EasingCase[] = [
  { name: 'linear', value: EasingFunction.EF_LINEAR, reference: (x) => x },

  { name: 'easeInQuad', value: EasingFunction.EF_EASEINQUAD, reference: (x) => Math.pow(x, 2) },
  { name: 'easeOutQuad', value: EasingFunction.EF_EASEOUTQUAD, reference: (x) => 1 - Math.pow(1 - x, 2) },
  {
    name: 'easeInOutQuad',
    value: EasingFunction.EF_EASEQUAD,
    reference: (x) => (x < 0.5 ? 2 * Math.pow(x, 2) : 1 - Math.pow(-2 * x + 2, 2) / 2)
  },

  { name: 'easeInCubic', value: EasingFunction.EF_EASEINCUBIC, reference: (x) => Math.pow(x, 3) },
  { name: 'easeOutCubic', value: EasingFunction.EF_EASEOUTCUBIC, reference: (x) => 1 - Math.pow(1 - x, 3) },
  {
    name: 'easeInOutCubic',
    value: EasingFunction.EF_EASECUBIC,
    reference: (x) => (x < 0.5 ? 4 * Math.pow(x, 3) : 1 - Math.pow(-2 * x + 2, 3) / 2)
  },

  { name: 'easeInQuart', value: EasingFunction.EF_EASEINQUART, reference: (x) => Math.pow(x, 4) },
  { name: 'easeOutQuart', value: EasingFunction.EF_EASEOUTQUART, reference: (x) => 1 - Math.pow(1 - x, 4) },
  {
    name: 'easeInOutQuart',
    value: EasingFunction.EF_EASEQUART,
    reference: (x) => (x < 0.5 ? 8 * Math.pow(x, 4) : 1 - Math.pow(-2 * x + 2, 4) / 2)
  },

  { name: 'easeInQuint', value: EasingFunction.EF_EASEINQUINT, reference: (x) => Math.pow(x, 5) },
  { name: 'easeOutQuint', value: EasingFunction.EF_EASEOUTQUINT, reference: (x) => 1 - Math.pow(1 - x, 5) },
  {
    name: 'easeInOutQuint',
    value: EasingFunction.EF_EASEQUINT,
    reference: (x) => (x < 0.5 ? 16 * Math.pow(x, 5) : 1 - Math.pow(-2 * x + 2, 5) / 2)
  },

  { name: 'easeInSine', value: EasingFunction.EF_EASEINSINE, reference: (x) => 1 - Math.cos((x * Math.PI) / 2) },
  { name: 'easeOutSine', value: EasingFunction.EF_EASEOUTSINE, reference: (x) => Math.sin((x * Math.PI) / 2) },
  {
    name: 'easeInOutSine',
    value: EasingFunction.EF_EASESINE,
    reference: (x) => -(Math.cos(Math.PI * x) - 1) / 2
  },

  {
    name: 'easeInExpo',
    value: EasingFunction.EF_EASEINEXPO,
    reference: (x) => (x === 0 ? 0 : Math.pow(2, 10 * x - 10))
  },
  {
    name: 'easeOutExpo',
    value: EasingFunction.EF_EASEOUTEXPO,
    reference: (x) => (x === 1 ? 1 : 1 - Math.pow(2, -10 * x))
  },
  {
    name: 'easeInOutExpo',
    value: EasingFunction.EF_EASEEXPO,
    reference: (x) => {
      if (x === 0) return 0
      if (x === 1) return 1
      return x < 0.5 ? Math.pow(2, 20 * x - 10) / 2 : (2 - Math.pow(2, -20 * x + 10)) / 2
    }
  },

  { name: 'easeInCirc', value: EasingFunction.EF_EASEINCIRC, reference: (x) => 1 - Math.sqrt(1 - Math.pow(x, 2)) },
  { name: 'easeOutCirc', value: EasingFunction.EF_EASEOUTCIRC, reference: (x) => Math.sqrt(1 - Math.pow(x - 1, 2)) },
  {
    name: 'easeInOutCirc',
    value: EasingFunction.EF_EASECIRC,
    reference: (x) =>
      x < 0.5
        ? (1 - Math.sqrt(1 - Math.pow(2 * x, 2))) / 2
        : (Math.sqrt(1 - Math.pow(-2 * x + 2, 2)) + 1) / 2
  },

  {
    name: 'easeInBack',
    value: EasingFunction.EF_EASEINBACK,
    reference: (x) => C3 * Math.pow(x, 3) - C1 * Math.pow(x, 2)
  },
  {
    name: 'easeOutBack',
    value: EasingFunction.EF_EASEOUTBACK,
    reference: (x) => 1 + C3 * Math.pow(x - 1, 3) + C1 * Math.pow(x - 1, 2)
  },
  {
    name: 'easeInOutBack',
    value: EasingFunction.EF_EASEBACK,
    reference: (x) =>
      x < 0.5
        ? (Math.pow(2 * x, 2) * ((C2 + 1) * 2 * x - C2)) / 2
        : (Math.pow(2 * x - 2, 2) * ((C2 + 1) * (x * 2 - 2) + C2) + 2) / 2
  },

  {
    name: 'easeInElastic',
    value: EasingFunction.EF_EASEINELASTIC,
    reference: (x) => {
      if (x === 0) return 0
      if (x === 1) return 1
      return -Math.pow(2, 10 * x - 10) * Math.sin((x * 10 - 10.75) * C4)
    }
  },
  {
    name: 'easeOutElastic',
    value: EasingFunction.EF_EASEOUTELASTIC,
    reference: (x) => {
      if (x === 0) return 0
      if (x === 1) return 1
      return Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * C4) + 1
    }
  },
  {
    name: 'easeInOutElastic',
    value: EasingFunction.EF_EASEELASTIC,
    reference: (x) => {
      if (x === 0) return 0
      if (x === 1) return 1
      return x < 0.5
        ? -(Math.pow(2, 20 * x - 10) * Math.sin((20 * x - 11.125) * C5)) / 2
        : (Math.pow(2, -20 * x + 10) * Math.sin((20 * x - 11.125) * C5)) / 2 + 1
    }
  },

  { name: 'easeInBounce', value: EasingFunction.EF_EASEINBOUNCE, reference: (x) => 1 - outBounce(1 - x) },
  { name: 'easeOutBounce', value: EasingFunction.EF_EASEOUTBOUNCE, reference: (x) => outBounce(x) },
  {
    name: 'easeInOutBounce',
    value: EasingFunction.EF_EASEBOUNCE,
    reference: (x) => (x < 0.5 ? (1 - outBounce(1 - 2 * x)) / 2 : (1 + outBounce(2 * x - 1)) / 2)
  }
]

// Every EasingFunction the protocol declares, minus the UNRECOGNIZED sentinel.
const DECLARED_EASINGS: EasingFunction[] = Object.values(EasingFunction).filter(
  (value): value is EasingFunction => typeof value === 'number' && value !== EasingFunction.UNRECOGNIZED
)

describe('easing functions', () => {
  describe('when enumerating the easing functions the protocol declares', () => {
    it('should cover every one of them in this spec', () => {
      expect(EASING_CASES.map((easingCase) => easingCase.value).sort((a, b) => a - b)).toEqual(
        [...DECLARED_EASINGS].sort((a, b) => a - b)
      )
    })

    it('should have an implementation for every one of them', () => {
      expect(DECLARED_EASINGS.filter((value) => typeof easingsFunctions[value] !== 'function')).toEqual([])
    })
  })

  describe.each(EASING_CASES)('when evaluating the $name easing', ({ value, reference }) => {
    let easing: (progress: number) => number

    beforeEach(() => {
      easing = easingsFunctions[value]
    })

    // A curve that does not start at 0 / end at 1 makes a tween snap at its
    // boundaries: the endpoints are exactly where the scene pinned start/end.
    it('should map the start of the curve to zero', () => {
      expect(easing(0)).toBeCloseTo(0, 10)
    })

    it('should map the end of the curve to one', () => {
      expect(easing(1)).toBeCloseTo(1, 10)
    })

    it('should match the easings.net curve at a quarter of the way through', () => {
      expect(easing(0.25)).toBeCloseTo(reference(0.25), 10)
    })

    it('should match the easings.net curve at the midpoint', () => {
      expect(easing(0.5)).toBeCloseTo(reference(0.5), 10)
    })

    it('should match the easings.net curve at three quarters of the way through', () => {
      expect(easing(0.75)).toBeCloseTo(reference(0.75), 10)
    })

    // 0.5 is where every in-out variant switches branch; a mistyped second half
    // shows up here as a step discontinuity rather than a wrong-looking curve.
    // The offset has to be this small because easeInOutCirc has a VERTICAL
    // tangent at 0.5 -- its legitimate difference across the branch grows as
    // 2*sqrt(offset), so a 1e-6 offset already spans 2e-3 of curve.
    it('should be continuous across the piecewise midpoint', () => {
      expect(easing(0.5 - 1e-12)).toBeCloseTo(easing(0.5 + 1e-12), 4)
    })
  })
})
