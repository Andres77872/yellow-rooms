import { describe, expect, it } from 'vitest'
import { lightingFrag } from '../shaders/lighting.js'
import { CONTACT_FRAG } from '../shaders/contact.js'
import { GRID_GLSL } from '../shaders/grid.js'
import { volFrag } from '../shaders/volumetric.js'
import { CELL } from '../../world/constants.js'
import { OCC_OFFSETS } from '../../world/lightGrid/gridSpec.js'

// Regressions of the chapter 14 review of the lighting pass GLSL (unified
// light loop, furniture prepass, cross-floor trace, crease AO, contact
// ownership). There is no GLSL compiler in node, so these pin the generated
// source: each assertion names the defect it guards against.

const FULL = { pbr: true, physicalAtt: true, occV2: true, furn: true, flashFilter: 0, bent: true, flashAnalytic: true }
const SRC = lightingFrag(FULL)

// Body of the GLSL function `name` (from its definition's opening brace to
// the matching closing brace).
function fnBody(src, name) {
  const m = new RegExp(`\\b(?:float|bool|void|int|vec[234]|uvec4)\\s+${name}\\s*\\(`).exec(src)
  if (!m) throw new Error(`no definition of ${name}`)
  let i = src.indexOf('{', m.index)
  const start = i
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) break
  }
  return src.slice(start, i + 1)
}

// Text between two markers of the lighting pass's main().
function section(from, to) {
  const a = SRC.indexOf(from)
  const b = SRC.indexOf(to, a)
  expect(a, from).toBeGreaterThanOrEqual(0)
  expect(b, to).toBeGreaterThan(a)
  return SRC.slice(a, b)
}

const LOOP = section('// --- Unified light loop', '// Contact (legacy aggregate mask)')
const PREPASS = section('// --- Furniture box shadows + box AO', '// --- Unified light loop')

describe('unified light loop', () => {
  it('stores a fully blocked bounce light / torch as 0 before the vis early-out', () => {
    // The bare `if (vis <= 0.002) continue;` skipped the vplVis / torchVis
    // stores, so a light behind a solid wall kept its initial 1 (the umbra
    // lit, only the penumbra dimmed).
    expect(LOOP).not.toMatch(/if \(vis <= 0\.002\) continue;/)
    expect(LOOP).toMatch(/if \(vis <= 0\.002\) \{[^}]*vplVis = 0\.0;[^}]*torchVis = 0\.0;[^}]*continue;\s*\}/)
  })

  it('caps traces by the number of partial candidates, not the list position', () => {
    // `k < uMaxTraced` let full-visibility lamps in the first slots use up
    // the budget, so doorway partials behind them were never traced.
    expect(LOOP).not.toMatch(/k < uMaxTraced/)
    expect(LOOP).toMatch(/bool inBudget = cand && traceCand < uMaxTraced;/)
    expect(LOOP).toMatch(/if \(cand\) traceCand\+\+;/)
    expect(LOOP).toMatch(/doTrace = gl\.partial && gl\.sameFloor && inBudget;/)
    expect(LOOP).toMatch(/if \(crossOk && inBudget\)/)
    // A slot is spent before any per-pixel test (the hole coverage), so the
    // traced set is constant across a cell.
    expect(LOOP.indexOf('traceCand++')).toBeLessThan(LOOP.indexOf('gHoleOpen('))
  })

  it('traces a cross-floor path as the full ray, windowed per storey', () => {
    // Two gridTrace calls on (Ptrace, segExit) and (segEnter, Lp) sized the
    // footprint, the columns and the sub-ray offsets by the segment's own s:
    // 2-3x too wide below the slab, zero at the slab on the lamp's storey.
    expect(LOOP).not.toMatch(/segExit|segEnter/)
    expect(LOOP).toMatch(/gTraceWin = nSeg == 1 \? vec2\(0\.0, 1\.0\) : \(sg == 0 \? vec2\(0\.0, tExit\) : vec2\(tEnter, 1\.0\)\);/)
    expect(LOOP).toMatch(/vis \*= gridTrace\(Ptrace, Lp, /)
    // ...and the window is reset for everything after it.
    expect(LOOP).toMatch(/\}\s*gTraceWin = vec2\(0\.0, 1\.0\);\s*traced\+\+;/)
  })

  it('tests the slab band where the ray leaves, crosses and enters it (min, one call site)', () => {
    // The mid-plane alone admitted rays whose slab entry or exit lies over
    // solid slab (a lamp 4 cm under its own ceiling lit the storey above).
    expect(LOOP.match(/\bgHoleOpen\s*\(/g)).toHaveLength(1)
    expect(LOOP).toMatch(/float sp = pl == 0 \? tExit : \(pl == 1 \? sC : tEnter\);/)
    expect(LOOP).toMatch(/holeOpen = min\(holeOpen, gHoleOpen\(X\.xz, max\(sp \* H, vec2\(0\.05\)\), lowF\)\);/)
  })
})

describe('lights that cannot reach the pixel', () => {
  const reach = fnBody(SRC, 'fixtureReaches')
  const shade = fnBody(SRC, 'shadeFixture')

  it('rejects a fixture before its hole test, trace, furniture cover and capsules', () => {
    const at = LOOP.indexOf('if (uLightDebug == 0 && !fixtureReaches(Lp)) continue;')
    expect(at).toBeGreaterThan(0)
    expect(LOOP.match(/fixtureReaches\(/g)).toHaveLength(1)
    for (const later of ['gHoleOpen(', 'gridTrace(', 'fvis[k]', 'capsuleShadow(', 'shadeFixture(']) {
      expect(LOOP.indexOf(later), later).toBeGreaterThan(at)
    }
    // The budget slot is spent first, whatever the pixel: which entries are
    // traced must not change inside a cell.
    expect(LOOP.indexOf('traceCand++')).toBeLessThan(at)
  })

  it('rejects only what shadeFixture would multiply by zero', () => {
    // PBR: past the range window, or N.L <= 0 for both the diffuse direction
    // and the specular representative point (brdfDirect clamps both).
    expect(reach).toMatch(/if \(fixtureAtt\(d, uLampRange\) <= 0\.0\) return false;/)
    expect(reach).toMatch(/if \(ndl > 0\.0\) return true;/)
    expect(reach).toMatch(/return dot\(sN, normalize\(rectRepPoint\(sP, R, lampPos, G_PANEL_HALF\) - sP\)\) > 0\.0;/)
    expect(shade).toMatch(/if \(att <= 0\.0\) return;/)
    expect(shade).toMatch(/vec3 Ls = normalize\(rectRepPoint\(sP, R, lampPos, G_PANEL_HALF\) - sP\);/)
    // Classic wraps light past the terminator: only the range decides, and
    // the glossy highlight's longer reach needs N.L > 0.
    expect(reach).toMatch(/return d <= reach && \(d <= uLampRange \|\| \(sGlossy && ndl > 0\.0\)\);/)
    expect(shade).toMatch(/if \(d > reach\) return;/)
    expect(shade).toMatch(/if \(sGlossy && ndl > 0\.0\) aSpec \+=/)
  })

  it('keeps no state alive across the trace (the test and the shading are independent)', () => {
    // Sharing L / Ls / att between the two kept nine more values live across
    // gridTrace: 12-18% slower on the builds that crossed the register limit.
    const between = SRC.slice(SRC.indexOf('bool fixtureReaches('), SRC.indexOf('void shadeFixture('))
    expect(between).not.toMatch(/^\s*(?:vec3|float) f[A-Z]\w*(?:, f[A-Z]\w*)*;/m)
    expect(shade).toMatch(/vec3 toL = lampPos - sP;/)
  })

  it('walks every entry in the debug views (traced count, furniture visibility)', () => {
    expect(LOOP).not.toMatch(/if \(!fixtureReaches\(Lp\)\) continue;/)
    expect(LOOP).toMatch(/if \(uLightDebug == 0 && vplGeo <= 0\.0\) continue;/)
  })

  it('skips the bounce light where its geometric term is zero, with the same term it shades with', () => {
    const before = SRC.slice(0, SRC.indexOf('for (int k = 0; k < LOOP_MAX; k++)'))
    expect(before).toMatch(/vplGeo = max\(dot\(Nw, Lv\), 0\.0\) \* max\(dot\(uVplN, -Lv\), 0\.0\) \/ \(dv \* dv \+ 1\.0\);/)
    expect(SRC).toMatch(/flashBounce = sAlbedo \* \(1\.0 - sMetal\) \* uVplColor \* \(uFlashIntensity \* uFlashBounce \* vplGeo \* vplVis\);/)
    expect(SRC.match(/max\(dot\(uVplN, -Lv\), 0\.0\)/g)).toHaveLength(1)
  })

  it('traces the analytic torch only inside its cone (and toward the lit side in PBR)', () => {
    expect(SRC).toMatch(/bool torchReach = uLightDebug > 0;/)
    expect(SRC).toMatch(/torchReach = smoothstep\(uFlashCosOuter, uFlashCosInner, dot\(-Lt, uFlashDirV\)\) > 0\.0;/)
    expect(LOOP).toMatch(/if \(!flashOn \|\| !torchReach \|\| !gridPixel/)
  })
})

describe('gTraceRay parameter window (cross-floor)', () => {
  const ray = fnBody(GRID_GLSL, 'gTraceRay')

  it('defaults to the whole ray, so the shaft pass is unchanged', () => {
    expect(GRID_GLSL).toMatch(/vec2 gTraceWin = vec2\(0\.0, 1\.0\);/)
    // only the declaration assigns it there
    expect(volFrag().match(/gTraceWin\s*=/g)).toHaveLength(1)
  })

  it('walks only the window, with full-ray parameters for every crossing', () => {
    expect(ray).toMatch(/vec2 a = P\.xz \+ d\.xz \* sLo;/)
    expect(ray).toMatch(/vec2 b = P\.xz \+ d\.xz \* sHi;/)
    expect(ray).toMatch(/sLo \+ \(\(float\(c\.x\) \+ 1\.0\) \* G_CELL - a\.x\) \/ d\.x/)
    expect(ray).toMatch(/if \(s > sHi\) break;/)
    expect(ray).not.toMatch(/s > 1\.0/)
    // columns see the full ray and the window
    expect(ray.match(/gColumnSq\(c, cy, P\.xz, Lp\.xz, H, minW, sLo, sHi\)/g)).toHaveLength(2)
    expect(fnBody(GRID_GLSL, 'gColumnSq')).toMatch(/if \(t <= tLo \|\| t >= tHi\) return 1\.0;/)
  })
})

describe('furniture prepass', () => {
  it('only furniture pixels skip the proxy they lie in; floors and walls never do', () => {
    // The skip dropped every box within 3 cm of Ptrace: a lit strip at the
    // foot of every piece, a lit wall behind desks, lit knee holes.
    expect(PREPASS).toMatch(/bool furnPx = !gArchSurface\(Pw, gcy\);/)
    expect(PREPASS).toMatch(/if \(furnPx && all\(greaterThan\(Ptrace, blo - 0\.03\)\) && all\(lessThan\(Ptrace, bhi \+ 0\.03\)\)\) continue;/)
    expect(PREPASS.match(/greaterThan\(Ptrace, blo/g)).toHaveLength(1)
  })

  it('undoes the proxy rounding for architecture receivers before shading a box', () => {
    // The proxies are rounded outward, so the floor right at a lit face lay
    // inside the box and read full cover and box AO ~1 for every lamp.
    const at = PREPASS.indexOf('if (!furnPx) gBoxBeside(Ptrace, Nw, blo, bhi);')
    expect(at).toBeGreaterThan(PREPASS.indexOf('gOccBox(o, w,'))
    expect(at).toBeLessThan(PREPASS.indexOf('gBoxFF(Ptrace, Nw, blo, bhi)'))
    expect(at).toBeLessThan(PREPASS.indexOf('gBoxCover(Ptrace, Lk, H, blo, bhi)'))
    const body = fnBody(GRID_GLSL, 'gBoxBeside')
    expect(body).toMatch(/if \(any\(lessThan\(P, lo\)\) \|\| any\(greaterThan\(P, hi\)\)\) return;/)
    // the receiver normal's axis never qualifies
    expect(body).toMatch(/e\.x = 1e6; else if \(an\.y >= an\.z\) e\.y = 1e6; else e\.z = 1e6;/)
    // added, not scaled: a receiver on the bottom plane has depth 0 there
    expect(body).toMatch(/vec3 rl = \(P - lo\) \* k \+ e;/)
    // one face only, the shallowest, in the twin's order (shadowMath boxBeside)
    expect(body).toMatch(/if \(m >= 1\.0\) return;/)
    expect(body.match(/= P\.[xyz] [+-] 0\.001;/g)).toEqual([
      '= P.x + 0.001;', '= P.x - 0.001;', '= P.y + 0.001;', '= P.y - 0.001;', '= P.z + 0.001;', '= P.z - 0.001;',
    ])
  })

  it('never asks for ring-2 box AO (it cannot pass dh < 2.5)', () => {
    // 511u must be exactly the own cell + ring 1 in OCC_OFFSETS bit order.
    for (let b = 0; b < OCC_OFFSETS.length; b++) {
      const [dx, dz] = OCC_OFFSETS[b]
      expect(Math.max(Math.abs(dx), Math.abs(dz)) <= 1, `bit ${b}`).toBe(b < 9)
    }
    // Ptrace = Pl - 0.26 N lies at most 0.26 m outside the receiver cell,
    // and a ring-2 box lies inside its own cell, a full CELL further out.
    expect(CELL - 0.26).toBeGreaterThan(2.5)
    expect(PREPASS).toMatch(/uint aoNeed = !aoAxis \? 0u : \(uBoxAOCells <= 1 \? 1u : 511u\);/)
    expect(PREPASS).not.toMatch(/G_OCC_MASK\)/)
  })

  it('gathers shadow cells before AO-only cells; only a dropped shadow cell truncates', () => {
    // One ring-order pass over ring & (need | aoNeed) let AO-only cells evict
    // a cell a light's shadow needed (high lost shadows medium kept).
    expect(PREPASS).toMatch(/uint todoShadow = ring & need;/)
    expect(PREPASS).toMatch(/uint todoAO = ring & aoNeed & ~need;/)
    expect(PREPASS).toMatch(/int cellsMax = min\(uFurnCellsMax, FURN_CELLS\);/)
    // Shadow bits are drained first, lowest (ring order) first; AO bits only
    // once none is left; the cap ends the walk.
    expect(PREPASS).toMatch(
      /if \(i >= cellsMax\) break;[\s\S]*?if \(todoShadow != 0u\) \{ bit = todoShadow & \(~todoShadow \+ 1u\); todoShadow \^= bit; \}\s*else if \(todoAO != 0u\) \{ bit = todoAO & \(~todoAO \+ 1u\); todoAO \^= bit; \}\s*else break;/
    )
    expect(PREPASS).toMatch(/furnTrunc = todoShadow != 0u;/)
    expect(PREPASS).not.toMatch(/furnTrunc = [^;]*todoAO/)
  })

  it('walks only the cells it takes (no scan of the 25-cell ring, no cell array)', () => {
    expect(PREPASS).not.toMatch(/b < G_OCC_CELLS/)
    expect(PREPASS).not.toMatch(/int cells\[/)
    expect(PREPASS).toMatch(/G_OCC_OFF\[gBitIndex\(bit\)\]/)
  })
})

describe('analytic torch boxes (gCellBoxes)', () => {
  const body = fnBody(GRID_GLSL, 'gCellBoxes')

  it('are walked only by builds that have the analytic torch', () => {
    // A runtime `kind == 2` kept the proxy walk (and its registers) in every
    // build, though only the F2 analytic torch can ever take it.
    expect(SRC).toMatch(/#define TRACE_BOXES\(kind\) \(\(kind\) == 2\)/)
    expect(lightingFrag({ ...FULL, flashAnalytic: false })).toMatch(/#define TRACE_BOXES\(kind\) false/)
    expect(LOOP).toMatch(/subRays, TRACE_BOXES\(kind\)\);/)
  })

  it('reads occupancy only for an owned slot', () => {
    expect(body.indexOf('if (!gridOwned(c.x, c.y, cy)) return 1.0;')).toBeGreaterThanOrEqual(0)
    expect(body.indexOf('gridOwned')).toBeLessThan(body.indexOf('texelFetch(tGridOcc'))
  })

  it('skips a box holding the receiver and never grows a box over it', () => {
    // The soft edge grew with distance (0.01 + 0.004 d) until Ptrace, 4 cm off
    // a desk top or cabinet front, fell inside: 50 % torch light past ~5-7 m.
    expect(body).toMatch(/float dB = length\(max\(max\(lo - P, P - hi\), 0\.0\)\);/)
    expect(body).toMatch(/if \(dB < 0\.005\) continue;/)
    expect(body).toMatch(/float delta = min\(0\.01 \+ 0\.004 \* length\(Lp - P\), 0\.5 \* dB\);/)
  })
})

describe('contact ownership', () => {
  const owned = fnBody(CONTACT_FRAG, 'owned')

  it('shares the architecture test with the lighting pass', () => {
    expect(owned).toMatch(/if \(gArchSurface\(Sw, cy\)\) return true;/)
    expect(owned).not.toMatch(/G_FRAME_BAND|G_HALF_THICK/)
    expect(CONTACT_FRAG.match(/bool gArchSurface\s*\(/g)).toHaveLength(1)
  })

  it('reads a cell occupancy texel only when this floor owns the slot', () => {
    // gOcc has no floor tag: after vertical aliasing it returned the boxes of
    // the floor six storeys away and dropped real contact hits there.
    const guard = owned.indexOf('if (gridOwned(c.x, c.y, cy))')
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(guard).toBeLessThan(owned.indexOf('gOcc('))
  })
})

describe('crease AO (gCreaseCorner)', () => {
  it('counts the columns of the four cells around the nearest corner', () => {
    // Only the receiver's own cell was read: a 0.1-0.25 AO step along every
    // cell line 0.4 m from a pier.
    const corner = fnBody(GRID_GLSL, 'gCreaseCorner')
    expect(corner.match(/gColumnFaces\(/g)).toHaveLength(4)
    expect(corner).toMatch(/if \(!xNear\) occ \+= gColumnFaces/)
    expect(corner).toMatch(/if \(!zNear\) occ \+= gColumnFaces/)
    expect(corner).toMatch(/if \(\(!xNear && !zFar\) \|\| \(!zNear && !xFar\)\) occ \+= gColumnFaces/)
    expect(fnBody(GRID_GLSL, 'gCreaseAO')).toMatch(/occ = gCreaseCorner\(/)
    expect(GRID_GLSL).not.toMatch(/gCreaseColumn\s*\(/)
  })
})

describe('indirect specular occlusion (PBR)', () => {
  it('applies AO once: Lagarde SO replaces it, plain AO when the look turns SO off', () => {
    // The hemisphere reflection took uHemi * aoTot * so, i.e. ~AO^2.
    expect(SRC).toMatch(/so = mix\(aoTot, so, uSpecOcc\);/)
    expect(SRC).toMatch(/\* \(uHemi \* so\) \* envK;/)
    expect(SRC).not.toMatch(/aoTot \* so/)
  })
})
