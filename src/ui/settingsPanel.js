import { NOISE_MODES, SENS_DEFAULT, SENS_MAX, SENS_MIN } from '../core/Settings.js'
import {
  PRESET_ORDER,
  TIER_ORDER,
  WORLD_DETAIL_ORDER,
} from '../core/graphics.js'

// The settings block lives on BOTH the title and pause cards, so it hooks into
// each card via data-k attributes (ids must stay unique); the UI collects one
// SettingsBlock per card and refresh() keeps them in lockstep.

// The sensitivity slider works in multiples of the default (×0.25 … ×3.00);
// only the Settings store ever sees raw radians-per-pixel.
const SENS_MULT_MIN = +(SENS_MIN / SENS_DEFAULT).toFixed(2)
const SENS_MULT_MAX = +(SENS_MAX / SENS_DEFAULT).toFixed(2)

// Graphics preset + per-feature tier pickers (labels shown uppercase).
const presetOpts = [...PRESET_ORDER, 'custom']
  .map((p) => `<option value="${p}">${p.toUpperCase()}</option>`)
  .join('')
const tierOpts = TIER_ORDER.map((t) => `<option value="${t}">${t.toUpperCase()}</option>`).join('')
const worldDetailOpts = WORLD_DETAIL_ORDER
  .map((t) => `<option value="${t}">${t.toUpperCase()}</option>`)
  .join('')
const noiseOpts = NOISE_MODES.map((n) => `<option value="${n}">${n.toUpperCase()}</option>`).join('')

// Simple view: the three knobs a player actually reaches for. Every other
// prop lives in the collapsed ADVANCED section so both cards stay short —
// nothing is removed, just one click deeper.
export const SETTINGS_HTML = `
  <div class="group">LOOK</div>
  <label>SENSITIVITY <span class="ctl">
    <input type="range" data-k="sens" min="${SENS_MULT_MIN}" max="${SENS_MULT_MAX}" step="0.05">
    <output class="val" data-k="sensVal"></output>
  </span></label>
  <div class="group">AUDIO</div>
  <label>VOLUME <span class="ctl">
    <input type="range" data-k="vol" min="0" max="1" step="0.02">
    <output class="val" data-k="volVal"></output>
  </span></label>
  <div class="group">GRAPHICS</div>
  <label>QUALITY PRESET <select data-k="preset">${presetOpts}</select></label>
  <button type="button" class="adv-toggle" data-k="advToggle" aria-expanded="false">
    ADVANCED SETTINGS <span class="caret" aria-hidden="true">▾</span>
  </button>
  <div class="adv hidden" data-k="adv">
    <div class="group">LOOK</div>
    <label>INVERT Y <input type="checkbox" data-k="invY"></label>
    <label>INVERT X <input type="checkbox" data-k="invX"></label>
    <div class="group">GRAPHICS TUNING</div>
    <label>RENDER SCALE <span class="ctl">
      <input type="range" data-k="rscale" min="0.5" max="1" step="0.05">
      <output class="val" data-k="rscaleVal"></output>
    </span></label>
    <label>WORLD DETAIL <select data-k="worldDetail">${worldDetailOpts}</select></label>
    <label>AMBIENT OCCLUSION <select data-k="ao">${tierOpts}</select></label>
    <label>LAMP SHADOWS <select data-k="shadow">${tierOpts}</select></label>
    <label>LIGHT SHAFTS <select data-k="volq">${tierOpts}</select></label>
    <label>BLOOM <input type="checkbox" data-k="bloom"></label>
    <label>ANTI-ALIASING (FXAA) <input type="checkbox" data-k="fxaa"></label>
    <div class="group">DISPLAY</div>
    <label>HEAD BOB <input type="checkbox" data-k="bob"></label>
    <label>CAMERA FX <input type="checkbox" data-k="camfx"></label>
    <label>NOISE <select data-k="noise">${noiseOpts}</select></label>
    <label>INK OUTLINE <input type="checkbox" data-k="out"></label>
    <label>MINIMAP <input type="checkbox" data-k="map"></label>
    <button type="button" class="ghost adv-reset" data-k="reset">RESET DEFAULTS</button>
  </div>`

// Declarative wiring: [data-k, event, Settings key, read]. Every change
// round-trips through the Settings store (which clamps/coerces), then the UI
// re-syncs BOTH cards from the truth so they can never show stale values.
// The graphics preset/pinning dance (preset -> rewrites advanced keys, any
// advanced edit -> preset flips to 'custom') lives in the Engine; this block
// only reports raw edits.
const WIRE = [
  // The slider is in multiples of the default; the store keeps radians/px.
  ['sens', 'input', 'sensitivity', (el) => parseFloat(el.value) * SENS_DEFAULT],
  ['vol', 'input', 'volume', (el) => parseFloat(el.value)],
  ['invY', 'change', 'invertY', (el) => el.checked],
  ['invX', 'change', 'invertX', (el) => el.checked],
  ['preset', 'change', 'preset', (el) => el.value],
  ['rscale', 'input', 'renderScale', (el) => parseFloat(el.value)],
  ['worldDetail', 'change', 'worldDetail', (el) => el.value],
  ['ao', 'change', 'aoQuality', (el) => el.value],
  ['shadow', 'change', 'shadowQuality', (el) => el.value],
  ['volq', 'change', 'volQuality', (el) => el.value],
  ['bloom', 'change', 'bloom', (el) => el.checked],
  ['fxaa', 'change', 'fxaa', (el) => el.checked],
  ['bob', 'change', 'bob', (el) => el.checked],
  ['camfx', 'change', 'cameraFx', (el) => el.checked],
  ['noise', 'change', 'noise', (el) => el.value],
  ['out', 'change', 'outline', (el) => el.checked],
  ['map', 'change', 'minimap', (el) => el.checked],
]

// One wired settings card. `onSetting(key, value)` reports a raw edit and
// `onReset()` the RESET DEFAULTS button; the host re-calls refresh() with the
// store after either so the widgets always show the clamped truth.
export class SettingsBlock {
  constructor(rootEl, { onSetting, onReset }) {
    this.el = {}
    for (const el of rootEl.querySelectorAll('[data-k]')) this.el[el.dataset.k] = el
    for (const [k, evt, setting, read] of WIRE) {
      this.el[k].addEventListener(evt, () => onSetting(setting, read(this.el[k])))
    }
    this.el.advToggle.addEventListener('click', () => this.toggleAdvanced())
    this.el.reset.addEventListener('click', () => onReset?.())
  }

  toggleAdvanced() {
    const open = !this.el.adv.classList.toggle('hidden')
    this.el.advToggle.setAttribute('aria-expanded', String(open))
  }

  // Pull every control back from the store. Also the way anything that changes
  // a setting outside this panel (the M key, RESET DEFAULTS) re-syncs widgets.
  refresh(s) {
    const mult = s.get('sensitivity') / SENS_DEFAULT
    this.el.sens.value = mult
    this.el.sensVal.value = `×${mult.toFixed(2)}`
    this.el.vol.value = s.get('volume')
    this.el.volVal.value = `${Math.round(s.get('volume') * 100)}%`
    this.el.invY.checked = s.get('invertY')
    this.el.invX.checked = s.get('invertX')
    this.el.preset.value = s.get('preset')
    this.el.rscale.value = s.get('renderScale')
    this.el.rscaleVal.value = `${Math.round(s.get('renderScale') * 100)}%`
    this.el.worldDetail.value = s.get('worldDetail')
    this.el.ao.value = s.get('aoQuality')
    this.el.shadow.value = s.get('shadowQuality')
    this.el.volq.value = s.get('volQuality')
    this.el.bloom.checked = s.get('bloom')
    this.el.fxaa.checked = s.get('fxaa')
    this.el.bob.checked = s.get('bob')
    this.el.camfx.checked = s.get('cameraFx')
    this.el.noise.value = s.get('noise')
    this.el.out.checked = s.get('outline')
    this.el.map.checked = s.get('minimap')
  }
}
