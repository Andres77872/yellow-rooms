import { describe, expect, it } from 'vitest'
import { COL_HALF, MONUMENTAL_COL_HALF, WALL_H } from '../../world/constants.js'
import {
  EDGE_DOOR,
  EDGE_OPEN,
  EDGE_RAIL,
  EDGE_WALL,
  EDGE_WINDOW,
  EMITTER_Y,
  FLAG_COLUMN,
  FLAG_PIER,
  OCC_UNIT_XZ,
  OCC_UNIT_Y,
  PANEL_EQ_R,
  PANEL_HALF_X,
  PANEL_HALF_Z,
} from '../../world/lightGrid/gridSpec.js'
import { ENEMY_CAPSULES } from '../enemyOccluders.js'
import {
  boxBeside,
  boxCover,
  boxFF,
  boxFormFactorAxis,
  capOccluded,
  capOccludedLens,
  capRatio,
  capsuleAO,
  capsuleVisibility,
  clampLenInt,
  columnFaces,
  columnVisibility,
  columnVisibilityClipped,
  creaseAO,
  creaseCornerColumns,
  creaseWedge,
  dominantAxis,
  edgeOpening,
  footprintOpen,
  footprintOpenPara,
  footprintOpenSub,
  openingWindow,
  posLin,
  quadFF,
  segSegClosest,
  slideOverlapInt,
} from '../shadowMath.js'
import {
  boxCoverMC,
  boxOccluder,
  capOcclusionMC,
  capsuleOccluder,
  capsuleVisibilityMC,
  columnAreaMC,
  cosineAO_MC,
  doorwayMC,
  makeRng,
  rectOccluder,
  segmentHitsSquare,
  segmentSegmentDistance,
} from './shadowReference.js'

// Chapter 14 analytic shadow maths (P5, P7, P9, P10, P13) against the brute
// force / Monte Carlo oracles. Every sample set is seeded, so the statistics
// are reproducible; SHADOW_MATH_REPORT=1 prints them.

const H = [PANEL_HALF_X, PANEL_HALF_Z]
const SOURCE_Y = EMITTER_Y // the visible panel (physically based looks), WALL_H - 0.04
const LEGACY_Y = 2.7 // the v1 virtual point
const BIG = 1e6

function errStats(errs) {
  const v = errs.slice().sort((a, b) => a - b)
  const at = (q) => v[Math.min(v.length - 1, Math.floor(v.length * q))]
  const mean = v.reduce((a, b) => a + b, 0) / v.length
  return { n: v.length, mean, p90: at(0.9), p99: at(0.99), max: v[v.length - 1] }
}

function report(label, value) {
  if (process.env.SHADOW_MATH_REPORT) console.log(label, JSON.stringify(value))
}

// Fixture light radius for the capsule cap: the equal-area disc, shrunk by
// the panel's foreshortening (plan P7: PANEL_EQ_R * sqrt(max(Ld.y, 0.15))).
function fixtureR(P, Lp) {
  const d = [Lp[0] - P[0], Lp[1] - P[1], Lp[2] - P[2]]
  return PANEL_EQ_R * Math.sqrt(Math.max(d[1] / Math.hypot(d[0], d[1], d[2]), 0.15))
}

const insideBox = (P, lo, hi, m) =>
  P[0] > lo[0] - m && P[0] < hi[0] + m && P[1] > lo[1] - m && P[1] < hi[1] + m && P[2] > lo[2] - m && P[2] < hi[2] + m

describe('boxCover (P9 furniture shadows)', () => {
  it('integrates clamped linear pieces exactly', () => {
    const rnd = makeRng(1)
    for (let k = 0; k < 200; k++) {
      const c = rnd() * 4 - 2
      const e0 = rnd() * 4 - 2
      const e1 = e0 + rnd() * 2
      const lo = rnd() * 2 - 1
      const hi = lo + rnd() * 2
      const ua = rnd() * 2
      const ub = ua + rnd() * 2
      let num = 0
      const steps = 4000
      for (let i = 0; i < steps; i++) {
        const u = ua + ((ub - ua) * (i + 0.5)) / steps
        num += Math.max(0, Math.min(c + e1 * u, hi) - Math.max(c + e0 * u, lo))
      }
      num *= (ub - ua) / steps
      expect(clampLenInt(c, e0, e1, lo, hi, ua, ub)).toBeCloseTo(num, 5)
    }
    expect(posLin(1, -1, 2)).toBeCloseTo(0.5, 12)
    expect(posLin(-1, -2, 2)).toBe(0)
  })

  it('returns 0 when unoccluded and 1 when the panel is fully covered', () => {
    const L = [0, SOURCE_Y, 0]
    const P = [0, 0, 0]
    // beside the frustum, behind the receiver, below the receiver
    for (const [lo, hi] of [
      [[2, 0, -0.5], [3, 1.5, 0.5]],
      [[-3, 0, -3], [-2, 2, -2]],
      [[-1, -1, -1], [1, -0.1, 1]],
    ]) {
      expect(boxCover(P, L, H, lo, hi)).toBe(0)
      expect(boxCoverMC(P, L, H, lo, hi, 24)).toBe(0)
    }
    // a slab over the receiver hiding the whole panel; the receiver on a desk top
    const lo = [-4, 1.0, -4]
    const hi = [4, 1.05, 4]
    expect(boxCover(P, L, H, lo, hi)).toBe(1)
    expect(boxCoverMC(P, L, H, lo, hi, 24)).toBe(1)
    expect(boxCover([0, 1.05, 0], L, H, lo, hi)).toBe(0)
  })

  it('matches boxCoverMC over 1500+ furniture configurations (lamp at the panel)', () => {
    const rnd = makeRng(2024)
    const all = []
    const partial = []
    let full = 0
    while (all.length < 1600) {
      const L = [rnd() * 8 - 4, SOURCE_Y, rnd() * 8 - 4]
      const w = 0.3 + rnd() * 1.8
      const d = 0.3 + rnd() * 1.2
      const x0 = rnd() * 4 - 2
      const z0 = rnd() * 4 - 2
      const y1 = 0.4 + rnd() * 1.7
      const y0 = rnd() < 0.4 ? y1 - 0.05 : 0 // table top slab or solid cabinet
      const lo = [x0, y0, z0]
      const hi = [x0 + w, y1, z0 + d]
      let P
      if (rnd() < 0.35) {
        P = [rnd() * 8 - 4, rnd() < 0.6 ? 0 : rnd() * 2, rnd() * 8 - 4] // anywhere
      } else {
        // aim through the box so most receivers sit in its umbra or penumbra
        const Q = [lo[0] + rnd() * w, lo[1] + rnd() * (hi[1] - lo[1]), lo[2] + rnd() * d]
        const yr = rnd() < 0.6 ? 0 : rnd() * Q[1]
        const k = (L[1] - yr) / (L[1] - Q[1])
        P = [L[0] + (Q[0] - L[0]) * k + (rnd() - 0.5) * 0.8, yr, L[2] + (Q[2] - L[2]) * k + (rnd() - 0.5) * 0.8]
      }
      // Receivers beside the box are kept, however close (the shader shades
      // floors and walls there with gBoxCover); a receiver inside it or on
      // its bottom plane is the solid-proxy case, tested separately below.
      if (insideBox(P, lo, hi, 0.001)) continue
      const a = boxCover(P, L, H, lo, hi)
      const r = boxCoverMC(P, L, H, lo, hi, 64, all.length + 1)
      all.push(Math.abs(a - r))
      if (r > 0.001 && r < 0.999) partial.push(Math.abs(a - r))
      else if (r >= 0.999) full++
    }
    const s = errStats(all)
    report('boxCover all', s)
    report('boxCover partial', errStats(partial))
    expect(partial.length).toBeGreaterThan(400)
    expect(full).toBeGreaterThan(200)
    expect(s.mean).toBeLessThanOrEqual(0.002)
    expect(s.max).toBeLessThanOrEqual(0.02)
    expect(errStats(partial).mean).toBeLessThanOrEqual(0.002)
  })

  // The lighting pass used to drop a box for every receiver whose Ptrace lay
  // within 3 cm of it: a lit 3-4 cm strip along the foot of every piece on
  // its side away from the lamp, and on the wall behind wall-backed pieces.
  // Floors and walls now keep the box there, so boxCover must hold right
  // down to the face.
  it('is exact for receivers 0.5 mm to 3.5 cm beside a box (the old self-skip band)', () => {
    // the review's case: a cabinet, the lamp 2 m off its far side
    const lo = [0, 0, 0]
    const hi = [0.6, 1.86, 1]
    const L = [-2, SOURCE_Y, 0.5]
    for (const x of [0.601, 0.605, 0.61, 0.62, 0.629, 0.631]) {
      expect(boxCover([x, 0.04, 0.5], L, H, lo, hi)).toBeCloseTo(1, 6)
      expect(boxCoverMC([x, 0.04, 0.5], L, H, lo, hi, 24)).toBe(1)
    }
    const rnd = makeRng(77)
    const errs = []
    let full = 0
    while (errs.length < 400) {
      const b0 = [rnd() * 2 - 1, rnd() < 0.5 ? 0 : 0.04, rnd() * 2 - 1]
      const b1 = [b0[0] + 0.4 + rnd() * 1.2, 0.7 + rnd() * 1.3, b0[2] + 0.3 + rnd() * 0.8]
      const Lr = [rnd() * 8 - 4, SOURCE_Y, rnd() * 8 - 4]
      const g = 0.0005 + rnd() * 0.035
      const P = [b0[0] + rnd() * (b1[0] - b0[0]), rnd() < 0.6 ? 0.04 : rnd() * b1[1], b0[2] + rnd() * (b1[2] - b0[2])]
      const face = Math.floor(rnd() * 4)
      if (face === 0) P[0] = b0[0] - g
      else if (face === 1) P[0] = b1[0] + g
      else if (face === 2) P[2] = b0[2] - g
      else P[2] = b1[2] + g
      const a = boxCover(P, Lr, H, b0, b1)
      const r = boxCoverMC(P, Lr, H, b0, b1, 64, errs.length + 1)
      errs.push(Math.abs(a - r))
      if (r >= 0.999) full++
    }
    const s = errStats(errs)
    report('boxCover beside the face', { ...s, full })
    expect(full).toBeGreaterThan(40)
    expect(s.mean).toBeLessThanOrEqual(0.002)
    expect(s.max).toBeLessThanOrEqual(0.02)
  })

  it('fully covers a receiver inside a solid proxy (the floor of a desk knee hole)', () => {
    // desk proxy .04-.78, floor Ptrace at .04 on its bottom plane
    const lo = [0, 0.04, 0]
    const hi = [1.4, 0.78, 0.7]
    for (const L of [[0.7, SOURCE_Y, 0.35], [-2, SOURCE_Y, 2], [4, SOURCE_Y, -1]]) {
      for (const P of [[0.7, 0.04, 0.35], [0.1, 0.04, 0.6], [1.3, 0.3, 0.05]]) {
        expect(boxCover(P, L, H, lo, hi)).toBeCloseTo(1, 9)
      }
    }
    // gBoxBeside leaves a receiver this deep inside alone
    const up = [0, 1, 0]
    for (const P of [[0.7, 0.04, 0.35], [0.1, 0.04, 0.6]]) expect(boxBeside(P, up, lo, hi)).toEqual([lo, hi])
  })

  // Proxies are rounded outward (packOccBox), so a floor or wall receiver
  // right beside a rendered face can lie up to one step inside the proxy.
  // Without gBoxBeside it read cover 1 and box AO ~1 for every lamp, the lit
  // side included: a hard dark line at the foot of each piece and on the
  // wall beside wall-backed ones.
  it('undoes the proxy rounding for a receiver just inside a face (gBoxBeside)', () => {
    const qUp = (v, u) => Math.ceil(v / u - 1e-6) * u
    const qDn = (v, u) => Math.floor(v / u + 1e-6) * u
    const proxy = (r) => [
      [qDn(r[0][0], OCC_UNIT_XZ), qDn(r[0][1], OCC_UNIT_Y), qDn(r[0][2], OCC_UNIT_XZ)],
      [qUp(r[1][0], OCC_UNIT_XZ), qUp(r[1][1], OCC_UNIT_Y), qUp(r[1][2], OCC_UNIT_XZ)],
    ]
    // the review's case: a cabinet, the lamp on its lit side
    const lo = [0, 0, 0]
    const hi = [0.6, 1.86, 1]
    const up = [0, 1, 0]
    for (const x of [0.595, 0.599]) {
      const P = [x, 0.04, 0.5]
      expect(boxCover(P, [2, SOURCE_Y, 0.5], H, lo, hi)).toBeCloseTo(1, 6) // the bug
      const [l, h] = boxBeside(P, up, lo, hi)
      expect(h[0]).toBeCloseTo(x - 0.001, 9)
      expect(boxCover(P, [2, SOURCE_Y, 0.5], H, l, h)).toBe(0)
      expect(boxCover(P, [-2, SOURCE_Y, 0.5], H, l, h)).toBeCloseTo(1, 6)
      expect(Math.abs(boxFF(P, up, l, h) - boxFF([0.601, 0.04, 0.5], up, lo, hi))).toBeLessThan(0.002)
    }

    // Random pieces and lamps: the rounded proxy with gBoxBeside must shade
    // floor receivers in the rounding margin like the rendered box does.
    // Receivers stay 3 cm from the other faces: within a step of two faces
    // (a 1.4 cm square at each vertical edge) the proxy cannot tell which
    // face the receiver is really beside.
    const rnd = makeRng(91)
    const errs = []
    const rawErrs = []
    const ffErrs = []
    while (errs.length < 300) {
      const r0 = [rnd() * 2 - 1, rnd() < 0.5 ? 0 : rnd() * 0.035, rnd() * 2 - 1] // floor-standing: bottom below P
      const r1 = [r0[0] + 0.4 + rnd() * 1.2, 0.7 + rnd() * 1.3, r0[2] + 0.3 + rnd() * 0.8]
      const [q0, q1] = proxy([r0, r1])
      const P = [r0[0] + 0.03 + rnd() * (r1[0] - r0[0] - 0.06), 0.04, r0[2] + 0.03 + rnd() * (r1[2] - r0[2] - 0.06)]
      const face = Math.floor(rnd() * 4)
      const a = face < 2 ? 0 : 2
      const out = face % 2 === 0 ? q0[a] : q1[a]
      const rendered = face % 2 === 0 ? r0[a] : r1[a]
      if (Math.abs(out - rendered) < 0.001) continue // no margin on this face
      P[a] = rendered + (out - rendered) * (0.05 + 0.9 * rnd())
      const Lr = [rnd() * 8 - 4, SOURCE_Y, rnd() * 8 - 4]
      const [l, h] = boxBeside(P, up, q0, q1)
      const r = boxCoverMC(P, Lr, H, r0, r1, 64, errs.length + 1)
      errs.push(Math.abs(boxCover(P, Lr, H, l, h) - r))
      rawErrs.push(Math.abs(boxCover(P, Lr, H, q0, q1) - r))
      ffErrs.push(Math.abs(boxFF(P, up, l, h) - boxFF(P, up, r0, r1)))
    }
    const s = errStats(errs)
    const ff = errStats(ffErrs)
    report('boxBeside vs the rendered box', { ...s, ff, raw: errStats(rawErrs) })
    // the residue is the unknown rounding itself: the moved face sits 1 mm
    // past P, the rendered one up to a step further
    expect(errStats(rawErrs).mean).toBeGreaterThan(0.3)
    expect(s.mean).toBeLessThanOrEqual(0.005)
    expect(s.max).toBeLessThanOrEqual(0.08)
    expect(ff.mean).toBeLessThanOrEqual(0.01)
    expect(ff.max).toBeLessThanOrEqual(0.05)

    // A wall receiver (N = +x, trace point 4 cm off the wall) beside a
    // wall-backed piece: the side face and the top move, the back face
    // (across the normal) never does.
    const px = [1, 0, 0]
    const wlo = [0, 0, 0.2]
    const whi = [0.45, 0.9, 1.2]
    const [sl, sh] = boxBeside([0.04, 0.5, 1.195], px, wlo, whi)
    expect(sh[2]).toBeCloseTo(1.194, 9)
    expect(sl).toEqual(wlo)
    const [tl, th] = boxBeside([0.04, 0.895, 0.7], px, wlo, whi)
    expect(th[1]).toBeCloseTo(0.894, 9)
    expect(tl).toEqual(wlo)
    expect(boxCover([0.04, 0.895, 0.7], [1.5, SOURCE_Y, 0.7], H, tl, th)).toBe(0)
    // a 3.5 cm gap behind the piece leaves the trace point 5 mm inside the
    // back face: that is the normal offset, not rounding
    const blo = [0.035, 0, 0.2]
    expect(boxBeside([0.04, 0.5, 0.7], px, blo, whi)).toEqual([blo, whi])
    // and a floor receiver just above a raised proxy's bottom keeps it
    const flo = [0, 0.035, 0]
    expect(boxBeside([0.3, 0.04, 0.5], up, flo, hi)).toEqual([flo, hi])
  })
})

describe('capOccluded (P7 cap intersection)', () => {
  // capocc.mjs distribution: ~47 % of these are exactly separated or
  // contained, so the pooled numbers flatter the smoothstep; the partial-
  // overlap subset (|aL - aO| < beta < aL + aO) is its real error.
  const configs = () => {
    const rnd = makeRng(1234)
    const out = []
    for (let k = 0; k < 1000; k++) {
      const aL = 0.03 + rnd() * 0.5
      const aO = 0.02 + rnd() * 0.7
      out.push([aL, aO, rnd() * (aL + aO) * 1.2, k + 1])
    }
    return out
  }
  const measure = (f) => {
    const all = []
    const partial = []
    for (const [aL, aO, b, seed] of configs()) {
      const e = Math.abs(f(aL, aO, b) - capOcclusionMC(aL, aO, b, 4096, seed))
      all.push(e)
      if (b > Math.abs(aL - aO) && b < aL + aO) partial.push(e)
    }
    return { all: errStats(all), partial: errStats(partial) }
  }

  // Measured: pooled mean 0.020 / p90 0.075; partial overlap only (n ~530)
  // mean 0.038 / p90 0.094 — above the plan's limits, which only the pooled
  // set meets. capOccludedLens: partial mean 0.008 / p90 0.017.
  it('matches capOcclusionMC: mean <= 0.03, p90 <= 0.08 (pooled)', () => {
    const { all, partial } = measure(capOccluded)
    report('capOccluded', { all, partial })
    expect(all.mean).toBeLessThanOrEqual(0.03)
    expect(all.p90).toBeLessThanOrEqual(0.08)
    expect(partial.n).toBeGreaterThan(400)
    expect(partial.mean).toBeLessThanOrEqual(0.045)
    expect(partial.p90).toBeLessThanOrEqual(0.11)
  })

  it('the lens-blend refinement is ~5x closer', () => {
    const { all, partial } = measure(capOccludedLens)
    report('capOccludedLens', { all, partial })
    expect(all.mean).toBeLessThanOrEqual(0.008)
    expect(all.p90).toBeLessThanOrEqual(0.025)
    expect(partial.mean).toBeLessThanOrEqual(0.012)
    expect(partial.p90).toBeLessThanOrEqual(0.03)
  })

  it('is exact at separation and containment, down to a point light', () => {
    for (const f of [capOccluded, capOccludedLens]) {
      expect(f(0.1, 0.2, 0.31)).toBe(0) // caps apart
      expect(f(0.1, 0.4, 0.2)).toBeCloseTo(1, 12) // light cap inside the occluder
      // occluder inside the light cap: covers its solid-angle share
      expect(f(0.4, 0.1, 0.1)).toBeCloseTo((1 - Math.cos(0.1)) / (1 - Math.cos(0.4)), 12)
      // tiny light caps (a 2 cm torch at 20 m is aL = 1e-3; 0 = point light):
      // the old (1 - cos) / max(1 - cos aL, 1e-6) ratio read 0.5 at 1e-3
      for (const aL of [0, 1e-4, 1e-3]) expect(f(aL, 0.05, 0)).toBe(1)
      expect(f(0, 0.05, 0.06)).toBe(0)
    }
  })

  it('the sin^2 cap ratio survives fp32 (the GLSL precision)', () => {
    // Every operation rounded to fp32, as the shader evaluates it. The 1 - cos
    // form loses the ratio to cancellation for small light caps.
    const f = Math.fround
    const oldF32 = (aL, aO) => f(f(1 - f(Math.cos(f(Math.min(aL, aO))))) / Math.max(f(1 - f(Math.cos(f(aL)))), 1e-6))
    const newF32 = (aL, aO) => {
      const sO = f(Math.sin(f(0.5 * aO)))
      const sL = f(Math.sin(f(0.5 * aL)))
      return Math.min(1, f(f(sO * sO) / Math.max(f(sL * sL), 1e-12)))
    }
    for (const aL of [1e-4, 3e-4, 1e-3, 3e-3, 0.01, 0.1, 0.5]) {
      const aO = 0.5 * aL // occluder inside the light: ratio ~ 1/4
      const exact = capRatio(aL, aO)
      expect(exact).toBeCloseTo((1 - Math.cos(aO)) / (1 - Math.cos(aL)), 6)
      expect(Math.abs(newF32(aL, aO) - exact) / exact).toBeLessThan(1e-5)
      if (aL <= 1e-3) expect(Math.abs(oldF32(aL, aO) - exact) / exact).toBeGreaterThan(0.1)
    }
  })
})

// The shipped capsule tables (enemy.mesh local = world here: feet at y = 0).
const STALKER = ENEMY_CAPSULES.stalker.glb
const PURSUER = ENEMY_CAPSULES.pursuer.glb
const HUSK = ENEMY_CAPSULES.husk.glb
const insideCaps = (P, caps, m) => caps.some((c) => segmentSegmentDistance(P, P, c.a, c.b) < c.r + m)

describe('segSegClosest (capsuleShadow closest points)', () => {
  it('finds the closest pair, incl. near-parallel segments and spheres', () => {
    const rnd = makeRng(31)
    const v = () => [rnd() * 4 - 2, rnd() * 4 - 2, rnd() * 4 - 2]
    for (let k = 0; k < 3000; k++) {
      const p1 = v()
      const q1 = v()
      const p2 = v()
      let q2 = v()
      if (k % 3 === 1) {
        // (nearly) parallel: second segment along the first, tilted < 1 mrad
        const s = rnd() * 2 - 0.5
        const tilt = (rnd() - 0.5) * 2e-3 * (k % 2)
        q2 = [p2[0] + (q1[0] - p1[0]) * s + tilt, p2[1] + (q1[1] - p1[1]) * s, p2[2] + (q1[2] - p1[2]) * s]
      } else if (k % 3 === 2) q2 = p2.slice() // a sphere
      const [s, t] = segSegClosest(p1, q1, p2, q2)
      const X = [0, 1, 2].map((i) => p1[i] + (q1[i] - p1[i]) * s)
      const Y = [0, 1, 2].map((i) => p2[i] + (q2[i] - p2[i]) * t)
      const d = Math.hypot(X[0] - Y[0], X[1] - Y[1], X[2] - Y[2])
      // near-parallel pairs fall back to s = 0: off by at most ~1 mrad x |d1|
      const tol = 1e-3 * Math.hypot(q1[0] - p1[0], q1[1] - p1[1], q1[2] - p1[2]) + 1e-9
      expect(d - segmentSegmentDistance(p1, q1, p2, q2)).toBeLessThan(tol)
    }
  })
})

describe('capsuleVisibility (P7 capsule soft shadows)', () => {
  const FOOT = [{ a: [0, 0.06, 0], b: [0, 1.6, 0], r: 0.3 }]
  const FOOT_O = [{ a: [0.45, 0.06, 0], b: [0.45, 1.6, 0], r: 0.3 }] // for the lamp overhead at x = 0
  const LAMP = [1.5, SOURCE_Y, 0]
  const OVERHEAD = [0, SOURCE_Y, 0]

  // Continuity along a floor sweep in 1 cm steps. Receivers inside a capsule
  // (+ 1 cm) are not receivers: the body covers them. Next to a capsule the
  // TRUE visibility itself changes steeply (a sphere 2 cm away subtends
  // ~70 deg, and the shipped legs' end spheres dip below the floor: the MC
  // drops 0.91 -> 0.56 over the last centimetre beside the Stalker's shin),
  // so a 1 cm step > 0.02 is re-sampled in 0.1 mm sub-steps: a steep but
  // continuous change splits into small sub-steps, a jump stays one step.
  function sweepSteps(caps, Lp, from, to, lens) {
    const vis = (P) => capsuleVisibility(P, Lp, fixtureR(P, Lp), caps, 1, lens)
    const at = (u) => [from[0] + (to[0] - from[0]) * u, 0, from[2] + (to[2] - from[2]) * u]
    const n = Math.round(Math.hypot(to[0] - from[0], to[2] - from[2]) / 0.01)
    let prev = null
    let step = 0
    let jump = 0
    for (let i = 0; i <= n; i++) {
      const P = at(i / n)
      if (insideCaps(P, caps, 0.01)) {
        prev = null
        continue
      }
      const v = vis(P)
      if (prev !== null && Math.abs(v - prev) > 0.02) {
        step = Math.max(step, Math.abs(v - prev))
        let pv = prev
        for (let k = 1; k <= 100; k++) {
          const sv = vis(at((i - 1 + k / 100) / n))
          jump = Math.max(jump, Math.abs(sv - pv))
          pv = sv
        }
      } else if (prev !== null) step = Math.max(step, Math.abs(v - prev))
      prev = v
    }
    return { step, jump }
  }

  it('is continuous past the foot and across an overhead lamp (1 cm sweeps)', () => {
    // Along the shadow axis from the lit side, past the foot, to the shadow's
    // tip (the plan's sweep: no 1 cm step > 0.02); then with the lamp
    // overhead, across the lamp's foot, where the segment-closest sphere
    // alone jumped by 0.2 (1.0 -> 0.8 between x = +-0.001) and, with only the
    // angular sphere added, still by 0.06-0.1 on the shipped tables (the
    // closest point flips end to end as the ray tilts through parallel to a
    // vertical axis).
    const sweeps = {
      foot: [FOOT, LAMP, [1.2, 0, 0], [-3, 0, 0]],
      footOverhead: [FOOT_O, OVERHEAD, [-2, 0, 0], [2, 0, 0]],
      footOverheadAcross: [FOOT_O, OVERHEAD, [-0.1, 0, -2], [-0.1, 0, 2]],
      stalker: [STALKER, LAMP, [1.2, 0, 0.07], [-3, 0, 0.07]],
      stalkerOverhead: [STALKER, [0.3, SOURCE_Y, 0.2], [-1.5, 0, 0.2], [1.5, 0, 0.2]],
      stalkerOverhead2: [STALKER, [-0.5, SOURCE_Y, 0.1], [-1.5, 0, 0.1], [1.5, 0, 0.1]],
      husk: [HUSK, LAMP, [1.2, 0, 0.06], [-3, 0, 0.06]],
      huskOverhead: [HUSK, [0.3, SOURCE_Y, 0.2], [-1.5, 0, 0.2], [1.5, 0, 0.2]],
      pursuerOverhead: [PURSUER, [0.6, SOURCE_Y, 0.4], [0.6, 0, -2], [0.6, 0, 2]],
    }
    const res = {}
    for (const [name, [caps, Lp, from, to]] of Object.entries(sweeps)) {
      res[name] = { smooth: sweepSteps(caps, Lp, from, to, false), lens: sweepSteps(caps, Lp, from, to, true) }
    }
    report('capsule sweep {1 cm step, 0.1 mm jump}', res)
    for (const [name, r] of Object.entries(res)) {
      for (const k of ['smooth', 'lens']) expect(r[k].jump, `${name} ${k}`).toBeLessThanOrEqual(0.01)
    }
    expect(res.foot.smooth.step).toBeLessThanOrEqual(0.02)
    expect(res.foot.lens.step).toBeLessThanOrEqual(0.02)
    // and the removed `along < r + 0.15` guard no longer lifts the shadow at the feet
    expect(capsuleVisibility([-0.35, 0, 0], LAMP, fixtureR([-0.35, 0, 0], LAMP), FOOT, 1)).toBeLessThan(0.05)
    // the overhead lamp's foot is in the capsule's penumbra on both sides
    for (const x of [-0.001, 0.001, 0.05]) {
      const P = [x, 0, 0]
      const mc = capsuleVisibilityMC(P, OVERHEAD, fixtureR(P, OVERHEAD), FOOT_O, 40)
      expect(Math.abs(capsuleVisibility(P, OVERHEAD, fixtureR(P, OVERHEAD), FOOT_O, 1) - mc)).toBeLessThanOrEqual(0.05)
    }
  })

  // Visibility errors against the disk-light MC along receiver lines.
  function linesErr(lines, n, mcN) {
    const smooth = []
    const lens = []
    let partial = 0
    for (const [caps, Lp, from, to] of lines) {
      for (let i = 0; i <= n; i++) {
        const P = [0, 1, 2].map((k) => from[k] + ((to[k] - from[k]) * i) / n)
        if (insideCaps(P, caps, 0.02)) continue
        const r = fixtureR(P, Lp)
        const mc = capsuleVisibilityMC(P, Lp, r, caps, mcN)
        if (mc > 0.02 && mc < 0.98) partial++
        smooth.push(Math.abs(capsuleVisibility(P, Lp, r, caps, 1) - mc))
        lens.push(Math.abs(capsuleVisibility(P, Lp, r, caps, 1, true) - mc))
      }
    }
    return { smooth: errStats(smooth), lens: errStats(lens), partial }
  }

  // One capsule: the model's own error. The sphere proxy covers a disc of
  // the capsule's stadium-shaped silhouette, and the two cap profiles err in
  // opposite directions: where the ray grazes the capsule's END (the shadow's
  // tip) the silhouette is nearly that disc, the lens form is exact and the
  // smoothstep over-darkens by up to 0.12; where the ray crosses the capsule's
  // SIDE the band of the silhouette covers more of the light than any disc,
  // and the lens form under-darkens by up to 0.09 while the smoothstep's
  // over-estimate happens to compensate. So the plan's 0.08 holds as the p90,
  // not the max. Measured (n 97 / 67): lamp beside smooth mean 0.018 / p90
  // 0.040 / max 0.118, lens 0.018 / 0.052 / 0.094; lamp overhead smooth
  // 0.016 / 0.061 / 0.148, lens 0.014 / 0.033 / 0.157.
  it('matches capsuleVisibilityMC for single capsules: p90 <= 0.08', () => {
    const side = linesErr(
      [
        [FOOT, LAMP, [1.2, 0, 0], [-3.5, 0, 0]],
        [FOOT, LAMP, [-0.8, 0, -1.5], [-0.8, 0, 1.5]],
        [FOOT, [4.5, SOURCE_Y, 3], [-1, 0, -1], [-3, 0, -3]],
        [FOOT, [3, SOURCE_Y, 0], [-0.5, 0, 0], [-0.5, 2.5, 0]], // wall receiver
      ],
      24,
      40,
    )
    const overhead = linesErr(
      [
        [FOOT_O, OVERHEAD, [-1.5, 0, 0], [1.5, 0, 0]],
        [FOOT_O, OVERHEAD, [-0.1, 0, -1.5], [-0.1, 0, 1.5]],
        [FOOT, [-0.45, SOURCE_Y, 0.2], [-1.5, 0, 0.2], [1.5, 0, 0.2]],
      ],
      24,
      40,
    )
    report('capsuleVisibility single capsule vs MC', { side, overhead })
    expect(side.partial).toBeGreaterThan(20)
    expect(overhead.partial).toBeGreaterThan(20)
    for (const s of [side.smooth, side.lens, overhead.smooth, overhead.lens]) {
      expect(s.mean).toBeLessThanOrEqual(0.025)
      expect(s.p90).toBeLessThanOrEqual(0.08)
    }
    expect(side.smooth.max).toBeLessThanOrEqual(0.13)
    expect(side.lens.max).toBeLessThanOrEqual(0.1)
    expect(overhead.smooth.max).toBeLessThanOrEqual(0.16)
    expect(overhead.lens.max).toBeLessThanOrEqual(0.17)
  })

  // A small light: the low tier's analytic flashlight passes lightR =
  // uTorchSize (2 cm) from up to FLASH_RANGE (26 m) away, so aL ~ 1e-3.
  it('shadows a 2 cm torch 20-26 m away (tiny light cap)', () => {
    for (const D of [20, 26]) {
      const P = [0, 1, 0]
      const Lp = [D, 1, 0]
      // capsule half-way, offset across the ray: umbra, both penumbra edges, clear
      for (const z of [0, 0.2, 0.295, 0.3, 0.305, 0.4]) {
        const caps = [{ a: [D / 2, 0.06, z], b: [D / 2, 1.6, z], r: 0.3 }]
        const mc = capsuleVisibilityMC(P, Lp, 0.02, caps, 40)
        for (const lens of [false, true]) {
          expect(Math.abs(capsuleVisibility(P, Lp, 0.02, caps, 1, lens) - mc)).toBeLessThanOrEqual(0.05)
        }
      }
      // and a point light (lightR = 0) is a hard shadow
      const caps = [{ a: [D / 2, 0.06, 0], b: [D / 2, 1.6, 0], r: 0.3 }]
      expect(capsuleVisibility(P, Lp, 0, caps, 1)).toBe(0)
    }
  })

  // The shipped GLB tables (render/enemyOccluders.js), along lines through
  // their shadows with the lamp beside, diagonal and overhead. On top of the
  // single-capsule errors above, the product over-darkens where capsules
  // overlap in the light cap (torso over legs, the Pursuer's 0.54 m fore body
  // over its hind-leg capsules: that overlap is counted twice), which adds to
  // the smoothstep's own over-estimate. Measured on the refitted tables,
  // mean / p90 / max:
  //            smooth                  lens
  //   stalker  0.020 / 0.070 / 0.166   0.014 / 0.051 / 0.087   (n 124)
  //   pursuer  0.015 / 0.054 / 0.113   0.014 / 0.053 / 0.142   (n 123)
  //   husk     0.013 / 0.053 / 0.209   0.010 / 0.044 / 0.113   (n 125)
  // The plan's 0.08 holds as the p90 for both forms. The lens form's worst
  // case is the Pursuer's fore/hind overlap (double-counted), the
  // smoothstep's an overhead lamp over the Husk's torso and legs.
  it('tracks capsuleVisibilityMC through the shipped enemy shadows', () => {
    const lines = (caps, z) => [
      [caps, LAMP, [1.2, 0, z], [-3.5, 0, z]],
      [caps, LAMP, [-0.8, 0, -1.5], [-0.8, 0, 1.5]],
      [caps, [4.5, SOURCE_Y, 3], [-1, 0, -1], [-3, 0, -3]],
      [caps, [3, SOURCE_Y, 0], [-0.5, 0, z], [-0.5, 2.5, z]], // wall receiver
      [caps, [0.3, SOURCE_Y, 0.2], [-1.5, 0, 0.2], [1.5, 0, 0.2]], // overhead
      [caps, [0.6, SOURCE_Y, 0.4], [0.6, 0, -1.5], [0.6, 0, 1.5]], // overhead, across
    ]
    const res = {
      stalker: linesErr(lines(STALKER, 0.07), 20, 32),
      pursuer: linesErr(lines(PURSUER, 0), 20, 32),
      husk: linesErr(lines(HUSK, 0.06), 20, 32),
    }
    report('capsuleVisibility shipped tables vs MC', res)
    for (const r of Object.values(res)) {
      expect(r.partial).toBeGreaterThan(25)
      expect(r.smooth.mean).toBeLessThanOrEqual(0.025)
      expect(r.smooth.p90).toBeLessThanOrEqual(0.08)
      expect(r.smooth.max).toBeLessThanOrEqual(0.21)
      expect(r.lens.mean).toBeLessThanOrEqual(0.02)
      expect(r.lens.p90).toBeLessThanOrEqual(0.065)
      expect(r.lens.max).toBeLessThanOrEqual(0.15)
    }
  })

  it('leaves unoccluded receivers at 1 and honours K', () => {
    const P = [2, 0, 2]
    expect(capsuleVisibility(P, LAMP, 0.6, STALKER, 1)).toBe(1)
    expect(capsuleVisibility([-1, 0, 0], LAMP, 0.6, FOOT, 0)).toBe(1)
    const v1 = capsuleVisibility([-1, 0, 0], LAMP, 0.6, FOOT, 1)
    const vh = capsuleVisibility([-1, 0, 0], LAMP, 0.6, FOOT, 0.5)
    expect(vh).toBeCloseTo(1 - 0.5 * (1 - v1), 12)
  })
})

describe('capsuleAO (P7 capsule ambient occlusion)', () => {
  it('is the exact form factor of a sphere above the horizon', () => {
    const P = [0, 0, 0]
    const N = [0, 1, 0]
    const sphere = { a: [0.3, 0.75, 0.2], b: [0.3, 0.75, 0.2], r: 0.28 } // d < 3r: no fade
    const occ = 1 - capsuleAO(P, N, [sphere], 1, 0)
    const mc = cosineAO_MC(P, N, capsuleOccluder([sphere]), Infinity, 65536, 5)
    report('capsuleAO sphere', { occ, mc })
    expect(Math.abs(occ - mc)).toBeLessThanOrEqual(0.005)
  })

  it('under-estimates a capsule (one inscribed sphere) and honours K and minVis', () => {
    const P = [0.6, 0, 0.1]
    const N = [0, 1, 0]
    const occ = 1 - capsuleAO(P, N, STALKER, 1, 0)
    const mc = cosineAO_MC(P, N, capsuleOccluder(STALKER), Infinity, 16384, 6)
    expect(occ).toBeGreaterThan(0)
    expect(occ).toBeLessThanOrEqual(mc + 0.005)
    expect(capsuleAO(P, N, STALKER, 0, 0)).toBe(1)
    // a sphere touching the receiver fills its hemisphere: occ 1, floored by minVis
    expect(capsuleAO([0, 0, 0], N, [{ a: [0, 0.3, 0], b: [0, 0.3, 0], r: 0.3 }], 1, 0.3)).toBe(0.3)
  })

  it('caps each term like lighting.js inside a capsule (d < r)', () => {
    // floor receiver 0.1 m from a leg axis, under the leg's end sphere
    const leg = { a: [0, 0.06, 0], b: [0, 0.5, 0], r: 0.13 }
    const P = [0.1, 0, 0]
    const d = Math.hypot(0.1, 0.06)
    const glsl = 1 - Math.min(((0.06 / d) * 0.13 * 0.13) / (d * d), 1) // 1 - min(occ, 1)
    expect(capsuleAO(P, [0, 1, 0], [leg], 1, 0)).toBeCloseTo(glsl, 12)
    expect(capsuleAO([0.05, 0, 0], [0, 1, 0], [leg], 1, 0)).toBe(0) // buried: fully occluded
  })
})

describe('crease AO (P10)', () => {
  const R = 0.8

  // Axis-aligned finite planes (creaseAO convention) as MC rectangles
  // reaching from the receiver's surface outward along N.
  function toRects(P, N, planes) {
    const n = dominantAxis(N)
    const up = N[n] > 0
    return planes.map((pl) => {
      const t = 3 - n - pl.axis
      const lo = [0, 0, 0]
      const hi = [0, 0, 0]
      lo[t] = pl.lo
      hi[t] = pl.hi
      lo[n] = up ? P[n] : -BIG
      hi[n] = up ? BIG : P[n]
      return { axis: pl.axis, pos: pl.pos, lo, hi }
    })
  }

  it('creaseWedge equals the plan acos/tan form and reaches the contact limit continuously', () => {
    const rnd = makeRng(9)
    for (let k = 0; k < 5000; k++) {
      const d = rnd() * 0.9
      const s0 = (rnd() * 2 - 1) * 2
      const s1 = s0 + rnd() * 3
      const RR = 0.3 + rnd()
      const dd = Math.max(d, 1e-3)
      const a = dd / RR
      let ref = 0
      if (a < 1) {
        const lim = Math.acos(a)
        const p0 = Math.max(Math.atan(s0 / dd), -lim)
        const p1 = Math.min(Math.atan(s1 / dd), lim)
        if (p1 > p0) ref = (0.5 * (p1 - a * a * Math.tan(p1) - (p0 - a * a * Math.tan(p0)))) / Math.PI
      }
      expect(Math.abs(creaseWedge(d, s0, s1, RR) - ref)).toBeLessThan(1e-12)
    }
    expect(creaseWedge(0, -BIG, BIG, R)).toBeCloseTo(0.5, 2)
    expect(creaseWedge(-0.1, -BIG, BIG, R)).toBe(creaseWedge(0, -BIG, BIG, R))
    expect(Math.abs(creaseWedge(0.002, -BIG, BIG, R) - creaseWedge(0.001, -BIG, BIG, R))).toBeLessThan(0.002)
    expect(creaseWedge(R, -BIG, BIG, R)).toBe(0)
  })

  it('matches cosineAO_MC within 0.005 for walls, corners, headers and columns', () => {
    const ctr = [4.5, 4.5]
    const h = COL_HALF
    const Pc = [ctr[0] + 0.55, 0, ctr[1] - 0.62]
    const cases = [
      // name, P, N, analytic planes (clipped at corners), MC occluder (true geometry)
      ['infinite wall', [0, 0, 0], [0, 1, 0], [{ axis: 0, pos: 0.2, lo: -BIG, hi: BIG }]],
      ['finite wall', [0, 0, 0], [0, 1, 0], [{ axis: 0, pos: 0.3, lo: -0.2, hi: 0.5 }]],
      [
        'room corner',
        [0, 0, 0],
        [0, 1, 0],
        [
          { axis: 0, pos: 0.25, lo: -BIG, hi: 0.35 },
          { axis: 2, pos: 0.35, lo: -BIG, hi: 0.25 },
        ],
        rectOccluder(
          toRects([0, 0, 0], [0, 1, 0], [
            { axis: 0, pos: 0.25, lo: -BIG, hi: BIG },
            { axis: 2, pos: 0.35, lo: -BIG, hi: BIG },
          ]),
        ),
      ],
      [
        'opposite walls',
        [0, 0, 0],
        [0, 1, 0],
        [
          { axis: 0, pos: 0.3, lo: -BIG, hi: BIG },
          { axis: 0, pos: -0.5, lo: -BIG, hi: BIG },
        ],
      ],
      [
        'ceiling beside a door header',
        [1.0, WALL_H, 3.3],
        [0, -1, 0],
        [{ axis: 2, pos: 3.0, lo: 0, hi: 3 }],
        rectOccluder([{ axis: 2, pos: 3.0, lo: [0, 2.4, 0], hi: [3, WALL_H, 0] }]),
      ],
      [
        'wall receiver in a floor / crossing-wall corner',
        [3.0, 0.25, 1.1],
        [-1, 0, 0],
        [
          { axis: 1, pos: 0, lo: 0.92, hi: BIG },
          { axis: 2, pos: 0.92, lo: 0, hi: BIG },
        ],
        rectOccluder([
          { axis: 1, pos: 0, lo: [-BIG, 0, -BIG], hi: [3.0, 0, BIG] },
          { axis: 2, pos: 0.92, lo: [-BIG, -BIG, 0], hi: [3.0, BIG, 0] },
        ]),
      ],
      [
        'floor diagonal to a column',
        Pc,
        [0, 1, 0],
        [
          { axis: 0, pos: ctr[0] + h, lo: ctr[1] - h, hi: ctr[1] + h },
          { axis: 2, pos: ctr[1] - h, lo: ctr[0] - h, hi: ctr[0] + h },
        ],
        boxOccluder([{ lo: [ctr[0] - h, -1, ctr[1] - h], hi: [ctr[0] + h, WALL_H, ctr[1] + h] }]),
      ],
    ]
    const errs = {}
    for (const [name, P, N, planes, occluder] of cases) {
      const an = creaseAO(P, N, planes, R)
      const mc = cosineAO_MC(P, N, occluder ?? rectOccluder(toRects(P, N, planes)), R, 65536, 3)
      errs[name] = { an, mc, err: Math.abs(an - mc) }
      expect(an).toBeGreaterThan(0.1)
      expect(Math.abs(an - mc)).toBeLessThanOrEqual(0.005)
    }
    report('creaseAO', errs)
    // parallel planes are ignored; the sum clamps at 1
    expect(creaseAO([0, 0, 0], [0, 1, 0], [{ axis: 1, pos: 0.1, lo: -BIG, hi: BIG }], R)).toBe(0)
    const walls = [0, 1, 2, 3].map((i) => ({ axis: 0, pos: i % 2 ? 0.001 : -0.001, lo: -BIG, hi: BIG }))
    expect(creaseAO([0, 0, 0], [0, 1, 0], walls, R)).toBe(1)
  })

  // A pier (half 1.1 in a 3 m cell) has its faces 0.4 m from its cell lines,
  // inside every tier's AO radius: floor receivers in the next cell must see
  // it too, or the crease AO steps by 0.1-0.25 along the cell line.
  describe('columns around the corner (gCreaseCorner)', () => {
    const pierAt = (x, z) => (x === 0 && z === 0 ? FLAG_PIER : 0) // pier centred at (1.5, 1.5)
    const open = { xLo: false, xHi: false, zLo: false, zHi: false }

    it('is continuous across the pier cell line, beside a face and at a corner', () => {
      for (const RR of [0.6, 0.8, 1.0]) {
        for (const [inside, outside, least] of [
          [[2.99, 1.5], [3.01, 1.5], 0.1], // x neighbour, mid-face
          [[1.2, 2.99], [1.2, 3.01], 0.1], // z neighbour
          [[2.99, 2.99], [3.01, 3.01], 0], // diagonal, off the pier corner
        ]) {
          const a = creaseCornerColumns(inside, RR, pierAt, open)
          const b = creaseCornerColumns(outside, RR, pierAt, open)
          expect(b).toBeGreaterThan(least)
          expect(Math.abs(a - b)).toBeLessThan(0.02)
        }
      }
    })

    it('matches cosineAO_MC for floor receivers in the neighbouring cells', () => {
      const pier = boxOccluder([
        { lo: [1.5 - MONUMENTAL_COL_HALF, -1, 1.5 - MONUMENTAL_COL_HALF], hi: [1.5 + MONUMENTAL_COL_HALF, WALL_H, 1.5 + MONUMENTAL_COL_HALF] },
      ])
      for (const [x, z] of [[3.2, 1.2], [3.15, 3.1], [0.8, 3.3]]) {
        const an = creaseCornerColumns([x, z], R, pierAt, open)
        const mc = cosineAO_MC([x, 0, z], [0, 1, 0], pier, R, 65536, 5)
        report('pier neighbour', { x, z, an, mc })
        expect(an).toBeGreaterThan(0.001)
        expect(Math.abs(an - mc)).toBeLessThanOrEqual(0.005)
      }
    })

    it('drops a neighbour pier behind a closed edge (the wall wedge holds it)', () => {
      // (3.01, 1.5): own cell (1, 0), the pier across the x-line half xLo
      expect(creaseCornerColumns([3.01, 1.5], R, pierAt, { ...open, xLo: true })).toBe(0)
      expect(creaseCornerColumns([3.01, 1.5], R, pierAt, { ...open, xHi: true })).toBeGreaterThan(0.1)
      // diagonal (3.01, 3.01): reachable through either L-shaped path
      const diag = creaseCornerColumns([3.01, 3.01], R, pierAt, open)
      expect(creaseCornerColumns([3.01, 3.01], R, pierAt, { ...open, xHi: true, zLo: true })).toBe(diag)
      expect(creaseCornerColumns([3.01, 3.01], R, pierAt, { ...open, xHi: true, zHi: true })).toBe(0)
    })

    it('adds nothing for a standard column in the next cell (beyond every radius)', () => {
      const colAt = (x, z) => (x === 0 && z === 0 ? FLAG_COLUMN : 0)
      expect(creaseCornerColumns([3.01, 1.5], 1.0, colAt, open)).toBe(0)
      expect(columnFaces([0, 0], FLAG_COLUMN, [2.0, 1.5], R)).toBeGreaterThan(0.1)
    })
  })
})

describe('boxFormFactorAxis (P13 box AO)', () => {
  it('matches cosineAO_MC for axis-aligned receivers: mean <= 0.005', () => {
    const rnd = makeRng(21)
    const errs = []
    let occluded = 0
    while (errs.length < 400) {
      const w = 0.4 + rnd() * 1.6
      const d = 0.3 + rnd() * 1.0
      const lo = [rnd() * 2 - 1, rnd() < 0.5 ? 0 : rnd(), rnd() * 2 - 1]
      const hi = [lo[0] + w, lo[1] + 0.05 + rnd() * 1.5, lo[2] + d]
      const axis = Math.floor(rnd() * 3)
      const sign = rnd() < 0.5 ? -1 : 1
      const P = [rnd() * 4 - 1.5, rnd() * 2, rnd() * 4 - 1.5]
      const N = [0, 0, 0]
      N[axis] = sign
      const a = boxFormFactorAxis(P, axis, sign, lo, hi)
      const mc = cosineAO_MC(P, N, boxOccluder([{ lo, hi }]), Infinity, 9216, errs.length + 1)
      if (mc > 0.001) occluded++
      errs.push(Math.abs(a - mc))
    }
    const s = errStats(errs)
    report('boxFormFactorAxis', { ...s, occluded })
    expect(occluded).toBeGreaterThan(150)
    expect(s.mean).toBeLessThanOrEqual(0.005)
    expect(s.max).toBeLessThanOrEqual(0.01)
  })

  it('sums faces in abs(): independent of each face winding', () => {
    // Regression for gBoxFF's first version (signed sum, abs of the total):
    // its corner lists mix orientations, so faces cancelled: 0.027 here.
    const P = [0.46, 0.572, 1.767]
    const lo = [0.599, 0, 0.414]
    const hi = [2.423, 1.507, 1.575]
    const a = boxFormFactorAxis(P, 2, -1, lo, hi)
    const mc = cosineAO_MC(P, [0, 0, -1], boxOccluder([{ lo, hi }]), Infinity, 65536, 8)
    report('boxFF regression', { a, mc })
    expect(Math.abs(a - mc)).toBeLessThanOrEqual(0.003)
    expect(a).toBeGreaterThan(0.4)
    expect(boxFF(P, [0, 0, -1], lo, hi)).toBe(a)
    // reversing a quad's corner order only flips the sign
    const q = [[0.6, 0, 0.4], [0.6, 0, 1.6], [0.6, 1.5, 1.6], [0.6, 1.5, 0.4]]
    const N = [0, 0, -1]
    const f = quadFF(P, N, q[0], q[1], q[2], q[3])
    expect(Math.abs(f)).toBeGreaterThan(0.1)
    expect(quadFF(P, N, q[3], q[2], q[1], q[0])).toBeCloseTo(-f, 12)
  })

  it('is 1 under an unbounded slab and 0 for a box behind the receiver', () => {
    expect(boxFormFactorAxis([0, 0, 0], 1, 1, [-BIG, 0.1, -BIG], [BIG, 0.2, BIG])).toBeCloseTo(1, 4)
    expect(boxFormFactorAxis([0, 1, 0], 1, 1, [-1, 0, -1], [1, 0.5, 1])).toBe(0)
    expect(boxFormFactorAxis([0, 1, 0], 0, -1, [0.5, 0, -1], [1, 2, 1])).toBe(0)
  })
})

describe('footprintOpen (P5 gridTrace v2 wall crossings)', () => {
  const LINE = 3 // wall line x = 3 (axis 0) or z = 3 (axis 1)
  const DOOR = (c) => (c === 1 ? EDGE_DOOR : EDGE_WALL)
  const MIXED = (c) => [EDGE_WALL, EDGE_DOOR, EDGE_WINDOW, EDGE_OPEN, EDGE_RAIL][((c % 5) + 5) % 5]

  // Randomised receivers beyond one wall line (both orientations), lamps in
  // the cell centres 1.5-4.5 m behind it; 60 % floor pixels (the
  // doorway3.mjs distribution). Returns the pooled statistics plus those of
  // the non-trivial receivers: most receivers see the emitter wholly through
  // the opening or not at all, where model and oracle agree exactly (0 or 1),
  // and they dilute the pooled numbers.
  // Every model is scored against the same oracle samples (the MC is the
  // cost), and each (edge set, lamp height) is measured once for all tests.
  function measure(codeFor, lampY, perAxis, seed) {
    const models = { single, sub2, para }
    const codeAt = (s) => edgeOpening(codeFor(Math.floor(s / 3)))
    const rnd = makeRng(seed)
    const errs = {}
    const hard = {}
    for (const name in models) {
      errs[name] = []
      hard[name] = []
    }
    let count = 0
    for (const axis of [0, 1]) {
      for (let k = 0; k < perAxis; k++) {
        const across = [1.5, -1.5, -4.5][Math.floor(rnd() * 3)]
        const along = [1.5, 4.5, 7.5, 10.5, -1.5][Math.floor(rnd() * 5)]
        const pAcross = LINE + 0.1 + rnd() * 8
        const pAlong = -1 + rnd() * 11
        const y = rnd() < 0.6 ? 0.02 : rnd() * 3.0
        const L = axis === 0 ? [across, lampY, along] : [along, lampY, across]
        const P = axis === 0 ? [pAcross, y, pAlong] : [pAlong, y, pAcross]
        const ref = doorwayMC(P, L, H, axis, LINE, codeAt, 32, true, seed * 7919 + count++)
        for (const name in models) {
          const m = models[name](P, L, axis, codeAt)
          errs[name].push(Math.abs(m - ref))
          if (!((m === 0 && ref === 0) || (m === 1 && ref === 1))) hard[name].push(Math.abs(m - ref))
        }
      }
    }
    const out = {}
    for (const name in models) out[name] = { ...errStats(errs[name]), hard: errStats(hard[name]) }
    return out
  }
  const cache = new Map()
  const stats = (set, lampY) => {
    const key = `${set}@${lampY}`
    if (!cache.has(key)) {
      cache.set(key, set === 'door' ? measure(DOOR, lampY, 1000, 11) : measure(MIXED, lampY, 700, 12))
    }
    return cache.get(key)
  }

  function single(P, L, axis, codeAt) {
    return footprintOpen(P, L, H, axis, LINE, codeAt, 0.04, true)
  }
  function sub2(P, L, axis, codeAt) {
    return footprintOpenSub(P, L, H, axis, LINE, codeAt, 0.04, true, 2)
  }
  function para(P, L, axis, codeAt) {
    return footprintOpenPara(P, L, H, axis, LINE, codeAt, 0.04, true)
  }

  it('clamps the vertical window to the storey and honours the jambs', () => {
    const door = edgeOpening(EDGE_DOOR)
    expect(openingWindow(door, 0.1, 1.0)).toBe(1) // v1 read 0.6 here: the sub-floor half counted as wall
    expect(openingWindow(door, 2.4, 0.4)).toBeCloseTo(0.5, 12)
    expect(openingWindow(edgeOpening(EDGE_WINDOW), 1.5, 0.2)).toBeCloseTo(0.82, 12)
    expect(edgeOpening(EDGE_WALL)).toBeNull()
    // a floor pixel looking straight through the jamb: blocked with jambs only
    const codeAt = (s) => edgeOpening(Math.floor(s / 3) === 1 ? EDGE_DOOR : EDGE_WALL)
    const P = [6, 0.02, 3.05]
    const L = [0, 1.2, 3.05]
    expect(footprintOpen(P, L, [0.001, 0.001], 0, 3, codeAt, 0.01, false)).toBeGreaterThan(0.9)
    expect(footprintOpen(P, L, [0.001, 0.001], 0, 3, codeAt, 0.01, true)).toBe(0)
  })

  // The plan's limits hold POOLED over both line orientations and over the
  // trivially exact receivers only. Split by orientation, lines crossed along
  // the panel's LONG axis (x-lines) are the hard case: with the emitter at
  // the panel (3.16 m) their p99 alone is ~0.145-0.157 depending on the
  // sample (8000 receivers: 0.156); z-lines are ~0.12. And 60-65 % of the
  // DOOR receivers are trivially exact (model and oracle both 0 or both 1):
  // on the non-trivial ones alone the single ray FAILS the plan's numbers —
  // measured mean / p99: door 0.034 / 0.172 (3.16 m), 0.035 / 0.144 (2.7 m);
  // mixed 0.025 / 0.136, 0.023 / 0.134 (n 708-945 each).
  // The separable footprint's error is at jamb/lintel corners, where the
  // along and vertical shifts are correlated — footprintOpenPara integrates
  // that parallelogram exactly and is ~3-5x better (next test).
  it('single ray matches the jamb-aware brute oracle: mean <= 0.02, p99 <= 0.15 (pooled)', () => {
    for (const lampY of [SOURCE_Y, LEGACY_Y]) {
      const door = stats('door', lampY).single
      const mixed = stats('mixed', lampY).single
      report(`footprintOpen y=${lampY}`, { door, mixed })
      for (const s of [door, mixed]) {
        expect(s.mean).toBeLessThanOrEqual(0.02)
        expect(s.p99).toBeLessThanOrEqual(0.15)
        expect(s.hard.n).toBeGreaterThan(500)
        expect(s.hard.mean).toBeLessThanOrEqual(0.04)
        expect(s.hard.p99).toBeLessThanOrEqual(0.19)
      }
    }
  })

  // Non-trivial receivers only, mean / p99 at 3.16 m and 2.7 m: two sub-rays
  // 0.014 / 0.074, 0.013 / 0.066; parallelogram 0.006 / 0.066, 0.005 / 0.065
  // (mixed), 0.007 / 0.073, 0.006 / 0.056 (door) — within the plan's
  // numbers even without the trivial receivers.
  it('two sub-rays (ultra) and the parallelogram footprint reach p99 <= 0.08', () => {
    for (const lampY of [SOURCE_Y, LEGACY_Y]) {
      const s = stats('mixed', lampY).sub2
      const p = stats('mixed', lampY).para
      const pd = stats('door', lampY).para
      report(`footprint y=${lampY}`, { sub2: s, para: p, paraDoor: pd })
      expect(s.mean).toBeLessThanOrEqual(0.012)
      expect(s.p99).toBeLessThanOrEqual(0.08)
      expect(p.mean).toBeLessThanOrEqual(0.008)
      expect(p.p99).toBeLessThanOrEqual(0.08)
      for (const h of [s.hard, p.hard, pd.hard]) {
        expect(h.n).toBeGreaterThan(500)
        expect(h.p99).toBeLessThanOrEqual(0.09)
      }
      expect(s.hard.mean).toBeLessThanOrEqual(0.02)
      expect(p.hard.mean).toBeLessThanOrEqual(0.01)
      expect(pd.hard.mean).toBeLessThanOrEqual(0.01)
    }
  })

  it('slideOverlapInt integrates the sliding box exactly', () => {
    const rnd = makeRng(4)
    for (let k = 0; k < 100; k++) {
      const x0 = rnd() * 4 - 2
      const kk = rnd() * 2 - 1
      const a = 0.05 + rnd()
      const lo = rnd() * 2 - 1
      const hi = lo + rnd() * 2
      const ua = -1 + rnd()
      const ub = ua + rnd()
      let num = 0
      for (let i = 0; i < 4000; i++) {
        const x = x0 + kk * (ua + ((ub - ua) * (i + 0.5)) / 4000)
        num += Math.max(0, Math.min(x + a, hi) - Math.max(x - a, lo))
      }
      expect(slideOverlapInt(x0, kk, a, lo, hi, ua, ub)).toBeCloseTo((num * (ub - ua)) / 4000, 5)
    }
  })
})

describe('columnVisibility (P5 square columns)', () => {
  // Blocked width across a ray family at `deg` for a point light: the range
  // of lateral offsets (1 mm steps) where the model reads < 0.5 visible.
  function blockedWidth(fn, half, deg) {
    const ctr = [4.5, 4.5]
    const u = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)]
    const nrm = [-u[1], u[0]]
    let blocked = 0
    for (let i = -2500; i <= 2500; i++) {
      const off = i * 0.001
      const a = [ctr[0] - 3 * u[0] + off * nrm[0], ctr[1] - 3 * u[1] + off * nrm[1]]
      const b = [ctr[0] + 4 * u[0] + off * nrm[0], ctr[1] + 4 * u[1] + off * nrm[1]]
      const vis = fn ? fn(a, b, ctr, half, 0, 0, 1e-4) : segmentHitsSquare(a, b, ctr, half) ? 0 : 1
      if (vis < 0.5) blocked++
    }
    return blocked * 0.001
  }

  it('matches the exact square cross-section at 45 degrees within 1 cm (point light)', () => {
    for (const half of [COL_HALF, MONUMENTAL_COL_HALF]) {
      for (const deg of [45, 0, 30]) {
        const exact = blockedWidth(null, half, deg)
        if (deg === 45) expect(exact).toBeCloseTo(2 * half * Math.SQRT2, 2)
        expect(Math.abs(blockedWidth(columnVisibility, half, deg) - exact)).toBeLessThanOrEqual(0.01)
        expect(Math.abs(blockedWidth(columnVisibilityClipped, half, deg) - exact)).toBeLessThanOrEqual(0.01)
      }
    }
  })

  it('ignores a column outside the traced window of the ray (cross-floor storeys)', () => {
    // A cross-floor path walks the full ray once per storey over its window;
    // a column whose centre lies outside the window stands in the other one.
    const ctr = [4.5, 4.5]
    const a = [0.5, 4.5]
    const b = [12.5, 4.5] // the column centre is at t = 1/3
    const full = columnVisibility(a, b, ctr, COL_HALF, PANEL_HALF_X, PANEL_HALF_Z, 0.05)
    expect(full).toBeLessThan(0.5)
    expect(columnVisibility(a, b, ctr, COL_HALF, PANEL_HALF_X, PANEL_HALF_Z, 0.05, 0, 1)).toBe(full)
    expect(columnVisibility(a, b, ctr, COL_HALF, PANEL_HALF_X, PANEL_HALF_Z, 0.05, 0.3, 0.4)).toBe(full)
    expect(columnVisibility(a, b, ctr, COL_HALF, PANEL_HALF_X, PANEL_HALF_Z, 0.05, 0, 0.3)).toBe(1)
    expect(columnVisibility(a, b, ctr, COL_HALF, PANEL_HALF_X, PANEL_HALF_Z, 0.05, 0.4, 1)).toBe(1)
  })

  it('never shadows a receiver from a column behind it', () => {
    // floor in front of the lit face of its own cell's column, lamp ahead
    const ctr = [4.5, 4.5]
    const a = [4.5 + COL_HALF + 0.05, 4.5]
    const b = [10.5, 4.5]
    expect(columnVisibility(a, b, ctr, COL_HALF, PANEL_HALF_X, PANEL_HALF_Z, 0.05)).toBe(1)
    expect(columnVisibilityClipped(a, b, ctr, COL_HALF, PANEL_HALF_X, PANEL_HALF_Z, 0.05)).toBe(1)
  })

  it('the clipped variant is the exact point-light test near columns', () => {
    const rnd = makeRng(42)
    const ctr = [4.5, 4.5]
    let n = 0
    let badGated = 0
    let badClipped = 0
    while (n < 5000) {
      const half = rnd() < 0.7 ? COL_HALF : MONUMENTAL_COL_HALF
      const a = [ctr[0] + (rnd() * 2 - 1) * (half + 1.2), ctr[1] + (rnd() * 2 - 1) * (half + 1.2)]
      const ang = rnd() * 2 * Math.PI
      const len = 1 + rnd() * 9
      const b = [a[0] + Math.cos(ang) * len, a[1] + Math.sin(ang) * len]
      const inside = (p) => Math.abs(p[0] - ctr[0]) < half + 0.01 && Math.abs(p[1] - ctr[1]) < half + 0.01
      if (inside(a) || inside(b)) continue
      n++
      const exact = segmentHitsSquare(a, b, ctr, half) ? 0 : 1
      if ((columnVisibility(a, b, ctr, half, 0, 0, 1e-4) >= 0.5 ? 1 : 0) !== exact) badGated++
      if ((columnVisibilityClipped(a, b, ctr, half, 0, 0, 1e-4) >= 0.5 ? 1 : 0) !== exact) badClipped++
    }
    report('column point-light misclassified', { n, badGated, badClipped })
    expect(badClipped).toBe(0)
    expect(badGated / n).toBeLessThan(0.005)
  })

  it('tracks the area-light oracle around columns', () => {
    const rnd = makeRng(7)
    const ctr = [4.5, 4.5]
    const eg = []
    const ec = []
    while (eg.length < 600) {
      const half = rnd() < 0.7 ? COL_HALF : MONUMENTAL_COL_HALF
      const P = [ctr[0] + (rnd() * 2 - 1) * 4, 0, ctr[1] + (rnd() * 2 - 1) * 4]
      if (Math.abs(P[0] - ctr[0]) < half + 0.03 && Math.abs(P[2] - ctr[1]) < half + 0.03) continue
      const L = [ctr[0] + (Math.floor(rnd() * 5) - 2) * 3, SOURCE_Y, ctr[1] + (Math.floor(rnd() * 5) - 2) * 3]
      if (L[0] === ctr[0] && L[2] === ctr[1]) continue
      const mc = columnAreaMC(P, L, H, ctr, half, 32, eg.length + 1)
      const a = [P[0], P[2]]
      const b = [L[0], L[2]]
      eg.push(Math.abs(columnVisibility(a, b, ctr, half, H[0], H[1], 0.04) - mc))
      ec.push(Math.abs(columnVisibilityClipped(a, b, ctr, half, H[0], H[1], 0.04) - mc))
    }
    const sg = errStats(eg)
    const sc = errStats(ec)
    report('column area light', { gated: sg, clipped: sc })
    expect(sg.mean).toBeLessThanOrEqual(0.015)
    expect(sc.mean).toBeLessThanOrEqual(0.015)
  })
})
