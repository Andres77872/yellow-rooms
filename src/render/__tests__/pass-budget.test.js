import { describe, expect, it } from 'vitest'
import { lightingFrag } from '../shaders/lighting.js'
import { volFrag } from '../shaders/volumetric.js'
import { CONTACT_FRAG } from '../shaders/contact.js'
import { GTAO_FRAG } from '../shaders/gtao.js'
import { OCC_RESOLVE_FRAG } from '../shaders/occResolve.js'
import { COMPOSITE_FRAG } from '../shaders/composite.js'
import { GRADE_FRAG } from '../shaders/grade.js'
import { SIGNAL_FRAG } from '../shaders/signal.js'
import { MOTION_BLUR_FRAG } from '../shaders/motionBlur.js'

// Shader budgets (engine-improvement chapter 14 P4/P6). WebGL2 guarantees 16
// fragment texture units and 224 fragment uniform vectors; ANGLE's D3D11
// backend (most integrated GPUs) compiles slowly when heavy functions are
// inlined many times or loops with gradient ops are forced to unroll. These
// rules are checked on the GENERATED source of every variant.

// Every lighting variant the renderer can select.
function lightingVariants() {
  const out = []
  for (const pbr of [false, true]) {
    for (const occV2 of [false, true]) {
      for (const furn of [false, true]) {
        for (const flashFilter of [0, 1, 2]) {
          for (const bent of [false, true]) {
            out.push({ pbr, physicalAtt: pbr, occV2, furn, flashFilter, bent, flashAnalytic: false })
          }
        }
      }
    }
  }
  out.push({ pbr: true, physicalAtt: true, occV2: true, furn: true, flashFilter: 0, bent: true, flashAnalytic: true })
  return out
}

// Samplers a variant actually declares (the PCSS depth sampler lives behind
// `#if FLASH_FILTER == 2`).
function samplers(src, key = {}) {
  const decls = src.match(/uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?(?:u|i)?sampler2D(?:Shadow)?\s+\w+/g) ?? []
  return decls.filter((d) => !(d.includes('tFlashDepth') && key.flashFilter !== 2)).length
}

// Upper bound on uniform vectors: a mat4 is 4, arrays count per element,
// every scalar/vector takes a full vec4 slot.
function uniformVectors(src) {
  let n = 0
  for (const m of src.matchAll(/uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?(\w+)\s+(\w+)(?:\[(\w+)\])?\s*;/g)) {
    const [, type, , len] = m
    if (/sampler/.test(type)) continue
    const per = type === 'mat4' ? 4 : type === 'mat3' ? 3 : 1
    let count = 1
    if (len) {
      const lit = Number(len)
      const def = src.match(new RegExp(`#define\\s+${len}\\s+(\\d+)`))
      count = Number.isFinite(lit) ? lit : Number(def?.[1] ?? 1)
    }
    n += per * count
  }
  return n
}

// Textual CALL sites of a function (its definition excluded).
function callSites(src, name) {
  const all = src.match(new RegExp(`\\b${name}\\s*\\(`, 'g'))?.length ?? 0
  const defs = src.match(new RegExp(`\\b(?:float|vec[234]|bool|void)\\s+${name}\\s*\\(`, 'g'))?.length ?? 0
  return all - defs
}

describe('lighting pass budgets (every variant)', () => {
  const variants = lightingVariants()

  it('stays within 14 of the 16 guaranteed texture units (13 without PCSS)', () => {
    for (const key of variants) {
      const src = lightingFrag(key)
      const n = samplers(src, key)
      expect(n, JSON.stringify(key)).toBeLessThanOrEqual(key.flashFilter === 2 ? 14 : 13)
    }
  })

  it('stays within 180 of the 224 guaranteed uniform vectors', () => {
    for (const key of variants) {
      expect(uniformVectors(lightingFrag(key)), JSON.stringify(key)).toBeLessThanOrEqual(180)
    }
  })

  it('inlines each heavy occlusion function exactly once', () => {
    for (const key of variants) {
      const src = lightingFrag(key)
      expect(callSites(src, 'gTraceRay'), 'gTraceRay').toBe(1)
      expect(callSites(src, 'gridTrace'), 'gridTrace').toBe(1)
      expect(callSites(src, 'capsuleShadow'), 'capsuleShadow').toBe(1)
      expect(callSites(src, 'gBoxCover'), 'gBoxCover').toBe(1)
      expect(callSites(src, 'flashShadow'), 'flashShadow').toBe(1)
    }
  })

  it('reads the GI stencil once per pixel (diffuse and specular share it)', () => {
    // PBR evaluates both directions from one stencil; toon has no specular
    // GI and calls the one-direction wrapper (the #else branch, textually
    // present in every variant).
    const shared = new RegExp(
      '#ifdef SHADING_PBR\\s*(?://[^\\n]*\\n\\s*)?' +
        'gridIndirect2\\(Pl, Nb, reflect\\(-sV, Nw\\), gcy, stencil, indirect, indirectSpec\\);\\s*' +
        '#else\\s*indirect = gridIndirect\\(Pl, Nb, gcy, stencil\\);\\s*#endif'
    )
    for (const key of variants) {
      const src = lightingFrag(key)
      expect(src, JSON.stringify(key)).toMatch(shared)
      expect(callSites(src, 'gridIndirect'), JSON.stringify(key)).toBe(1)
    }
  })

  it('skips the torch map taps where the PBR BRDF zeroes the torch anyway', () => {
    const pbr = lightingFrag({ pbr: true, physicalAtt: true, occV2: true, furn: true, flashFilter: 2, bent: true })
    expect(pbr).toMatch(/bool fLit = uLightDebug > 0 \|\| dot\(N, Lf\) > 0\.0;/)
    expect(pbr).toMatch(/uFlashShadowOn > 0\.5 && fLit\) fvis = flashShadow\(/)
    // Toon wraps light past the terminator: its taps always run.
    const toon = lightingFrag({ pbr: false, physicalAtt: false, occV2: false, furn: false, flashFilter: 1, bent: false })
    expect(toon).toMatch(/bool fLit = true;/)
  })

  it('never takes derivatives (undefined after the early returns in GLSL ES 3.00)', () => {
    for (const key of variants) {
      const src = lightingFrag(key)
      expect(src).not.toMatch(/\bdFd[xy]\s*\(/)
      expect(src).not.toMatch(/\bfwidth\s*\(/)
    }
  })

  it('reads textures inside loops only with explicit LOD (texelFetch / textureLod)', () => {
    const src = lightingFrag({ pbr: true, physicalAtt: true, occV2: true, furn: true, flashFilter: 2, bent: true })
    // Implicit-derivative texture() calls exist only at main()'s top level.
    const implicit = src.match(/\btexture\s*\(\s*(\w+)/g) ?? []
    for (const call of implicit) expect(call, call).toMatch(/tColor|tNormal|tMaterial|tDepth|tOcc|tContact/)
  })
})

describe('other passes', () => {
  it('each stays within 10 texture units', () => {
    const passes = {
      contact: CONTACT_FRAG,
      gtao: GTAO_FRAG,
      occResolve: OCC_RESOLVE_FRAG,
      volumetric: volFrag(),
      volumetricHaze: volFrag({ haze: true }),
      composite: COMPOSITE_FRAG,
      grade: GRADE_FRAG,
      signal: SIGNAL_FRAG,
      motionBlur: MOTION_BLUR_FRAG,
    }
    for (const [name, src] of Object.entries(passes)) {
      expect(samplers(src), name).toBeLessThanOrEqual(10)
      expect(uniformVectors(src), name).toBeLessThanOrEqual(200)
    }
  })

  it('the shaft and contact passes each inline gridTrace at most once', () => {
    expect(callSites(volFrag(), 'gridTrace')).toBe(1)
    expect(callSites(volFrag({ haze: true }), 'gridTrace')).toBe(1)
    expect(callSites(CONTACT_FRAG, 'gridTrace')).toBe(0)
  })

  it('the shaft march gates a wall trace on the cheap lamp weight first', () => {
    for (const src of [volFrag(), volFrag({ haze: true })]) {
      const gate = src.indexOf('bool worth = gl.flicker * lampAtt(dl, uLampRange) >')
      const guarded = src.indexOf('if (worth && k < uTraceLights')
      const trace = src.search(/\bgridTrace\s*\(\s*Sw/)
      expect(gate).toBeGreaterThan(0)
      expect(guarded).toBeGreaterThan(gate)
      expect(trace).toBeGreaterThan(guarded)
    }
  })
})
