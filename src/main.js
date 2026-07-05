import { Engine } from './core/Engine.js'

// Fatal-boot panel in the same anime-liminal language as the game UI. Styles
// are inlined because the overlays.js stylesheet never mounts when the Engine
// can't boot.
function showFatal(jp, title, msg) {
  document.getElementById('fatal')?.remove()
  const div = document.createElement('div')
  div.id = 'fatal'
  div.setAttribute('role', 'alert')
  div.style.cssText =
    'position:fixed;inset:0;z-index:99;display:flex;align-items:center;' +
    'justify-content:center;padding:24px;text-align:center;' +
    'background:radial-gradient(circle at 50% 40%, rgba(40,36,12,.55), rgba(14,11,6,.97));' +
    'font-family:ui-monospace,"Cascadia Mono","SF Mono",Menlo,Consolas,"Courier New",monospace;' +
    'color:#f4e9c8;'
  const card =
    'display:flex;flex-direction:column;align-items:center;gap:18px;' +
    'max-width:min(560px,92vw);padding:40px 44px;background:rgba(23,18,10,.9);' +
    'border:1px solid rgba(232,207,122,.28);' +
    'clip-path:polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 0 100%);'
  div.innerHTML = `
    <div style="${card}">
      <div aria-hidden="true" style="font-size:14px;letter-spacing:.5em;color:#8a7a3f;">${jp}</div>
      <h1 style="margin:0;font-size:clamp(20px,4vw,34px);letter-spacing:.3em;font-weight:700;
        color:#f4e9c8;text-shadow:0 0 18px rgba(224,88,74,.4);">${title}</h1>
      <p style="margin:0;font-size:13px;line-height:2;letter-spacing:.08em;color:rgba(244,233,200,.6);">${msg}</p>
      <a href="https://get.webgl.org/webgl2/" style="color:#e8cf7a;letter-spacing:.14em;font-size:13px;">
        get.webgl.org/webgl2</a>
    </div>`
  document.body.appendChild(div)
}

function hasWebGL2() {
  try {
    return !!document.createElement('canvas').getContext('webgl2')
  } catch {
    return false
  }
}

const app = document.getElementById('app')

if (!hasWebGL2()) {
  showFatal(
    '「非対応」',
    'REALITY UNAVAILABLE',
    'THE YELLOW ROOMS needs WebGL2 and this browser or device does not provide it.<br/>Update your browser or enable hardware acceleration.'
  )
} else {
  try {
    const engine = new Engine(app)
    engine.start()
    // expose for debugging in the console
    window.__game = engine
  } catch (err) {
    console.error('[yellow-rooms] engine failed to boot:', err)
    showFatal(
      '「描画不能」',
      'RENDER FAILURE',
      'The renderer failed to start on this GPU.<br/>Update your graphics drivers or try another browser.'
    )
  }
}
