// Editor chrome CSS. The `dbg-` classes mirror DebugMode's injected styles so
// the shared debug widget kit (src/debug/widgets.js) renders correctly here;
// `edt-` classes are editor-specific layout.

export const EDITOR_CSS = `
  :root { color-scheme: dark; }
  #editor { position: fixed; inset: 0; display: flex; flex-direction: row;
    font: 12px/1.45 ui-monospace, Menlo, Consolas, monospace; color: #e8e0a0;
    background: #0d0d09; }

  .edt-panel { width: 300px; min-width: 300px; height: 100%; overflow-y: auto;
    background: #14110a; border-right: 1px solid #5e501a; padding: 8px 10px 40px;
    box-sizing: border-box; user-select: none; }
  .edt-title { font-size: 14px; letter-spacing: 2px; color: #cdbf6e; margin: 2px 0 10px; }
  .edt-title small { color: #7c6f3a; letter-spacing: 1px; }
  .edt-viewport { position: relative; flex: 1; height: 100%; overflow: hidden; }
  .edt-viewport canvas { position: absolute; inset: 0; width: 100%; height: 100%;
    display: block; touch-action: none; }
  .edt-status { position: absolute; left: 8px; bottom: 6px; color: #8d7f42;
    background: rgba(13,13,9,0.72); padding: 2px 8px; border-radius: 3px;
    pointer-events: none; white-space: pre; }
  .edt-help { position: absolute; right: 8px; bottom: 6px; color: #6b5f30;
    background: rgba(13,13,9,0.72); padding: 2px 8px; border-radius: 3px;
    pointer-events: none; }

  .edt-list { margin: 2px 0; max-height: 180px; overflow-y: auto; }
  .edt-list-row { padding: 1px 6px; cursor: pointer; color: #b7a95e;
    border-radius: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .edt-list-row:hover { background: #241e10; }
  .edt-list-row.edt-on { background: #33290f; color: #ffe6a0; }

  .dbg-section { border: 1px solid #3a3212; border-radius: 4px; margin: 6px 0;
    background: #171309; }
  .dbg-sec-head { padding: 4px 8px; cursor: pointer; color: #cdbf6e;
    letter-spacing: 1px; font-weight: 600; }
  .dbg-sec-head.dbg-collapsed { opacity: 0.6; }
  .dbg-sec-body { padding: 2px 8px 8px; }
  .dbg-row { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
  .dbg-label { flex: 0 0 84px; color: #9a8c4c; }
  .dbg-val { flex: 0 0 auto; color: #e8e0a0; min-width: 34px; text-align: right; }
  .dbg-range { flex: 1; accent-color: #cdbf6e; min-width: 0; }
  .dbg-color { width: 40px; height: 20px; padding: 0; border: 1px solid #5e501a;
    background: none; }
  .dbg-toggle input { accent-color: #cdbf6e; }
  .dbg-btn { background: #241e10; color: #e8e0a0; border: 1px solid #5e501a;
    border-radius: 3px; padding: 3px 10px; cursor: pointer; font: inherit; }
  .dbg-btn:hover { background: #33290f; }
  .dbg-seg { display: flex; flex-wrap: wrap; gap: 3px; margin: 3px 0; }
  .dbg-seg-btn { background: #1b160c; color: #9a8c4c; border: 1px solid #4a3f18;
    border-radius: 3px; padding: 2px 8px; cursor: pointer; font: inherit; }
  .dbg-seg-btn.dbg-seg-on { background: #4a3f18; color: #ffe6a0; }
  .dbg-read { display: flex; justify-content: space-between; margin: 2px 0; }
  .dbg-read-k { color: #9a8c4c; }
  .dbg-read-v { color: #e8e0a0; }
  .dbg-block { white-space: pre; color: #b7a95e; margin: 4px 0; overflow-x: auto; }

  .edt-input { background: #1b160c; color: #e8e0a0; border: 1px solid #4a3f18;
    border-radius: 3px; padding: 2px 6px; font: inherit; flex: 1; min-width: 0; }
  select.edt-input { appearance: auto; }
`

export function injectEditorStyle() {
  const style = document.createElement('style')
  style.textContent = EDITOR_CSS
  document.head.appendChild(style)
  return style
}
