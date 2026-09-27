import { EditorApp } from './EditorApp.js'

// /editor entry — a standalone map-creation tool (see docs/map-editor.md).
const root = document.getElementById('editor')

try {
  const app = new EditorApp(root)
  // Console handle for debugging, mirroring the game's window.__game.
  window.__editor = app
} catch (err) {
  console.error(err)
  // textContent only: the message may contain markup-like text.
  root.textContent = ''
  const wrap = document.createElement('div')
  wrap.style.cssText = 'display:flex;height:100%;align-items:center;justify-content:center;color:#e8e0a0;font:14px ui-monospace,monospace;text-align:center'
  const box = document.createElement('div')
  const title = document.createElement('div')
  title.style.cssText = 'font-size:18px;letter-spacing:2px;margin-bottom:8px'
  title.textContent = 'EDITOR FAILED TO START'
  const msg = document.createElement('div')
  msg.style.cssText = 'color:#b7a95e'
  msg.textContent = String(err?.message ?? err)
  box.append(title, msg)
  wrap.appendChild(box)
  root.appendChild(wrap)
}
