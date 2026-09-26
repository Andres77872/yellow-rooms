// GPU class + auto-preset decision (engine-improvement P4 part 5 / P23).
//
// The coarse-pointer test in core/device.js is an input heuristic, not a GPU
// benchmark (chapter 04): a gaming laptop and a Celeron both read "desktop".
// This module turns two cheap facts into a starting preset:
//   1. the renderer string -> a GPU CLASS (a prior + hard caps), and
//   2. a short startup benchmark -> a SCORE (ms of GPU time for one frame of
//      the 'high' preset at the 0.92 MP reference, i.e. 1280x720),
// then picks the highest preset whose predicted frame cost fits 70% of the
// frame budget at the player's real backing resolution. The remaining 30% is
// headroom for streaming, encounters and the rooms the benchmark did not see;
// DynamicResolution absorbs what is left at runtime.
//
// Contract:
//   - Plain logic, no three.js, no DOM globals: the engine passes the GL
//     context, the storage object and the viewport in, so everything here is
//     unit-testable in node.
//   - Presets are NAMES ('low' | 'medium' | 'high' | 'ultra'). 'cinematic'
//     is never chosen automatically — it is an explicit opt-in.
//   - Privacy: the raw renderer string identifies hardware. It is only ever
//     reduced to a class and a 32-bit hash in memory; only the hash is stored
//     (localStorage, this origin) and nothing here is sent anywhere.

export const GPU_CLASSES = Object.freeze(['discrete', 'integrated', 'apple', 'mobile', 'software'])

// Presets the auto path may pick, cheapest first.
export const PRESET_ORDER_AUTO = Object.freeze(['low', 'medium', 'high', 'ultra'])

// Relative GPU cost of each preset at equal pixel count, 'high' = 1. Planning
// estimates (AO/shadow/volumetric step counts), not measurements: only their
// ordering and rough spacing matter — the headroom absorbs the rest. Re-fit
// them from PassTimer captures when the v2 tier tables settle.
export const PRESET_COST_WEIGHT = Object.freeze({ low: 0.5, medium: 0.7, high: 1.0, ultra: 1.6 })

// Bump when the benchmark scene or scoring changes: stored scores measured by
// an older benchmark are not comparable and must be re-measured.
// 2: samples are normalised by the pixels actually rendered (the benchmark
//    no longer needs DRS at its ceiling), the in-session guard stores its
//    evidence as a raised score, and profiles v1 guard drops may have stored
//    for good on a device that was never over budget are dropped.
export const BENCH_VERSION = 2

// The benchmark renders at 1280x720; scores are normalised to it.
export const REFERENCE_MP = 0.92

// Fraction of the frame budget the preset may consume (the rest is headroom).
export const AUTO_BUDGET_FRACTION = 0.7

// Integrated GPUs share memory bandwidth with the CPU and throttle under
// sustained load, so 'high' must fit with a further 30% margin.
export const INTEGRATED_HEADROOM = 0.7

// Samples above this are stalls (shader compile, tab switch), not frame cost.
export const BENCH_MAX_SAMPLE_MS = 250

export const GPU_PROFILE_KEY = 'yellowrooms.gpuProfile'

// ---------------------------------------------------------------------------
// Renderer string

// The unmasked string names the actual GPU ("ANGLE (NVIDIA, ...)"); plain
// RENDERER is "WebKit WebGL" on older Chromium. Firefox exposes a sanitised
// name through both (and logs a deprecation note for the extension). Any
// failure yields '' which classifies as the conservative default.
export function readRendererString(gl) {
  if (!gl || typeof gl.getParameter !== 'function') return ''
  try {
    const ext = typeof gl.getExtension === 'function' ? gl.getExtension('WEBGL_debug_renderer_info') : null
    if (ext) {
      const unmasked = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
      if (typeof unmasked === 'string' && unmasked) return unmasked
    }
  } catch {
    /* fall through to the masked string */
  }
  try {
    const masked = gl.getParameter(gl.RENDERER)
    return typeof masked === 'string' ? masked : ''
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Classification
//
// Order matters: software renderers first (they can embed a vendor name, e.g.
// "ANGLE (Google, Vulkan (SwiftShader ...))"), then mobile families (Tegra
// would otherwise read as NVIDIA), then the desktop vendors. ANGLE wraps the
// device as "ANGLE (<vendor>, <device> <api>, <driver>)"; matching the device
// tokens rather than the vendor keeps Intel/AMD Macs out of 'apple'.
//
// Unknown strings map to 'integrated': a wrong 'discrete' guess would start a
// weak GPU on high/ultra (a slideshow first impression), while a wrong
// 'integrated' guess costs at most one preset step that the benchmark can
// win back ('high' is allowed when it fits with headroom).

const SOFTWARE_RE = /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render/
// Windows-on-ARM laptops (Snapdragon X "Adreno X1-85") run D3D11 ANGLE and
// have laptop-class iGPUs; phone Adrenos never report Direct3D.
const LAPTOP_ADRENO_RE = /adreno.*(direct3d|d3d1[12])|adreno\s*(\(tm\)\s*)?x\d/
const MOBILE_RE = /\bmali\b|adreno|powervr|\bimg\b|videocore|\bv3d\b|immortalis|xclipse|maleoon|tegra|\bapple a\d{1,2}\b/
const APPLE_SILICON_RE = /\bapple m\d|\bapple gpu\b/
// Hypervisor adapters forward to an unknown host GPU with overhead.
const VIRTUAL_RE = /vmware|virtualbox|parallels|svga3d|virgl|hyper-v|citrix|\bqxl\b/
const NVIDIA_RE = /nvidia|geforce|quadro|\brtx\b|\bgtx\b|titan|tesla/
// Discrete Arc cards carry a model number (A380/A770/B580); Meteor/Lunar
// Lake iGPUs are "Arc(TM) Graphics" / "Arc(TM) 140V".
const INTEL_ARC_DISCRETE_RE = /\barc(\(tm\))?\s*[ab]\d{3}/
const INTEL_RE = /intel|\biris\b|\buhd graphics|\bhd graphics/
// Ryzen APUs: "Radeon(TM) Graphics", "Radeon 680M/780M/890M", "Radeon 8060S",
// "Radeon Vega 8 Graphics", Kaveri-era "Radeon R7 Graphics", the Steam Deck
// "AMD Custom GPU", and Mesa codenames in the radeonsi string.
const AMD_APU_RE = new RegExp(
  [
    'radeon(\\(tm\\))?\\s*(r[2-7]\\s+)?graphics',
    'radeon(\\(tm\\))?\\s+\\d{3}m\\b',
    'radeon(\\(tm\\))?\\s+\\d{4}s\\b',
    'vega\\s*(3|6|7|8|9|10|11)\\b',
    'amd custom gpu',
    '\\b(renoir|cezanne|rembrandt|phoenix|raven|raven2|picasso|lucienne|barcelo|mendocino|vangogh|raphael|gfx1103|gfx1150)\\b',
  ].join('|')
)
const AMD_RE = /radeon|\bamd\b|\bati\b|firepro/
// Firefox sanitises the renderer (webgl.sanitize-unmasked-renderer, on by
// default): each vendor collapses to a few representative device names plus
// ", or similar", so a Ryzen APU can read "Radeon R9 200 Series, or similar".
// The device name then carries no information for AMD — the one vendor that
// sells APUs and discrete cards under one brand — and Firefox has no timer
// query to benchmark with, so the class default is all the auto path gets:
// fall back to the conservative class. (NVIDIA ships no PC iGPUs, and the
// generic Intel names classify as integrated anyway.)
const SANITIZED_RE = /,\s*or similar\s*$/

export function classifyRenderer(str, { mobile = false } = {}) {
  const s = typeof str === 'string' ? str.toLowerCase() : ''
  if (SOFTWARE_RE.test(s)) return 'software'
  // Touch/UA says phone or tablet: thermals and battery cap it whatever the
  // chip (an M-series iPad is still a fanless tablet).
  if (mobile) return 'mobile'
  if (LAPTOP_ADRENO_RE.test(s)) return 'integrated'
  if (MOBILE_RE.test(s)) return 'mobile'
  // Safari masks every Mac GPU as "Apple GPU" (Intel Macs included); the
  // benchmark, not the class, catches a slow one.
  if (APPLE_SILICON_RE.test(s)) return 'apple'
  if (VIRTUAL_RE.test(s)) return 'integrated'
  if (NVIDIA_RE.test(s)) return 'discrete'
  if (INTEL_ARC_DISCRETE_RE.test(s)) return 'discrete'
  if (INTEL_RE.test(s)) return 'integrated'
  if (AMD_APU_RE.test(s)) return 'integrated'
  if (AMD_RE.test(s)) return SANITIZED_RE.test(s) ? 'integrated' : 'discrete'
  if (/\bapple\b/.test(s)) return 'apple'
  return 'integrated'
}

// Phones and tablets, including iPadOS which reports a desktop "Macintosh"
// UA but has multi-touch. Callers usually OR this with device.js IS_TOUCH.
export function isMobileUserAgent(ua, maxTouchPoints = 0) {
  const s = typeof ua === 'string' ? ua.toLowerCase() : ''
  if (/android|iphone|ipad|ipod|mobile|silk|kindle/.test(s)) return true
  return /macintosh/.test(s) && maxTouchPoints > 1
}

// Starting preset before (or without) a benchmark.
export function defaultPresetForClass(cls) {
  switch (cls) {
    case 'discrete':
    case 'apple':
      return 'high'
    case 'software':
      return 'low'
    default: // integrated, mobile, unknown
      return 'medium'
  }
}

// ---------------------------------------------------------------------------
// Preset decision

// Predicted GPU ms of `preset` at `mp` megapixels: the score is ms per
// REFERENCE_MP at 'high', scaled linearly by pixel count (the deferred passes
// are fill-bound) and by the preset's relative weight.
export function presetCostMs(score, preset, mp) {
  const w = PRESET_COST_WEIGHT[preset]
  if (!(score > 0) || !(mp > 0) || w === undefined) return Infinity
  return score * w * (mp / REFERENCE_MP)
}

// Backing megapixels per preset. `ratioFor(preset)` returns the effective
// pixel ratio that preset would run at under 'auto' with DRS at its ceiling —
// Engine._autoViewportMegapixels passes
//   (p) => nativeRatio * drsCeiling(fixed ratio for p, nativeRatio)
// where nativeRatio is the post-clamp ratio at scale 1, so the DPR clamp and
// the 4K backing ceiling are honoured exactly as DRS applies them.
export function viewportMegapixels(cssWidth, cssHeight, ratioFor = () => 1) {
  const out = {}
  const area = cssWidth > 0 && cssHeight > 0 ? cssWidth * cssHeight : 0
  for (const p of PRESET_ORDER_AUTO) {
    const r = Number(ratioFor(p))
    out[p] = r > 0 ? (area * r * r) / 1e6 : 0
  }
  return out
}

const mpFor = (viewportMP, preset) =>
  typeof viewportMP === 'number' ? viewportMP : Number(viewportMP?.[preset])

const cheaper = (a, b) => (PRESET_ORDER_AUTO.indexOf(a) <= PRESET_ORDER_AUTO.indexOf(b) ? a : b)

// Pick the auto preset. Returns { preset, reason } where reason is one of
//   'memory'        deviceMemory <= 2 GB: forced 'low'
//   'software'      software rasteriser: forced 'low'
//   'no-benchmark'  no usable score/viewport: the class default
//   'over-budget'   even 'low' misses the budget: 'low' (DRS takes over)
//   'class-cap'     the budget allowed more than the class permits
//   'budget'        the highest preset that fits the budget
// Unknown classes are treated as 'integrated'.
export function choosePreset({ score, cls, viewportMP, targetFps = 60, deviceMemory } = {}) {
  const gpuClass = GPU_CLASSES.includes(cls) ? cls : 'integrated'
  if (Number.isFinite(deviceMemory) && deviceMemory <= 2) return { preset: 'low', reason: 'memory' }
  if (gpuClass === 'software') return { preset: 'low', reason: 'software' }

  const fallback = { preset: defaultPresetForClass(gpuClass), reason: 'no-benchmark' }
  if (!Number.isFinite(score) || score <= 0) return fallback
  if (!PRESET_ORDER_AUTO.every((p) => mpFor(viewportMP, p) > 0)) return fallback

  const fps = Number.isFinite(targetFps) && targetFps > 0 ? targetFps : 60
  const limit = (AUTO_BUDGET_FRACTION * 1000) / fps
  const cost = (p) => presetCostMs(score, p, mpFor(viewportMP, p))

  let best = null
  for (const p of PRESET_ORDER_AUTO) if (cost(p) <= limit) best = p
  if (!best) return { preset: 'low', reason: 'over-budget' }

  let cap = 'ultra'
  if (gpuClass === 'mobile') cap = 'medium'
  // Integrated: 'high' only with extra margin, and never 'ultra' on a guess
  // from a few hundred ms of benchmark (thermal throttling comes later).
  else if (gpuClass === 'integrated') cap = cost('high') <= limit * INTEGRATED_HEADROOM ? 'high' : 'medium'

  const preset = cheaper(best, cap)
  return { preset, reason: preset === best ? 'budget' : 'class-cap' }
}

// ---------------------------------------------------------------------------
// Benchmark summary

// Median of the valid samples. Non-finite, non-positive (a disjoint or unready
// timer query) and stall samples (> maxMs, 250 ms) are discarded. median is
// null when nothing survived. Samples already normalised per megapixel are not
// milliseconds: the caller filters stalls on the raw value and passes
// maxMs = Infinity.
export function summarizeBenchmark(samplesMs, { maxMs = BENCH_MAX_SAMPLE_MS } = {}) {
  const kept = []
  for (const v of samplesMs ?? []) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= maxMs) kept.push(v)
  }
  kept.sort((a, b) => a - b)
  const n = kept.length
  const median = n === 0 ? null : n % 2 ? kept[(n - 1) / 2] : (kept[n / 2 - 1] + kept[n / 2]) / 2
  return { median, count: n }
}

// Normalise a median measured at `mp` megapixels to the REFERENCE_MP score.
export function toScore(medianMs, mp) {
  if (!(medianMs > 0) || !(mp > 0) || !Number.isFinite(medianMs) || !Number.isFinite(mp)) return null
  return (medianMs / mp) * REFERENCE_MP
}

// The in-session guard's evidence (the auto preset held the resolution
// controller starved at its floor) as a score: the lowest score at which
// `preset` just misses the budget at `viewportMP`, never below the measured
// one. Stored in place of a lowered preset NAME, so the boot-time
// choosePreset re-derives the drop at this resolution and a smaller viewport
// can still earn the preset back. null when there is nothing to scale by.
export function guardScore(score, preset, viewportMP, targetFps = 60) {
  const measured = Number.isFinite(score) && score > 0 ? score : null
  const w = PRESET_COST_WEIGHT[preset]
  const mp = mpFor(viewportMP, preset)
  if (w === undefined || !(mp > 0)) return measured
  const fps = Number.isFinite(targetFps) && targetFps > 0 ? targetFps : 60
  const limit = (AUTO_BUDGET_FRACTION * 1000) / fps
  // 1% past the line, so rounding cannot land the preset back on it.
  const miss = (limit / (w * (mp / REFERENCE_MP))) * 1.01
  return Math.max(measured ?? 0, miss)
}

// ---------------------------------------------------------------------------
// Persistence

// 32-bit FNV-1a over the UTF-8 bytes, as 8 lowercase hex digits. Stable
// across sessions and browsers; it only has to notice "this is a different
// GPU/driver string than the one that was benchmarked".
export function rendererKeyHash(str) {
  const s = typeof str === 'string' ? str : ''
  const bytes = typeof TextEncoder === 'function' ? new TextEncoder().encode(s) : null
  let h = 0x811c9dc5
  const n = bytes ? bytes.length : s.length
  for (let i = 0; i < n; i++) {
    h ^= bytes ? bytes[i] : s.charCodeAt(i) & 0xff
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

// The stored profile, or null when absent, unreadable, measured on another
// GPU/driver (hash mismatch) or by another benchmark version.
export function loadGpuProfile(storage, key) {
  let raw = null
  try {
    raw = storage ? storage.getItem(GPU_PROFILE_KEY) : null
  } catch {
    return null
  }
  if (typeof raw !== 'string') return null
  let p = null
  try {
    p = JSON.parse(raw)
  } catch {
    return null
  }
  if (!p || typeof p !== 'object') return null
  if (p.key !== key || p.benchVersion !== BENCH_VERSION) return null
  if (!PRESET_ORDER_AUTO.includes(p.preset) || !GPU_CLASSES.includes(p.cls)) return null
  const score = Number.isFinite(p.score) && p.score > 0 ? p.score : null
  return { key: p.key, score, preset: p.preset, cls: p.cls, benchVersion: p.benchVersion, date: p.date ?? null }
}

// Persist only the whitelisted fields (never a raw renderer string, even if a
// caller passes one along). Returns false when storage is missing or throws
// (private mode, quota) — the next boot simply benchmarks again — and when
// the profile is one loadGpuProfile would reject (no key hash, a preset the
// auto path cannot pick such as 'auto'/'cinematic', an unknown class, another
// benchmark version): reporting success there would hide a re-benchmark on
// every boot.
export function saveGpuProfile(storage, profile) {
  if (!storage || !profile) return false
  if (typeof profile.key !== 'string' || !profile.key) return false
  if (!PRESET_ORDER_AUTO.includes(profile.preset) || !GPU_CLASSES.includes(profile.cls)) return false
  const benchVersion = profile.benchVersion ?? BENCH_VERSION
  if (benchVersion !== BENCH_VERSION) return false
  const out = {
    key: profile.key,
    score: Number.isFinite(profile.score) && profile.score > 0 ? profile.score : null,
    preset: profile.preset,
    cls: profile.cls,
    benchVersion,
    date: profile.date ?? Date.now(),
  }
  try {
    storage.setItem(GPU_PROFILE_KEY, JSON.stringify(out))
    return true
  } catch {
    return false
  }
}
