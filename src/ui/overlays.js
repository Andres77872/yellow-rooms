import { Phase } from '../core/GameState.js'
import { IS_TOUCH } from '../core/device.js'

const CSS = `
#ui, #ui * { box-sizing:border-box; }
#ui { position:fixed; inset:0; z-index:20; pointer-events:none;
  font-family:"Courier New",ui-monospace,monospace; color:#e9e1a3; }
#ui .panel { position:absolute; inset:0; display:flex; flex-direction:column;
  align-items:center; justify-content:center; gap:22px; pointer-events:auto;
  background:radial-gradient(circle at 50% 40%, rgba(40,36,12,.55), rgba(8,8,5,.92));
  text-align:center; padding:24px; }
#ui h1 { font-size:clamp(28px,6vw,64px); letter-spacing:.32em; margin:0;
  color:#f6efb0; text-shadow:0 0 18px rgba(216,200,110,.5); font-weight:700; }
#ui .sub { letter-spacing:.3em; opacity:.7; font-size:13px; }
#ui .keys { opacity:.6; font-size:13px; line-height:2; }
#ui input[type=text]{ background:#1b1908; border:1px solid #5e501a; color:#f0e7a0;
  font-family:inherit; font-size:15px; padding:9px 12px; width:min(320px,80vw);
  text-align:center; letter-spacing:.12em; outline:none; }
#ui button{ pointer-events:auto; cursor:pointer; background:#cdbf6e; color:#15130a;
  border:none; padding:12px 26px; font-family:inherit; font-weight:700;
  letter-spacing:.18em; font-size:15px; border-radius:2px;
  transition:transform .08s, background .2s; }
#ui button:hover{ background:#f0e08a; transform:translateY(-1px); }
#ui .ghost{ background:transparent; color:#cdbf6e; border:1px solid #5e501a; }
#ui .row{ display:flex; gap:14px; flex-wrap:wrap; justify-content:center; }
#ui .settings{ display:flex; flex-direction:column; gap:12px; width:min(340px,86vw);
  font-size:13px; text-align:left; }
#ui .settings label{ display:flex; justify-content:space-between; align-items:center; gap:12px; }
#ui input[type=range]{ width:160px; }

/* HUD */
#hud { position:absolute; inset:0; pointer-events:none; }
#hud .cross{ position:absolute; left:50%; top:50%; width:5px; height:5px;
  margin:-2.5px 0 0 -2.5px; border-radius:50%; background:rgba(245,239,176,.6);
  box-shadow:0 0 3px rgba(0,0,0,.8); }
#hud .topbar{ position:absolute; top:14px; left:0; right:0; display:flex;
  justify-content:space-between; padding:0 18px; font-size:12px; letter-spacing:.18em;
  text-shadow:0 1px 2px #000; opacity:.85; }
#hud .bars{ position:absolute; left:18px; bottom:16px; width:190px;
  display:flex; flex-direction:column; gap:7px; }
#hud .bar{ font-size:10px; letter-spacing:.2em; }
#hud .bar .track{ height:6px; background:rgba(0,0,0,.5); border:1px solid #4a4017; margin-top:3px; }
#hud .bar .fill{ height:100%; width:100%; transition:width .12s linear; }
#hud .fl{ position:absolute; right:18px; bottom:18px; font-size:12px;
  letter-spacing:.2em; opacity:.5; text-shadow:0 1px 2px #000; }
#hud .fl.on{ opacity:1; color:#fff2b0; }
#hud .compass{ position:absolute; left:50%; top:64px; transform:translateX(-50%);
  text-align:center; font-size:11px; letter-spacing:.22em; opacity:.8; text-shadow:0 1px 2px #000; }
#hud .compass .arrow{ font-size:20px; display:inline-block; }
#hud .mapwrap{ position:absolute; right:18px; top:40px; width:150px; height:150px;
  border-radius:50%; overflow:hidden; border:1px solid #5e501a; opacity:.97;
  background:radial-gradient(circle at 50% 42%, rgba(40,36,12,.35), rgba(8,8,5,.82));
  box-shadow:0 0 0 3px rgba(13,13,9,.6), 0 2px 10px rgba(0,0,0,.5),
             inset 0 0 18px rgba(0,0,0,.55); }
#hud #minimap{ display:block; width:150px; height:150px; }
#ui .touchnote{ position:absolute; bottom:18px; font-size:11px; opacity:.6; letter-spacing:.16em; }
.hidden{ display:none !important; }

/* Safe-area (notch) offsets — separate override rules so browsers without
   env()/max() drop these and keep the plain offsets above. */
#hud .topbar{ top:max(14px, env(safe-area-inset-top));
  padding:0 max(18px, env(safe-area-inset-right)) 0 max(18px, env(safe-area-inset-left)); }
#hud .bars{ left:max(18px, env(safe-area-inset-left)); bottom:max(16px, env(safe-area-inset-bottom)); }
#hud .fl{ right:max(18px, env(safe-area-inset-right)); bottom:max(18px, env(safe-area-inset-bottom)); }
#hud .mapwrap{ right:max(18px, env(safe-area-inset-right)); }

/* Touch controls (only mounted in touch mode) */
#hud .tc-zone{ position:absolute; top:0; bottom:0; pointer-events:auto; touch-action:none; }
#hud .tc-zone-left{ left:0; width:45%; }
#hud .tc-zone-right{ left:45%; right:0; }
#hud .tc-stick-base{ position:absolute; width:120px; height:120px; border-radius:50%;
  transform:translate(-50%,-50%); pointer-events:none;
  border:1px solid rgba(205,191,110,.45); background:rgba(20,18,8,.35); }
#hud .tc-stick-base.sprint{ border-color:#f0e08a; box-shadow:0 0 14px rgba(240,224,138,.35); }
#hud .tc-stick-nub{ position:absolute; left:50%; top:50%; width:56px; height:56px;
  border-radius:50%; transform:translate(-50%,-50%);
  background:rgba(205,191,110,.55); border:1px solid #5e501a; }
#ui .tc-btn{ position:absolute; pointer-events:auto; touch-action:none;
  width:64px; height:64px; padding:0; border-radius:50%;
  background:rgba(20,18,8,.5); color:#cdbf6e; border:1px solid #5e501a;
  font-size:24px; line-height:1; letter-spacing:0; }
#ui .tc-btn.on{ background:rgba(205,191,110,.85); color:#15130a; }
#ui .tc-btn-light{ right:max(24px, env(safe-area-inset-right));
  bottom:calc(max(18px, env(safe-area-inset-bottom)) + 64px); }
#ui .tc-btn-pause{ left:max(14px, env(safe-area-inset-left));
  top:max(14px, env(safe-area-inset-top)); width:48px; height:48px; font-size:16px; }

/* Touch-mode HUD tweaks */
#ui.touch .fl{ display:none; }                 /* [F] LIGHT → replaced by the button */
#ui.touch #hud .topbar{ padding-left:max(76px, env(safe-area-inset-left)); } /* clear the pause btn */
#ui.touch .panel button{ min-height:48px; }
#ui.touch input[type=range]{ width:200px; height:32px; }

/* Portrait blocker — opaque so the phase panel underneath can't bleed through */
#ui #p-rotate{ z-index:30; gap:14px; background:#0b0a06; }
#p-rotate .glyph{ font-size:44px; animation:tc-rot 2.4s ease-in-out infinite; }
@keyframes tc-rot{ 0%,20%{ transform:rotate(0) } 60%,100%{ transform:rotate(90deg) } }
`

const bar = (id, label, color) => `
  <div class="bar"><span>${label}</span>
    <div class="track"><div class="fill" id="${id}" style="background:${color}"></div></div>
  </div>`

export class UI {
  constructor(settings) {
    this.settings = settings
    this.onStart = null
    this.onResume = null
    this.onRestart = null
    this.onSetting = null

    const style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)

    const root = document.createElement('div')
    root.id = 'ui'
    root.classList.toggle('touch', IS_TOUCH)
    root.innerHTML = `
      <div id="hud" class="hidden">
        <div class="cross"></div>
        <div class="topbar"><span id="hud-level">LEVEL 0</span><span id="hud-seed"></span></div>
        <div class="compass" id="hud-compass"><div class="arrow">▲</div><div id="hud-dist">—</div></div>
        <div class="bars">
          ${bar('hud-stam', 'STAMINA', '#cdbf6e')}
          ${bar('hud-batt', 'BATTERY', '#9fd0c0')}
          ${bar('hud-san', 'SANITY', '#c58fd0')}
          ${bar('hud-expo', 'EXPOSURE', '#d06a5a')}
        </div>
        <div class="fl" id="hud-fl">[F] LIGHT</div>
        <div class="mapwrap" id="hud-mapwrap"><canvas id="minimap" width="150" height="150"></canvas></div>
      </div>

      <div class="panel" id="p-title">
        <div class="sub">A LIMINAL DESCENT</div>
        <h1>THE&nbsp;YELLOW&nbsp;ROOMS</h1>
        <div class="keys">you have no-clipped out of reality.<br/>find the exit. don't let it reach you.</div>
        <input type="text" id="seed-input" placeholder="world seed (optional)" />
        <div class="row">
          <button id="btn-start">ENTER ▸</button>
        </div>
        <div class="keys">${
          IS_TOUCH
            ? 'LEFT STICK move · DRAG RIGHT look · STICK EDGE sprint · ⚡ flashlight'
            : 'WASD move · MOUSE look · SHIFT sprint · F flashlight · ESC pause'
        }</div>
        ${IS_TOUCH ? '<div class="touchnote">best with headphones · landscape only</div>' : ''}
      </div>

      <div class="panel hidden" id="p-pause">
        <h1 style="font-size:clamp(24px,4vw,40px)">PAUSED</h1>
        <div class="settings">
          <label>SENSITIVITY <input type="range" id="set-sens" min="0.0008" max="0.005" step="0.0001"></label>
          <label>VOLUME <input type="range" id="set-vol" min="0" max="1" step="0.02"></label>
          <label>HEAD BOB <input type="checkbox" id="set-bob"></label>
          <label>INK OUTLINE <input type="checkbox" id="set-out"></label>
          <label>MINIMAP <input type="checkbox" id="set-map"></label>
        </div>
        <div class="row">
          <button id="btn-resume">RESUME</button>
          <button class="ghost" id="btn-restart-p">RESTART</button>
        </div>
      </div>

      <div class="panel hidden" id="p-dead">
        <h1 id="dead-title">TAKEN</h1>
        <div class="keys" id="dead-sub"></div>
        <button id="btn-restart">TRY AGAIN</button>
      </div>

      <div class="panel hidden" id="p-trans">
        <div class="sub">NO-CLIP DETECTED</div>
        <h1 id="trans-level">LEVEL 1</h1>
        <div class="keys">descending deeper…</div>
      </div>

      <div class="panel hidden" id="p-rotate">
        <div class="glyph">📱</div>
        <h1 style="font-size:clamp(20px,4vw,36px)">ROTATE YOUR DEVICE</h1>
        <div class="keys">the yellow rooms need landscape.</div>
      </div>
    `
    document.body.appendChild(root)
    this.root = root
    this._cache()
    this._wire()
    this._applySettingsToInputs()
  }

  _cache() {
    const $ = (id) => this.root.querySelector(id)
    this.el = {
      hud: $('#hud'),
      level: $('#hud-level'),
      seed: $('#hud-seed'),
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
      deadSub: $('#dead-sub'),
      trans: $('#p-trans'),
      transLevel: $('#trans-level'),
      rotate: $('#p-rotate'),
      seedInput: $('#seed-input'),
      sens: $('#set-sens'),
      vol: $('#set-vol'),
      bob: $('#set-bob'),
      out: $('#set-out'),
      map: $('#set-map'),
      minimap: $('#minimap'),
      mapwrap: $('#hud-mapwrap'),
    }
  }

  _wire() {
    this.root.querySelector('#btn-start').addEventListener('click', () =>
      this.onStart?.(this.el.seedInput.value.trim())
    )
    this.root.querySelector('#btn-resume').addEventListener('click', () => this.onResume?.())
    this.root.querySelector('#btn-restart').addEventListener('click', () => this.onRestart?.())
    this.root.querySelector('#btn-restart-p').addEventListener('click', () => this.onRestart?.())

    this.el.sens.addEventListener('input', (e) =>
      this.onSetting?.('sensitivity', parseFloat(e.target.value))
    )
    this.el.vol.addEventListener('input', (e) =>
      this.onSetting?.('volume', parseFloat(e.target.value))
    )
    this.el.bob.addEventListener('change', (e) => this.onSetting?.('bob', e.target.checked))
    this.el.out.addEventListener('change', (e) => this.onSetting?.('outline', e.target.checked))
    this.el.map.addEventListener('change', (e) => this.onSetting?.('minimap', e.target.checked))
  }

  _applySettingsToInputs() {
    const s = this.settings
    this.el.sens.value = s.get('sensitivity')
    this.el.vol.value = s.get('volume')
    this.el.bob.checked = s.get('bob')
    this.el.out.checked = s.get('outline')
    this.el.map.checked = s.get('minimap')
  }

  setSeedInput(v) {
    this.el.seedInput.value = v
  }

  _showOnly(phase) {
    this.el.title.classList.toggle('hidden', phase !== Phase.TITLE)
    this.el.pause.classList.toggle('hidden', phase !== Phase.PAUSED)
    this.el.dead.classList.toggle('hidden', phase !== Phase.DEAD)
    this.el.trans.classList.toggle('hidden', phase !== Phase.TRANSITION)
    this.el.hud.classList.toggle('hidden', phase !== Phase.PLAYING)
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
  showPause() {
    this._showOnly(Phase.PAUSED)
  }
  showDeath(reason) {
    this.el.deadTitle.textContent = reason === 'lost' ? 'CONSUMED' : 'TAKEN'
    this.el.deadSub.textContent =
      reason === 'lost'
        ? 'your mind dissolved into the hum.'
        : 'it found you in the yellow.'
    this._showOnly(Phase.DEAD)
  }
  showTransition(level) {
    this.el.transLevel.textContent = `LEVEL ${level}`
    this._showOnly(Phase.TRANSITION)
  }

  updateHud(state, exit) {
    this.el.level.textContent = `LEVEL ${state.level}`
    this.el.seed.textContent = state.seedText ? `SEED ${state.seedText}` : ''
    this.el.stam.style.width = `${Math.max(0, state.stamina) * 100}%`
    this.el.batt.style.width = `${Math.max(0, state.battery) * 100}%`
    this.el.batt.style.background = state.battery < 0.2 ? '#d06a5a' : '#9fd0c0'
    this.el.san.style.width = `${Math.max(0, state.sanity) * 100}%`
    this.el.san.style.background = state.sanity < 0.25 ? '#d06a5a' : '#c58fd0'
    // Exposure only matters while staring; reveal the bar as it charges, redden
    // toward the freeze-failure limit.
    const expo = Math.max(0, Math.min(1, state.stareCharge || 0))
    this.el.expoBar.style.opacity = expo > 0.01 ? '1' : '0.18'
    this.el.expo.style.width = `${expo * 100}%`
    this.el.expo.style.background = expo > 0.75 ? '#ff5a4a' : '#d0a85a'
    this.el.fl.classList.toggle('on', state.flashlightOn)
    if (exit) {
      this.el.compass.style.opacity = '0.85'
      this.el.compassArrow.style.transform = `rotate(${exit.relAngle}rad)`
      this.el.dist.textContent = `${Math.round(exit.dist)}m`
    } else {
      this.el.compass.style.opacity = '0.25'
      this.el.dist.textContent = '—'
    }
  }
}
