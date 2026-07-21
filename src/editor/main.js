import { EditorApp } from './EditorApp.js'

// /editor entry — a standalone map-creation tool (see docs/map-editor.md).
const root = document.getElementById('editor')

try {
  const app = new EditorApp(root)
  // Console handle for debugging, mirroring the game's window.__game.
  window.__editor = app
} catch (err) {
  console.error(err)
  root.innerHTML = `
    <div style="display:flex;height:100%;align-items:center;justify-content:center;
                color:#e8e0a0;font:14px ui-monospace,monospace;text-align:center">
      <div>
        <div style="font-size:18px;letter-spacing:2px;margin-bottom:8px">EDITOR FAILED TO START</div>
        <div style="color:#8d7f42">${String(err?.message ?? err)}</div>
      </div>
    </div>`
}
