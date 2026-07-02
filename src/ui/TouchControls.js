import { stickVector, sprintGate } from './stick.js'

const STICK_RADIUS = 60 // px from base center to full deflection

// On-screen touch controls, mounted inside #hud so the existing phase logic
// (_showOnly) shows/hides them with the rest of the HUD. Two capture zones —
// left spawns a floating joystick, right is drag-to-look — plus flashlight and
// pause buttons layered on top. Each zone owns at most ONE pointer id (via
// setPointerCapture) so simultaneous move+look just works; extra fingers in
// the same zone are ignored until the first lifts.
export class TouchControls {
  constructor(hud, { onMove, onLook, onFlashlight, onPause }) {
    this.onMove = onMove
    this.onLook = onLook

    this.zoneL = el('div', 'tc-zone tc-zone-left')
    this.zoneR = el('div', 'tc-zone tc-zone-right')
    this.base = el('div', 'tc-stick-base hidden')
    this.nub = el('div', 'tc-stick-nub')
    this.base.appendChild(this.nub)
    this.zoneL.appendChild(this.base)

    this.btnLight = el('button', 'tc-btn tc-btn-light', '⚡')
    this.btnPause = el('button', 'tc-btn tc-btn-pause', 'Ⅱ')

    for (const node of [this.zoneL, this.zoneR, this.btnLight, this.btnPause]) {
      node.addEventListener('contextmenu', (e) => e.preventDefault())
      hud.appendChild(node)
    }

    this.moveId = null // captured pointer per zone
    this.lookId = null
    this.baseX = 0 // joystick base center (client px)
    this.baseY = 0
    this.sprint = false
    this.lastX = 0 // previous look-pointer position
    this.lastY = 0

    this._bindStick()
    this._bindLook()
    // Buttons swallow the pointer so a tap never bleeds into the look zone.
    this.btnLight.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      onFlashlight?.()
    })
    this.btnPause.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      onPause?.()
    })
  }

  _bindStick() {
    const z = this.zoneL
    z.addEventListener('pointerdown', (e) => {
      if (this.moveId !== null) return
      this.moveId = e.pointerId
      capture(z, e.pointerId)
      this.baseX = e.clientX
      this.baseY = e.clientY
      this.base.style.left = `${e.clientX}px`
      this.base.style.top = `${e.clientY}px`
      this.base.classList.remove('hidden')
      this._stickMove(e)
      e.preventDefault()
    })
    z.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.moveId) this._stickMove(e)
    })
    const end = (e) => {
      if (e.pointerId !== this.moveId) return
      this._releaseStick()
    }
    z.addEventListener('pointerup', end)
    z.addEventListener('pointercancel', end)
    z.addEventListener('lostpointercapture', end)
  }

  _stickMove(e) {
    const v = stickVector(e.clientX - this.baseX, e.clientY - this.baseY, STICK_RADIUS)
    this.sprint = sprintGate(this.sprint, v.mag)
    // v is unit-clamped; z is forward (screen up), so flip it back to screen y.
    this.nub.style.transform = `translate(-50%,-50%) translate(${v.x * STICK_RADIUS}px, ${-v.z * STICK_RADIUS}px)`
    this.base.classList.toggle('sprint', this.sprint)
    this.onMove?.(v.x, v.z, this.sprint)
  }

  _releaseStick() {
    this.moveId = null
    this.sprint = false
    this.base.classList.add('hidden')
    this.base.classList.remove('sprint')
    this.nub.style.transform = 'translate(-50%,-50%)'
    this.onMove?.(0, 0, false)
  }

  _bindLook() {
    const z = this.zoneR
    z.addEventListener('pointerdown', (e) => {
      if (this.lookId !== null) return
      this.lookId = e.pointerId
      capture(z, e.pointerId)
      this.lastX = e.clientX
      this.lastY = e.clientY
      e.preventDefault()
    })
    z.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookId) return
      // Touch pointermove has no reliable movementX/Y — diff client coords.
      this.onLook?.(e.clientX - this.lastX, e.clientY - this.lastY)
      this.lastX = e.clientX
      this.lastY = e.clientY
    })
    const end = (e) => {
      if (e.pointerId === this.lookId) this.lookId = null
    }
    z.addEventListener('pointerup', end)
    z.addEventListener('pointercancel', end)
    z.addEventListener('lostpointercapture', end)
  }

  setFlashlight(on) {
    this.btnLight.classList.toggle('on', on)
  }

  // Drop any held pointers and zero movement — called on every phase exit so a
  // finger held through pause/death can't leak input into the next phase.
  reset() {
    if (this.moveId !== null) {
      try {
        this.zoneL.releasePointerCapture(this.moveId)
      } catch {
        /* pointer already gone */
      }
      this._releaseStick()
    }
    if (this.lookId !== null) {
      try {
        this.zoneR.releasePointerCapture(this.lookId)
      } catch {
        /* pointer already gone */
      }
      this.lookId = null
    }
  }
}

function el(tag, cls, text) {
  const n = document.createElement(tag)
  n.className = cls
  if (text) n.textContent = text
  return n
}

// setPointerCapture throws for already-released pointer ids (a tap can end
// before the handler runs); the zone still tracks the id without capture.
function capture(zone, id) {
  try {
    zone.setPointerCapture(id)
  } catch {
    /* ignore */
  }
}
