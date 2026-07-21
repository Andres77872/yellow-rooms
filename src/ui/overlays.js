import { Phase } from '../core/GameState.js'
import { IS_TOUCH } from '../core/device.js'
import { MAP_FAMILY_ORDER } from '../world/mapFamily.js'
import { UI_CSS } from './theme.js'
import { SETTINGS_HTML, SettingsBlock } from './settingsPanel.js'
import { CONTROL_CHIPS, HUD_HTML } from './hud.js'

// Menu + HUD shell. Presentation lives in three sibling modules — theme.js
// (design tokens + all CSS), hud.js (HUD markup + the control legend),
// settingsPanel.js (the simple + advanced settings block) — while this class
// owns the panel lifecycle: title / pause / death / transition / rotate, plus
// per-frame HUD updates. Public API (el shape, show*, updateHud,
// refreshSettings) is pinned by src/ui/__tests__ and the engine tests.

export class UI {
  constructor(settings) {
    this.settings = settings
    this.onStart = null
    this.onResume = null
    this.onRestart = null
    this.onQuit = null
    this.onSetting = null
    this.onResetSettings = null
    this._hudCache = {} // last-written HUD values; skips redundant DOM writes

    const style = document.createElement('style')
    style.textContent = UI_CSS
    document.head.appendChild(style)

    const root = document.createElement('div')
    root.id = 'ui'
    root.classList.toggle('touch', IS_TOUCH)
    root.innerHTML = `
      ${HUD_HTML}

      <div class="panel" id="p-title">
        <div class="card">
          <div class="kicker">A LIMINAL DESCENT</div>
          <div class="jp-accent" aria-hidden="true">「黄色の部屋」</div>
          <h1>THE&nbsp;YELLOW&nbsp;ROOMS</h1>
          <div class="keys">you have no-clipped out of reality.<br/>find the exit. don't let it reach you.</div>
          <input type="text" id="seed-input" placeholder="world seed (optional)" aria-label="world seed" />
          <select id="family-select" aria-label="map family">${MAP_FAMILY_ORDER.map(
            (f) => `<option value="${f}">MAP · ${f.toUpperCase()}</option>`
          ).join('')}</select>
          <div class="row">
            <button id="btn-start" class="primary">ENTER ▸</button>
            <button id="btn-settings" class="ghost" aria-expanded="false">SETTINGS</button>
            <button id="btn-editor" class="ghost">EDITOR</button>
          </div>
          <div class="settings hidden" id="title-settings">${SETTINGS_HTML}</div>
          <div class="chips">${CONTROL_CHIPS}</div>
        </div>
        ${IS_TOUCH ? '<div class="touchnote">best with headphones · landscape only</div>' : ''}
      </div>

      <div class="panel hidden" id="p-pause">
        <div class="card">
          <div class="jp-accent" aria-hidden="true">「小休止」</div>
          <h1 class="h-sm">PAUSED</h1>
          <div class="chip dead-run hidden" id="pause-run"></div>
          <div class="settings">${SETTINGS_HTML}</div>
          <div class="chips">${CONTROL_CHIPS}</div>
          <div class="row">
            <button id="btn-resume" class="primary">RESUME</button>
            <button class="ghost" id="btn-restart-p">RESTART</button>
            <button class="ghost" id="btn-quit">QUIT TO TITLE</button>
          </div>
        </div>
      </div>

      <div class="panel hidden" id="p-dead">
        <div class="card">
          <div class="jp-accent" id="dead-jp" aria-hidden="true">「捕獲」</div>
          <h1 id="dead-title">TAKEN</h1>
          <div class="keys" id="dead-sub"></div>
          <div class="chip dead-run" id="dead-run"></div>
          <button id="btn-restart" class="primary">TRY AGAIN</button>
        </div>
      </div>

      <div class="panel hidden" id="p-trans">
        <div class="card">
          <div class="jp-accent" aria-hidden="true">「現実剥離」</div>
          <div class="kicker glitch">NO-CLIP DETECTED</div>
          <h1 id="trans-level">LEVEL 1</h1>
          <div class="keys">descending deeper…</div>
        </div>
      </div>

      <div class="panel hidden" id="p-rotate">
        <div class="glyph" aria-hidden="true">📱</div>
        <h1 class="h-sm">ROTATE YOUR DEVICE</h1>
        <div class="keys">the yellow rooms need landscape.</div>
      </div>
    `
    document.body.appendChild(root)
    this.root = root
    this._cache()
    this._wire()
    this.refreshSettings()
  }

  _cache() {
    const $ = (id) => this.root.querySelector(id)
    this.el = {
      hud: $('#hud'),
      level: $('#hud-level'),
      seed: $('#hud-seed'),
      fam: $('#hud-fam'),
      stam: $('#hud-stam'),
      batt: $('#hud-batt'),
      san: $('#hud-san'),
      expo: $('#hud-expo'),
      expoBar: this.root.querySelector('#hud-expo').closest('.bar'),
      fl: $('#hud-fl'),
      compass: $('#hud-compass'),
      compassArrow: this.root.querySelector('#hud-compass .arrow'),
      dist: $('#hud-dist'),
      title: $('#p-title'),
      pause: $('#p-pause'),
      dead: $('#p-dead'),
      deadTitle: $('#dead-title'),
      deadJp: $('#dead-jp'),
      deadSub: $('#dead-sub'),
      deadRun: $('#dead-run'),
      trans: $('#p-trans'),
      transLevel: $('#trans-level'),
      rotate: $('#p-rotate'),
      seedInput: $('#seed-input'),
      familySelect: $('#family-select'),
      pauseRun: $('#pause-run'),
      titleSettings: $('#title-settings'),
      btnStart: $('#btn-start'),
      btnSettings: $('#btn-settings'),
      btnResume: $('#btn-resume'),
      btnRetry: $('#btn-restart'),
      minimap: $('#minimap'),
      mapwrap: $('#hud-mapwrap'),
    }
    // One wired block per .settings card (title + pause share SETTINGS_HTML).
    // Every edit round-trips through the Settings store, then BOTH cards are
    // re-synced from the (clamped) truth so they can never show stale values.
    this.settingsBlocks = [...this.root.querySelectorAll('.settings')].map(
      (rootEl) =>
        new SettingsBlock(rootEl, {
          onSetting: (k, v) => {
            this.onSetting?.(k, v)
            this.refreshSettings()
          },
          onReset: () => this.onResetSettings?.(),
        })
    )
  }

  _wire() {
    const start = () =>
      this.onStart?.(this.el.seedInput.value.trim(), this.el.familySelect.value)
    this.el.btnStart.addEventListener('click', start)
    this.el.seedInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') start()
    })
    this.el.btnSettings.addEventListener('click', () => {
      const open = !this.el.titleSettings.classList.toggle('hidden')
      this.el.btnSettings.setAttribute('aria-expanded', String(open))
    })
    this.el.btnResume.addEventListener('click', () => this.onResume?.())
    this.el.btnRetry.addEventListener('click', () => this.onRestart?.())
    this.root.querySelector('#btn-restart-p').addEventListener('click', () => this.onRestart?.())
    this.root.querySelector('#btn-quit').addEventListener('click', () => this.onQuit?.())
    // The map editor lives at its own entry (/editor, see vite.config.ts).
    this.root.querySelector('#btn-editor').addEventListener('click', () => {
      location.href = '/editor'
    })
  }

  // Pull every control back from the store. Also the way anything that changes a
  // setting outside the panels (the M key, RESET DEFAULTS) re-syncs the widgets.
  refreshSettings() {
    for (const b of this.settingsBlocks) b.refresh(this.settings)
  }

  setSeedInput(v) {
    this.el.seedInput.value = v
  }

  setFamilyInput(v) {
    this.el.familySelect.value = v
    // Unknown value: a <select> silently blanks — land on the office default.
    if (this.el.familySelect.value !== v) this.el.familySelect.value = 'office'
  }

  // `LEVEL n · SEED s[ · FAMILY]` — the shareable run identity, used by the
  // death card and the pause card. Office is implicit and adds no suffix.
  _runSummary(state) {
    if (!state) return ''
    const fam = state.mapFamily && state.mapFamily !== 'office'
      ? ` · ${state.mapFamily.toUpperCase()}`
      : ''
    return `LEVEL ${state.level}${state.seedText ? ` · SEED ${state.seedText}` : ''}${fam}`
  }

  _showOnly(phase) {
    this.el.title.classList.toggle('hidden', phase !== Phase.TITLE)
    this.el.pause.classList.toggle('hidden', phase !== Phase.PAUSED)
    this.el.dead.classList.toggle('hidden', phase !== Phase.DEAD)
    this.el.trans.classList.toggle('hidden', phase !== Phase.TRANSITION)
    this.el.hud.classList.toggle('hidden', phase !== Phase.PLAYING)
    // Move focus to the panel's primary action so Enter works without a mouse
    // (and drop it when the HUD takes over, else Space would re-click a button).
    const primary =
      phase === Phase.TITLE
        ? this.el.btnStart
        : phase === Phase.PAUSED
          ? this.el.btnResume
          : phase === Phase.DEAD
            ? this.el.btnRetry
            : null
    if (primary) primary.focus({ preventScroll: true })
    else if (document.activeElement?.closest?.('#ui')) document.activeElement.blur()
  }

  // Portrait blocker sits above the phase panels and is driven by orientation,
  // not phase, so it's toggled independently of _showOnly.
  setRotateVisible(v) {
    this.el.rotate.classList.toggle('hidden', !v)
  }

  showTitle() {
    this._showOnly(Phase.TITLE)
  }
  showHud() {
    this._showOnly(Phase.PLAYING)
  }
  showPause(state) {
    const summary = this._runSummary(state)
    this.el.pauseRun.textContent = summary
    this.el.pauseRun.classList.toggle('hidden', !summary)
    this._showOnly(Phase.PAUSED)
  }
  showDeath(reason, state) {
    const lost = reason === 'lost'
    const voided = reason === 'void'
    this.el.deadTitle.textContent = voided ? 'FALLEN' : lost ? 'CONSUMED' : 'TAKEN'
    this.el.deadJp.textContent = voided ? '「虚無」' : lost ? '「崩壊」' : '「捕獲」'
    this.el.deadSub.textContent = voided
      ? 'the void swallowed you whole.'
      : lost
        ? 'your mind dissolved into the hum.'
        : 'it found you in the yellow.'
    // Run summary: how deep + which seed/family (shareable / reproducible).
    this.el.deadRun.textContent = this._runSummary(state)
    this._showOnly(Phase.DEAD)
  }
  showTransition(level) {
    this.el.transLevel.textContent = `LEVEL ${level}`
    this._showOnly(Phase.TRANSITION)
  }

  updateHud(state, exit) {
    const c = this._hudCache
    // Dedupe DOM writes: text/aria/width only change when the VALUE changes.
    const setText = (key, el, text) => {
      if (c[key] === text) return
      c[key] = text
      el.textContent = text
    }
    // 0.1% granularity — sub-pixel on the ~190px tracks, so still smooth.
    const setBar = (key, el, frac) => {
      const pct = Math.round(Math.max(0, frac) * 1000) / 10
      if (c[key] === pct) return
      c[key] = pct
      el.style.width = `${pct}%`
      el.setAttribute('aria-valuenow', Math.round(pct))
    }

    setText('level', this.el.level, `LEVEL ${state.level}`)
    const seedText = state.seedText ? `SEED ${state.seedText}` : ''
    if (c.seed !== seedText) {
      c.seed = seedText
      this.el.seed.textContent = seedText
      this.el.seed.classList.toggle('hidden', !seedText)
    }
    // Family chip only for non-office runs — the default world stays clean.
    const famText = state.mapFamily && state.mapFamily !== 'office'
      ? `FAMILY ${state.mapFamily.toUpperCase()}`
      : ''
    if (c.fam !== famText) {
      c.fam = famText
      this.el.fam.textContent = famText
      this.el.fam.classList.toggle('hidden', !famText)
    }

    setBar('stam', this.el.stam, state.stamina)
    this.el.stam.classList.toggle('low', state.stamina < 0.2)
    setBar('batt', this.el.batt, state.battery)
    this.el.batt.classList.toggle('low', state.battery < 0.2)
    setBar('san', this.el.san, state.sanity)
    this.el.san.classList.toggle('low', state.sanity < 0.25)

    // Exposure only matters while staring; reveal the bar as it charges, redden
    // toward the freeze-failure limit.
    const expo = Math.max(0, Math.min(1, state.stareCharge || 0))
    const expoOp = expo > 0.01 ? '1' : '0.18'
    if (c.expoOp !== expoOp) {
      c.expoOp = expoOp
      this.el.expoBar.style.opacity = expoOp
    }
    setBar('expo', this.el.expo, expo)
    this.el.expo.classList.toggle('hot', expo > 0.75)

    this.el.fl.classList.toggle('on', state.flashlightOn)
    if (exit) {
      // When the exit is on another floor, say so — "2m" at an unreachable
      // spot a slab away reads as a bug. The dimmed compass + a ▼/▲ floor
      // count tell the player to find stairs.
      const df = exit.floorDelta ?? 0
      this.el.compass.style.opacity = df === 0 ? '0.85' : '0.45'
      this.el.compassArrow.style.transform = `rotate(${exit.relAngle}rad)`
      setText(
        'dist',
        this.el.dist,
        df === 0
          ? `${Math.round(exit.dist)}m`
          : `${Math.round(exit.dist)}m ${df < 0 ? '▼' : '▲'}${Math.abs(df)}`
      )
    } else {
      this.el.compass.style.opacity = '0.25'
      setText('dist', this.el.dist, '—')
    }
  }
}
