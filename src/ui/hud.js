import { IS_TOUCH } from '../core/device.js'
import { MINIMAP_SIZE } from './Minimap.js'

const bar = (id, label, jp) => `
  <div class="bar">
    <div class="lab"><span>${label}</span><span class="jp" aria-hidden="true">${jp}</span></div>
    <div class="track"><div class="fill" id="${id}" role="progressbar"
      aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100"></div></div>
  </div>`

const chip = (key, desc) => `<span class="chip"><b>${key}</b>&nbsp;${desc}</span>`

// The control legend is the same on the title and pause cards — a paused player
// looking for "how do I toggle the map again?" shouldn't have to quit to find it.
const KEY_CHIPS =
  chip('W A S D', 'MOVE') +
  chip('MOUSE', 'LOOK') +
  chip('SHIFT', 'SPRINT') +
  chip('F', 'LIGHT') +
  chip('M', 'MAP') +
  chip('ESC', 'PAUSE')
const TOUCH_CHIPS =
  chip('STICK', 'MOVE') + chip('DRAG', 'LOOK') + chip('EDGE', 'SPRINT') + chip('⚡', 'LIGHT')
export const CONTROL_CHIPS = IS_TOUCH ? TOUCH_CHIPS : KEY_CHIPS

// In-game HUD: crosshair, top chips, exit compass, resource bars, flashlight
// chip, minimap. Per-frame updates run through UI.updateHud (overlays.js),
// which dedupes DOM writes against a value cache.
export const HUD_HTML = `
  <div id="hud" class="hidden">
    <div class="cross"></div>
    <div class="topbar">
      <span class="chip" id="hud-level">LEVEL 0</span>
      <span class="chip hidden" id="hud-seed"></span>
      <span class="chip hidden" id="hud-fam"></span>
    </div>
    <div class="compass" id="hud-compass">
      <div class="ring"><div class="arrow">▲</div></div>
      <div class="chip" id="hud-dist">—</div>
    </div>
    <div class="bars">
      ${bar('hud-stam', 'STAMINA', '体')}
      ${bar('hud-batt', 'BATTERY', '電')}
      ${bar('hud-san', 'SANITY', '心')}
      ${bar('hud-expo', 'EXPOSURE', '曝')}
    </div>
    <div class="fl chip" id="hud-fl">[F] LIGHT</div>
    <div class="chip relock hidden" id="hud-relock">CLICK TO CAPTURE THE MOUSE</div>
    <div class="mapwrap" id="hud-mapwrap"><canvas id="minimap" width="${MINIMAP_SIZE}" height="${MINIMAP_SIZE}"></canvas></div>
  </div>`
