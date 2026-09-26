import { describe, expect, it } from 'vitest'
import { volFrag } from '../shaders/volumetric.js'
import { VOL_MAXDIST } from '../../world/constants.js'

const src = volFrag()
const mainMarch = src.slice(src.indexOf('float N = float(max(uSteps, 1));'))

// One statement of the main march, turned into a JS expression.
function expr(name) {
  const m = mainMarch.match(new RegExp(`float ${name} = ([^;]+);`))
  expect(m, name).not.toBeNull()
  return m[1].replace(/\bfloat\(/g, '(').replace(/\b(min|max)\(/g, 'Math.$1(').replace(/(\d)\.0\b/g, '$1')
}

// Length of the ray the main march's flashlight samples cover past nearT,
// computed with the shader's own step and clip statements.
const flashCoverage = new Function(
  'maxT',
  'nearT',
  'N',
  'jitter',
  `let sum = 0
   for (let i = 0; i < N; i++) {
     const u0 = ${expr('u0')}
     const u1 = ${expr('u1')}
     const t = ${expr('t')}
     const dt = ${expr('dt')}
     const tF = ${expr('tF')}
     const dtF = ${expr('dtF')}
     if (dtF > 0) sum += dtF
   }
   return sum`
)

describe('volumetric march', () => {
  it('hands the flashlight from the near field to the main march without a hole', () => {
    expect(mainMarch).not.toMatch(/flashOn && t >= nearT/)
    const nearT = 8
    for (const N of [16, 24, 32, 44]) {
      for (let j = 0; j < 16; j++) {
        const covered = flashCoverage(VOL_MAXDIST, nearT, N, j / 16)
        expect(covered, `${N} steps, jitter ${j}/16`).toBeCloseTo(VOL_MAXDIST - nearT, 9)
      }
    }
  })

  it('samples each flashlight segment at its midpoint', () => {
    expect(mainMarch).toContain('float tm = tF + 0.5 * dtF;')
    expect(mainMarch).toMatch(/flashTerm\(dir \* tm, dir, exp\(-uFogDensity \* uFogDensity \* tm \* tm\), tap\) \* dtF/)
  })
})
