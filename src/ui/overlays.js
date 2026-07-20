import { Phase } from '../core/GameState.js'
import { IS_TOUCH } from '../core/device.js'
import { SENS_DEFAULT, SENS_MAX, SENS_MIN } from '../core/Settings.js'
import { MAP_FAMILY_ORDER } from '../world/mapFamily.js'
import { MINIMAP_SIZE } from './Minimap.js'

// ANIME + LIMINAL design language: the eerie warmth of empty backrooms drawn
// like a 90s anime background. Every component reads from the design tokens on
// #ui; the Minimap canvas mirrors them in ./Minimap.js (canvas can't read CSS
// custom properties per-frame).
const CSS = `
#ui, #ui * { box-sizing:border-box; }
#ui {
  /* ── design tokens ─────────────────────────────────────────────── */
  --ink:#17120a;                       /* deep warm near-black          */
  --ink-70:rgba(23,18,10,.72);         /* chip / track backing          */
  --ink-90:rgba(23,18,10,.9);          /* card fallback (no blur)       */
  --paper:#f4e9c8;                     /* warm cream body text          */
  --paper-dim:rgba(244,233,200,.55);   /* secondary text                */
  --gold:#e8cf7a;                      /* signature accent              */
  --gold-dim:#8a7a3f;                  /* muted accent / rules          */
  --amber-glow:rgba(232,207,122,.32);  /* soft gold halo                */
  --mint:#9fd0c0;                      /* battery / exit                */
  --violet:#c9a8e0;                    /* sanity                        */
  --red:#e0584a;                       /* danger / death                */
  --line:rgba(232,207,122,.28);        /* 1px hairline gold             */
  --line-weak:rgba(232,207,122,.14);   /* fainter separators            */
  position:fixed; inset:0; z-index:20; pointer-events:none;
  font-family:ui-monospace,"Cascadia Mono","SF Mono",Menlo,Consolas,"Courier New",monospace;
  color:var(--paper);
}

/* ── panels: fullscreen radial backdrop + inner corner-cut card ──── */
#ui .panel { position:absolute; inset:0; display:flex; flex-direction:column;
  align-items:center; justify-content:center; pointer-events:auto;
  background:radial-gradient(circle at 50% 40%, rgba(40,36,12,.55), rgba(10,9,5,.92));
  text-align:center; padding:24px; }
#ui .card { position:relative; display:flex; flex-direction:column;
  align-items:center; gap:20px; max-width:min(680px,94vw); max-height:100%;
  overflow-y:auto; overflow-x:clip; padding:clamp(26px,5vh,44px) clamp(22px,6vw,56px);
  background:var(--ink-90); border:1px solid var(--line);
  clip-path:polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 0 100%); }
@supports ((backdrop-filter:blur(10px)) or (-webkit-backdrop-filter:blur(10px))) {
  #ui .card { background:rgba(23,18,10,.62);
    -webkit-backdrop-filter:blur(10px) saturate(1.2);
    backdrop-filter:blur(10px) saturate(1.2); }
}
#ui .panel:not(.hidden) { animation:panel-fade .3s ease-out both; }
#ui .panel:not(.hidden) .card { animation:card-in .42s cubic-bezier(.16,1,.3,1) both; }
@keyframes panel-fade { from { opacity:0; } }
@keyframes card-in { from { opacity:0; transform:translateY(8px); } }

/* ── typography ────────────────────────────────────────────────── */
/* Sized so the 16-char tracked title always fits the 680px card:
   ~0.85em/char incl. tracking -> 13.6em; 42px x 13.6 = 571px <= card content. */
#ui h1 { font-size:clamp(19px,4vw,42px); letter-spacing:.24em; margin:0; white-space:nowrap;
  color:var(--paper); font-weight:700;
  text-shadow:0 0 2px rgba(244,233,200,.7), 0 0 18px var(--amber-glow),
              0 0 44px rgba(232,207,122,.16); }
#ui h1.h-sm { font-size:clamp(22px,4vw,40px); }
#ui .kicker { display:flex; align-items:center; gap:14px; letter-spacing:.34em;
  font-size:12px; color:var(--paper-dim); text-transform:uppercase; white-space:nowrap; }
#ui .kicker::before, #ui .kicker::after { content:''; height:1px; width:44px;
  background:var(--line); flex:none; }
#ui .jp-accent { font-size:14px; letter-spacing:.5em; color:var(--gold-dim);
  text-shadow:0 0 10px var(--amber-glow); user-select:none; }
#ui .keys { color:var(--paper-dim); font-size:13px; line-height:2; letter-spacing:.1em; }
#p-title h1 { animation:h1-breathe 4s ease-in-out infinite; }
@keyframes h1-breathe {
  0%,100% { text-shadow:0 0 2px rgba(244,233,200,.7), 0 0 16px var(--amber-glow),
                        0 0 36px rgba(232,207,122,.14); }
  50%     { text-shadow:0 0 3px rgba(244,233,200,.85), 0 0 26px var(--amber-glow),
                        0 0 64px rgba(232,207,122,.28); }
}

/* ── seed input: centered underline-only field ─────────────────── */
#ui input[type=text] { background:transparent; border:none;
  border-bottom:1px solid var(--gold-dim); color:var(--paper);
  font-family:inherit; font-size:15px; padding:9px 6px; width:min(320px,72vw);
  text-align:center; letter-spacing:.12em; outline:none; border-radius:0;
  transition:border-color .2s, box-shadow .25s; }
#ui input[type=text]::placeholder { color:var(--paper-dim); opacity:.6; }
#ui input[type=text]:focus { border-bottom-color:var(--gold);
  box-shadow:0 8px 16px -10px var(--amber-glow); }

/* ── map-family selector: matches the seed underline field ─────── */
#ui select { pointer-events:auto; background:transparent; border:none;
  border-bottom:1px solid var(--gold-dim); color:var(--paper);
  font-family:inherit; font-size:13px; letter-spacing:.14em;
  padding:8px 6px; width:min(320px,72vw); text-align:center; outline:none;
  border-radius:0; cursor:pointer; transition:border-color .2s; }
#ui select:focus { border-bottom-color:var(--gold); }
#ui select option { background:#17120a; color:var(--paper); }

/* ── buttons ───────────────────────────────────────────────────── */
#ui button { pointer-events:auto; cursor:pointer; font-family:inherit;
  font-weight:700; letter-spacing:.18em; font-size:15px; border-radius:0; }
#ui .primary { position:relative; overflow:hidden; background:var(--gold);
  color:var(--ink); border:none; padding:13px 32px; min-width:min(240px,64vw);
  clip-path:polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 0 100%);
  transition:background .2s, transform .08s; }
#ui .primary:hover { background:#f4e08e; transform:translateY(-1px); }
#ui .primary::after { content:''; position:absolute; top:-40%; bottom:-40%;
  left:-60%; width:36%; transform:skewX(-20deg); opacity:0; pointer-events:none;
  background:linear-gradient(105deg, transparent, rgba(255,252,235,.65), transparent); }
#ui .primary:hover::after, #ui .primary:focus-visible::after {
  animation:btn-shine .7s ease forwards; }
@keyframes btn-shine { from { left:-60%; opacity:1; } to { left:124%; opacity:1; } }
#ui .ghost { background:transparent; color:var(--gold);
  border:1px solid var(--gold-dim); padding:12px 26px;
  transition:border-color .2s, color .2s; }
#ui .ghost:hover { border-color:var(--gold); color:var(--paper); }
#ui .row { display:flex; gap:14px; flex-wrap:wrap; justify-content:center; }

/* ── focus (gold ring; .primary is clip-path'd so ring goes inside) */
#ui :focus-visible { outline:2px solid var(--gold); outline-offset:2px; }
#ui .primary:focus-visible { outline:2px solid var(--ink); outline-offset:-5px; }
#ui input[type=text]:focus-visible { outline:none; } /* underline glow is the indicator */

/* ── chips ─────────────────────────────────────────────────────── */
#ui .chip { display:inline-block; padding:4px 10px; border:1px solid var(--line);
  background:var(--ink-70); letter-spacing:.18em; font-size:11px; color:var(--paper); }
#ui .chips { display:flex; flex-wrap:wrap; gap:8px; justify-content:center;
  max-width:min(540px,86vw); }
#ui .chips .chip b { color:var(--gold); font-weight:700; }
/* death-card run summary: user seeds can be arbitrarily long */
#ui .dead-run { overflow-wrap:anywhere; }

/* ── pause settings: grouped label/control rows, hairline separators ── */
#ui .settings { display:flex; flex-direction:column; width:min(400px,90vw);
  font-size:13px; text-align:left; letter-spacing:.14em; }
#ui .settings .group { margin:16px 0 2px; font-size:10px; letter-spacing:.32em;
  color:var(--gold-dim); text-transform:uppercase; }
#ui .settings .group:first-child { margin-top:0; }
#ui .settings label { display:flex; justify-content:space-between;
  align-items:center; gap:12px; padding:11px 2px;
  border-bottom:1px solid var(--line-weak); }
#ui .settings label:last-child { border-bottom:none; }
/* slider + its readout travel together on the right edge of the row */
#ui .settings .ctl { display:flex; align-items:center; gap:10px; flex:none; }
#ui .settings .val { min-width:46px; text-align:right; color:var(--gold);
  font-size:12px; letter-spacing:.06em; font-variant-numeric:tabular-nums; }
#ui input[type=range] { width:150px; accent-color:var(--gold); }
#ui input[type=checkbox] { width:16px; height:16px; accent-color:var(--gold); }

/* ── death panel: red-shifted card ─────────────────────────────── */
#p-dead .card { border-color:rgba(224,88,74,.4); }
#p-dead h1 { text-shadow:0 0 2px rgba(244,220,200,.7), 0 0 18px rgba(224,88,74,.45),
             0 0 44px rgba(224,88,74,.2); }
#p-dead .jp-accent { color:rgba(224,88,74,.75); text-shadow:0 0 10px rgba(224,88,74,.3); }

/* ── transition panel: no-clip glitch ──────────────────────────── */
#p-trans .glitch { animation:glitch-jitter 2.8s steps(1,end) infinite; }
@keyframes glitch-jitter {
  0%,86%,100% { transform:none; opacity:1; clip-path:none; }
  87% { transform:translateX(-2px) skewX(-10deg); }
  88% { transform:translateX(2px) skewX(6deg); opacity:.7;
        clip-path:inset(0 0 52% 0); }
  89% { transform:translateX(-1px); clip-path:inset(44% 0 0 0); }
  90% { transform:none; clip-path:none; }
  94% { transform:translateX(1px) skewX(-4deg); opacity:.85; }
  95% { transform:none; opacity:1; }
}

/* ── HUD ───────────────────────────────────────────────────────── */
#hud { position:absolute; inset:0; pointer-events:none; }
#hud .cross { position:absolute; left:50%; top:50%; width:7px; height:7px;
  margin:-3.5px 0 0 -3.5px; border:1px solid rgba(244,233,200,.8);
  transform:rotate(45deg); background:transparent;
  box-shadow:0 0 6px var(--amber-glow), 0 0 2px rgba(0,0,0,.8); }
#hud .topbar { position:absolute; top:14px; left:0; right:0; display:flex;
  justify-content:space-between; padding:0 18px; }
#hud .compass { position:absolute; left:50%; top:56px; transform:translateX(-50%);
  text-align:center; font-size:11px; letter-spacing:.22em; opacity:.8;
  transition:opacity .3s; }
#hud .compass .ring { width:38px; height:38px; margin:0 auto 5px;
  border:1px solid var(--line); border-radius:50%; background:var(--ink-70);
  display:flex; align-items:center; justify-content:center; }
#hud .compass .arrow { font-size:18px; line-height:1; display:block;
  color:var(--gold); text-shadow:0 0 6px var(--amber-glow); }

/* bars: slanted tracks, token fills, JP glyph labels */
#hud .bars { position:absolute; left:18px; bottom:16px; width:190px;
  display:flex; flex-direction:column; gap:8px; }
#hud .bar { font-size:10px; letter-spacing:.2em; }
#hud .bar .lab { display:flex; justify-content:space-between; align-items:baseline;
  text-shadow:0 1px 2px #000; }
#hud .bar .lab .jp { color:var(--gold-dim); letter-spacing:0; user-select:none; }
#hud .bar .track { height:8px; margin-top:3px; background:var(--ink-70);
  border:1px solid var(--line-weak); transform:skewX(-12deg); }
#hud .bar .fill { height:100%; width:100%; background:var(--bar-c, var(--gold));
  box-shadow:0 0 8px var(--bar-glow, var(--amber-glow));
  transition:width .12s linear; }
#hud-stam { --bar-c:var(--gold);   --bar-glow:rgba(232,207,122,.4); }
#hud-batt { --bar-c:var(--mint);   --bar-glow:rgba(159,208,192,.4); }
#hud-san  { --bar-c:var(--violet); --bar-glow:rgba(201,168,224,.4); }
#hud-expo { --bar-c:#d0a85a;       --bar-glow:rgba(208,168,90,.4); }
#hud .bar .fill.low { --bar-c:var(--red); --bar-glow:rgba(224,88,74,.55);
  animation:bar-pulse 1.1s ease-in-out infinite; }
#hud .bar .fill.hot { --bar-c:#ff5a4a; --bar-glow:rgba(255,90,74,.6);
  animation:bar-pulse .8s ease-in-out infinite; }
@keyframes bar-pulse { 50% { opacity:.5; } }

/* flashlight chip */
#hud .fl { position:absolute; right:18px; bottom:18px; opacity:.55;
  transition:opacity .2s, background .2s, color .2s, box-shadow .2s; }
#hud .fl.on { opacity:1; background:var(--gold); color:var(--ink);
  border-color:var(--gold); box-shadow:0 0 12px var(--amber-glow); }

/* minimap: hairline gold ring + inner vignette (no heavy bezel) */
#hud .mapwrap { position:absolute; right:18px; top:40px;
  width:${MINIMAP_SIZE}px; height:${MINIMAP_SIZE}px; border-radius:50%;
  overflow:hidden; border:1px solid var(--line);
  background:radial-gradient(circle at 50% 42%, rgba(40,36,12,.3), rgba(10,9,5,.85));
  box-shadow:inset 0 0 22px rgba(0,0,0,.55); }
#hud #minimap { display:block; width:${MINIMAP_SIZE}px; height:${MINIMAP_SIZE}px; }
#ui .touchnote { position:absolute; bottom:18px; font-size:11px;
  color:var(--paper-dim); letter-spacing:.16em; }
.hidden { display:none !important; }

/* Safe-area (notch) offsets — separate override rules so browsers without
   env()/max() drop these and keep the plain offsets above. */
#hud .topbar { top:max(14px, env(safe-area-inset-top));
  padding:0 max(18px, env(safe-area-inset-right)) 0 max(18px, env(safe-area-inset-left)); }
#hud .bars { left:max(18px, env(safe-area-inset-left)); bottom:max(16px, env(safe-area-inset-bottom)); }
#hud .fl { right:max(18px, env(safe-area-inset-right)); bottom:max(18px, env(safe-area-inset-bottom)); }
#hud .mapwrap { right:max(18px, env(safe-area-inset-right)); }

/* ── touch controls (only mounted in touch mode) ───────────────── */
#hud .tc-zone { position:absolute; top:0; bottom:0; pointer-events:auto; touch-action:none; }
#hud .tc-zone-left { left:0; width:45%; }
#hud .tc-zone-right { left:45%; right:0; }
#hud .tc-stick-base { position:absolute; width:120px; height:120px; border-radius:50%;
  transform:translate(-50%,-50%); pointer-events:none;
  border:1px solid var(--line); background:rgba(23,18,10,.35); }
#hud .tc-stick-base.sprint { border-color:var(--gold); box-shadow:0 0 14px var(--amber-glow); }
#hud .tc-stick-nub { position:absolute; left:50%; top:50%; width:56px; height:56px;
  border-radius:50%; transform:translate(-50%,-50%);
  background:rgba(232,207,122,.5); border:1px solid var(--gold-dim); }
#ui .tc-btn { position:absolute; pointer-events:auto; touch-action:none;
  width:64px; height:64px; padding:0; border-radius:50%;
  background:rgba(23,18,10,.55); color:var(--gold); border:1px solid var(--line);
  -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px);
  font-size:24px; line-height:1; letter-spacing:0; }
#ui .tc-btn.on { background:rgba(232,207,122,.9); color:var(--ink);
  border-color:var(--gold); box-shadow:0 0 12px var(--amber-glow); }
#ui .tc-btn-light { right:max(24px, env(safe-area-inset-right));
  bottom:calc(max(18px, env(safe-area-inset-bottom)) + 64px); }
#ui .tc-btn-pause { left:max(14px, env(safe-area-inset-left));
  top:max(14px, env(safe-area-inset-top)); width:48px; height:48px; font-size:16px; }

/* touch-mode HUD tweaks */
#ui.touch .fl { display:none; }                 /* [F] LIGHT → replaced by the button */
#ui.touch #hud .topbar { padding-left:max(76px, env(safe-area-inset-left)); } /* clear the pause btn */
#ui.touch .panel button { min-height:48px; }
/* fat thumb target, but the row must still fit the readout inside the card */
#ui.touch input[type=range] { width:150px; height:32px; }
#ui.touch input[type=checkbox] { width:22px; height:22px; }

/* portrait blocker — opaque so the phase panel underneath can't bleed through */
#ui #p-rotate { z-index:30; gap:14px; background:#0e0b06; }
/* The blocker headline must survive 280-320px portrait phones — the nowrap
   tracked h1 measures ~333px at the .h-sm 22px floor, so let this one wrap. */
#ui #p-rotate h1 { white-space:normal; }
#p-rotate .glyph { font-size:44px; animation:tc-rot 2.4s ease-in-out infinite; }
@keyframes tc-rot { 0%,20% { transform:rotate(0); } 60%,100% { transform:rotate(90deg); } }

/* ── reduced motion: kill every animation/transition in the UI ─── */
@media (prefers-reduced-motion: reduce) {
  #ui *, #ui *::before, #ui *::after {
    animation:none !important; transition:none !important; }
}

/* ── short landscape screens (phones): slim the HUD down ───────── */
@media (max-height:430px) {
  #hud .bars { width:150px; gap:5px; }
  #hud .bar .track { height:6px; margin-top:2px; }
  #hud .compass { top:44px; }
}
`

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
const CONTROL_CHIPS = IS_TOUCH ? TOUCH_CHIPS : KEY_CHIPS

// The sensitivity slider works in multiples of the default (×0.25 … ×3.00);
// only the Settings store ever sees raw radians-per-pixel.
const SENS_MULT_MIN = +(SENS_MIN / SENS_DEFAULT).toFixed(2)
const SENS_MULT_MAX = +(SENS_MAX / SENS_DEFAULT).toFixed(2)

// The settings block lives on BOTH the title and pause cards, so it hooks into
// each card via data-key attributes (ids must stay unique); _cache collects one
// wired instance per card and refreshSettings() keeps them in lockstep.
const SETTINGS_HTML = `
  <div class="group">LOOK</div>
  <label>SENSITIVITY <span class="ctl">
    <input type="range" data-k="sens" min="${SENS_MULT_MIN}" max="${SENS_MULT_MAX}" step="0.05">
    <output class="val" data-k="sensVal"></output>
  </span></label>
  <label>INVERT Y <input type="checkbox" data-k="invY"></label>
  <label>INVERT X <input type="checkbox" data-k="invX"></label>
  <div class="group">AUDIO</div>
  <label>VOLUME <span class="ctl">
    <input type="range" data-k="vol" min="0" max="1" step="0.02">
    <output class="val" data-k="volVal"></output>
  </span></label>
  <div class="group">DISPLAY</div>
  <label>HEAD BOB <input type="checkbox" data-k="bob"></label>
  <label>INK OUTLINE <input type="checkbox" data-k="out"></label>
  <label>MINIMAP <input type="checkbox" data-k="map"></label>`

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
    style.textContent = CSS
    document.head.appendChild(style)

    const root = document.createElement('div')
    root.id = 'ui'
    root.classList.toggle('touch', IS_TOUCH)
    root.innerHTML = `
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
        <div class="mapwrap" id="hud-mapwrap"><canvas id="minimap" width="${MINIMAP_SIZE}" height="${MINIMAP_SIZE}"></canvas></div>
      </div>

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
            <button id="btn-settings" class="ghost">SETTINGS</button>
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
            <button class="ghost" id="btn-defaults">DEFAULTS</button>
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
      btnResume: $('#btn-resume'),
      btnRetry: $('#btn-restart'),
      minimap: $('#minimap'),
      mapwrap: $('#hud-mapwrap'),
    }
    // One handle set per .settings card (title + pause share SETTINGS_HTML).
    this.settingsBlocks = [...this.root.querySelectorAll('.settings')].map((rootEl) => {
      const q = (k) => rootEl.querySelector(`[data-k="${k}"]`)
      return {
        sens: q('sens'),
        sensVal: q('sensVal'),
        invY: q('invY'),
        invX: q('invX'),
        vol: q('vol'),
        volVal: q('volVal'),
        bob: q('bob'),
        out: q('out'),
        map: q('map'),
      }
    })
  }

  _wire() {
    const start = () =>
      this.onStart?.(this.el.seedInput.value.trim(), this.el.familySelect.value)
    this.el.btnStart.addEventListener('click', start)
    this.el.seedInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') start()
    })
    this.root
      .querySelector('#btn-settings')
      .addEventListener('click', () => this.el.titleSettings.classList.toggle('hidden'))
    this.el.btnResume.addEventListener('click', () => this.onResume?.())
    this.el.btnRetry.addEventListener('click', () => this.onRestart?.())
    this.root.querySelector('#btn-restart-p').addEventListener('click', () => this.onRestart?.())
    this.root.querySelector('#btn-defaults').addEventListener('click', () => this.onResetSettings?.())
    this.root.querySelector('#btn-quit').addEventListener('click', () => this.onQuit?.())

    // Every change round-trips through the Settings store, then BOTH cards are
    // re-synced from the (clamped) truth so they can never show stale values.
    const changed = () => this.refreshSettings()
    for (const b of this.settingsBlocks) {
      // The slider is in multiples of the default; the store keeps radians/px.
      b.sens.addEventListener('input', (e) => {
        this.onSetting?.('sensitivity', parseFloat(e.target.value) * SENS_DEFAULT)
        changed()
      })
      b.vol.addEventListener('input', (e) => {
        this.onSetting?.('volume', parseFloat(e.target.value))
        changed()
      })
      b.invY.addEventListener('change', (e) => {
        this.onSetting?.('invertY', e.target.checked)
        changed()
      })
      b.invX.addEventListener('change', (e) => {
        this.onSetting?.('invertX', e.target.checked)
        changed()
      })
      b.bob.addEventListener('change', (e) => {
        this.onSetting?.('bob', e.target.checked)
        changed()
      })
      b.out.addEventListener('change', (e) => {
        this.onSetting?.('outline', e.target.checked)
        changed()
      })
      b.map.addEventListener('change', (e) => {
        this.onSetting?.('minimap', e.target.checked)
        changed()
      })
    }
  }

  // Pull every control back from the store. Also the way anything that changes a
  // setting outside this panel (the M key, DEFAULTS) re-syncs the widgets.
  refreshSettings() {
    const s = this.settings
    const mult = s.get('sensitivity') / SENS_DEFAULT
    for (const b of this.settingsBlocks) {
      b.sens.value = mult
      b.sensVal.value = `×${mult.toFixed(2)}`
      b.vol.value = s.get('volume')
      b.volVal.value = `${Math.round(s.get('volume') * 100)}%`
      b.invY.checked = s.get('invertY')
      b.invX.checked = s.get('invertX')
      b.bob.checked = s.get('bob')
      b.out.checked = s.get('outline')
      b.map.checked = s.get('minimap')
    }
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
