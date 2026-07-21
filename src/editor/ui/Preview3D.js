import * as THREE from 'three'
import { CHUNK_WORLD, LAYER_H, layerY } from '../../world/constants.js'
import { buildChunkMeshes } from '../../world/mesh.js'
import { createGeometries, disposeGeometries } from '../../render/geometries.js'
import { ceilingTexture, floorTexture, wallTexture } from '../../render/textures.js'
import { familyPalette } from '../../world/familyPalette.js'

// 3D preview of the edited document. Reuses the game's chunk mesher
// (world/mesh.js) verbatim, but with standard lit materials under the same
// keys instead of the deferred G-buffer shaders — a faithful geometry preview
// with conventional lighting, not the game's final look.

function buildMaterials(renderer, family) {
  const pal = familyPalette(family)
  const aniso = renderer.capabilities.getMaxAnisotropy()
  const tex = {
    floor: floorTexture(aniso, pal.floor),
    wall: wallTexture(aniso, pal.wall),
    ceiling: ceilingTexture(aniso, pal.ceiling),
  }
  const lambert = (opts) => new THREE.MeshLambertMaterial(opts)
  return {
    carpet: lambert({ map: tex.floor }),
    ceiling: lambert({ map: tex.ceiling }),
    wallpaper: lambert({ map: tex.wall }),
    panel: new THREE.MeshBasicMaterial({ color: pal.panel }),
    panelDead: new THREE.MeshBasicMaterial({ color: pal.panelDead }),
    doorFrame: lambert({ color: pal.trim }),
    doorLeaf: lambert({ color: pal.leaf }),
    prop: lambert({ color: 0xffffff }),
    signGlow: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    furniture: lambert({ color: 0xffffff }),
    exit: new THREE.MeshBasicMaterial({ color: 0xeafff2 }),
  }
}

export class Preview3D {
  constructor(app, container) {
    this.app = app
    this.container = container
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setClearColor(0x17120a)
    container.appendChild(this.renderer.domElement)
    this.scene = new THREE.Scene()
    this.scene.fog = new THREE.FogExp2(0x17120a, 0.008)
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 900)
    this.scene.add(new THREE.HemisphereLight(0xfff2c8, 0x55482c, 1.05))
    const dir = new THREE.DirectionalLight(0xfff0c0, 0.6)
    dir.position.set(0.6, 1, 0.35)
    this.scene.add(dir)
    this.geom = createGeometries()
    this.materials = buildMaterials(this.renderer, app.map.meta.family)
    this._family = app.map.meta.family
    this.built = new Map() // key3 -> {group, dispose}
    this.orbit = { tx: 0, ty: 0, tz: 0, radius: 60, theta: -0.7, phi: 1.0 }
    this._bind()
    this.resize()
    this.fit()
  }

  resize() {
    const rect = this.container.getBoundingClientRect()
    const w = Math.max(1, rect.width)
    const h = Math.max(1, rect.height)
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    this.renderer.setSize(w, h, true)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  fit() {
    const b = this.app.map.bounds()
    if (!b) return
    this.orbit.tx = ((b.x0 + b.x1 + 1) / 2) * CHUNK_WORLD
    this.orbit.tz = ((b.z0 + b.z1 + 1) / 2) * CHUNK_WORLD
    this.orbit.ty = layerY(this.app.floor) + LAYER_H / 2
    const span = Math.max(b.x1 - b.x0 + 1, b.z1 - b.z0 + 1) * CHUNK_WORLD
    this.orbit.radius = Math.max(30, span * 0.9)
  }

  setCeiling(visible) {
    this.materials.ceiling.visible = visible
    this.materials.panel.visible = visible
    this.materials.panelDead.visible = visible
  }

  _bind() {
    const el = this.renderer.domElement
    el.addEventListener('contextmenu', (e) => e.preventDefault())
    let drag = null
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId)
      drag = { x: e.clientX, y: e.clientY, pan: e.button !== 0 }
    })
    el.addEventListener('pointermove', (e) => {
      if (!drag) return
      const dx = e.clientX - drag.x
      const dy = e.clientY - drag.y
      drag.x = e.clientX
      drag.y = e.clientY
      const o = this.orbit
      if (drag.pan) {
        const scale = o.radius * 0.0016
        const sin = Math.sin(o.theta), cos = Math.cos(o.theta)
        o.tx -= (dx * cos - dy * sin) * scale
        o.tz -= (dx * sin + dy * cos) * scale
      } else {
        o.theta -= dx * 0.005
        o.phi = Math.min(1.5, Math.max(0.08, o.phi - dy * 0.005))
      }
    })
    const end = () => { drag = null }
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
    el.addEventListener('wheel', (e) => {
      e.preventDefault()
      this.orbit.radius = Math.min(600, Math.max(6, this.orbit.radius * Math.exp(e.deltaY * 0.0012)))
    }, { passive: false })
  }

  // Rebuild chunks whose data changed; drop chunks deleted from the document.
  sync(dirtyKeys = null) {
    const { map } = this.app
    if (map.meta.family !== this._family) {
      this._family = map.meta.family
      for (const m of Object.values(this.materials)) m.dispose?.()
      this.materials = buildMaterials(this.renderer, this._family)
      dirtyKeys = null // full rebuild with the new palette
    }
    if (dirtyKeys === null) {
      for (const [, built] of this.built) this._drop(built)
      this.built.clear()
      dirtyKeys = new Set(map.chunks.keys())
    }
    for (const key of dirtyKeys) {
      const prev = this.built.get(key)
      if (prev) {
        this._drop(prev)
        this.built.delete(key)
      }
      const d = map.chunks.get(key)
      if (!d) continue
      const built = buildChunkMeshes(
        d, this.geom, this.materials,
        d.cx * CHUNK_WORLD, layerY(d.cy), d.cz * CHUNK_WORLD
      )
      this.scene.add(built.group)
      this.built.set(key, built)
    }
  }

  _drop(built) {
    this.scene.remove(built.group)
    built.dispose()
  }

  render() {
    const o = this.orbit
    const y = o.ty + o.radius * Math.cos(o.phi)
    const r = o.radius * Math.sin(o.phi)
    this.camera.position.set(o.tx + r * Math.sin(o.theta), y, o.tz + r * Math.cos(o.theta))
    this.camera.lookAt(o.tx, o.ty, o.tz)
    this.renderer.render(this.scene, this.camera)
  }

  dispose() {
    for (const [, built] of this.built) this._drop(built)
    this.built.clear()
    disposeGeometries(this.geom)
    for (const m of Object.values(this.materials)) m.dispose?.()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
