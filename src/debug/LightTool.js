import * as THREE from 'three'
import { section, slider, colorPicker, toggle, button, segmented, buttonRow, readout, textBlock } from './widgets.js'
import { formatTuning, copyText } from './tuningExport.js'
import { LOOK_ORDER, LOOK_PROFILES } from '../render/lookProfile.js'
import {
  PANEL_COLOR,
  AMBIENT_SKY,
  AMBIENT_GROUND,
  FOG_COLOR,
  FLASH_COLOR,
  OUTLINE_INK,
  RIM_COLOR,
  ENTITY_RIM,
  LIGHT_MAX,
} from '../world/constants.js'

// Names double as the status-line label (DebugMode) — keep them short.
// Index == the DEBUG_VIEW_FRAG uMode that blits that channel.
export const CHANNELS = [
  'final', 'albedo', 'matID', 'normal', 'depth', 'AO', 'lit', 'vol', 'bloom', 'comp', 'shadow',
  'rough', 'metal', 'matAO',
]
// Lighting-pass diagnostics (lighting.js uLightDebug), shown through 'lit'.
// 6 furniture visibility (red: cell cap hit), 7 world AO (crease x box x
// capsule), 8 flashlight visibility (chapter 14).
export const LIGHT_DEBUG = ['off', 'lists', 'grid', 'direct', 'indirect', 'traced', 'furniture', 'worldAO', 'torch']
const LIT_CHANNEL = CHANNELS.indexOf('lit')

// One tooltip per CHANNELS entry (same order).
export const CHANNEL_TIPS = [
  'Normal final image (all passes).',
  'G-buffer albedo (base color, unlit).',
  'G-buffer material ID as grey levels (0 / 0.5 / 1).',
  'G-buffer view-space normals.',
  'Linearized scene depth (near = dark).',
  'Ambient occlusion fed to the lighting pass (blurred SSAO, or the resolved occlusion on v2 looks).',
  'Lighting pass output before volumetrics, bloom and grade (also where the light-debug heatmaps show).',
  'Volumetric lamp/flashlight scattering buffer.',
  'Bloom buffer (the glow added in composite).',
  'Composite (lit + volumetrics + bloom) before outline and grade.',
  'Blurred lamp shadow / contact mask fed to the lighting pass (white = unshadowed).',
  'G-buffer roughness.',
  'G-buffer metalness.',
  'Material (baked) ambient occlusion channel.',
]

// One tooltip per LIGHT_DEBUG entry (same order). Any mode other than off
// also switches the channel viewer to 'lit'.
export const LIGHT_DEBUG_TIPS = [
  'Lighting diagnostics off (back to the final channel).',
  'Heatmap of lamps per world-grid cell list (blue few, red at the list cap).',
  'Green where the pixel is shaded by the world grid, red where it falls back.',
  'Direct lamp light only.',
  'Indirect only: ambient plus cell-graph bounce (GI) with AO.',
  'Traced (red) vs untraced (green) lamps per pixel.',
  'Furniture shadow visibility; red where the per-cell furniture cap was hit.',
  'World AO term (crease × box × capsule occluders).',
  'Flashlight visibility (torch shadow) term.',
]

// Tooltips for the uniform binders (_f/_fMulti/_fVec/_c), keyed by label.
// Every one writes a live renderer uniform: "reset all to defaults" restores
// it and nothing is saved (a reload also restores it).
export const LIGHT_TIPS = {
  'bounce (GI)': 'Strength of the cell-graph bounce light (look GI term), 0-3.',
  'ambient floor': 'Hemisphere ambient share: the minimum light in unlit areas, 0-2.',
  'lamp intensity': 'Brightness multiplier for every ceiling lamp, 0-6.',
  'lamp wrap': 'Half-Lambert wrap for lamp and flashlight N·L (0 = hard terminator, 1 = fully wrapped). Shared with the shadow pass.',
  'lamp range': 'Lamp falloff radius in world units; written to lighting, volumetrics and shadows together so they stay matched.',
  'lamp color': 'Ceiling-lamp light color (also tints volumetric shafts). Reset uses the active family palette.',
  'ambient sky': 'Hemisphere ambient color from above. Reset uses the active family palette.',
  'ambient ground': 'Hemisphere ambient color from below. Reset uses the active family palette.',
  rim: 'Strength of the world rim light, 0-1.',
  'rim color': 'World rim light color. Reset uses the active family palette.',
  'entity rim': 'Rim/ink color that keeps entities readable in the dark.',
  terminator: 'Strength of the painted light/shadow terminator edge (anime shading), 0-1.5.',
  bounce: 'One-bounce fill light from lit surfaces, 0-0.5.',
  'spec strength': 'Lamp specular highlight strength, 0-2.',
  'spec power': 'Lamp specular exponent (4-256): higher = tighter, glossier highlight.',
  'shadow thickness': 'Assumed occluder thickness for the lamp shadow march, in world units (0-3).',
  'shadow strength': 'How dark lamp shadows get: 0 = no shadows, 1 = full.',
  'shadow soften': 'Depth falloff of the bilateral shadow blur (higher = softer across depth edges).',
  'fog color': 'Distance fog color. Reset uses the active family palette.',
  'fog density': 'Exponential fog density (0-0.1). Also fades outlines.',
  'flash color': 'Flashlight light color.',
  'flash range': 'Flashlight reach in world units (1-80).',
  'flash intensity': 'Flashlight brightness (0-8).',
  'cos inner': 'Cosine of the flashlight hot-spot half-angle (closer to 1 = narrower bright core).',
  'cos outer': 'Cosine of the flashlight cone edge half-angle (closer to 1 = narrower beam). Keep below cos inner.',
  radius: 'SSAO sample radius in world units.',
  bias: 'SSAO depth bias; raise it to remove self-occlusion acne on flat surfaces.',
  intensity: 'SSAO darkening strength (0-4).',
  'vol density': 'Volumetric fog density lit by lamps and the flashlight.',
  'vol phase g': 'Henyey-Greenstein anisotropy: 0 scatters evenly, near 1 glows mostly when looking toward a light.',
  'vol max dist': 'Farthest distance the volumetric march covers, in world units.',
  'vol intensity': 'Volumetric scattering added in composite (0-3).',
  'bloom intensity': 'Tight bloom added in composite (0-4).',
  'bloom wide': 'Wide bloom veil added in composite (0-3).',
  'bloom threshold': 'Brightness above which pixels feed bloom.',
  'bloom surface': 'Weight of lit-surface excess vs emissives feeding bloom (0 = emissives only).',
  thickness: 'Outline width in pixels (0-5).',
  'depth thresh': 'Depth-edge sensitivity for outlines (lower = more lines).',
  'normal thresh': 'Normal-edge sensitivity for outlines (lower = more crease lines).',
  'fade near': 'Normalized depth where outlines start fading out.',
  'fade far': 'Normalized depth where outlines are fully gone.',
  'ink color': 'Flat outline ink color.',
  'ink tint': '0 = flat ink color, 1 = ink traced from the surface albedo.',
  'ink opacity': 'World outline strength (entity outlines stay at full).',
  exposure: 'Fixed grade exposure (0.2-2). No effect while the look uses auto exposure (see the exposure readout); a look or family change re-stamps it.',
  saturation: 'Grade saturation (0 = grey, 1 = neutral, 2 = double). A look or family change re-stamps it.',
  levels: 'Posterize steps per channel (2-64; higher = smoother; 0 from the look = off). A look change re-stamps it.',
  'shadow lift': 'Raises the blacks (0-0.1). A look change re-stamps it.',
  'tint R': 'Grade red multiplier (1 = neutral; scene-stage looks keep it at 1 and tint in white balance). A look or family change re-stamps it.',
  'tint G': 'Grade green multiplier (1 = neutral; scene-stage looks keep it at 1 and tint in white balance). A look or family change re-stamps it.',
  'tint B': 'Grade blue multiplier (1 = neutral; scene-stage looks keep it at 1 and tint in white balance). A look or family change re-stamps it.',
  vignette: 'Edge darkening (0-1). Needs freeze sim; the survival FX drive it every frame otherwise.',
  grain: 'Film grain amount (0-1). Needs freeze sim; the survival FX drive it every frame otherwise.',
  aberration: 'Chromatic aberration offset (0-0.02). Needs freeze sim; gameplay FX drive it otherwise.',
  'dead static': 'Blend toward full-screen signal-loss static (0-1). Needs freeze sim; the death FX drive it otherwise.',
}
const LIVE_NOTE = ' Live uniform, not saved: reset all or a reload restores it (a look or graphics change may re-stamp it).'
const tipFor = (label) => (LIGHT_TIPS[label] ? { title: label, text: LIGHT_TIPS[label] + LIVE_NOTE } : undefined)

// Pipeline order for the GPU pass-timing table (matches _pass names in
// DeferredRenderer.render).
const PASS_ORDER = [
  'gbuffer', 'flashShadow', 'ssao', 'shadow', 'gtao', 'contact', 'occResolve', 'lighting', 'exposure',
  'volumetric', 'bloom', 'composite', 'outline', 'motionBlur', 'grade', 'fxaa', 'signal',
]

// Lighting / post-processing tuning panel. Every control binds live to a public
// deferred uniform. Grade controls and the light room require the sim frozen
// (Engine._applyFX / LightField would otherwise overwrite the uniforms).
export class LightTool {
  constructor(engine, dbg) {
    this.engine = engine
    this.dbg = dbg
    this.d = engine.deferred
    this._reset = [] // reset-to-default closures
    this._export = [] // { label, get } pairs serialized by "copy values"
    this._build()
  }

  _build() {
    const root = document.createElement('div')
    this.el = root
    const d = this.d

    // --- Top: channel viewer + global toggles ---------------------------
    const top = section('view + sim')
    root.appendChild(top.el)
    this._chan = segmented({
      labels: CHANNELS,
      value: 0,
      tips: CHANNEL_TIPS.map((text, i) => ({ title: `channel: ${CHANNELS[i]}`, text })),
      ariaLabel: 'debug view channel',
      onPick: (i) => this.dbg.setChannel(i),
    })
    top.body.appendChild(this._chan.el)
    this._freeze = toggle({
      label: 'freeze sim (hold FX/lamps)',
      value: this.dbg.freeze,
      tip: { text: 'Pause the simulation so lamp flicker, FX and grade stop overwriting the uniforms you tune. Same flag as the AI tab live-observe.', keys: 'F3' },
      onChange: (v) => this.dbg.setFreeze(v),
    })
    top.body.appendChild(this._freeze.el)
    top.body.appendChild(
      toggle({
        label: 'flashlight force-on',
        value: false,
        tip: 'Set the player flashlight flag directly (the same one F toggles). The battery still drains while the sim runs and an empty battery switches it off; this box does not track later changes.',
        onChange: (v) => {
          this.engine.state.flashlightOn = v
          d.lightUniforms.uFlashOn.value = v ? 1 : 0
        },
      }).el
    )
    const copyBtn = button({
      label: 'copy values',
      tip: 'Copy every tuning slider and color on this tab to the clipboard as text, to paste into constants.',
      onClick: async () => {
        const ok = await copyText(
          formatTuning(this._export.map((e) => ({ label: e.label, value: e.get() })))
        )
        copyBtn.el.textContent = ok ? 'copied ✓' : 'copy failed'
        setTimeout(() => (copyBtn.el.textContent = 'copy values'), 1200)
      },
    })
    top.body.appendChild(
      buttonRow('', [
        button({
          label: 'reset all to defaults',
          tip: 'Restore every slider and color on this tab to the value it had when the panel was built (colors use the active family palette).',
          onClick: () => this._resetAll(),
        }),
        copyBtn,
      ]).el
    )

    // --- Engine: look profile, world-grid lighting, culling, evidence ----
    // (engine-improvement S1/S2/S6 + R0). The look selector goes through the
    // Settings store so the pause menu stays in sync.
    const en = section('engine: look + grid')
    root.appendChild(en.el)
    const lookIds = LOOK_ORDER
    this._look = segmented({
      labels: lookIds.map((id) => LOOK_PROFILES[id].label),
      value: Math.max(0, lookIds.indexOf(d.look?.id)),
      tips: lookIds.map((id) => ({
        title: `look: ${LOOK_PROFILES[id].label}`,
        text: 'Switch the renderer look profile. Same as the pause-menu Look setting and saved with settings; may briefly rebuild shaders.',
      })),
      ariaLabel: 'look profile',
      onPick: (i) => {
        this.engine._applySetting('look', lookIds[i])
        this.engine.ui?.refreshSettings?.()
      },
    })
    en.body.appendChild(this._look.el)
    this._gridToggle = toggle({
      label: 'world-grid lighting',
      value: d.gridEnabled,
      tip: 'Shade from the world light grid (per-cell lamp lists). Off falls back to the legacy per-pixel lamp set. Live renderer only.',
      onChange: (v) => d.setGridEnabled(v),
    })
    en.body.appendChild(this._gridToggle.el)
    this._cullToggle = toggle({
      label: 'sight culling (chunks)',
      value: !!this.engine.cm.sightCulling,
      tip: 'Hide same-floor chunks no straight sight line from the eye can reach (occlusion culling over wall edges).',
      onChange: (v) => this.engine.cm.enableSightCulling(v),
    })
    en.body.appendChild(this._cullToggle.el)
    this._flashShadow = toggle({
      label: 'flashlight shadow map',
      value: d.flashShadowEnabled,
      tip: 'Render the flashlight shadow (torch) map so the beam casts shadows. A graphics-settings change or closing debug mode re-stamps it from the quality tier.',
      onChange: (v) => (d.flashShadowEnabled = v),
    })
    en.body.appendChild(this._flashShadow.el)
    this._analyticTorch = toggle({
      label: 'analytic torch shadows (P18)',
      value: !!d.analyticTorchDebug,
      tip: 'Force analytic flashlight shadows (needs the flashlight shadow map and a PBR look). Rebuilds the lighting shader.',
      onChange: (v) => d.setAnalyticTorch(v),
    })
    en.body.appendChild(this._analyticTorch.el)
    this._lightDebug = segmented({
      labels: LIGHT_DEBUG,
      value: 0,
      tips: LIGHT_DEBUG_TIPS.map((text, i) => ({ title: `light debug: ${LIGHT_DEBUG[i]}`, text })),
      ariaLabel: 'lighting diagnostics',
      onPick: (i) => {
        d.setLightDebug(i)
        this.dbg.setChannel(i ? LIT_CHANNEL : 0)
      },
    })
    en.body.appendChild(this._lightDebug.el)
    this._f(en, 'bounce (GI)', d.lightUniforms.uGI, 0, 3, 0.05)
    this._f(en, 'ambient floor', d.lightUniforms.uHemi, 0, 2, 0.05)
    this._gridStats = readout('grid lists / pending')
    en.body.appendChild(this._gridStats.el)
    this._pairStats = readout('pairs clear/sampled/blocked')
    en.body.appendChild(this._pairStats.el)
    this._cullStats = readout('chunks drawn / resident')
    en.body.appendChild(this._cullStats.el)
    this._exposure = readout('exposure (auto)')
    en.body.appendChild(this._exposure.el)
    this._variant = readout('lighting variant')
    en.body.appendChild(this._variant.el)
    this._tiers = readout('tiers shadow/torch/ao/vol')
    en.body.appendChild(this._tiers.el)
    this._torch = readout('torch map renders / skips')
    en.body.appendChild(this._torch.el)
    this._drs = readout('resolution scale (DRS)')
    en.body.appendChild(this._drs.el)
    const capBtn = button({
      label: 'copy capture',
      tip: 'Copy a JSON capture of the current state (family/seed/level, camera pose, time, graphics settings) that can be replayed for bug reports.',
      onClick: async () => {
        const ok = await copyText(JSON.stringify(this.engine.capture(), null, 2))
        capBtn.el.textContent = ok ? 'copied ✓' : 'copy failed'
        setTimeout(() => (capBtn.el.textContent = 'copy capture'), 1200)
      },
    })
    const timeBtn = button({
      label: 'copy timings',
      tip: 'Copy capture + GPU capabilities + per-pass GPU timings + draw calls/triangles as JSON. Turn on gpu pass timings first for timing data.',
      onClick: async () => {
        const report = {
          capture: this.engine.capture(),
          capabilities: this.engine.capabilities,
          timings: d.timer?.export() ?? null,
          renderer: {
            calls: this.engine.renderer.info.render.calls,
            triangles: this.engine.renderer.info.render.triangles,
          },
        }
        const ok = await copyText(JSON.stringify(report, null, 2))
        timeBtn.el.textContent = ok ? 'copied ✓' : 'copy failed'
        setTimeout(() => (timeBtn.el.textContent = 'copy timings'), 1200)
      },
    })
    const setBtn = button({
      label: 'run shadow set',
      tip: 'Load the Office seed "engine-improvement" (level 1, enemies removed), replay the fixed evidence poses, read back probes and pass timings, and copy the JSON report. Leaves you in that world at the last pose and turns gpu pass timings off.',
      onClick: async () => {
        setBtn.el.textContent = 'running…'
        try {
          const report = await this.engine.runShadowSet()
          const ok = await copyText(JSON.stringify(report, null, 2))
          setBtn.el.textContent = ok ? 'copied ✓' : 'copy failed'
        } catch {
          setBtn.el.textContent = 'failed'
        }
        setTimeout(() => (setBtn.el.textContent = 'run shadow set'), 1500)
      },
    })
    en.body.appendChild(buttonRow('evidence', [capBtn, timeBtn, setBtn]).el)
    this._expT = 0

    // --- Pipeline: light-field readouts, pass isolation, GPU timings ----
    // The pass toggles poke the live enable flags directly (bypassing the
    // graphics settings), so a pass can be isolated while tuning; any settings
    // change re-stamps them from the stored quality (Engine._applyGraphics).
    const pp = section('pipeline')
    root.appendChild(pp.el)
    this._lampCount = readout('lamps visible / loaded')
    pp.body.appendChild(this._lampCount.el)
    this._shadowBudget = readout('shadow march / vol lamps')
    pp.body.appendChild(this._shadowBudget.el)
    this._passToggles = []
    const passToggle = (label, key, what) => {
      const w = toggle({
        label,
        value: d[key],
        tip: `Enable the ${what}. Isolation only: a graphics-settings change or closing debug mode re-stamps it from the stored quality.`,
        onChange: (v) => (d[key] = v),
      })
      this._passToggles.push({ w, key })
      pp.body.appendChild(w.el)
    }
    passToggle('ssao pass', 'aoEnabled', 'screen-space ambient occlusion pass')
    passToggle('shadow pass', 'shadowEnabled', 'lamp shadow march pass')
    passToggle('volumetric pass', 'volEnabled', 'volumetric scattering pass')
    passToggle('bloom pass', 'bloomEnabled', 'bloom pass')
    passToggle('fxaa pass', 'fxaaEnabled', 'FXAA anti-aliasing pass')
    this._timing = toggle({
      label: 'gpu pass timings',
      value: false,
      tip: 'Measure per-pass GPU time (needs EXT_disjoint_timer_query_webgl2) and list it below. Turned off when debug mode closes.',
      onChange: (v) => {
        const ok = d.setTiming(v)
        if (v && !ok) {
          this._timing.set(false)
          this._passTimes.set('EXT_disjoint_timer_query_webgl2 unavailable')
        } else if (!v) this._passTimes.set('')
      },
    })
    pp.body.appendChild(this._timing.el)
    this._passTimes = textBlock()
    pp.body.appendChild(this._passTimes.el)

    // --- Light room -----------------------------------------------------
    const lr = section('light room')
    root.appendChild(lr.el)
    lr.body.appendChild(
      toggle({
        label: 'enter isolated room',
        value: false,
        tip: 'Swap the view to a standalone test room with its own lamps and orbit camera (drag to orbit, wheel to zoom). Freezes the sim; gameplay lighting is restored on exit.',
        onChange: (v) => this.dbg.enterLightRoom(v),
      }).el
    )
    const cfg = this.dbg.lightRoomCfg
    lr.body.appendChild(
      slider({
        label: 'lamp count',
        min: 1,
        max: 48,
        step: 1,
        value: cfg.count,
        fmt: 0,
        tip: 'Number of lamps in the light room (1-48). Rebuilds its fixtures.',
        onInput: (v) => ((cfg.count = v), this.dbg.refreshLightRoomLamps()),
      }).el
    )
    lr.body.appendChild(
      slider({
        label: 'spacing',
        min: 1,
        max: 10,
        step: 0.5,
        value: cfg.spacing,
        fmt: 1,
        tip: 'Distance between light-room lamps in world units (1-10). Rebuilds its fixtures.',
        onInput: (v) => ((cfg.spacing = v), this.dbg.refreshLightRoomLamps()),
      }).el
    )
    lr.body.appendChild(
      slider({
        label: 'intensity',
        min: 0,
        max: 6,
        step: 0.05,
        value: cfg.intensity,
        tip: 'Lamp intensity inside the light room only (0-6); gameplay lamp intensity is restored on exit.',
        onInput: (v) => (cfg.intensity = v),
      }).el
    )
    lr.body.appendChild(toggle({
        label: 'orbit animate',
        value: false,
        tip: 'Slowly auto-orbit the light-room camera.',
        onChange: (v) => (cfg.animate = v),
      }).el)
    lr.body.appendChild(
      toggle({
        label: 'standard PBR reference (A/B)',
        value: false,
        tip: 'Show the light room rendered with stock three.js MeshStandardMaterial (same camera, lamps, exposure) to A/B the deferred shading.',
        onChange: (v) => this.dbg.setLightRoomReference(v),
      }).el
    )

    // --- Lighting -------------------------------------------------------
    const L = d.lightUniforms
    const V = d.volUniforms
    const S = d.shadowUniforms
    const lit = section('lighting')
    root.appendChild(lit.el)
    this._f(lit, 'lamp intensity', L.uLampIntensity, 0, 6, 0.05)
    // wrap + range feed lighting, volumetrics AND the shadow weight, so edit all
    // so the shadow mask stays contribution-matched to the lit pass while tuning.
    this._f(lit, 'lamp wrap', L.uLampWrap, 0, 1, 0.01) // shadow pass shares it
    this._fMulti(lit, 'lamp range', [L.uLampRange, V.uLampRange, S.uLampRange], 1, 40, 0.5, 1)
    this._c(lit, 'lamp color', [L.uLampColor], PANEL_COLOR, 'panel') // volumetrics share it
    this._c(lit, 'ambient sky', [L.uAmbSky], AMBIENT_SKY, 'ambientSky')
    this._c(lit, 'ambient ground', [L.uAmbGround], AMBIENT_GROUND, 'ambientGround')
    this._f(lit, 'rim', L.uRim, 0, 1, 0.01)
    this._c(lit, 'rim color', [L.uRimColor], RIM_COLOR, 'rim')
    this._c(lit, 'entity rim', [L.uEntityRim], ENTITY_RIM)
    // Semi-realistic anime terms (lighting.js): painted terminator edge,
    // one-bounce fill and the gloss-scaled lamp highlight.
    this._f(lit, 'terminator', L.uTermStrength, 0, 1.5, 0.01)
    this._f(lit, 'bounce', L.uBounce, 0, 0.5, 0.005, 3)
    this._f(lit, 'spec strength', L.uSpecStrength, 0, 2, 0.01)
    this._f(lit, 'spec power', L.uSpecPower, 4, 256, 1, 0)
    this._f(lit, 'shadow thickness', S.uShadowThickness, 0, 3, 0.05)
    this._f(lit, 'shadow strength', L.uShadowStrength, 0, 1, 0.01)
    this._f(lit, 'shadow soften', d.shadowBlurUniforms.uDepthSigma, 0.05, 2, 0.01)
    this._c(lit, 'fog color', [L.uFogColor], FOG_COLOR, 'fog')
    this._f(lit, 'fog density', L.uFogDensity, 0, 0.1, 0.001, 3)

    // --- Flashlight -----------------------------------------------------
    const fl = section('flashlight')
    root.appendChild(fl.el)
    this._c(fl, 'flash color', [L.uFlashColor], FLASH_COLOR)
    this._f(fl, 'flash range', L.uFlashRange, 1, 80, 1, 0)
    this._f(fl, 'flash intensity', L.uFlashIntensity, 0, 8, 0.1, 1)
    this._f(fl, 'cos inner', L.uFlashCosInner, 0.5, 1, 0.005, 3)
    this._f(fl, 'cos outer', L.uFlashCosOuter, 0.5, 1, 0.005, 3)

    // --- SSAO -----------------------------------------------------------
    const ao = section('ssao')
    root.appendChild(ao.el)
    this._f(ao, 'radius', d.aoUniforms.uRadius, 0.05, 3, 0.05)
    this._f(ao, 'bias', d.aoUniforms.uBias, 0, 0.2, 0.001, 3)
    this._f(ao, 'intensity', d.aoUniforms.uIntensity, 0, 4, 0.05)

    // --- Volumetrics / Bloom -------------------------------------------
    const vb = section('volumetrics + bloom')
    root.appendChild(vb.el)
    this._f(vb, 'vol density', V.uDensity, 0, 0.4, 0.005, 3)
    this._f(vb, 'vol phase g', V.uPhaseG, 0, 0.95, 0.01)
    this._f(vb, 'vol max dist', V.uMaxDist, 5, 120, 1, 0)
    this._f(vb, 'vol intensity', d.compositeUniforms.uVolIntensity, 0, 3, 0.05)
    this._f(vb, 'bloom intensity', d.compositeUniforms.uBloomIntensity, 0, 4, 0.05)
    this._f(vb, 'bloom wide', d.compositeUniforms.uBloomWide, 0, 3, 0.05)
    this._f(vb, 'bloom threshold', d.bloomPreUniforms.uThreshold, 0, 4, 0.05)
    this._f(vb, 'bloom surface', d.bloomPreUniforms.uSurface, 0, 1, 0.01)

    // --- Outline --------------------------------------------------------
    const ol = section('outline')
    root.appendChild(ol.el)
    ol.body.appendChild(
      toggle({
        label: 'enabled',
        value: d.outlineEnabled,
        tip: 'Draw the ink outline pass. Restored to its previous state when debug mode closes.',
        onChange: (v) => d.setOutline(v),
      }).el
    )
    const O = d.outlineUniforms
    this._f(ol, 'thickness', O.uThickness, 0, 5, 0.1)
    this._f(ol, 'depth thresh', O.uDepthThresh, 0, 0.05, 0.001, 3)
    this._f(ol, 'normal thresh', O.uNormalThresh, 0, 2, 0.01)
    this._f(ol, 'fade near', O.uFadeNear, 0, 1, 0.005, 3)
    this._f(ol, 'fade far', O.uFadeFar, 0, 1, 0.005, 3)
    this._c(ol, 'ink color', [O.uInk], OUTLINE_INK)
    this._f(ol, 'ink tint', O.uInkTint, 0, 1, 0.01)
    this._f(ol, 'ink opacity', O.uInkOpacity, 0, 1, 0.01)

    // --- Grade (needs freeze) ------------------------------------------
    const gr = section('grade (freeze sim)')
    root.appendChild(gr.el)
    const G = d.grade
    this._f(gr, 'exposure', G.exposure, 0.2, 2, 0.01)
    this._f(gr, 'saturation', G.sat, 0, 2, 0.01)
    this._f(gr, 'levels', G.levels, 2, 64, 1, 0)
    this._f(gr, 'shadow lift', G.lift, 0, 0.1, 0.001, 3)
    this._fVec(gr, 'tint R', G.tint.value, 'x', 0, 2, 0.01)
    this._fVec(gr, 'tint G', G.tint.value, 'y', 0, 2, 0.01)
    this._fVec(gr, 'tint B', G.tint.value, 'z', 0, 2, 0.01)
    this._f(gr, 'vignette', G.vignette, 0, 1, 0.01)
    this._f(gr, 'grain', G.grain, 0, 1, 0.005, 3)
    this._f(gr, 'aberration', G.aberration, 0, 0.02, 0.0005, 4)
    this._f(gr, 'dead static', G.dead, 0, 1, 0.01)
  }

  // --- binders --------------------------------------------------------
  // Each binder also registers an export getter so "copy values" can dump the
  // live tuning without a parallel hand-maintained list of uniforms.
  _f(sec, label, u, min, max, step, fmt = 2) {
    const def = u.value
    const w = slider({ label, min, max, step, value: def, fmt, tip: tipFor(label), onInput: (v) => (u.value = v) })
    sec.body.appendChild(w.el)
    this._reset.push(() => ((u.value = def), w.set(def)))
    this._export.push({ label, get: () => u.value })
  }

  _fMulti(sec, label, us, min, max, step, fmt = 2) {
    const def = us[0].value
    const w = slider({
      label,
      min,
      max,
      step,
      value: def,
      fmt,
      tip: tipFor(label),
      onInput: (v) => us.forEach((u) => (u.value = v)),
    })
    sec.body.appendChild(w.el)
    this._reset.push(() => (us.forEach((u) => (u.value = def)), w.set(def)))
    this._export.push({ label, get: () => us[0].value })
  }

  _fVec(sec, label, vec, comp, min, max, step, fmt = 2) {
    const def = vec[comp]
    const w = slider({ label, min, max, step, value: def, fmt, tip: tipFor(label), onInput: (v) => (vec[comp] = v) })
    sec.body.appendChild(w.el)
    this._reset.push(() => ((vec[comp] = def), w.set(def)))
    this._export.push({ label, get: () => vec[comp] })
  }

  // `def` is the palette key whose ACTIVE family value is the default (reset
  // must not stamp Office colors over a sewer run); `fallback` covers a
  // renderer that has not received a palette yet.
  _c(sec, label, us, fallback, def) {
    const defHex = () => this.d.palette?.[def] ?? fallback
    const w = colorPicker({ label, value: defHex(), tip: tipFor(label), onInput: (h) => this._setColors(us, h) })
    sec.body.appendChild(w.el)
    this._reset.push(() => {
      const hex = defHex()
      this._setColors(us, hex)
      w.set(hex)
    })
    this._export.push({ label, get: () => '#' + us[0].value.getHexString() })
  }

  _setColors(us, hex) {
    // Single sRGB -> linear decode (ColorManagement does it in the constructor);
    // matches linVec/lin so picker edits land in the same space as the defaults.
    for (const u of us) u.value.copy(new THREE.Color(hex))
  }

  _resetAll() {
    for (const r of this._reset) r()
  }

  // Keep the freeze checkbox + channel strip in sync with changes made
  // elsewhere (the F3 hotkey, the AI tab's live-observe toggle), and refresh
  // the live pipeline readouts.
  update() {
    this._freeze.set(this.dbg.freeze)
    this._chan.set(this.dbg.channel)
    const d = this.d
    // A cutoff below LAMP_QUERY_R means the LIGHT_MAX cap is binding and the
    // edge fade has moved inward with it — the readout makes that visible.
    const cut = d.lamps.cutoffR
    this._lampCount.set(
      `${d.visibleLamps.uLampCount.value} / ${d.lamps.uLampCount.value} (max ${LIGHT_MAX})` +
        ` @ ${Number.isFinite(cut) ? cut.toFixed(1) : '∞'}u`
    )
    this._shadowBudget.set(
      `${d.shadowUniforms.uMaxLamps.value} × ${d.shadowUniforms.uSteps.value} steps / ` +
        `${d.volUniforms.uMaxLights.value} × ${d.volUniforms.uSteps.value} steps`
    )
    // Engine section readouts.
    const grid = this.engine.cm.lightGrid
    const st = grid.stats
    this._gridStats.set(`${st.listCells} cells · ${grid.pending} jobs`)
    this._pairStats.set(`${st.clearPairs} / ${st.sampledPairs} / ${st.blockedPairs}`)
    const chunks = [...this.engine.cm.chunks.values()]
    const drawn = chunks.filter((c) => c.group.visible).length
    const sc = this.engine.cm.sightCulling
    this._cullStats.set(`${drawn} / ${chunks.length}${sc ? ` · flood ${sc.stats.ms.toFixed(2)} ms` : ''}`)
    this._look.set(Math.max(0, LOOK_ORDER.indexOf(d.look?.id)))
    const v = d.variant
    if (v) {
      const on = Object.entries(v).filter(([, x]) => x === true).map(([k]) => k)
      this._variant.set(`${on.join(' ')}${v.flashFilter ? ` · torch filter ${v.flashFilter}` : ''}`)
    }
    const q = d.quality
    if (q) this._tiers.set(`${q.shadow.tier} / ${q.flash?.tier ?? '-'} / ${q.ao.tier} / ${q.vol.tier}${q.cinematic ? ' · cinematic' : ''}`)
    const fs = d.flashShadow.stats
    this._torch.set(`${fs.renders} / ${fs.skips}`)
    const drs = this.engine._drs
    this._drs.set(drs ? `${drs.scale.toFixed(2)} (floor ${drs.floor.toFixed(2)}, ${drs.mode})` : 'off')
    this._gridToggle.set(d.gridEnabled)
    this._cullToggle.set(!!sc)
    this._flashShadow.set(d.flashShadowEnabled)
    // A 1x1 read-back stalls the pipeline; sample it twice a second only.
    const now = performance.now()
    if (d.gradeUniforms.autoExposure.value > 0.5 && now - this._expT > 500 && d.exposure) {
      this._expT = now
      try {
        const buf = new Float32Array(4)
        const rt = d.exposure.adaptRTs[d.exposure._ping]
        this.engine.renderer.readRenderTargetPixels(rt, 0, 0, 1, 1, buf)
        this._exposure.set(`${buf[0].toFixed(3)} (target ${buf[2].toFixed(3)}, log2 L ${buf[3].toFixed(2)})`)
      } catch {
        this._exposure.set('n/a')
      }
    } else if (d.gradeUniforms.autoExposure.value <= 0.5) {
      this._exposure.set(`fixed ${d.gradeUniforms.exposure.value.toFixed(3)}`)
    }

    // Settings changes re-stamp the enable flags behind our back — mirror them
    // (and DebugMode.deactivate turns GPU timing off when the panel closes).
    for (const { w, key } of this._passToggles) w.set(d[key])
    this._timing.set(d.timingEnabled)
    if (d.timingEnabled && d.timer) {
      const lines = []
      let total = 0
      for (const name of PASS_ORDER) {
        const ms = d.timer.results.get(name)
        if (ms === undefined) continue
        total += ms
        lines.push(`${name.padEnd(10)} ${ms.toFixed(2)} ms`)
      }
      if (lines.length) lines.push(`${'total'.padEnd(10)} ${total.toFixed(2)} ms`)
      this._passTimes.set(lines)
    }
  }

  onShow() {}

  dispose() {}
}
