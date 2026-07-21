import * as THREE from 'three'
import { CELL, WALL_H, NEAR, FAR, FOV, LIGHT_MAX, LIGHT_INTENSITY } from '../world/constants.js'
import { lampTint, lampPanelTint } from '../world/lampCharacter.js'

const ROOM = 7 // cells across (odd -> centered)
const HALF = (ROOM / 2) | 0

// An isolated, enclosed room built from the game's shared materials/geometry,
// lit by a controllable lamp grid written straight into the deferred lamp
// uniforms. Has its own orbit camera so the renderer can swap to it for a clean,
// world-free illumination test. Bypasses LightField (debug mode is frozen here).
export class LightRoom {
  constructor(engine) {
    this.engine = engine
    this.config = { count: 4, spacing: 5, intensity: LIGHT_INTENSITY, animate: false }
    this.lampPos = [] // Vector3[] written into deferred.lamps
    this._fixtures = null
    this._sphereGeo = null
    this._pillarGeo = null // tool-owned full-cell test box (not in the shared set)
    this._anim = 0

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x0a0a07)

    this.target = new THREE.Vector3(0, 1.1, 0)
    this.radius = 15
    this.theta = 0.7
    this.phi = 1.0
    this.camera = new THREE.PerspectiveCamera(FOV, 1, NEAR, FAR)
    this.camera.rotation.order = 'YXZ'

    this._build()
    this.rebuildLamps()
    this._applyCamera()
  }

  _build() {
    const { materials, geom } = this.engine

    // Floor + ceiling (static, mapped, lit surfaces).
    const floor = new THREE.Mesh(geom.floor, materials.carpet)
    this.scene.add(floor)
    const ceiling = new THREE.Mesh(geom.ceiling, materials.ceiling)
    ceiling.position.y = WALL_H
    this.scene.add(ceiling)

    // Perimeter walls + a couple of interior test pillars (instanced wallpaper).
    const cells = []
    for (let gz = -HALF; gz <= HALF; gz++) {
      for (let gx = -HALF; gx <= HALF; gx++) {
        if (Math.abs(gx) === HALF || Math.abs(gz) === HALF) cells.push([gx, gz])
      }
    }
    cells.push([-1, -1], [2, 1]) // interior props
    // Full-cell test box, tool-owned: the shared geometry set no longer ships a
    // `pillar` (production walls/columns use per-instance-scaled unit cubes), so
    // the room makes + disposes its own here.
    this._pillarGeo = new THREE.BoxGeometry(CELL, WALL_H, CELL)
    const walls = new THREE.InstancedMesh(this._pillarGeo, materials.wallpaper, cells.length)
    const m = new THREE.Matrix4()
    cells.forEach(([gx, gz], i) => {
      m.makeTranslation(gx * CELL, WALL_H / 2, gz * CELL)
      walls.setMatrixAt(i, m)
    })
    walls.instanceMatrix.needsUpdate = true
    this.scene.add(walls)
    this._walls = walls

    // Entity capsule (matID 2) — inspect rim/shadow on the AI silhouette.
    const ent = new THREE.Mesh(geom.entity, materials.entity)
    ent.scale.set(1, 1.28, 1)
    ent.position.set(-3, 1.2, 2)
    this.scene.add(ent)

    // A neutral lit sphere (tool-owned geometry, shared lit material).
    this._sphereGeo = new THREE.SphereGeometry(1.2, 32, 24)
    const sphere = new THREE.Mesh(this._sphereGeo, materials.ceiling)
    sphere.position.set(3, 1.4, -2)
    this.scene.add(sphere)
  }

  // Recompute lamp positions + the visual fixture instances from config.count.
  rebuildLamps() {
    const n = Math.max(1, Math.min(LIGHT_MAX, this.config.count | 0))
    const sp = this.config.spacing
    const cols = Math.ceil(Math.sqrt(n))
    this.lampPos = []
    for (let i = 0; i < n; i++) {
      const col = i % cols
      const row = Math.floor(i / cols)
      const x = (col - (cols - 1) / 2) * sp
      const z = (row - (cols - 1) / 2) * sp
      this.lampPos.push(new THREE.Vector3(x, WALL_H - 0.3, z))
    }

    if (this._fixtures) {
      this.scene.remove(this._fixtures)
      this._fixtures.dispose() // instance buffers only; shared geom/material kept
    }
    const fix = new THREE.InstancedMesh(this.engine.geom.panel, this.engine.materials.panel, n)
    const m = new THREE.Matrix4()
    const tint = [0, 0, 0]
    const c = new THREE.Color(1, 1, 1)
    for (let i = 0; i < n; i++) {
      const p = this.lampPos[i]
      m.makeTranslation(p.x, WALL_H - 0.02, p.z)
      fix.setMatrixAt(i, m)
      // The shared panel material expects per-instance colour (production sets
      // it in mesh.js); the room previews the same fixture identity.
      lampPanelTint(p.x, p.z, 0, tint)
      fix.setColorAt(i, c.setRGB(tint[0], tint[1], tint[2]))
    }
    fix.instanceMatrix.needsUpdate = true
    fix.instanceColor.needsUpdate = true
    this.scene.add(fix)
    this._fixtures = fix
  }

  // Write our lamps into the shared deferred uniform array (LightField is idle).
  applyLamps(deferred) {
    const L = deferred.lamps
    const n = this.lampPos.length
    const tint = [0, 0, 0]
    for (let i = 0; i < n; i++) {
      L.uLampPos.value[i].copy(this.lampPos[i])
      lampTint(this.lampPos[i].x, this.lampPos[i].z, 0, tint)
      // raw flicker 1: isolated room runs steady tubes (no flicker dip on cast
      // light). DeferredRenderer folds raw * query-edge fade into uLampChar.w.
      L.uLampChar.value[i].set(tint[0], tint[1], tint[2], 1)
      L.lampFlickerRaw[i] = 1
    }
    L.uLampCount.value = n
    deferred.lightUniforms.uLampIntensity.value = this.config.intensity
    deferred.lightUniforms.uLampFlicker.value = 1 // isolated room: no flicker dip on the cast light
    if (deferred.volUniforms) deferred.volUniforms.uLampRange.value = deferred.lightUniforms.uLampRange.value
    this.engine.materials.panel.uniforms.uIntensity.value = 1 // stop flicker-driven dimming
  }

  update(dt) {
    if (this.config.animate) {
      this._anim += dt * 0.3
      this.theta = this._anim
      this._applyCamera()
    }
  }

  setAspect(a) {
    this.camera.aspect = a
    this.camera.updateProjectionMatrix()
  }

  _applyCamera() {
    const t = this.target
    const sp = Math.sin(this.phi)
    this.camera.position.set(
      t.x + this.radius * sp * Math.sin(this.theta),
      t.y + this.radius * Math.cos(this.phi),
      t.z + this.radius * sp * Math.cos(this.theta)
    )
    this.camera.lookAt(t)
    this.camera.updateMatrixWorld(true)
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert()
  }

  // Orbit controls (wired by DebugMode while the room is active).
  onPointerDown(e) {
    if (e.button === 0) {
      this._drag = true
      this._lx = e.clientX
      this._ly = e.clientY
    }
  }
  onPointerUp() {
    this._drag = false
  }
  onPointerMove(e) {
    if (!this._drag) return
    this.theta -= (e.clientX - this._lx) * 0.006
    this.phi = Math.max(0.2, Math.min(1.5, this.phi - (e.clientY - this._ly) * 0.006))
    this._lx = e.clientX
    this._ly = e.clientY
    this._applyCamera()
  }
  onWheel(e) {
    this.radius = Math.max(5, Math.min(60, this.radius * Math.exp(e.deltaY * 0.001)))
    this._applyCamera()
  }

  dispose() {
    if (this._fixtures) this._fixtures.dispose()
    if (this._walls) this._walls.dispose()
    if (this._sphereGeo) this._sphereGeo.dispose()
    if (this._pillarGeo) this._pillarGeo.dispose()
  }
}
