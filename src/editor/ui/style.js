// Editor chrome CSS. Design tokens (custom properties on #editor) reuse the
// game palette from src/ui/theme.js (ink / paper / gold / mint / violet / red
// / line). The `dbg-` classes style the shared debug widget kit
// (src/debug/widgets.js) inside the editor only; `edt-` classes are
// editor-specific. Text colours meet WCAG AA (≥ 4.5:1) on their surfaces.

export const EDITOR_CSS = `
  /* Tokens live on :root so overlays appended to <body> (tooltip, dialogs,
     popovers) share them. The editor page hosts nothing else. */
  :root {
    color-scheme: dark;
    /* game palette (src/ui/theme.js) */
    --ink: #17120a; --paper: #f4e9c8; --gold: #e8cf7a; --gold-dim: #8a7a3f;
    --mint: #9fd0c0; --violet: #c9a8e0; --red: #e0584a; --line: rgba(232,207,122,.28);
    /* surfaces */
    --bg-0: #0d0d09; --bg-1: #14110a; --bg-2: #1b160c; --bg-3: #241e10; --bg-4: #33290f;
    --border: #3a3212; --border-strong: #5e501a;
    /* field / segmented edges: ≥ 3:1 on every surface they sit on (WCAG 1.4.11) */
    --border-field: #806f30;
    /* text (dimmest allowed for text: --text-3, 6:1 on --bg-1) */
    --text: #e8e0a0; --text-2: #c9bd7a; --text-3: #a89a5c; --text-disabled: #7d7247;
    /* accents & status */
    --accent: #cdbf6e; --accent-strong: #ffe6a0; --accent-bg: #4a3f18;
    --info: #78c8ff; --info-bg: #1d3a4a; --focus: #78c8ff;
    --ok: #9fe0a8; --ok-bg: #1f3a22; --warn: #ffcf7a; --warn-bg: #4a3510; --err: #ff8f80; --err-bg: #4a1c14;
    /* scale */
    --s-1: 2px; --s-2: 4px; --s-3: 6px; --s-4: 8px; --s-5: 12px; --s-6: 16px;
    --r-1: 3px; --r-2: 6px; --r-3: 10px;
    --font-ui: system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, sans-serif;
    --font-data: ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace;
    --fs-data: 11.5px; --fs-body: 12.5px; --fs-label: 13px; --fs-head: 14px;
    --appbar-h: 44px; --status-h: 28px; --rail-w: 52px; --insp-w: 356px;
    --shadow: 0 8px 28px rgba(0,0,0,.55);
  }
  #editor {
    position: fixed; inset: 0; display: block;
    font: var(--fs-body)/1.45 var(--font-ui); color: var(--text); background: var(--bg-0);
  }
  #editor *, .edt-overlay *, .edt-tooltip, .edt-popover { box-sizing: border-box; }

  /* ── shell grid ───────────────────────────────────────────────────── */
  .edt-shell { position: absolute; inset: 0; display: grid;
    grid-template-columns: var(--rail-w) minmax(0, 1fr) var(--insp-w);
    grid-template-rows: var(--appbar-h) minmax(0, 1fr) var(--status-h);
    grid-template-areas: "bar bar bar" "rail center insp" "status status status";
    user-select: none; -webkit-user-select: none; }
  .edt-shell.edt-inspector-hidden { grid-template-columns: var(--rail-w) minmax(0, 1fr) 0; }
  .edt-shell.edt-inspector-hidden .edt-inspector { display: none; }
  .edt-selectable, .dbg-block, .dbg-read, .edt-sb-hover, .edt-sb-notice, .edt-report td,
  .edt-note, .edt-card, .edt-help, .edt-history-list, .edt-level-stats, input, select {
    user-select: text; -webkit-user-select: text; }

  :where(#editor, .edt-overlay, .edt-popover) :focus-visible {
    outline: 2px solid var(--focus); outline-offset: 1px; border-radius: var(--r-1); }
  :where(#editor, .edt-overlay) :focus:not(:focus-visible) { outline: none; }
  .edt-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

  /* ── app bar ──────────────────────────────────────────────────────── */
  .edt-appbar { grid-area: bar; display: flex; align-items: center; gap: var(--s-3);
    padding: 0 var(--s-4); background: var(--bg-1); border-bottom: 1px solid var(--border-strong);
    min-width: 0; overflow: hidden; }
  .edt-brand { display: flex; align-items: center; gap: var(--s-3); color: var(--accent); flex: 0 0 auto; }
  .edt-brand-mark { display: grid; place-items: center; width: 28px; height: 28px; border-radius: var(--r-2);
    background: var(--gold); color: var(--ink); font: 700 12px/1 var(--font-data); letter-spacing: .5px; }
  .edt-brand-text { font-size: var(--fs-label); letter-spacing: 1.5px; text-transform: uppercase; color: var(--text-2); }
  .edt-docname { flex: 0 1 200px; min-width: 90px; height: 28px; font: var(--fs-label) var(--font-ui); }
  .edt-modeswitch { display: flex; flex: 0 0 auto; border: 1px solid var(--border-strong); border-radius: var(--r-2); overflow: hidden; }
  .edt-mode-btn { background: var(--bg-2); color: var(--text-3); border: 0; padding: 0 var(--s-5); height: 28px;
    font: 600 var(--fs-body) var(--font-ui); cursor: pointer; }
  .edt-mode-btn + .edt-mode-btn { border-left: 1px solid var(--border-strong); }
  .edt-mode-btn:hover { background: var(--bg-3); color: var(--text); }
  .edt-mode-btn.edt-on { background: var(--accent-bg); color: var(--accent-strong); }
  .edt-sep { width: 1px; height: 22px; background: var(--border); flex: 0 0 auto; }
  .edt-spacer { flex: 1; min-width: 0; }
  .edt-search { display: flex; align-items: center; gap: var(--s-3); height: 28px; padding: 0 var(--s-4);
    min-width: 0; flex: 0 1 220px; background: var(--bg-2); color: var(--text-3); border: 1px solid var(--border-strong);
    border-radius: var(--r-2); cursor: pointer; font: var(--fs-body) var(--font-ui); }
  .edt-search:hover { color: var(--text); background: var(--bg-3); }
  .edt-search-text { flex: 1; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  kbd { font: 600 10.5px/1 var(--font-data); color: var(--text-2); background: var(--bg-3);
    border: 1px solid var(--border-strong); border-bottom-width: 2px; border-radius: 4px; padding: 2px 5px; white-space: nowrap; }

  .edt-ibtn { display: inline-flex; align-items: center; justify-content: center; gap: var(--s-2);
    min-width: 28px; height: 28px; padding: 0 var(--s-2); background: transparent; color: var(--text-2);
    border: 1px solid transparent; border-radius: var(--r-2); cursor: pointer; font: var(--fs-body) var(--font-ui); flex: 0 0 auto; }
  .edt-ibtn:hover { background: var(--bg-3); color: var(--text); border-color: var(--border); }
  .edt-ibtn.edt-on, .edt-ibtn[aria-pressed="true"] { background: var(--accent-bg); color: var(--accent-strong); border-color: var(--border-strong); }
  .edt-ibtn-text { padding: 0 var(--s-4) 0 var(--s-3); }
  .edt-ibtn[aria-disabled="true"], .edt-rail-btn[aria-disabled="true"] { color: var(--text-disabled); cursor: not-allowed; background: transparent; }
  .edt-icon { flex: 0 0 auto; display: block; }
  .edt-chip { display: inline-flex; align-items: center; height: 22px; padding: 0 var(--s-3); border-radius: 11px;
    background: var(--bg-2); border: 1px solid var(--border); color: var(--text-2); font: var(--fs-data) var(--font-data);
    white-space: nowrap; flex: 0 0 auto; }
  .edt-chip-warn { background: var(--warn-bg); color: var(--warn); border-color: #7a5a1a; }

  /* ── tool rail ────────────────────────────────────────────────────── */
  .edt-rail { grid-area: rail; display: flex; flex-direction: column; justify-content: space-between;
    background: var(--bg-1); border-right: 1px solid var(--border-strong); padding: var(--s-3) 0; overflow-y: auto; overflow-x: hidden; }
  .edt-rail-tools, .edt-rail-bottom { display: flex; flex-direction: column; align-items: center; gap: var(--s-1); }
  .edt-rail-btn { position: relative; display: grid; place-items: center; width: 40px; height: 38px; flex: 0 0 auto;
    background: transparent; color: var(--text-2); border: 1px solid transparent; border-radius: var(--r-2); cursor: pointer; }
  .edt-rail-btn:hover { background: var(--bg-3); color: var(--text); }
  .edt-rail-btn.edt-on { background: var(--accent-bg); color: var(--accent-strong); border-color: var(--border-strong); }
  .edt-rail-btn.edt-on::before { content: ''; position: absolute; left: -6px; top: 8px; bottom: 8px; width: 3px; border-radius: 2px; background: var(--gold); }
  .edt-rail-key { position: absolute; right: 2px; bottom: 1px; font: 600 9.5px/1 var(--font-data); color: var(--text-3); }
  .edt-rail-btn.edt-on .edt-rail-key { color: var(--accent-strong); }
  .edt-rail-sep { width: 26px; height: 1px; background: var(--border); margin: var(--s-2) 0; }
  .edt-rail-lock[aria-pressed="true"] { color: var(--mint); background: transparent; border-color: transparent; }
  .edt-rail-lock[aria-pressed="false"] { color: var(--warn); }
  .edt-rail-lock-icon { display: grid; place-items: center; }

  /* ── center: tool bar + viewport ─────────────────────────────────── */
  .edt-center { grid-area: center; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .edt-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: var(--s-3) var(--s-4);
    padding: var(--s-2) var(--s-4); min-height: 38px; background: var(--bg-1); border-bottom: 1px solid var(--border); }
  .edt-tb-title { display: flex; align-items: center; gap: var(--s-3); color: var(--accent-strong); font-weight: 600; flex: 0 0 auto; }
  .edt-tb-opts { display: flex; align-items: center; gap: var(--s-4); flex-wrap: wrap; min-width: 0; }
  .edt-tb-opts .dbg-row { margin: 0; }
  .edt-tb-opts .dbg-label { flex: 0 0 auto; }
  .edt-tb-opts .dbg-seg { margin: 0; }
  .edt-tb-hint { flex: 1 1 0; min-width: 0; color: var(--text-3); font-size: var(--fs-data);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .edt-tb-view { display: flex; align-items: center; gap: var(--s-2); margin-left: auto; flex: 0 0 auto; }
  .edt-stepper { display: flex; align-items: center; border: 1px solid var(--border); border-radius: var(--r-2); margin-right: var(--s-3); }
  .edt-floor-label { min-width: 54px; height: 28px; background: transparent; border: 0; color: var(--accent-strong);
    font: 600 var(--fs-body) var(--font-data); cursor: pointer; }
  .edt-floor-label:hover { background: var(--bg-3); }
  .edt-viewport { position: relative; flex: 1; min-height: 0; overflow: hidden; background: var(--bg-0); }
  .edt-viewport:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
  .edt-viewport:focus:not(:focus-visible) { outline: none; }
  .edt-plan { position: absolute; left: 0; right: 0; top: 0; bottom: 0; overflow: hidden; }
  .edt-plan canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }

  .edt-section { position: absolute; left: 0; right: 0; bottom: 0; display: flex;
    flex-direction: column; background: #0b0b08; border-top: 1px solid var(--border-strong); }
  .edt-section-handle { position: absolute; left: 0; right: 0; top: -5px; height: 10px; cursor: ns-resize; z-index: 2; touch-action: none; }
  .edt-section-handle::after { content: ''; position: absolute; left: 50%; top: 3px; width: 44px; height: 4px;
    margin-left: -22px; border-radius: 2px; background: var(--text-3); }
  .edt-section-handle:hover::after, .edt-section-handle:focus-visible::after { background: var(--info); }
  .edt-section-head { display: flex; align-items: center; gap: var(--s-3); padding: var(--s-2) var(--s-4);
    color: var(--info); background: #12100a; border-bottom: 1px solid var(--border);
    letter-spacing: .5px; white-space: nowrap; overflow: hidden; font: var(--fs-data) var(--font-data); }
  .edt-section-read { color: var(--text-2); letter-spacing: 0; margin-left: var(--s-4); overflow: hidden; text-overflow: ellipsis; }
  .edt-section canvas { flex: 1; min-height: 0; width: 100%; display: block; touch-action: none; }

  /* ── welcome card ─────────────────────────────────────────────────── */
  .edt-welcome { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 5;
    width: min(520px, calc(100% - 32px)); padding: var(--s-6) 20px; background: rgba(23,18,10,.94);
    border: 1px solid var(--line); border-radius: var(--r-3); box-shadow: var(--shadow); }
  .edt-welcome[hidden] { display: none; }
  .edt-welcome h2 { margin: 0 0 var(--s-2); font-size: 18px; color: var(--gold); letter-spacing: 1px; }
  .edt-welcome p { margin: 0 0 var(--s-5); color: var(--text-2); }
  .edt-welcome-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: var(--s-4); }
  .edt-welcome-btn { display: flex; align-items: center; gap: var(--s-4); padding: var(--s-4) var(--s-5); min-height: 44px;
    background: var(--bg-2); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--r-2);
    cursor: pointer; font: var(--fs-body) var(--font-ui); text-align: left; }
  .edt-welcome-btn:hover { background: var(--bg-4); color: var(--accent-strong); }
  .edt-welcome-close { position: absolute; right: 8px; top: 8px; }
  .edt-welcome-never { display: flex; align-items: center; gap: var(--s-3); margin-top: var(--s-5); color: var(--text-3); }

  /* ── inspector ────────────────────────────────────────────────────── */
  .edt-inspector { grid-area: insp; display: flex; flex-direction: column; min-height: 0; min-width: 0;
    background: var(--bg-1); border-left: 1px solid var(--border-strong); }
  .edt-tabs { display: flex; gap: 1px; padding: var(--s-3) var(--s-3) 0; border-bottom: 1px solid var(--border-strong);
    flex: 0 0 auto; overflow-x: auto; scrollbar-width: none; }
  .edt-tab { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 2px;
    padding: var(--s-2) 2px var(--s-3); background: transparent; color: var(--text-3); border: 0;
    border-bottom: 2px solid transparent; cursor: pointer; font: 600 11px var(--font-ui); letter-spacing: .2px; }
  .edt-tab span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .edt-tab:hover { color: var(--text); background: var(--bg-2); }
  .edt-tab.edt-on { color: var(--accent-strong); border-bottom-color: var(--gold); }
  .edt-tabpanels { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
  .edt-tabpanel { padding: var(--s-3) var(--s-4) 40px; }
  .edt-tabpanel[hidden] { display: none; }
  .edt-tabpanel:focus { outline: none; }
  .edt-slot:empty { display: none; }

  .edt-card { margin: var(--s-4) var(--s-4) 0; padding: var(--s-3) var(--s-4) var(--s-4); background: var(--bg-2);
    border: 1px solid var(--border-strong); border-radius: var(--r-2); flex: 0 0 auto; }
  .edt-card[hidden] { display: none; }
  .edt-card-head { display: flex; align-items: center; gap: var(--s-3); color: var(--accent-strong); font-weight: 600; }
  .edt-card-close { margin-left: auto; min-width: 24px; height: 24px; }
  .edt-card .dbg-block { margin: var(--s-2) 0; }
  .edt-card-actions .dbg-row, .edt-card-actions { display: flex; flex-wrap: wrap; gap: var(--s-3); align-items: center; }

  /* ── widget kit inside the editor ─────────────────────────────────── */
  #editor .dbg-section { border: 1px solid var(--border); border-radius: var(--r-2); margin: var(--s-4) 0; background: #171309; }
  #editor .dbg-sec-head { display: flex; align-items: center; gap: var(--s-3); padding: var(--s-3) var(--s-4); cursor: pointer;
    color: var(--accent); letter-spacing: .4px; font: 600 var(--fs-label) var(--font-ui); border-radius: var(--r-2); }
  #editor .dbg-sec-head::before { content: ''; width: 7px; height: 7px; border-right: 2px solid currentColor;
    border-bottom: 2px solid currentColor; transform: rotate(45deg) translate(-2px, -2px); transition: transform .12s; flex: 0 0 auto; }
  #editor .dbg-sec-head.dbg-collapsed::before { transform: rotate(-45deg); }
  #editor .dbg-sec-head:hover { background: var(--bg-3); }
  #editor .dbg-sec-head.dbg-collapsed { opacity: 1; color: var(--text-2); }
  #editor .dbg-sec-body { padding: var(--s-1) var(--s-4) var(--s-4); }
  #editor .dbg-row { display: flex; align-items: center; gap: var(--s-3); margin: var(--s-2) 0; flex-wrap: wrap; }
  #editor .dbg-label { flex: 0 0 92px; color: var(--text-3); }
  #editor .dbg-toggle { cursor: pointer; min-height: 24px; }
  #editor .dbg-toggle .dbg-label { flex: 1 1 auto; color: var(--text-2); }
  #editor .dbg-val { flex: 0 0 auto; color: var(--text); min-width: 30px; text-align: right; font-family: var(--font-data); }
  #editor .dbg-range { flex: 1; accent-color: var(--accent); min-width: 60px; }
  #editor .dbg-toggle input { accent-color: var(--accent); width: 15px; height: 15px; margin: 0; }
  #editor .dbg-btn, .edt-overlay .dbg-btn { background: var(--bg-3); color: var(--text); border: 1px solid var(--border-strong);
    border-radius: var(--r-1); padding: 3px 10px; min-height: 26px; cursor: pointer; font: var(--fs-body) var(--font-ui); }
  #editor .dbg-btn:hover, .edt-overlay .dbg-btn:hover { background: var(--bg-4); }
  #editor .dbg-btn[aria-disabled="true"] { color: var(--text-disabled); }
  #editor .dbg-seg { display: flex; flex-wrap: wrap; gap: 3px; margin: var(--s-2) 0; }
  #editor .dbg-seg-btn { background: var(--bg-2); color: var(--text-2); border: 1px solid var(--border-field); border-radius: var(--r-1);
    padding: 2px 8px; min-height: 24px; cursor: pointer; font: var(--fs-body) var(--font-ui); }
  #editor .dbg-seg-btn:hover { background: var(--bg-3); color: var(--text); }
  #editor .dbg-seg-btn.dbg-seg-on { background: var(--accent-bg); color: var(--accent-strong); border-color: var(--accent); }
  #editor .dbg-read { display: flex; justify-content: space-between; gap: var(--s-4); margin: var(--s-1) 0; }
  #editor .dbg-read-k { color: var(--text-3); }
  #editor .dbg-read-v { color: var(--text); font-family: var(--font-data); font-size: var(--fs-data); text-align: right; }
  #editor .dbg-block { white-space: pre-wrap; color: var(--text-2); margin: var(--s-2) 0; overflow-x: auto;
    font: var(--fs-data)/1.5 var(--font-data); }
  #editor .dbg-block:empty { display: none; }
  .dbg-btn.edt-mini { padding: 1px 8px; min-height: 22px; font-size: 11px; letter-spacing: 0; }
  .dbg-btn.edt-on { background: var(--info-bg) !important; border-color: #3e7ea0 !important; color: #bfe6ff !important; }
  .dbg-btn.edt-danger, .edt-overlay .dbg-btn.edt-danger { background: #6a2a18; border-color: #a0482c; color: #ffe0d6; }
  .dbg-btn.edt-danger:hover, .edt-overlay .dbg-btn.edt-danger:hover { background: #803420; }
  .dbg-btn.edt-primary { background: var(--accent-bg); color: var(--accent-strong); }
  .dbg-btn.edt-danger-ghost:hover { background: var(--err-bg); color: var(--err); border-color: #7a3020; }

  .edt-input { background: var(--bg-2); color: var(--text); border: 1px solid var(--border-field); border-radius: var(--r-1);
    padding: 3px 7px; min-height: 26px; font: var(--fs-body) var(--font-ui); flex: 1; min-width: 0; }
  .edt-input:hover { border-color: var(--accent); }
  .edt-input:disabled { color: var(--text-disabled); }
  select.edt-input { appearance: auto; }
  .edt-note { color: var(--text-3); font-size: var(--fs-data); margin: var(--s-2) 0; }
  .edt-muted { opacity: .85; }
  .edt-more { align-self: center; color: var(--text-3); font-size: var(--fs-data); padding: 0 var(--s-3); }

  /* lists */
  .edt-list { margin: var(--s-2) 0; max-height: 220px; overflow-y: auto; border-radius: var(--r-1); }
  .edt-structs { max-height: 260px; }
  .edt-list-row { padding: 2px var(--s-3); color: var(--text-2); border-radius: var(--r-1);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font: var(--fs-data)/1.7 var(--font-data); }
  .edt-list-row.edt-clickable { cursor: pointer; }
  .edt-list-row.edt-clickable:hover { background: var(--bg-3); color: var(--text); }
  .edt-list-row.edt-on { background: var(--bg-4); color: var(--accent-strong); }
  .edt-list-row.edt-dim, .edt-dim { color: var(--text-3); }
  .edt-struct-row { display: flex; align-items: center; gap: var(--s-3); }
  .edt-struct-label { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  .edt-struct-item { display: flex; align-items: center; gap: var(--s-2); }
  .edt-struct-item > .edt-list-row { flex: 1; min-width: 0; }
  .edt-swatch { flex: 0 0 9px; height: 9px; border-radius: 2px; }
  .edt-catalog-list { display: flex; flex-direction: column; gap: 4px; max-height: 420px; overflow-y: auto; }
  .edt-catalog-row { display: flex; align-items: flex-start; gap: 6px; padding: 5px 6px; border: 1px solid var(--border); border-radius: var(--r-1); background: var(--surface-2, transparent); }
  .edt-catalog-row .edt-swatch { width: 4px; align-self: stretch; border-radius: 2px; flex: 0 0 auto; }
  .edt-catalog-name { flex: 1 1 auto; min-width: 0; }
  .edt-catalog-title { color: var(--text-1); font-weight: 600; }
  .edt-catalog-meta { color: var(--text-2); font-size: 11px; }
  .edt-catalog-about { color: var(--text-3); font-size: 11px; line-height: 1.35; margin-top: 2px; }
  .edt-catalog-actions { display: flex; flex-direction: column; gap: 3px; flex: 0 0 auto; }
  .edt-catalog-actions .dbg-btn { min-width: 52px; }
  .edt-size { min-width: 20px; text-align: center; font-weight: 700; }
  .edt-size-landmark { background: var(--warn-bg); color: var(--warn); }
  .edt-size-small { background: var(--ok-bg); color: var(--ok); }
  .edt-size-medium { color: var(--text-1); border: 1px solid var(--border); }
  .edt-size-large { color: var(--text-1); border: 1px solid var(--text-2); }
  .edt-disabled { opacity: .5; cursor: not-allowed; }
  .edt-badge { flex: 0 0 auto; font-size: 10.5px; line-height: 16px; padding: 0 5px; border-radius: var(--r-1); }
  .edt-badge-ok { background: var(--ok-bg); color: var(--ok); }
  .edt-badge-warn { background: var(--warn-bg); color: var(--warn); }
  .edt-badge-dim { color: var(--text-3); }
  .edt-badge-src { color: var(--text-2); border: 1px solid var(--border); }
  .edt-struct-detail[hidden] { display: none; }
  .edt-subhead { color: var(--text-2); margin: var(--s-4) 0 var(--s-2); font-size: var(--fs-data); font-weight: 600; }
  .edt-levels { border: 1px solid var(--border); border-radius: var(--r-1); max-height: 340px; overflow-y: auto; }
  .edt-list-row.edt-level { display: flex; flex-wrap: wrap; column-gap: var(--s-3); white-space: normal;
    border-bottom: 1px solid #211b0c; border-radius: 0; line-height: 1.5; padding: 3px var(--s-3); }
  .edt-level-cy { flex: 0 0 44px; color: var(--accent); }
  .edt-level-role { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .edt-level-stats { flex: 0 0 100%; padding-left: 50px; color: var(--text-3); font-size: 11px; }
  .edt-level-bad { flex: 0 0 auto; color: var(--err); }
  .edt-issues { max-height: 220px; }
  .edt-sev-error { color: var(--err) !important; }
  .edt-sev-warn { color: var(--warn) !important; }
  .edt-sev-ok { color: var(--ok) !important; }
  #editor .dbg-block.edt-ok { color: var(--ok); }
  #editor .dbg-block.edt-bad { color: var(--err); }
  #editor .dbg-block.edt-warn { color: var(--warn); }
  .edt-floors { max-height: 96px; overflow-y: auto; }
  .edt-floor-btn { min-width: 32px; }
  #editor .edt-floor-btn.edt-in-struct { border-color: #3e7ea0; box-shadow: inset 0 -2px 0 #3e7ea0; }
  #editor .edt-floor-btn.edt-dim { color: var(--text-3); }
  #editor .dbg-block.edt-inspect { font-size: 11px; color: var(--text-2); max-height: 260px; overflow-y: auto; }
  #editor .dbg-block.edt-inspect-tall { max-height: none; }

  /* legends */
  .edt-layer { display: flex; flex-wrap: wrap; align-items: center; column-gap: var(--s-4); margin: 0 0 var(--s-1); }
  .edt-layer .dbg-row { margin: 0; flex: 0 0 auto; }
  #editor .edt-layer .dbg-toggle .dbg-label { flex: 0 1 auto; }
  .edt-layer .edt-legend-row { margin: 0; }
  .edt-legend-row { display: flex; flex-wrap: wrap; gap: 2px var(--s-4); margin: 0 0 var(--s-2); font-size: 11px; color: var(--text-3); }
  .edt-legend-item { display: inline-flex; align-items: center; gap: var(--s-2); }
  .edt-sw { display: inline-block; width: 12px; height: 10px; border-radius: 2px; flex: 0 0 auto; box-shadow: inset 0 0 0 1px rgba(255,255,255,.12); }
  .edt-sw-line { background: transparent !important; border-bottom: 3px solid; height: 7px; border-radius: 0; box-shadow: none; }
  .edt-sw-dash { background: transparent !important; border-bottom: 2px dashed; height: 7px; border-radius: 0; box-shadow: none; }
  .edt-sw-text { width: auto; height: auto; font: 700 10px/1 var(--font-data); box-shadow: none; }
  .edt-fill-legend { margin-top: var(--s-2); }

  /* report table */
  .edt-report { overflow-x: auto; }
  .edt-report table { border-collapse: collapse; font: 10.5px var(--font-data); width: 100%; }
  .edt-report th { padding: 0; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: #171309; }
  .edt-th-btn { width: 100%; background: transparent; border: 0; color: var(--text-2); font: 600 10.5px var(--font-data);
    text-align: right; padding: 3px 3px; cursor: pointer; white-space: nowrap; }
  .edt-th-btn:hover { color: var(--accent-strong); background: var(--bg-3); }
  .edt-report td { color: var(--text); text-align: right; padding: 2px 3px; cursor: pointer; }
  .edt-report tr:hover td, .edt-report tr.edt-on td { background: var(--bg-3); }
  .edt-row-btn { background: transparent; border: 0; padding: 0; color: var(--accent-strong); font: inherit; cursor: pointer; text-decoration: underline dotted; }

  /* ── status bar ───────────────────────────────────────────────────── */
  .edt-statusbar { grid-area: status; display: flex; align-items: center; gap: var(--s-4); padding: 0 var(--s-3) 0 0;
    background: var(--bg-1); border-top: 1px solid var(--border-strong); font: var(--fs-data) var(--font-data);
    color: var(--text-2); min-width: 0; overflow: hidden; }
  .edt-sb-mode { align-self: stretch; display: flex; align-items: center; padding: 0 var(--s-4); background: var(--accent-bg);
    color: var(--accent-strong); font-weight: 700; letter-spacing: 1px; flex: 0 0 auto; }
  .edt-sb-mode.edt-sb-explore { background: var(--info-bg); color: #bfe6ff; }
  .edt-sb-field { flex: 0 0 auto; white-space: nowrap; color: var(--text-2); }
  .edt-sb-hover { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text); }
  .edt-sb-notice { flex: 0 1 auto; max-width: 42%; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-2); }
  .edt-sb-notice:not(:empty) { padding: 1px var(--s-3); border-radius: var(--r-1); background: var(--bg-2); }
  .edt-sb-notice.edt-sev-warn { background: var(--warn-bg); }
  .edt-sb-notice.edt-sev-error { background: var(--err-bg); }
  .edt-sb-notice.edt-sev-ok { background: var(--ok-bg); }
  .edt-sb-notice.edt-sev-prompt { color: var(--text-2); font-style: italic; }
  .edt-sb-history { height: 22px; min-width: 24px; }
  .edt-sb-save { color: var(--text-3); }

  /* ── tooltip / popover / overlays (appended to <body>) ────────────── */
  .edt-tooltip { position: fixed; z-index: 1000; max-width: 320px; padding: 7px 10px 8px; user-select: text;
    background: #221b0d; color: var(--text, #e8e0a0); border: 1px solid #6e5e22; border-radius: 6px;
    box-shadow: 0 6px 20px rgba(0,0,0,.6); font: 12px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .edt-tooltip[hidden] { display: none; }
  .edt-tooltip-title { display: flex; align-items: center; gap: 8px; font-weight: 650; color: #ffe6a0; margin-bottom: 2px; }
  .edt-tooltip-keys { margin-left: auto; display: inline-flex; gap: 4px; }
  .edt-tooltip kbd, .edt-overlay kbd, .edt-popover kbd { font: 600 10.5px/1 ui-monospace, Menlo, Consolas, monospace; color: #e8e0a0;
    background: #33290f; border: 1px solid #5e501a; border-bottom-width: 2px; border-radius: 4px; padding: 2px 5px; }
  .edt-tooltip-text { color: #e0d7a8; }
  .edt-tooltip-meta { margin-top: 4px; color: #b7d8c8; font-size: 11px; }
  .edt-tooltip-note { margin-top: 4px; color: #ffcf7a; font-size: 11px; }

  .edt-popover { position: fixed; z-index: 900; width: min(460px, calc(100vw - 16px)); max-height: 50vh; overflow: auto;
    background: #1b160c; color: #e8e0a0; border: 1px solid #5e501a; border-radius: 8px; box-shadow: 0 8px 28px rgba(0,0,0,.55);
    font: 11.5px/1.5 ui-monospace, Menlo, Consolas, monospace; }
  .edt-popover[hidden] { display: none; }
  .edt-popover-head { position: sticky; top: 0; padding: 6px 10px; background: #241e10; color: #ffe6a0; font: 600 12px system-ui, sans-serif; }
  .edt-history-row { padding: 3px 10px; border-top: 1px solid #2a2210; user-select: text; }
  .edt-history-time { color: #a89a5c; margin-right: 8px; }

  .edt-overlay { position: fixed; inset: 0; z-index: 800; display: flex; align-items: flex-start; justify-content: center;
    padding: 10vh 16px 16px; background: rgba(8,7,4,.62); color: #e8e0a0;
    font: 12.5px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .edt-dialog { width: min(460px, 100%); max-height: 80vh; overflow: auto; background: #1b160c; border: 1px solid #6e5e22;
    border-radius: 10px; box-shadow: 0 16px 48px rgba(0,0,0,.6); padding: 16px 18px; }
  .edt-dialog-head { display: flex; align-items: center; gap: 8px; color: #ffcf7a; }
  .edt-dialog-head h2 { margin: 0; font-size: 15px; color: #ffe6a0; }
  .edt-dialog-body { margin: 10px 0 4px; }
  .edt-dialog-note { margin: 6px 0 0; color: #c9bd7a; font-size: 12px; }
  .edt-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  .edt-dialog-actions .dbg-btn { min-height: 30px; padding: 4px 14px; }

  .edt-palette .edt-dialog { width: min(640px, 100%); padding: 0; display: flex; flex-direction: column; max-height: 70vh; overflow: hidden; }
  .edt-pal-bar { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #3a3212; color: #c9bd7a; }
  .edt-pal-input { flex: 1; background: transparent; border: 0; color: #f4e9c8; font: 15px system-ui, sans-serif; outline: none; min-width: 0; }
  .edt-pal-input::placeholder { color: #8d8150; }
  .edt-pal-list { overflow-y: auto; padding: 4px; }
  .edt-pal-row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 6px; cursor: pointer; color: #c9bd7a; }
  .edt-pal-row.edt-active { background: #33290f; color: #ffe6a0; }
  .edt-pal-row.edt-disabled { color: #8d8150; }
  .edt-pal-main { flex: 1; min-width: 0; }
  .edt-pal-label { color: inherit; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .edt-pal-row:not(.edt-disabled) .edt-pal-label { color: #e8e0a0; }
  .edt-pal-row.edt-active .edt-pal-label { color: #ffe6a0; }
  .edt-pal-hint { font-size: 11.5px; color: #a89a5c; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .edt-pal-check { color: #9fe0a8; font-weight: 400; }
  .edt-pal-group { font-size: 11px; color: #a89a5c; flex: 0 0 auto; }
  .edt-pal-keys { display: inline-flex; gap: 4px; flex: 0 0 auto; }
  .edt-pal-empty { padding: 16px; color: #a89a5c; }
  .edt-pal-foot { padding: 6px 12px; border-top: 1px solid #3a3212; color: #a89a5c; font-size: 11px; }

  .edt-help .edt-dialog { width: min(1100px, 100%); max-height: 84vh; }
  .edt-help { padding-top: 6vh; }
  .edt-help-close { margin-left: auto; color: #c9bd7a; background: transparent; border: 1px solid transparent; border-radius: 6px;
    min-width: 28px; height: 28px; cursor: pointer; display: grid; place-items: center; }
  .edt-help-close:hover { background: #33290f; }
  .edt-help-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 12px 24px; margin-top: 8px; }
  .edt-help h3 { margin: 10px 0 6px; font-size: 13px; color: #e8cf7a; letter-spacing: .5px; text-transform: uppercase; }
  .edt-help h4 { margin: 10px 0 4px; font-size: 12px; color: #c9bd7a; }
  .edt-help-steps { margin: 0; padding-left: 20px; color: #e0d7a8; }
  .edt-help-steps li { margin: 4px 0; }
  .edt-help-dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; margin: 0; }
  .edt-help-dl dt { color: #ffe6a0; } .edt-help-dl dd { margin: 0; color: #c9bd7a; }
  .edt-help-keys { border-collapse: collapse; width: 100%; }
  .edt-help-keys td { padding: 2px 0; vertical-align: top; color: #e0d7a8; }
  .edt-help-kbd { width: 1%; white-space: nowrap; padding-right: 10px !important; }
  .edt-help-scope { color: #a89a5c; font-size: 11.5px; }
  .edt-help-note { color: #a89a5c; font-size: 11.5px; }
  .edt-help .edt-legend-row { color: #c9bd7a; }

  /* ── responsive ───────────────────────────────────────────────────── */
  @media (max-width: 1180px) {
    #editor { --insp-w: 316px; }
    .edt-search-text { display: none; }
    .edt-search { flex: 0 0 auto; }
  }
  @media (max-width: 980px) {
    .edt-shell { grid-template-columns: var(--rail-w) minmax(0, 1fr) 0; }
    .edt-inspector { position: absolute; right: 0; top: var(--appbar-h); bottom: var(--status-h); width: min(360px, 92vw);
      z-index: 20; box-shadow: var(--shadow); }
    .edt-brand-text, .edt-ibtn-text .edt-ibtn-label, .edt-version { display: none; }
    .edt-tb-hint { display: none; }
  }
  @media (max-width: 640px) {
    #editor { --rail-w: 44px; }
    .edt-rail-btn { width: 36px; height: 34px; }
    .edt-docname { flex-basis: 90px; }
    .edt-sb-hover { display: none; }
    .edt-sb-notice { max-width: none; flex: 1 1 auto; }
  }
  @media (prefers-reduced-motion: reduce) {
    #editor .dbg-sec-head::before { transition: none; }
  }
`

export function injectEditorStyle() {
  const style = document.createElement('style')
  style.textContent = EDITOR_CSS
  document.head.appendChild(style)
  return style
}
