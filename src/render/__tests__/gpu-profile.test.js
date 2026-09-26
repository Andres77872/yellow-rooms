import { describe, expect, it } from 'vitest'
import {
  BENCH_VERSION,
  GPU_CLASSES,
  GPU_PROFILE_KEY,
  PRESET_COST_WEIGHT,
  PRESET_ORDER_AUTO,
  choosePreset,
  classifyRenderer,
  defaultPresetForClass,
  guardScore,
  isMobileUserAgent,
  loadGpuProfile,
  presetCostMs,
  readRendererString,
  rendererKeyHash,
  saveGpuProfile,
  summarizeBenchmark,
  toScore,
  viewportMegapixels,
} from '../gpuProfile.js'

// Renderer strings as browsers actually report them (Chrome/Edge ANGLE on
// D3D11/Metal/GL, Firefox sanitised, Linux Mesa, Safari masked, Android).
const RENDERERS = [
  // Intel iGPUs
  ['ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated'],
  ['ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11-27.20.100.8681)', 'integrated'],
  ['ANGLE (Intel, Intel(R) Arc(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated'],
  ['ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 655, OpenGL 4.1)', 'integrated'],
  ['Mesa Intel(R) UHD Graphics 620 (KBL GT2)', 'integrated'],
  ['Mesa Intel(R) Xe Graphics (TGL GT2)', 'integrated'],
  ['ANGLE (Intel, Mesa Intel(R) Graphics (ADL GT2), OpenGL 4.6)', 'integrated'],
  ['Intel(R) HD Graphics 4000', 'integrated'],
  // Intel discrete Arc
  ['ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'discrete'],
  // NVIDIA
  ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'discrete'],
  ['ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 Ti Direct3D11 vs_5_0 ps_5_0, D3D11-27.21.14.5671)', 'discrete'],
  ['ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3080/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 535.54.03)', 'discrete'],
  ['NVIDIA GeForce RTX 4090/PCIe/SSE2', 'discrete'],
  ['Quadro P2000/PCIe/SSE2', 'discrete'],
  ['ANGLE (NVIDIA, NVIDIA GeForce MX450 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'discrete'],
  // Firefox sanitised: NVIDIA has no PC iGPUs, so the family name is enough.
  ['NVIDIA GeForce GTX 980, or similar', 'discrete'],
  ['ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar', 'discrete'],
  // AMD APUs vs discrete Radeons
  ['ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated'],
  ['ANGLE (AMD, AMD Radeon 780M Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated'],
  ['AMD Radeon 680M (radeonsi, rembrandt, LLVM 15.0.7, DRM 3.49, 6.2.0)', 'integrated'],
  ['AMD Radeon Graphics (radeonsi, renoir, LLVM 15.0.7, DRM 3.49, 6.2.0)', 'integrated'],
  ['ANGLE (AMD, Radeon Vega 8 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated'],
  ['AMD Radeon R7 Graphics', 'integrated'],
  ['AMD Custom GPU 0405 (radeonsi, vangogh, LLVM 15.0.7, DRM 3.49)', 'integrated'], // Steam Deck
  ['Radeon 8060S Graphics', 'integrated'],
  ['AMD Radeon RX 6700 XT', 'discrete'],
  ['ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.12027.9001)', 'discrete'],
  ['ANGLE (AMD, AMD Radeon RX 7900 XTX Direct3D11 vs_5_0 ps_5_0, D3D11)', 'discrete'],
  ['AMD Radeon RX Vega 64', 'discrete'],
  ['ANGLE (ATI Technologies Inc., AMD Radeon Pro 5500M OpenGL Engine, OpenGL 4.1)', 'discrete'],
  ['AMD Radeon R9 200 Series', 'discrete'],
  // Firefox sanitised AMD (a Ryzen APU reports a desktop family name): the
  // name proves nothing, so the conservative class.
  ['ANGLE (AMD, Radeon R9 200 Series Direct3D11 vs_5_0 ps_5_0), or similar', 'integrated'],
  ['Radeon R9 200 Series, or similar', 'integrated'],
  ['AMD Radeon HD 5850, or similar', 'integrated'],
  ['ANGLE (Intel, Intel(R) HD Graphics 400 Direct3D11 vs_5_0 ps_5_0), or similar', 'integrated'],
  // Apple
  ['Apple M1', 'apple'],
  ['Apple M3 Max', 'apple'],
  ['ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)', 'apple'],
  ['Apple GPU', 'apple'], // Safari masks every Mac
  // Mobile families
  ['Apple A15 GPU', 'mobile'],
  ['ANGLE (ARM, Mali-G78, OpenGL ES 3.2)', 'mobile'],
  ['Mali-G52 MC2', 'mobile'],
  ['Adreno (TM) 740', 'mobile'],
  ['ANGLE (Qualcomm, Adreno (TM) 650, OpenGL ES 3.2)', 'mobile'],
  ['PowerVR Rogue GE8320', 'mobile'],
  ['ANGLE (Samsung Xclipse 920) on Vulkan 1.1.179', 'mobile'],
  ['NVIDIA Tegra X1', 'mobile'],
  // Windows on ARM laptop: an Adreno, but a laptop-class iGPU
  ['ANGLE (Qualcomm, Qualcomm(R) Adreno(TM) X1-85 GPU Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated'],
  // Software rasterisers
  ['Google SwiftShader', 'software'],
  ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'software'],
  ['llvmpipe (LLVM 15.0.7, 256 bits)', 'software'],
  ['ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)', 'software'],
  // Virtual and unknown: conservative
  ['VMware SVGA 3D', 'integrated'],
  ['WebKit WebGL', 'integrated'],
  ['', 'integrated'],
]

describe('classifyRenderer', () => {
  it.each(RENDERERS)('%s -> %s', (str, cls) => {
    expect(classifyRenderer(str)).toBe(cls)
  })

  it('covers every class with real-world strings', () => {
    expect(RENDERERS.length).toBeGreaterThanOrEqual(20)
    expect(new Set(RENDERERS.map(([, c]) => c))).toEqual(new Set(GPU_CLASSES))
  })

  it('the mobile flag forces mobile, except for software rasterisers', () => {
    expect(classifyRenderer('Apple GPU', { mobile: true })).toBe('mobile')
    expect(classifyRenderer('Apple M2', { mobile: true })).toBe('mobile') // M-series iPad
    expect(classifyRenderer('NVIDIA GeForce RTX 3060', { mobile: true })).toBe('mobile')
    expect(classifyRenderer('Google SwiftShader', { mobile: true })).toBe('software')
  })

  it('tolerates non-strings', () => {
    expect(classifyRenderer(null)).toBe('integrated')
    expect(classifyRenderer(undefined, undefined)).toBe('integrated')
    expect(classifyRenderer(42)).toBe('integrated')
  })

  it('detects phone and tablet user agents, including iPadOS desktop mode', () => {
    expect(isMobileUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36')).toBe(true)
    expect(isMobileUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(true)
    expect(isMobileUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', 5)).toBe(true)
    expect(isMobileUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', 0)).toBe(false)
    expect(isMobileUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0')).toBe(false)
    expect(isMobileUserAgent(undefined)).toBe(false)
  })
})

describe('readRendererString', () => {
  const DEBUG = { UNMASKED_RENDERER_WEBGL: 0x9246 }
  const RENDERER = 0x1f01

  it('prefers the unmasked renderer when the debug extension exists', () => {
    const gl = {
      RENDERER,
      getExtension: (n) => (n === 'WEBGL_debug_renderer_info' ? DEBUG : null),
      getParameter: (p) => (p === DEBUG.UNMASKED_RENDERER_WEBGL ? 'ANGLE (NVIDIA, RTX)' : 'WebKit WebGL'),
    }
    expect(readRendererString(gl)).toBe('ANGLE (NVIDIA, RTX)')
  })

  it('falls back to RENDERER without the extension or when it throws', () => {
    const plain = { RENDERER, getExtension: () => null, getParameter: () => 'Apple GPU' }
    expect(readRendererString(plain)).toBe('Apple GPU')
    const throwing = {
      RENDERER,
      getExtension: () => {
        throw new Error('deprecated')
      },
      getParameter: (p) => (p === RENDERER ? 'Mali-G78' : null),
    }
    expect(readRendererString(throwing)).toBe('Mali-G78')
    const empty = { RENDERER, getExtension: () => DEBUG, getParameter: (p) => (p === RENDERER ? 'Adreno (TM) 740' : '') }
    expect(readRendererString(empty)).toBe('Adreno (TM) 740')
  })

  it('is safe on missing or broken contexts', () => {
    expect(readRendererString(null)).toBe('')
    expect(readRendererString({})).toBe('')
    const broken = {
      getExtension: () => null,
      getParameter: () => {
        throw new Error('context lost')
      },
    }
    expect(readRendererString(broken)).toBe('')
    expect(readRendererString({ getParameter: () => 7 })).toBe('')
  })
})

describe('preset decision', () => {
  it('maps classes to starting presets', () => {
    expect(defaultPresetForClass('discrete')).toBe('high')
    expect(defaultPresetForClass('apple')).toBe('high')
    expect(defaultPresetForClass('integrated')).toBe('medium')
    expect(defaultPresetForClass('mobile')).toBe('medium')
    expect(defaultPresetForClass('software')).toBe('low')
    expect(defaultPresetForClass('quantum')).toBe('medium')
  })

  it('exposes weights for exactly the auto presets, never cinematic', () => {
    expect(Object.keys(PRESET_COST_WEIGHT)).toEqual([...PRESET_ORDER_AUTO])
    expect(PRESET_ORDER_AUTO).not.toContain('cinematic')
    expect(PRESET_COST_WEIGHT.high).toBe(1)
  })

  // Render scales of the current preset table (low renders at 0.75).
  const SCALES = { low: 0.75, medium: 1, high: 1, ultra: 1 }
  const mpAt = (w, h, dpr = 1) => viewportMegapixels(w, h, (p) => dpr * SCALES[p])

  it('a desktop scoring ~1.5 ms at 1687x1235 DPR 1 resolves to ultra at 60 fps', () => {
    const viewportMP = mpAt(1687, 1235)
    expect(viewportMP.high).toBeCloseTo(2.0834, 3)
    expect(viewportMP.low).toBeCloseTo(2.0834 * 0.5625, 3)
    expect(choosePreset({ score: 1.5, cls: 'discrete', viewportMP })).toEqual({ preset: 'ultra', reason: 'budget' })
    // Predicted ultra cost ~5.4 ms against a 0.7 x 16.7 = 11.7 ms allowance.
    expect(presetCostMs(1.5, 'ultra', viewportMP.ultra)).toBeCloseTo(5.435, 2)
  })

  it('walks down the ladder as the score worsens', () => {
    const viewportMP = mpAt(1920, 1080) // 2.07 MP
    const pick = (score, extra = {}) => choosePreset({ score, cls: 'discrete', viewportMP, ...extra }).preset
    expect(pick(2)).toBe('ultra') // ultra 7.2 ms
    expect(pick(4)).toBe('high') // ultra 14.4, high 9.0
    expect(pick(6)).toBe('medium') // high 13.5, medium 9.5
    expect(pick(9)).toBe('low') // medium 14.2, low 5.7
    expect(choosePreset({ score: 25, cls: 'discrete', viewportMP })).toEqual({ preset: 'low', reason: 'over-budget' })
    // A 30 fps target doubles the allowance.
    expect(pick(6, { targetFps: 30 })).toBe('ultra')
    // Retina doubles each axis: 4x the pixels (5.2 MP), high 14.1 ms > 11.7.
    expect(choosePreset({ score: 2.5, cls: 'apple', viewportMP: mpAt(1440, 900) }).preset).toBe('ultra')
    expect(choosePreset({ score: 2.5, cls: 'apple', viewportMP: mpAt(1440, 900, 2) }).preset).toBe('medium')
  })

  it('applies class caps', () => {
    const viewportMP = mpAt(1920, 1080)
    // Integrated: 'high' only with 30% extra headroom, never 'ultra'.
    expect(choosePreset({ score: 1, cls: 'integrated', viewportMP })).toEqual({ preset: 'high', reason: 'class-cap' })
    expect(choosePreset({ score: 3, cls: 'integrated', viewportMP }).preset).toBe('high') // high 6.8 <= 8.2
    expect(choosePreset({ score: 4.5, cls: 'integrated', viewportMP })).toEqual({ preset: 'medium', reason: 'class-cap' })
    expect(choosePreset({ score: 7, cls: 'integrated', viewportMP })).toEqual({ preset: 'medium', reason: 'budget' })
    // Mobile: never above medium, whatever the score.
    expect(choosePreset({ score: 0.5, cls: 'mobile', viewportMP })).toEqual({ preset: 'medium', reason: 'class-cap' })
    // Software: always low.
    expect(choosePreset({ score: 0.5, cls: 'software', viewportMP })).toEqual({ preset: 'low', reason: 'software' })
    // Low memory beats everything.
    expect(choosePreset({ score: 0.5, cls: 'discrete', viewportMP, deviceMemory: 2 })).toEqual({ preset: 'low', reason: 'memory' })
    expect(choosePreset({ score: 0.5, cls: 'discrete', viewportMP, deviceMemory: 4 }).preset).toBe('ultra')
    // Unknown class behaves like integrated.
    expect(choosePreset({ score: 1, cls: 'mystery', viewportMP }).preset).toBe('high')
  })

  it('falls back to the class default without a usable benchmark', () => {
    const viewportMP = mpAt(1920, 1080)
    expect(choosePreset({ score: null, cls: 'discrete', viewportMP })).toEqual({ preset: 'high', reason: 'no-benchmark' })
    expect(choosePreset({ score: Number.NaN, cls: 'mobile', viewportMP }).preset).toBe('medium')
    expect(choosePreset({ score: 1.5, cls: 'apple' }).preset).toBe('high')
    expect(choosePreset({ score: 1.5, cls: 'apple', viewportMP: { high: 2 } }).reason).toBe('no-benchmark')
    expect(choosePreset().preset).toBe('medium')
    // A single number is accepted as the same megapixels for every preset.
    expect(choosePreset({ score: 1.5, cls: 'discrete', viewportMP: 2.08 }).preset).toBe('ultra')
  })

  it('never returns cinematic', () => {
    for (const cls of GPU_CLASSES) {
      for (const score of [0.01, 0.5, 2, 8, 40]) {
        const { preset } = choosePreset({ score, cls, viewportMP: 0.5 })
        expect(PRESET_ORDER_AUTO).toContain(preset)
      }
    }
  })
})

describe('benchmark summary', () => {
  it('takes the median of valid samples, discarding stalls and garbage', () => {
    expect(summarizeBenchmark([4, 5, 6])).toEqual({ median: 5, count: 3 })
    expect(summarizeBenchmark([6, 4, 5, 7])).toEqual({ median: 5.5, count: 4 })
    expect(summarizeBenchmark([5, 300, Number.NaN, Infinity, -1, 0, 'x', null, 4, 6])).toEqual({ median: 5, count: 3 })
    expect(summarizeBenchmark([])).toEqual({ median: null, count: 0 })
    expect(summarizeBenchmark(undefined)).toEqual({ median: null, count: 0 })
    expect(summarizeBenchmark([251, 1000])).toEqual({ median: null, count: 0 })
    // Per-megapixel samples are not milliseconds: the stall cap is the caller's.
    expect(summarizeBenchmark([251, 1000, 300], { maxMs: Infinity })).toEqual({ median: 300, count: 3 })
  })

  it('normalises to the 0.92 MP reference', () => {
    expect(toScore(5, 0.92)).toBeCloseTo(5, 10)
    expect(toScore(4.52, 2.0834)).toBeCloseTo(1.996, 3)
    expect(toScore(5, 0)).toBeNull()
    expect(toScore(Number.NaN, 1)).toBeNull()
    expect(toScore(-3, 1)).toBeNull()
  })

  it('viewportMegapixels guards bad inputs', () => {
    expect(viewportMegapixels(0, 1080)).toEqual({ low: 0, medium: 0, high: 0, ultra: 0 })
    expect(viewportMegapixels(1000, 1000, () => Number.NaN).high).toBe(0)
    expect(viewportMegapixels(1000, 1000).high).toBe(1)
  })
})

describe('persistence', () => {
  function fakeStorage() {
    const map = new Map()
    return {
      map,
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
    }
  }
  const throwing = {
    getItem() {
      throw new Error('SecurityError')
    },
    setItem() {
      throw new Error('QuotaExceededError')
    },
  }
  const RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'

  it('hashes renderer strings with 32-bit FNV-1a', () => {
    // Published FNV-1a 32 test vectors.
    expect(rendererKeyHash('')).toBe('811c9dc5')
    expect(rendererKeyHash('a')).toBe('e40c292c')
    expect(rendererKeyHash('foobar')).toBe('bf9cf968')
    expect(rendererKeyHash(RENDERER)).toMatch(/^[0-9a-f]{8}$/)
    expect(rendererKeyHash(RENDERER)).toBe(rendererKeyHash(RENDERER))
    expect(rendererKeyHash(RENDERER)).not.toBe(rendererKeyHash(RENDERER.replace('3060', '3070')))
    expect(rendererKeyHash(null)).toBe('811c9dc5')
  })

  it('round-trips a profile and stores only the hash', () => {
    const storage = fakeStorage()
    const key = rendererKeyHash(RENDERER)
    const profile = { key, score: 1.5, preset: 'ultra', cls: 'discrete', benchVersion: BENCH_VERSION, date: 1790000000000 }
    expect(saveGpuProfile(storage, { ...profile, renderer: RENDERER })).toBe(true)
    const raw = storage.map.get(GPU_PROFILE_KEY)
    expect(raw).not.toContain('NVIDIA')
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['benchVersion', 'cls', 'date', 'key', 'preset', 'score'])
    expect(loadGpuProfile(storage, key)).toEqual(profile)
  })

  it('fills benchVersion and date when omitted', () => {
    const storage = fakeStorage()
    saveGpuProfile(storage, { key: 'abcd1234', score: 2, preset: 'high', cls: 'apple' })
    const p = loadGpuProfile(storage, 'abcd1234')
    expect(p.benchVersion).toBe(BENCH_VERSION)
    expect(typeof p.date).toBe('number')
  })

  it('invalidates on a different GPU/driver or benchmark version', () => {
    const storage = fakeStorage()
    const key = rendererKeyHash(RENDERER)
    expect(saveGpuProfile(storage, { key, score: 1.5, preset: 'ultra', cls: 'discrete' })).toBe(true)
    expect(loadGpuProfile(storage, key)).not.toBeNull()
    expect(loadGpuProfile(storage, rendererKeyHash('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 ... newer driver)'))).toBeNull()
    expect(loadGpuProfile(storage, undefined)).toBeNull()
    // A profile an older benchmark left behind.
    const stale = { key, score: 1.5, preset: 'ultra', cls: 'discrete', benchVersion: BENCH_VERSION - 1, date: 1 }
    storage.map.set(GPU_PROFILE_KEY, JSON.stringify(stale))
    expect(loadGpuProfile(storage, key)).toBeNull()
  })

  it('refuses to save a profile that loading would reject', () => {
    // Otherwise the save "succeeds" and the game re-benchmarks on every boot.
    const storage = fakeStorage()
    const base = { key: 'abcd1234', score: 2, preset: 'high', cls: 'discrete' }
    for (const bad of [
      { preset: 'auto' },
      { preset: 'cinematic' },
      { preset: undefined },
      { cls: 'gpu9000' },
      { cls: undefined },
      { key: '' },
      { key: 1234 },
      { benchVersion: BENCH_VERSION - 1 },
    ]) {
      expect(saveGpuProfile(storage, { ...base, ...bad })).toBe(false)
    }
    expect(storage.map.size).toBe(0)
    // Every valid profile round-trips.
    for (const preset of PRESET_ORDER_AUTO) {
      for (const cls of GPU_CLASSES) {
        expect(saveGpuProfile(storage, { ...base, preset, cls })).toBe(true)
        expect(loadGpuProfile(storage, base.key)).toMatchObject({ preset, cls })
      }
    }
    // A non-positive score is stored as "no score", not as a bogus benchmark.
    saveGpuProfile(storage, { ...base, score: -1 })
    expect(loadGpuProfile(storage, base.key).score).toBeNull()
  })

  it('rejects corrupt or out-of-range blobs', () => {
    const storage = fakeStorage()
    const key = 'deadbeef'
    const put = (v) => storage.map.set(GPU_PROFILE_KEY, typeof v === 'string' ? v : JSON.stringify(v))
    put('{not json')
    expect(loadGpuProfile(storage, key)).toBeNull()
    put('null')
    expect(loadGpuProfile(storage, key)).toBeNull()
    put({ key, score: 1, preset: 'cinematic', cls: 'discrete', benchVersion: BENCH_VERSION })
    expect(loadGpuProfile(storage, key)).toBeNull()
    put({ key, score: 1, preset: 'high', cls: 'gpu9000', benchVersion: BENCH_VERSION })
    expect(loadGpuProfile(storage, key)).toBeNull()
    // A preset without a usable score is still a valid decision to reuse.
    put({ key, score: 'fast', preset: 'high', cls: 'discrete', benchVersion: BENCH_VERSION })
    expect(loadGpuProfile(storage, key)).toMatchObject({ preset: 'high', score: null })
  })

  it('survives missing and throwing storage', () => {
    expect(loadGpuProfile(null, 'x')).toBeNull()
    expect(loadGpuProfile(throwing, 'x')).toBeNull()
    expect(saveGpuProfile(null, { key: 'x' })).toBe(false)
    expect(saveGpuProfile(throwing, { key: 'x', score: 1, preset: 'low', cls: 'software' })).toBe(false)
    expect(saveGpuProfile(fakeStorage(), null)).toBe(false)
  })
})

describe('in-session guard score', () => {
  // 1080p, 'auto' at its DRS ceilings ('low' at 0.75 of native).
  const mp = viewportMegapixels(1920, 1080, (p) => (p === 'low' ? 0.75 : 1))

  it('raises the score just past the current preset, so the recompute drops exactly one step', () => {
    for (const [cur, lower] of [['ultra', 'high'], ['high', 'medium'], ['medium', 'low']]) {
      // A score at which `cur` is the highest preset that fits.
      const fits = (0.9 * AUTO_LIMIT) / (PRESET_COST_WEIGHT[cur] * (mp[cur] / 0.92))
      expect(choosePreset({ score: fits, cls: 'discrete', viewportMP: mp }).preset).toBe(cur)
      const raised = guardScore(fits, cur, mp)
      expect(raised).toBeGreaterThan(fits)
      expect(choosePreset({ score: raised, cls: 'discrete', viewportMP: mp }).preset, cur).toBe(lower)
    }
  })

  it('never lowers a measured score and synthesises one without a benchmark', () => {
    expect(guardScore(1000, 'high', mp)).toBe(1000)
    const s = guardScore(null, 'high', mp)
    expect(s).toBeGreaterThan(0)
    expect(choosePreset({ score: s, cls: 'discrete', viewportMP: mp }).preset).toBe('medium')
    expect(guardScore(3, 'cinematic', mp)).toBe(3)
    expect(guardScore(null, 'high', { high: 0 })).toBeNull()
  })

  it('a smaller viewport can earn the dropped preset back', () => {
    const raised = guardScore(null, 'high', mp)
    const small = viewportMegapixels(1280, 720, (p) => (p === 'low' ? 0.75 : 1))
    expect(choosePreset({ score: raised, cls: 'discrete', viewportMP: small }).preset).not.toBe('low')
    expect(PRESET_ORDER_AUTO.indexOf(choosePreset({ score: raised, cls: 'discrete', viewportMP: small }).preset))
      .toBeGreaterThanOrEqual(PRESET_ORDER_AUTO.indexOf('high'))
  })
})

const AUTO_LIMIT = (0.7 * 1000) / 60
