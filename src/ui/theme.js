import { MINIMAP_SIZE } from './Minimap.js'

// ANIME + LIMINAL design language: the eerie warmth of empty backrooms drawn
// like a 90s anime background. Every component reads from the design tokens on
// #ui; the Minimap canvas mirrors them in ./Minimap.js (canvas can't read CSS
// custom properties per-frame).
export const UI_CSS = `
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

/* ── settings: grouped label/control rows, hairline separators ───── */
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
/* compact selects inside settings rows (the wide underline style above is for
   the title card's family picker) */
#ui .settings select { width:130px; flex:none; font-size:12px; padding:5px 2px;
  text-align:right; letter-spacing:.1em; }

/* advanced settings: collapsed by default. The toggle reads like a group
   label so the closed state stays visually quiet; the open section gets a
   hairline indent to mark it as the deep-tuning area. */
#ui .settings .adv-toggle { display:flex; justify-content:space-between;
  align-items:center; width:100%; margin-top:8px; padding:11px 2px;
  background:none; border:none; border-top:1px solid var(--line-weak);
  color:var(--gold-dim); font-size:10px; font-weight:400;
  letter-spacing:.32em; text-transform:uppercase; transition:color .2s; }
#ui .settings .adv-toggle:hover, #ui .settings .adv-toggle[aria-expanded="true"] {
  color:var(--gold); }
#ui .settings .adv-toggle .caret { transition:transform .2s; }
#ui .settings .adv-toggle[aria-expanded="true"] .caret { transform:rotate(180deg); }
#ui .settings .adv { display:flex; flex-direction:column; margin-top:2px;
  padding-left:12px; border-left:1px solid var(--line-weak); }
#ui .settings .adv .adv-reset { align-self:center; margin:14px 0 4px;
  padding:8px 18px; font-size:11px; }

/* ── death panel: red-shifted card ─────────────────────────────── */
#p-dead .card { border-color:rgba(224,88,74,.4); }
#p-dead h1 { text-shadow:0 0 2px rgba(244,220,200,.7), 0 0 18px rgba(224,88,74,.45),
             0 0 44px rgba(224,88,74,.2); }
#p-dead .jp-accent { color:rgba(224,88,74,.75); text-shadow:0 0 10px rgba(224,88,74,.3); }

/* ── transition panel: no-clip glitch ──────────────────────────── */
#p-trans .glitch { animation:glitch-jitter 2.8s steps(1,end) infinite; }
#ui.reduce-flicker #p-trans .glitch { animation:none; }
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

/* ── title: full-bleed main menu over the live world backdrop ─────
   Left column = wordmark + menu; the right side keeps the world visible
   (lighter scrim there). No backdrop-filter on the full panel — the world
   behind it is a live deferred frame, and blurring it every frame is waste. */
#ui #p-title { display:block; padding:0; text-align:left;
  background:
    repeating-linear-gradient(0deg, rgba(0,0,0,.07) 0 1px, transparent 1px 3px),
    linear-gradient(90deg, rgba(10,9,5,.93) 0%, rgba(10,9,5,.8) 30%,
                    rgba(10,9,5,.28) 64%, rgba(10,9,5,.46) 100%),
    radial-gradient(ellipse 80% 75% at 70% 46%, transparent 35%, rgba(10,9,5,.6) 100%); }
#p-title .title-main { position:absolute; inset:0; display:flex; flex-direction:column;
  gap:clamp(18px,4.2vh,44px); width:min(780px,100%); overflow-y:auto; overflow-x:clip;
  padding:clamp(20px,6vh,72px) clamp(20px,7vw,120px) calc(clamp(20px,6vh,72px) + 44px);
  transition:opacity .25s; }
/* auto margins = "safe" centering: overflowing content scrolls from the top
   instead of being clipped above it the way justify-content:center would. */
#p-title .brand { display:flex; flex-direction:column; align-items:flex-start;
  gap:clamp(10px,1.8vh,16px); margin-top:auto; }
#p-title .kicker { justify-content:flex-start; }
#p-title .kicker::before { display:none; }

/* wordmark: THE / YELLOW (lit tubes) / ROOMS (hollow neon outline) */
#p-title .logo { display:flex; flex-direction:column; align-items:flex-start;
  font-size:clamp(40px, min(12vh, 10.5vw), 132px); line-height:.94;
  letter-spacing:.05em; white-space:nowrap; font-weight:800; text-shadow:none; }
#p-title .logo-the { display:flex; align-items:center; gap:.8em; margin:0 0 .45em .1em;
  font-size:.19em; font-weight:700; letter-spacing:.9em; color:var(--gold);
  text-shadow:0 0 12px var(--amber-glow); }
#p-title .logo-the::after { content:''; width:4.5em; height:1px; background:var(--line); }
#p-title .logo-word { display:block; }
#p-title .lit .lt { color:#fbefc4;
  text-shadow:0 0 2px rgba(255,248,220,.9), 0 0 .12em rgba(232,207,122,.7),
              0 0 .42em rgba(232,207,122,.32); }
#p-title .hollow .lt { color:rgba(23,18,10,.4); -webkit-text-stroke:max(1px,.02em) var(--gold);
  text-shadow:0 0 .16em rgba(232,207,122,.4); }
/* every tube flickers on once per arrival; one keeps failing afterwards */
#p-title:not(.hidden) .lt { animation:tube-on .8s steps(1,end) calc(120ms + var(--i) * 55ms) both; }
#p-title:not(.hidden) .lt.fail {
  animation:tube-on .8s steps(1,end) calc(120ms + var(--i) * 55ms) both,
            tube-fail 9s steps(1,end) 3s infinite; }
@keyframes tube-on { 0% { opacity:0; } 10% { opacity:.85; } 16% { opacity:.08; }
  28% { opacity:1; } 34% { opacity:.3; } 44%,100% { opacity:1; } }
@keyframes tube-fail { 0%,88%,100% { opacity:1; } 89% { opacity:.15; } 90% { opacity:.9; }
  91.5% { opacity:.2; } 93% { opacity:1; } 96% { opacity:.55; } 97% { opacity:1; } }
/* REDUCE FLICKER (photosensitivity, Settings 'reduceFlicker'): the power-on
   and failing-tube flicker swing opacity by up to 90% several times a second,
   so they are dropped. The tubes simply glow; the failing one keeps a slow
   ~0.2 Hz sag (one soft change, well under the 3 Hz flash limit). */
#ui.reduce-flicker #p-title:not(.hidden) .lt { animation:none; }
#ui.reduce-flicker #p-title:not(.hidden) .lt.fail { animation:tube-sag 5s ease-in-out 3s infinite; }
@keyframes tube-sag { 0%,100% { opacity:1; } 50% { opacity:.7; } }

/* fluorescent hum: a hairline with a slow travelling highlight */
#p-title .hum { position:relative; width:min(440px,72%); height:1px;
  background:var(--line); overflow:hidden; }
#p-title .hum::after { content:''; position:absolute; top:0; bottom:0; left:0; width:30%;
  background:linear-gradient(90deg, transparent, var(--gold), transparent);
  animation:hum-sweep 5.5s cubic-bezier(.4,0,.2,1) infinite; }
@keyframes hum-sweep { from { transform:translateX(-100%); } to { transform:translateX(340%); } }
#p-title .tagline { margin:0; color:var(--paper-dim); font-size:13px; line-height:1.9;
  letter-spacing:.12em; }

/* menu: left-aligned console-style items; hover and keyboard focus share
   one look (gold rail + caret + nudge) */
#p-title .menu { display:flex; flex-direction:column; align-items:stretch; gap:4px;
  width:min(400px,100%); margin-bottom:auto; }
#p-title .mi { position:relative; display:flex; align-items:center;
  justify-content:space-between; gap:12px; width:100%; padding:13px 18px;
  background:transparent; border:none; color:var(--paper-dim); text-align:left;
  font-size:14px; letter-spacing:.3em;
  transition:color .18s, padding-left .18s, background-color .18s; }
#p-title .mi::before { content:''; position:absolute; left:0; top:22%; bottom:22%; width:2px;
  background:var(--gold); box-shadow:0 0 8px var(--amber-glow);
  transform:scaleY(0); transition:transform .18s; }
#p-title .mi-caret { color:var(--gold); opacity:0; transform:translateX(-6px);
  transition:opacity .18s, transform .18s; }
#p-title .mi:hover, #p-title .mi:focus-visible, #p-title .mi[aria-expanded="true"] {
  color:var(--paper); padding-left:26px; outline:none;
  background-color:rgba(232,207,122,.08); }
#p-title .mi:hover::before, #p-title .mi:focus-visible::before,
#p-title .mi[aria-expanded="true"]::before { transform:scaleY(1); }
#p-title .mi:hover .mi-caret, #p-title .mi:focus-visible .mi-caret,
#p-title .mi[aria-expanded="true"] .mi-caret { opacity:1; transform:none; }
/* ENTER: the gold primary bar (inherits .primary's clip + shine) */
#p-title .mi.primary { min-width:0; padding:16px 20px; margin-bottom:4px;
  color:var(--ink); font-size:15px; background:var(--gold); }
#p-title .mi.primary::before { display:none; }
#p-title .mi.primary .mi-caret { color:var(--ink); opacity:1; transform:none; }
#p-title .mi.primary:hover, #p-title .mi.primary:focus-visible {
  color:var(--ink); background:#f4e08e; padding-left:26px; }
#p-title .mi.primary:focus-visible { outline:2px solid var(--ink); outline-offset:-5px; }

/* run parameters: seed + map family under ENTER */
#p-title .world { display:grid; grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);
  gap:2px 18px; margin:2px 0 8px; padding:8px 18px 6px;
  border-left:1px solid var(--line-weak); }
#p-title .field { display:flex; flex-direction:column; gap:1px; min-width:0; }
#p-title .field-lab { font-size:10px; letter-spacing:.32em; color:var(--gold-dim); }
#p-title .field input[type=text], #p-title .field select { width:100%; padding:7px 2px;
  text-align:left; font-size:13px; letter-spacing:.12em; }
#p-title .world-note { grid-column:1 / -1; min-height:1.7em; padding-top:6px;
  font-size:11px; letter-spacing:.02em; color:var(--paper-dim); opacity:.85; }

/* vertical kanji running down the right edge, anime title-card style */
#p-title .jp-vert { position:absolute; top:50%; right:clamp(16px,4.5vw,72px);
  transform:translateY(-50%); writing-mode:vertical-rl; pointer-events:none;
  font-size:clamp(22px,5.4vh,58px); letter-spacing:.42em; color:rgba(232,207,122,.34);
  text-shadow:0 0 18px rgba(232,207,122,.2); user-select:none; transition:opacity .25s; }
#p-title .jp-vert::before { content:''; position:absolute; top:-2.2em; left:50%;
  width:1px; height:1.6em; background:var(--line); }

/* footer: control legend + build tag */
#p-title .title-foot { position:absolute; left:0; right:0; bottom:0; display:flex;
  justify-content:space-between; align-items:flex-end; gap:16px; pointer-events:none;
  padding:0 max(clamp(20px,7vw,120px), env(safe-area-inset-right))
          max(18px, env(safe-area-inset-bottom)) max(clamp(20px,7vw,120px), env(safe-area-inset-left)); }
#p-title .title-foot .chips { justify-content:flex-start; max-width:min(560px,62vw); }
#p-title .title-foot .chip { padding:3px 8px; font-size:10px; background:rgba(23,18,10,.5); }
#p-title .build { font-size:10px; letter-spacing:.22em; color:var(--paper-dim);
  opacity:.7; text-align:right; text-transform:uppercase; }

/* settings side sheet */
#p-title .sheet { position:absolute; top:0; right:0; bottom:0; z-index:2;
  display:flex; flex-direction:column; gap:18px; width:min(460px,100%); overflow-y:auto;
  padding:max(28px, env(safe-area-inset-top)) max(28px, env(safe-area-inset-right))
          max(28px, env(safe-area-inset-bottom)) 28px;
  background:var(--ink-90); border-left:1px solid var(--line);
  box-shadow:-24px 0 48px rgba(0,0,0,.45);
  animation:sheet-in .32s cubic-bezier(.16,1,.3,1) both; }
@supports ((backdrop-filter:blur(10px)) or (-webkit-backdrop-filter:blur(10px))) {
  #p-title .sheet { background:rgba(23,18,10,.8);
    -webkit-backdrop-filter:blur(12px) saturate(1.15);
    backdrop-filter:blur(12px) saturate(1.15); }
}
@keyframes sheet-in { from { opacity:0; transform:translateX(24px); } }
#p-title .sheet-head { display:flex; justify-content:space-between; align-items:flex-start; }
#p-title .sheet-head h2 { margin:6px 0 0; font-size:20px; letter-spacing:.3em; }
#p-title .sheet-close { padding:8px 13px; font-size:14px; letter-spacing:0; }
#p-title .sheet .settings { width:100%; }
#p-title.sheet-open .title-main { opacity:.3; }
#p-title.sheet-open .jp-vert { opacity:0; }

/* staggered arrival: brand details, then the menu items */
#p-title:not(.hidden) .kicker,
#p-title:not(.hidden) .hum,
#p-title:not(.hidden) .tagline,
#p-title:not(.hidden) .menu > *,
#p-title:not(.hidden) .jp-vert,
#p-title:not(.hidden) .title-foot { animation:title-rise .6s cubic-bezier(.16,1,.3,1) both; }
#p-title:not(.hidden) .kicker { animation-delay:.05s; }
#p-title:not(.hidden) .hum { animation-delay:.6s; }
#p-title:not(.hidden) .hum::after { animation-delay:1.2s; }
#p-title:not(.hidden) .tagline { animation-delay:.7s; }
#p-title:not(.hidden) .menu > :nth-child(1) { animation-delay:.8s; }
#p-title:not(.hidden) .menu > :nth-child(2) { animation-delay:.87s; }
#p-title:not(.hidden) .menu > :nth-child(3) { animation-delay:.94s; }
#p-title:not(.hidden) .menu > :nth-child(4) { animation-delay:1.01s; }
#p-title:not(.hidden) .jp-vert { animation-name:title-fade; animation-duration:1.4s;
  animation-delay:.4s; }
#p-title:not(.hidden) .title-foot { animation-name:title-fade; animation-delay:1.1s; }
@keyframes title-rise { from { opacity:0; transform:translateY(8px); } }
@keyframes title-fade { from { opacity:0; } }

/* narrow windows: the kanji would collide with the wordmark, and the legend
   wraps to several rows — stack it in flow under the (scrollable) menu column
   so the two can never overlap. */
@media (max-width:760px) {
  #ui #p-title { display:flex; flex-direction:column; align-items:stretch; }
  #p-title .title-main { position:relative; inset:auto; flex:1 1 auto; min-height:0;
    padding-bottom:clamp(16px,3vh,32px); }
  #p-title .title-foot { position:relative; flex:none; }
  #p-title .jp-vert { display:none; }
  #p-title .title-foot .build { display:none; }
}
/* short landscape (phones): wordmark left, menu right, no legend */
@media (max-height:520px) and (min-width:560px) {
  #ui #p-title { background:
    repeating-linear-gradient(0deg, rgba(0,0,0,.07) 0 1px, transparent 1px 3px),
    linear-gradient(90deg, rgba(10,9,5,.9), rgba(10,9,5,.72)); }
  #p-title .title-main { flex-direction:row; align-items:center; justify-content:center;
    gap:clamp(20px,5vw,64px); width:100%;
    padding:14px max(24px, env(safe-area-inset-right)) 14px max(24px, env(safe-area-inset-left)); }
  #p-title .brand, #p-title .menu { margin:auto 0; }
  #p-title .logo { font-size:clamp(32px, 13vh, 76px); }
  #p-title .tagline, #p-title .jp-vert, #p-title .title-foot { display:none; }
  #p-title .menu { width:min(380px,48vw); }
  #p-title .mi { padding:10px 14px; }
  #p-title .mi.primary { padding:12px 16px; }
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

/* pointer-lock recovery hint (browser refused the re-lock after an Esc-resume):
   centered near the bottom so it reads over the world, pulsing like the
   low-resource bars so it can't be mistaken for static chrome. */
#hud .relock { position:absolute; left:50%; bottom:96px; transform:translateX(-50%);
  color:var(--gold); border-color:var(--gold); background:var(--ink-90);
  animation:bar-pulse .8s ease-in-out infinite; }
#ui.touch #hud .relock { display:none; } /* touch mode never locks */

/* minimap: hairline gold ring + inner vignette (no heavy bezel) */
#hud .mapwrap { position:absolute; right:18px; top:40px;
  width:${MINIMAP_SIZE}px; height:${MINIMAP_SIZE}px; border-radius:50%;
  overflow:hidden; border:1px solid var(--line);
  background:radial-gradient(circle at 50% 42%, rgba(40,36,12,.3), rgba(10,9,5,.85));
  box-shadow:inset 0 0 22px rgba(0,0,0,.55); }
#hud #minimap { display:block; width:${MINIMAP_SIZE}px; height:${MINIMAP_SIZE}px; }
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
