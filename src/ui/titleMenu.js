import { IS_TOUCH } from '../core/device.js'
import { MAP_FAMILY_ORDER } from '../world/mapFamily.js'
import { WORLD_GEN_VERSION } from '../world/constants.js'
import { SETTINGS_HTML } from './settingsPanel.js'
import { CONTROL_CHIPS } from './hud.js'

// Main-menu title screen markup. Full-bleed over the live world backdrop: the
// wordmark + menu sit in a left column, the world stays visible on the right,
// and settings slide in as a side sheet instead of growing a centered card.
// Lifecycle (open/close, focus, arrow keys) lives in overlays.js; styles in
// theme.js. Element ids are the UI class's cache contract — keep them stable.

// One-line spatial identity per map family, shown under the MAP picker.
// Mirrors the README family table; unknown families show nothing.
export const FAMILY_NOTES = Object.freeze({
  office: 'room districts · empty bullpens · tall atria',
  sewer: 'dry galleries · confluences · manhole stairs',
  tower: 'broad galleries · service cores · skybridges',
  lattice: 'service alleys · catwalks · transfer plazas',
  hotel: 'guest-room wings · corridor loops · atria',
})

export function familyNote(family) {
  return Object.hasOwn(FAMILY_NOTES, family) ? FAMILY_NOTES[family] : ''
}

// ArrowUp/ArrowDown focus step through the menu's [data-nav] items, wrapping
// at both ends. Any other key (or an empty menu) leaves the index unchanged.
export function stepMenuIndex(index, count, key) {
  if (count <= 0) return index
  if (key === 'ArrowDown') return (index + 1) % count
  if (key === 'ArrowUp') return (index - 1 + count) % count
  return index
}

// Each wordmark letter is its own "tube" so it can power on separately; --i
// staggers the flicker-on. `failAt` marks the one tube that keeps failing.
const tubes = (word, from, failAt = -1) =>
  [...word]
    .map((ch, i) => `<span class="lt${i === failAt ? ' fail' : ''}" style="--i:${from + i}">${ch}</span>`)
    .join('')

const familyOpts = MAP_FAMILY_ORDER.map(
  (f) => `<option value="${f}">${f.toUpperCase()}</option>`
).join('')

const footNote = IS_TOUCH ? 'best with headphones · landscape only' : 'best with headphones'

export const TITLE_HTML = `
  <div class="panel" id="p-title">
    <div class="title-main">
      <div class="brand">
        <div class="kicker">A LIMINAL DESCENT</div>
        <h1 class="logo" aria-label="The Yellow Rooms">
          <span class="logo-the" aria-hidden="true">THE</span>
          <span class="logo-word lit" aria-hidden="true">${tubes('YELLOW', 0)}</span>
          <span class="logo-word hollow" aria-hidden="true">${tubes('ROOMS', 6, 2)}</span>
        </h1>
        <div class="hum" aria-hidden="true"></div>
        <p class="tagline">you have no-clipped out of reality.<br/>find the exit. don't let it reach you.</p>
      </div>
      <nav class="menu" id="title-menu" aria-label="Main menu">
        <button id="btn-start" class="mi primary" data-nav>ENTER THE ROOMS<span class="mi-caret" aria-hidden="true">▸</span></button>
        <div class="world" role="group" aria-label="World">
          <label class="field"><span class="field-lab">SEED</span>
            <input type="text" id="seed-input" placeholder="random" aria-label="world seed"
              autocomplete="off" spellcheck="false" /></label>
          <label class="field"><span class="field-lab">MAP</span>
            <select id="family-select" aria-label="map family">${familyOpts}</select></label>
          <div class="world-note" id="family-note"></div>
        </div>
        <button id="btn-settings" class="mi" data-nav aria-expanded="false" aria-controls="title-settings">SETTINGS<span class="mi-caret" aria-hidden="true">▸</span></button>
        <button id="btn-editor" class="mi" data-nav>MAP EDITOR<span class="mi-caret" aria-hidden="true">▸</span></button>
      </nav>
    </div>
    <div class="jp-vert" aria-hidden="true">黄色の部屋</div>
    <div class="title-foot">
      <div class="chips">${CONTROL_CHIPS}</div>
      <div class="build">${footNote} · world-gen v${WORLD_GEN_VERSION}</div>
    </div>
    <aside class="sheet hidden" id="title-settings" aria-label="Settings">
      <div class="sheet-head">
        <div>
          <div class="jp-accent" aria-hidden="true">「設定」</div>
          <h2>SETTINGS</h2>
        </div>
        <button type="button" class="ghost sheet-close" id="btn-settings-close" aria-label="Close settings">✕</button>
      </div>
      <div class="settings">${SETTINGS_HTML}</div>
    </aside>
  </div>`
