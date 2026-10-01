import { Engine } from './core/Engine.js'
import { BootLoader, painted, settleWithin } from './ui/bootLoader.js'

// The boot screen (index.html) stays up until the title can be shown over a
// drawn world: a GPU that never presents a frame still reaches the menu after
// FIRST_FRAME_WAIT_MS, and the Blender models get ASSET_WAIT_MS beyond the
// first frame before the title opens without them (chunks then swap their box
// furniture in place when the models land, as before).
const FIRST_FRAME_WAIT_MS = 10000
const ASSET_WAIT_MS = 2500

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

function showBootFailure(err) {
  console.error('[yellow-rooms] engine failed to boot:', err)
  if (err?.name === 'DeferredUnsupportedError') {
    // capabilities.js: the GPU cannot allocate the deferred G-buffer
    // (float colour attachments / multiple render targets).
    showFatal(
      '「描画不能」',
      'RENDER FAILURE',
      'This GPU cannot allocate the renderer\'s floating-point render targets.<br/>' +
        'Update your graphics drivers, enable hardware acceleration, or try another browser.'
    )
  } else {
    showFatal(
      '「描画不能」',
      'RENDER FAILURE',
      'The renderer failed to start on this GPU.<br/>Update your graphics drivers or try another browser.'
    )
  }
}

async function boot() {
  const loader = new BootLoader(document.getElementById('boot'))
  if (!hasWebGL2()) {
    loader.remove()
    showFatal(
      '「非対応」',
      'REALITY UNAVAILABLE',
      'THE YELLOW ROOMS needs WebGL2 and this browser or device does not provide it.<br/>Update your browser or enable hardware acceleration.'
    )
    return
  }

  // Each stage paints its label before the work it names blocks the thread.
  loader.stage('renderer')
  await painted()
  let engine
  try {
    engine = new Engine(document.getElementById('app'))
    // expose for debugging in the console
    window.__game = engine
    // The title waits under the boot screen: its arrival (tubes powering on,
    // the menu rising) plays when the screen lifts, not unseen behind it.
    engine.ui.setBooting(true)
    loader.stage('lights')
    await painted()
    engine.start()
  } catch (err) {
    loader.remove()
    showBootFailure(err)
    return
  }
  await settleWithin(engine.whenFirstFrame(), FIRST_FRAME_WAIT_MS)

  loader.stage('furnish')
  await settleWithin(engine.whenAssetsSettled(), ASSET_WAIT_MS)
  await loader.finish(() => engine.ui.setBooting(false))
}

boot()
