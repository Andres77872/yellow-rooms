import * as THREE from 'three'
import { CELL, CHUNK_WORLD, LAYER_H, PANEL_GLOW, WALL_H, layerY } from '../../world/constants.js'
import { buildChunkMeshes } from '../../world/mesh.js'
import { createGeometries, disposeGeometries } from '../../render/geometries.js'
import { ceilingTexture, floorTexture, wallTexture } from '../../render/textures.js'
import { familyPalette } from '../../world/familyPalette.js'
import { createGBufferMaterials, disposeGBufferMaterials } from '../../render/gbufferMaterials.js'
import { DeferredRenderer } from '../../render/DeferredRenderer.js'
import { LightGrid } from '../../world/lightGrid/LightGrid.js'
import { furnitureProxyBoxes } from '../../world/objects/furniture/proxies.js'
import { GRAPHICS_PRESETS, resolveGraphics } from '../../core/graphics.js'

// 3D preview of the edited document. Reuses the game's chunk mesher
// (world/mesh.js) verbatim. Two modes (engine-improvement gap G8):
//   geometry  standard lit materials under the same keys — a fast, readable
//             geometry preview with conventional lighting (the default);
//   look id   the PRODUCTION path: G-buffer materials, the deferred renderer,
//             the chosen look profile and a world light grid baked from the
//             edited chunks, so authors approve the look the game ships.
// Orbit views sit far above the plate, so the game-look fog is thinned.
export const PREVIEW_GEOMETRY = 'geometry'
// Stacked storeys hide each other from an orbit camera; tall structures are
// reviewed as cutaways. `below` keeps every floor up to the current one (the
// structure's lower storeys stay in context), `floor` isolates one storey.
export const PREVIEW_CLIP_MODES = Object.freeze([
  Object.freeze({ id: 'all', label: 'all' }),
  Object.freeze({ id: 'below', label: '≤ floor' }),
  Object.freeze({ id: 'floor', label: 'floor' }),
])

export function previewChunkVisible(clip, chunkCy, floor) {
  if (clip === 'below') return chunkCy <= floor
  if (clip === 'floor') return chunkCy === floor
  return true
}
const EDITOR_FOG_DENSITY = 0.0035
// Geometry-mode haze scales with the orbit distance: the historical 0.008 at
// a 60-unit orbit, so a framed 4×4-chunk Lattice district (~200 units away)
// is not swallowed by fog while small plates keep their depth cue.
const GEOMETRY_FOG_AT_UNIT = 0.48
export const geometryFogDensity = (radius) =>
  Math.min(0.012, Math.max(0.0012, GEOMETRY_FOG_AT_UNIT / Math.max(1, radius)))
// The quality tier the look preview renders at: the desktop default. Without
// one the renderer never builds the furniture shadow/box AO variant, and the
// passes run on constructor placeholders instead of real tier values.
const PREVIEW_PRESET = 'high'
// Mean of the game's fluorescent hum (Engine._updateFlicker), so a still
// preview panel reads as bright as the game's on average.
const PANEL_HUM_MEAN = 0.92

// The look's fixture brightness and troffer face on the panel material. The
// game sets both every frame (Engine._updateFlicker), and so does the preview
// (render): a look whose lighting build differs commits asynchronously, so
// deferred.panelGlow/panelPattern change some frames after setLook.
export function applyPreviewPanelLook(materials, deferred) {
  const u = materials.panel.uniforms
  u.uIntensity.value = PANEL_HUM_MEAN * PANEL_GLOW * (deferred.panelGlow ?? 1)
  if (u.uPanelPattern) u.uPanelPattern.value = deferred.panelPattern ?? 0
}

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
    this.materials = buildMaterials(this.renderer, app.previewSource().meta.family)
    this._family = app.previewSource().meta.family
    this.mode = PREVIEW_GEOMETRY
    this.game = null // { scene, materials, grid, deferred } while a look is previewed
    this._ceiling = true
    this.clip = app.previewClip ?? 'all'
    this._highlight = null // Box3Helper around the selected structure volume
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
    this.game?.deferred.setSize()
  }

  // Switch between the geometry preview and a production look profile id
  // (render/lookProfile.js). Rebuilds every chunk with the matching materials.
  setMode(mode) {
    if (mode === this.mode) return
    this.mode = mode
    if (mode === PREVIEW_GEOMETRY) {
      this._disposeGame()
    } else if (this.game) {
      this.game.deferred.setLook(mode)
    } else {
      this._createGame(mode)
    }
    this.sync(null)
  }

  _createGame(look) {
    const family = this._family
    const scene = new THREE.Scene()
    const materials = createGBufferMaterials(this.renderer, family)
    const grid = new LightGrid()
    // Furniture occupancy, as ChunkManager wires it: box shadows, box AO and
    // contact ownership need the proxies. Only together with the quality
    // tier below: with the furniture variant off, owned proxies would only
    // lose their screen-space contact shadows.
    grid.proxyBoxes = furnitureProxyBoxes
    const deferred = new DeferredRenderer(this.renderer, scene, this.camera)
    deferred.bindLightGrid(grid)
    deferred.applyPalette(familyPalette(family))
    deferred.setLook(look)
    const preset = GRAPHICS_PRESETS[PREVIEW_PRESET]
    deferred.applyQuality(
      resolveGraphics(
        { get: (k) => (k === 'preset' ? PREVIEW_PRESET : preset[k]) },
        { maxTextureSize: this.renderer.capabilities.maxTextureSize }
      )
    )
    deferred.lightUniforms.uFogDensity.value = EDITOR_FOG_DENSITY
    applyPreviewPanelLook(materials, deferred)
    this.game = { scene, materials, grid, deferred }
    this._applyCeiling()
  }

  _disposeGame() {
    if (!this.game) return
    for (const [, built] of this.built) this._drop(built)
    this.built.clear()
    this.game.deferred.dispose()
    disposeGBufferMaterials(this.game.materials)
    this.game = null
  }

  _applyCeiling() {
    for (const set of [this.materials, this.game?.materials]) {
      if (!set) continue
      set.ceiling.visible = this._ceiling
      set.panel.visible = this._ceiling
      set.panelDead.visible = this._ceiling
    }
  }

  fit() {
    const b = this.app.previewSource().bounds()
    if (!b) return
    this.orbit.tx = ((b.x0 + b.x1 + 1) / 2) * CHUNK_WORLD
    this.orbit.tz = ((b.z0 + b.z1 + 1) / 2) * CHUNK_WORLD
    this.orbit.ty = layerY(this.app.floor) + LAYER_H / 2
    const span = Math.max(b.x1 - b.x0 + 1, b.z1 - b.z0 + 1) * CHUNK_WORLD
    this.orbit.radius = Math.max(30, span * 0.9)
  }

  setCeiling(visible) {
    this._ceiling = visible
    this._applyCeiling()
  }

  setClip(clip) {
    this.clip = clip
    this._applyClip()
  }

  // Floor changes keep the author's orbit; only the pivot height follows
  // (and the cutaway, when one is active).
  onFloorChanged() {
    this.orbit.ty = layerY(this.app.floor) + LAYER_H / 2
    this._applyClip()
  }

  // A cutaway lifts the lid of the cut storey: its ceiling and troffers are
  // hidden (via the mesher's semantic parts) so the floor plan reads from
  // above, while lower storeys keep theirs. The global "ceiling in 3D"
  // toggle still hides every ceiling through the shared materials.
  _applyClip() {
    const floor = this.app?.floor ?? 0
    for (const built of this.built.values()) this._applyClipTo(built, floor)
  }

  _applyClipTo(built, floor) {
    built.group.visible = previewChunkVisible(this.clip, built.cy, floor)
    const lid = !(this.clip !== 'all' && built.cy === floor)
    const parts = built.parts
    if (!parts) return
    for (const part of [parts.ceiling, parts.litPanels, parts.deadPanels]) {
      if (part) part.visible = lid
    }
  }

  // Outline (geometry mode) and frame a structure volume: bounds × band.
  setHighlight(structure) {
    if (this._highlight) {
      this._highlight.parent?.remove(this._highlight)
      this._highlight.geometry.dispose()
      this._highlight.material.dispose()
      this._highlight = null
    }
    if (!structure?.globalBounds) return
    const b = structure.globalBounds
    const box = new THREE.Box3(
      new THREE.Vector3(b.x0 * CELL, layerY(structure.baseCy), b.z0 * CELL),
      new THREE.Vector3((b.x1 + 1) * CELL, layerY(structure.topCy) + WALL_H, (b.z1 + 1) * CELL)
    )
    this._highlight = new THREE.Box3Helper(box, 0x7fd0e8)
    // The deferred look path renders G-buffer materials only; the helper
    // lives in the geometry scene.
    this.scene.add(this._highlight)
  }

  frameStructure(structure) {
    const b = structure?.globalBounds
    if (!b) return
    this.orbit.tx = ((b.x0 + b.x1 + 1) / 2) * CELL
    this.orbit.tz = ((b.z0 + b.z1 + 1) / 2) * CELL
    this.orbit.ty = (layerY(structure.baseCy) + layerY(structure.topCy + 1)) / 2
    const span = Math.max((b.x1 - b.x0 + 1) * CELL, (b.z1 - b.z0 + 1) * CELL,
      (structure.topCy - structure.baseCy + 1) * LAYER_H)
    this.orbit.radius = Math.max(24, span * 1.1)
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
    const map = this.app.previewSource()
    if (map.meta.family !== this._family) {
      this._family = map.meta.family
      for (const m of Object.values(this.materials)) m.dispose?.()
      this.materials = buildMaterials(this.renderer, this._family)
      if (this.game) {
        const look = this.mode
        this._disposeGame()
        this._createGame(look)
      }
      this._applyCeiling()
      dirtyKeys = null // full rebuild with the new palette
    }
    const game = this.game
    const scene = game ? game.scene : this.scene
    const materials = game ? game.materials : this.materials
    if (dirtyKeys === null) {
      for (const [, built] of this.built) this._drop(built)
      this.built.clear()
      if (game) game.grid.reset()
      dirtyKeys = new Set(map.chunks.keys())
    }
    for (const key of dirtyKeys) {
      const prev = this.built.get(key)
      if (prev) {
        this._drop(prev)
        this.built.delete(key)
        if (game) game.grid.removeChunk(prev.cx, prev.cy, prev.cz)
      }
      const d = map.chunks.get(key)
      if (!d) continue
      const built = buildChunkMeshes(
        d, this.geom, materials,
        d.cx * CHUNK_WORLD, layerY(d.cy), d.cz * CHUNK_WORLD
      )
      built.cx = d.cx
      built.cy = d.cy
      built.cz = d.cz
      this._applyClipTo(built, this.app.floor)
      scene.add(built.group)
      this.built.set(key, built)
      if (game) game.grid.addChunk(d)
    }
    if (game) {
      // Edits are small; bake the affected light lists and bounce now.
      game.grid.setPlayerFloor(this.app.floor ?? 0)
      game.grid.flush()
    }
  }

  _drop(built) {
    built.group.parent?.remove(built.group)
    built.dispose()
  }

  render() {
    const o = this.orbit
    const y = o.ty + o.radius * Math.cos(o.phi)
    const r = o.radius * Math.sin(o.phi)
    this.camera.position.set(o.tx + r * Math.sin(o.theta), y, o.tz + r * Math.cos(o.theta))
    this.camera.lookAt(o.tx, o.ty, o.tz)
    if (this.game) {
      this.camera.updateMatrixWorld(true)
      applyPreviewPanelLook(this.game.materials, this.game.deferred)
      this.game.deferred.render(performance.now() / 1000)
    } else {
      this.scene.fog.density = geometryFogDensity(o.radius)
      this.renderer.render(this.scene, this.camera)
    }
  }

  dispose() {
    this.setHighlight(null)
    for (const [, built] of this.built) this._drop(built)
    this.built.clear()
    this._disposeGame()
    disposeGeometries(this.geom)
    for (const m of Object.values(this.materials)) m.dispose?.()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
