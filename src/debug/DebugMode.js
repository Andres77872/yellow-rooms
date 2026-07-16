import * as THREE from 'three'
import { LIGHT_INTENSITY } from '../world/constants.js'
import { Phase } from '../core/GameState.js'
import { hasLineOfSight } from '../player/collision.js'
import { groundHeightAt } from '../player/ground.js'
import { sightGate } from '../entities/sense.js'
import { WorldMapTool } from './WorldMapTool.js'
import { LightTool, CHANNELS } from './LightTool.js'
import { AiTool } from './AiTool.js'
import { PerfTool } from './PerfTool.js'
import { LightRoom } from './LightRoom.js'

const CSS = `
#dbg-panel{ position:fixed; top:8px; right:8px; width:348px; max-height:calc(100vh - 16px);
  overflow-y:auto; overflow-x:hidden; z-index:60; display:none;
  font:11px/1.45 ui-monospace,"Courier New",monospace; color:#e8e0a0;
  background:rgba(8,8,5,.94); border:1px solid #5e501a; border-radius:4px; }
#dbg-panel::-webkit-scrollbar{ width:8px; } #dbg-panel::-webkit-scrollbar-thumb{ background:#5e501a; }
#dbg-panel *{ box-sizing:border-box; }
#dbg-head{ position:sticky; top:0; z-index:2; background:#15130a; border-bottom:1px solid #5e501a;
  padding:6px 8px; display:flex; flex-direction:column; gap:5px; }
#dbg-head .t{ letter-spacing:.18em; color:#f8f1a8; display:flex; justify-content:space-between;
  align-items:center; }
#dbg-head .hint{ opacity:.5; font-size:9px; letter-spacing:.08em; }
#dbg-head .st{ opacity:.7; font-size:10px; }
#dbg-collapse{ cursor:pointer; background:none; border:1px solid #4a4017; color:#cdbf6e;
  font:inherit; width:18px; height:18px; line-height:1; padding:0; border-radius:2px; }
#dbg-panel.dbg-min #dbg-tabs, #dbg-panel.dbg-min .dbg-body{ display:none; }
#dbg-tabs{ display:flex; gap:4px; }
#dbg-tabs button{ flex:1; cursor:pointer; background:#1b1908; color:#cdbf6e; border:1px solid #4a4017;
  padding:4px 0; font:inherit; letter-spacing:.12em; border-radius:2px; }
#dbg-tabs button.on{ background:#cdbf6e; color:#15130a; font-weight:700; }
.dbg-body{ display:none; padding:6px 8px 10px; }
.dbg-section{ border:1px solid #36300f; border-radius:3px; margin:6px 0; }
.dbg-sec-head{ cursor:pointer; background:rgba(94,80,26,.20); padding:3px 6px; letter-spacing:.14em;
  color:#f0e7a0; user-select:none; }
.dbg-sec-head::before{ content:"▾ "; opacity:.7; } .dbg-sec-head.dbg-collapsed::before{ content:"▸ "; }
.dbg-sec-body{ padding:5px 6px; display:flex; flex-direction:column; gap:4px; }
.dbg-row{ display:flex; align-items:center; gap:6px; }
.dbg-label{ flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dbg-val{ width:48px; text-align:right; color:#f8f1a8; }
.dbg-range{ width:120px; }
.dbg-toggle{ cursor:pointer; } .dbg-toggle input{ accent-color:#cdbf6e; }
.dbg-text{ flex:1; min-width:0; background:#1b1908; border:1px solid #5e501a; color:#f0e7a0;
  font:inherit; padding:3px 5px; outline:none; }
.dbg-color{ width:30px; height:18px; padding:0; border:1px solid #4a4017; background:#1b1908; }
.dbg-btn{ cursor:pointer; background:#cdbf6e; color:#15130a; border:none; padding:4px 8px;
  font:inherit; font-weight:700; letter-spacing:.08em; border-radius:2px; }
.dbg-btn:hover{ background:#f0e08a; }
.dbg-seg{ display:flex; flex-wrap:wrap; gap:3px; }
.dbg-seg-btn{ cursor:pointer; background:#1b1908; color:#cdbf6e; border:1px solid #4a4017;
  padding:3px 5px; font:inherit; font-size:10px; border-radius:2px; }
.dbg-seg-btn.dbg-seg-on{ background:#cdbf6e; color:#15130a; font-weight:700; }
.dbg-read{ display:flex; justify-content:space-between; gap:8px; }
.dbg-read-k{ opacity:.65; } .dbg-read-v{ color:#f8f1a8; text-align:right; }
.dbg-canvas{ display:block; margin:4px auto; border:1px solid #4a4017; background:#0d0d09;
  cursor:grab; touch-action:none; }
`

const TABS = ['world', 'light', 'ai', 'perf']

// Debug-mode orchestrator. Inert until F2. Owns the tabbed panel, the four
// tools, the isolated light room (scene + orbit camera), and all engine hooks.
// Almost everything runs without taking over the render loop; only the light
// room swaps deferred.scene/camera (restored every frame by Engine in a finally).
export class DebugMode {
  constructor(engine) {
    this.engine = engine
    this.active = false
    this.freeze = false
    this.invincible = true
    this.channel = 0
    this.tab = 'world'

    // Shared overlay/AI state read by the tools.
    this.aiOverlay = true
    this.mapClickMode = 'off' // world-map click: off | stalker | player
    this.aiSeen = false
    this.aiFlags = { dist: 0, inFrustum: false, los: false, seen: false, tension: 0 }

    // Light room.
    this.lightRoom = null
    this.lightRoomActive = false
    this.lightRoomCfg = { count: 4, spacing: 5, intensity: LIGHT_INTENSITY, animate: false }

    this._savedScene = null
    this._savedCam = null
    this._savedOutline = true

    this._proj = new THREE.Matrix4()
    this._frustum = new THREE.Frustum()
    this._v = new THREE.Vector3()

    this._onKeyDown = this._onKeyDown.bind(this)
    this._onRoomDown = (e) => this.lightRoom && this.lightRoom.onPointerDown(e)
    this._onRoomMove = (e) => this.lightRoom && this.lightRoom.onPointerMove(e)
    this._onRoomUp = (e) => this.lightRoom && this.lightRoom.onPointerUp(e)
    this._onRoomWheel = (e) => {
      if (this.lightRoom) {
        e.preventDefault()
        this.lightRoom.onWheel(e)
      }
    }

    addEventListener('keydown', this._onKeyDown)
  }

  // --- Lifecycle ------------------------------------------------------
  _ensureBuilt() {
    if (this.root) return
    const style = document.createElement('style')
    style.id = 'dbg-style'
    style.textContent = CSS
    document.head.appendChild(style)

    const root = document.createElement('div')
    root.id = 'dbg-panel'
    this.root = root

    const head = document.createElement('div')
    head.id = 'dbg-head'
    head.innerHTML = `<div class="t"><span>● DEBUG</span><button id="dbg-collapse" title="collapse panel">–</button></div>`
    head.querySelector('#dbg-collapse').addEventListener('click', (e) => {
      const min = root.classList.toggle('dbg-min')
      e.target.textContent = min ? '+' : '–'
    })
    const hint = document.createElement('div')
    hint.className = 'hint'
    hint.textContent = '1-4 tabs · F3 freeze · F2 close · ` stats overlay'
    head.appendChild(hint)
    this._status = document.createElement('div')
    this._status.className = 'st'
    head.appendChild(this._status)
    const tabs = document.createElement('div')
    tabs.id = 'dbg-tabs'
    this._tabBtns = {}
    TABS.forEach((t, i) => {
      const b = document.createElement('button')
      b.textContent = `${i + 1} ${t.toUpperCase()}`
      b.addEventListener('click', () => this.showTab(t))
      tabs.appendChild(b)
      this._tabBtns[t] = b
    })
    head.appendChild(tabs)
    root.appendChild(head)

    // Tools + bodies.
    this._tools = {
      world: new WorldMapTool(this.engine, this),
      light: new LightTool(this.engine, this),
      ai: new AiTool(this.engine, this),
      perf: new PerfTool(this.engine),
    }
    this.ai = this._tools.ai
    this._bodies = {}
    for (const t of TABS) {
      const body = document.createElement('div')
      body.className = 'dbg-body'
      body.appendChild(this._tools[t].el)
      root.appendChild(body)
      this._bodies[t] = body
    }
    document.body.appendChild(root)

    // Keep panel-input keystrokes from leaking to the game's global listeners.
    const guard = (e) => {
      if (e.target.matches('input,textarea,select') && e.code !== 'F2' && e.code !== 'F3')
        e.stopPropagation()
    }
    root.addEventListener('keydown', guard)
    root.addEventListener('keyup', guard)
  }

  toggle() {
    if (this.active) this.deactivate()
    else this.activate()
  }

  activate() {
    this._ensureBuilt()
    this.active = true
    this.freeze = true
    this.invincible = true
    this.channel = 0
    const e = this.engine
    e.controller.unlock()
    e.controller.inputEnabled = false
    this._savedOutline = e.deferred.outlineEnabled
    e.stalker.recordCandidates = true
    this.root.style.display = 'block'
    this.showTab(this.tab)
  }

  deactivate() {
    const e = this.engine
    if (this.lightRoomActive) this.enterLightRoom(false)
    this.active = false
    this.freeze = false
    this.setChannel(0)
    e.deferred.setOutline(this._savedOutline)
    e.deferred.scene = e.scene
    e.deferred.camera = e.camera
    e.lightField.reset()
    e.controller.inputEnabled = true
    e.stalker.recordCandidates = false
    // Reset AI-tab toggles that write to persistent objects, else they leak into
    // normal play (frozen => monster disabled; alwaysVisible => model stuck on
    // screen; gizmos => stale LOS/range overlays left in the live scene).
    e.stalker.frozen = false
    e.stalker.alwaysVisible = false
    e.stalker.mesh.visible = e.stalker.active
    e.pursuer.frozen = false
    e.pursuer.alwaysVisible = false
    e.pursuer.mesh.visible = e.pursuer.active
    if (this.ai?.gizmos) this.ai.gizmos.visible = false
    if (this.root) this.root.style.display = 'none'
    if (e.state.phase === Phase.PLAYING) e.controller.lock()
  }

  showTab(t) {
    this.tab = t
    for (const k of TABS) {
      this._bodies[k].style.display = k === t ? 'block' : 'none'
      this._tabBtns[k].classList.toggle('on', k === t)
    }
    this._tools[t].onShow?.()
  }

  // --- Tool/control API ----------------------------------------------
  setChannel(i) {
    this.channel = i | 0
    this.engine.deferred.setDebugView(i)
  }

  setFreeze(v) {
    this.freeze = !!v
  }

  enterLightRoom(on) {
    const e = this.engine
    if (on) {
      if (!this.lightRoom) this.lightRoom = new LightRoom(e)
      this.lightRoom.config = this.lightRoomCfg
      this.lightRoom.rebuildLamps()
      this.lightRoom.setAspect(innerWidth / innerHeight)
      this.lightRoom._applyCamera()
      this.lightRoomActive = true
      this.freeze = true
      const c = e.renderer.domElement
      c.addEventListener('pointerdown', this._onRoomDown)
      addEventListener('pointermove', this._onRoomMove)
      addEventListener('pointerup', this._onRoomUp)
      c.addEventListener('wheel', this._onRoomWheel, { passive: false })
    } else {
      this.lightRoomActive = false
      const c = e.renderer.domElement
      c.removeEventListener('pointerdown', this._onRoomDown)
      removeEventListener('pointermove', this._onRoomMove)
      removeEventListener('pointerup', this._onRoomUp)
      c.removeEventListener('wheel', this._onRoomWheel)
      e.lightField.reset()
    }
  }

  refreshLightRoomLamps() {
    if (this.lightRoom) this.lightRoom.rebuildLamps()
  }

  placeStalker(wx, wz, cy = this.engine.controller.floor) {
    const e = this.engine
    if (e.cm.isBlocked(wx, wz, cy)) return
    const s = e.stalker
    s.active = true
    s.cy = cy
    s.pos.set(wx, groundHeightAt(e.cm, wx, wz, cy), wz)
    s.mesh.position.set(wx, s.pos.y + s.mesh.scale.y * 0.95, wz)
    s.mesh.visible = true
  }

  // Drop the player at a map-clicked spot. The frozen sim skips Engine._tick,
  // so chunk streaming + floor visibility must be refreshed explicitly here.
  teleportPlayer(wx, wz, cy = this.engine.controller.floor) {
    const e = this.engine
    if (e.cm.isBlocked(wx, wz, cy)) return
    e.controller.teleport(wx, wz, cy, e.controller.yaw)
    e.cm.update(wx, wz, cy)
    e.cm.updateVisibility(cy, null)
    e._transitStair = null // stale stair cache would mis-gate the next live tick
  }

  // --- Per-frame (called by Engine before render, while active) -------
  update(dt) {
    if (!this.active) return
    this._computeAiFlags()
    if (this.lightRoomActive && this.lightRoom) this.lightRoom.update(dt)
    if (this.ai) this.ai.tickGizmos()
    this._tools[this.tab].update?.(dt)
    if (this._status) {
      this._status.textContent =
        `${this.freeze ? 'FROZEN' : 'LIVE'} · ${this.invincible ? 'INVINC' : 'mortal'}` +
        `${this.lightRoomActive ? ' · ROOM' : ''}${this.channel ? ' · ch ' + CHANNELS[this.channel] : ''}`
    }
  }

  _computeAiFlags() {
    const e = this.engine
    const s = e.stalker
    const p = e.controller.pos
    const cam = e.camera
    const dx = p.x - s.pos.x
    const dy = (p.y || 0) - s.pos.y
    const dz = p.z - s.pos.z
    const dist = Math.hypot(dx, dy, dz)
    this._proj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    this._frustum.setFromProjectionMatrix(this._proj)
    this._v.set(s.pos.x, s.pos.y + 1.6, s.pos.z)
    const inFrustum = this._frustum.containsPoint(this._v)
    const sameFloor = s.cy === e.controller.floor
    const los =
      sameFloor && hasLineOfSight(e.cm, p.x, p.z, s.pos.x, s.pos.z, s.cy)
    // Delegate the full rule (incl. the stairwell-aperture case) to the real
    // gate so the debug readout can never drift from what the AI actually uses.
    const seen = s.active && sightGate(e.cm, cam, s.pos, s.cy, p, e.controller.floor, s.sightDist)
    let tension = Math.max(0, 1 - dist / 22)
    if (seen) tension = Math.min(1, tension + 0.35)
    this.aiFlags = { dist, inFrustum, los, seen, tension, dcy: s.cy - e.controller.floor }
    this.aiSeen = seen
  }

  // Swap to the light-room scene/camera for this frame (restored in postRender).
  preRender() {
    if (!this.active) return
    const d = this.engine.deferred
    this._savedScene = d.scene
    this._savedCam = d.camera
    if (this.lightRoomActive && this.lightRoom) {
      d.scene = this.lightRoom.scene
      d.camera = this.lightRoom.camera
      this.lightRoom.applyLamps(d)
    }
  }

  postRender() {
    if (!this.active) return
    const d = this.engine.deferred
    if (this._savedScene) d.scene = this._savedScene
    if (this._savedCam) d.camera = this._savedCam
  }

  resize(w, h) {
    if (this.lightRoom) this.lightRoom.setAspect(w / h)
  }

  // --- Input ----------------------------------------------------------
  _onKeyDown(e) {
    if (e.code === 'F2') {
      e.preventDefault()
      this.toggle()
      return
    }
    if (!this.active) return
    if (e.code === 'F3') {
      e.preventDefault()
      this.setFreeze(!this.freeze)
      return
    }
    const typing =
      document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)
    if (typing) return
    if (e.code === 'Digit1') this.showTab('world')
    else if (e.code === 'Digit2') this.showTab('light')
    else if (e.code === 'Digit3') this.showTab('ai')
    else if (e.code === 'Digit4') this.showTab('perf')
  }

  dispose() {
    removeEventListener('keydown', this._onKeyDown)
    if (this.lightRoomActive) this.enterLightRoom(false)
    if (this.lightRoom) this.lightRoom.dispose()
    if (this._tools) for (const t of TABS) this._tools[t].dispose?.()
    if (this.root) this.root.remove()
    document.getElementById('dbg-style')?.remove()
  }
}
