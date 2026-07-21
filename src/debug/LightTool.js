import * as THREE from 'three'
import { section, slider, colorPicker, toggle, button, segmented, buttonRow, readout, textBlock } from './widgets.js'
import { formatTuning, copyText } from './tuningExport.js'
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
export const CHANNELS = ['final', 'albedo', 'matID', 'normal', 'depth', 'AO', 'lit', 'vol', 'bloom', 'comp', 'shadow']

// Pipeline order for the GPU pass-timing table (matches _pass names in
// DeferredRenderer.render).
const PASS_ORDER = ['gbuffer', 'ssao', 'shadow', 'lighting', 'volumetric', 'bloom', 'composite', 'outline', 'grade', 'fxaa']

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
    this._chan = segmented({ labels: CHANNELS, value: 0, onPick: (i) => this.dbg.setChannel(i) })
    top.body.appendChild(this._chan.el)
    this._freeze = toggle({
      label: 'freeze sim (hold FX/lamps)',
      value: this.dbg.freeze,
      onChange: (v) => this.dbg.setFreeze(v),
    })
    top.body.appendChild(this._freeze.el)
    top.body.appendChild(
      toggle({
        label: 'flashlight force-on',
        value: false,
        onChange: (v) => {
          this.engine.state.flashlightOn = v
          d.lightUniforms.uFlashOn.value = v ? 1 : 0
        },
      }).el
    )
    const copyBtn = button({
      label: 'copy values',
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
        button({ label: 'reset all to defaults', onClick: () => this._resetAll() }),
        copyBtn,
      ]).el
    )

    // --- Pipeline: light-field readouts, pass isolation, GPU timings ----
    // The pass toggles poke the live enable flags directly (bypassing the
    // graphics settings), so a pass can be isolated while tuning; any settings
    // change re-stamps them from the stored quality (Engine._applyGraphics).
    const pp = section('pipeline')
    root.appendChild(pp.el)
    this._lampCount = readout('active lamps')
    pp.body.appendChild(this._lampCount.el)
    this._shadowBudget = readout('shadow march / vol lamps')
    pp.body.appendChild(this._shadowBudget.el)
    this._passToggles = []
    const passToggle = (label, key) => {
      const w = toggle({ label, value: d[key], onChange: (v) => (d[key] = v) })
      this._passToggles.push({ w, key })
      pp.body.appendChild(w.el)
    }
    passToggle('ssao pass', 'aoEnabled')
    passToggle('shadow pass', 'shadowEnabled')
    passToggle('volumetric pass', 'volEnabled')
    passToggle('bloom pass', 'bloomEnabled')
    passToggle('fxaa pass', 'fxaaEnabled')
    this._timing = toggle({
      label: 'gpu pass timings',
      value: false,
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
      toggle({ label: 'enter isolated room', value: false, onChange: (v) => this.dbg.enterLightRoom(v) }).el
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
        onInput: (v) => ((cfg.spacing = v), this.dbg.refreshLightRoomLamps()),
      }).el
    )
    lr.body.appendChild(
      slider({ label: 'intensity', min: 0, max: 6, step: 0.05, value: cfg.intensity, onInput: (v) => (cfg.intensity = v) }).el
    )
    lr.body.appendChild(toggle({ label: 'orbit animate', value: false, onChange: (v) => (cfg.animate = v) }).el)

    // --- Lighting -------------------------------------------------------
    const L = d.lightUniforms
    const V = d.volUniforms
    const S = d.shadowUniforms
    const lit = section('lighting')
    root.appendChild(lit.el)
    this._f(lit, 'lamp intensity', L.uLampIntensity, 0, 6, 0.05)
    // wrap + range feed lighting, volumetrics AND the shadow weight, so edit all
    // so the shadow mask stays contribution-matched to the lit pass while tuning.
    this._fMulti(lit, 'lamp wrap', [L.uLampWrap, S.uLampWrap], 0, 1, 0.01)
    this._fMulti(lit, 'lamp range', [L.uLampRange, V.uLampRange, S.uLampRange], 1, 40, 0.5, 1)
    this._c(lit, 'lamp color', [L.uLampColor, V.uLampColor], PANEL_COLOR)
    this._c(lit, 'ambient sky', [L.uAmbSky], AMBIENT_SKY)
    this._c(lit, 'ambient ground', [L.uAmbGround], AMBIENT_GROUND)
    this._f(lit, 'rim', L.uRim, 0, 1, 0.01)
    this._c(lit, 'rim color', [L.uRimColor], RIM_COLOR)
    this._c(lit, 'entity rim', [L.uEntityRim], ENTITY_RIM)
    this._f(lit, 'shadow thickness', S.uShadowThickness, 0, 3, 0.05)
    this._f(lit, 'shadow strength', L.uShadowStrength, 0, 1, 0.01)
    this._f(lit, 'shadow soften', d.shadowBlurUniforms.uDepthSigma, 0.05, 2, 0.01)
    this._c(lit, 'fog color', [L.uFogColor], FOG_COLOR)
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

    // --- Outline --------------------------------------------------------
    const ol = section('outline')
    root.appendChild(ol.el)
    ol.body.appendChild(
      toggle({ label: 'enabled', value: d.outlineEnabled, onChange: (v) => d.setOutline(v) }).el
    )
    const O = d.outlineUniforms
    this._f(ol, 'thickness', O.uThickness, 0, 5, 0.1)
    this._f(ol, 'depth thresh', O.uDepthThresh, 0, 0.05, 0.001, 3)
    this._f(ol, 'normal thresh', O.uNormalThresh, 0, 2, 0.01)
    this._f(ol, 'fade near', O.uFadeNear, 0, 1, 0.005, 3)
    this._f(ol, 'fade far', O.uFadeFar, 0, 1, 0.005, 3)
    this._c(ol, 'ink color', [O.uInk], OUTLINE_INK)

    // --- Grade (needs freeze) ------------------------------------------
    const gr = section('grade (freeze sim)')
    root.appendChild(gr.el)
    const G = d.grade
    this._f(gr, 'exposure', G.exposure, 0.2, 2, 0.01)
    this._f(gr, 'saturation', G.sat, 0, 2, 0.01)
    this._f(gr, 'levels', G.levels, 2, 32, 1, 0)
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
    const w = slider({ label, min, max, step, value: def, fmt, onInput: (v) => (u.value = v) })
    sec.body.appendChild(w.el)
    this._reset.push(() => ((u.value = def), w.set(def)))
    this._export.push({ label, get: () => u.value })
  }

  _fMulti(sec, label, us, min, max, step, fmt = 2) {
    const def = us[0].value
    const w = slider({ label, min, max, step, value: def, fmt, onInput: (v) => us.forEach((u) => (u.value = v)) })
    sec.body.appendChild(w.el)
    this._reset.push(() => (us.forEach((u) => (u.value = def)), w.set(def)))
    this._export.push({ label, get: () => us[0].value })
  }

  _fVec(sec, label, vec, comp, min, max, step, fmt = 2) {
    const def = vec[comp]
    const w = slider({ label, min, max, step, value: def, fmt, onInput: (v) => (vec[comp] = v) })
    sec.body.appendChild(w.el)
    this._reset.push(() => ((vec[comp] = def), w.set(def)))
    this._export.push({ label, get: () => vec[comp] })
  }

  _c(sec, label, us, defHex) {
    const w = colorPicker({ label, value: defHex, onInput: (h) => this._setColors(us, h) })
    sec.body.appendChild(w.el)
    this._reset.push(() => (this._setColors(us, defHex), w.set(defHex)))
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
    this._lampCount.set(`${d.lamps.uLampCount.value} / ${LIGHT_MAX}`)
    this._shadowBudget.set(
      `${d.shadowUniforms.uMaxLamps.value} × ${d.shadowUniforms.uSteps.value} steps / ` +
        `${d.volUniforms.uMaxLights.value} × ${d.volUniforms.uSteps.value} steps`
    )
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
