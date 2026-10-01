import * as THREE from 'three'
import { CELL, CHUNK_WORLD, LIGHT_RANGE } from '../../world/constants.js'
import { lampTint } from '../../world/lampCharacter.js'
import { mirrorMaterial } from '../../debug/PbrReference.js'
import { FLASH_HAND_OFFSET } from '../flashFrame.js'

// Proxy scene for the experimental WebGPU path tracer's VIEWER
// (PathTraceView.js), plus the chunk, lamp and torch policies the realtime
// tracer shares with it (its own proxies are built in a worker:
// sceneMirror.js, chunkMerge.js, tracerHost.js).
//
// The tracer only understands MeshStandard/MeshPhysical materials and stock
// lights, and it writes into what it is given: setScene() hangs a BVH on
// every geometry and, with generateMissingAttributes, adds attributes to it.
// So nothing the deferred renderer draws is handed over. Resident chunks
// near the camera are mirrored instead. InstancedMesh batches stay
// instanced: the WebGPU backend's two-level BVH consumes instance matrices
// and instanceColor directly, so proxies share the chunks' instance
// attributes read-only and geometry is cloned once per source geometry.
// Cheap to build, but the tracer's top-level BVH then spans every instance:
// setScene costs ~65 us per instance (0.45 s for a 6.4k-instance
// neighbourhood, docs/pathracer/10), which only the frozen viewer can afford.
//
// Materials map through debug/PbrReference's mirrorMaterial, are kept for
// the builder's lifetime, and are re-synced from their G-buffer source on
// every build (a family switch retints the proxies in place).
//
// Emitters (docs/pathracer/07-experiments.md E3):
//   - every lit panel near the camera becomes a downward RectAreaLight with
//     the panel's 1.7 x 1.0 footprint, 1 cm BELOW the recessed panel mesh.
//     On the panel plane it would be coplanar with the mesh (double-counted
//     light, shadow-ray ties), so the lit-panel material becomes a dark,
//     non-emissive diffuser; area lights are invisible to camera rays, so
//     panel faces read dark in the traced image;
//   - radiance = lamp power / panel area, so the panel's on-axis intensity
//     equals the engine's point emitter (LIGHT_INTENSITY x look.lampPower)
//     and its cosine falloff stands in for the diffuser profile;
//   - the tracer picks NEE lights uniformly, so light count drives noise
//     (E3: 148 panels were ~2x noisier than 9). Only panels within
//     LIGHT_RANGE + one cell are kept, nearest first, capped at maxLights.
//     The engine windows every fixture to zero at LIGHT_RANGE, so the
//     dropped lamps contribute nothing to the raster frame either.

// Lit-panel footprint (render/geometries.js: PlaneGeometry(1.7, 1.0)).
export const PANEL_W = 1.7
export const PANEL_D = 1.0
export const PANEL_AREA = PANEL_W * PANEL_D
// Chunk lamp points hang at WALL_H - 0.5 (world/mesh.js); the recessed panel
// mesh sits at WALL_H - 0.02. The area light goes 1 cm below the mesh.
const LAMP_POINT_DROP = 0.5
const PANEL_MESH_DROP = 0.02
const PANEL_LIGHT_CLEARANCE = 0.01
export const PANEL_LIGHT_LIFT = LAMP_POINT_DROP - PANEL_MESH_DROP - PANEL_LIGHT_CLEARANCE

export const DEFAULT_LIGHT_RADIUS = LIGHT_RANGE + CELL
export const DEFAULT_MAX_LIGHTS = 64
// Geometry reach: every surface the kept lamps can light, plus a margin so
// corridors do not end in a void within the first bounce.
export const DEFAULT_GEOMETRY_RADIUS = DEFAULT_LIGHT_RADIUS + 2 * CELL
// Flashlight disc radius for the tracer's spot light (m). A hand torch lens.
const FLASH_RADIUS = 0.02

const white = new THREE.Color(1, 1, 1)
const _pos = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _v = new THREE.Vector3()
const _tint = [1, 1, 1]

// Horizontal distance from (x, z) to a chunk's footprint (0 inside it).
function chunkDistance(chunk, x, z) {
  const minX = chunk.cx * CHUNK_WORLD
  const minZ = chunk.cz * CHUNK_WORLD
  const dx = Math.max(minX - x, 0, x - (minX + CHUNK_WORLD))
  const dz = Math.max(minZ - z, 0, z - (minZ + CHUNK_WORLD))
  return Math.hypot(dx, dz)
}

const hasApertures = (c) => (c?.apertures?.length ?? 0) > 0

// Chunks the traced view needs, within `radius` horizontally: the camera's
// floor, plus a neighbouring floor's chunk only where an opening joins it to
// the camera floor (Chunk.apertures are holes in a chunk's CEILING: stairs,
// atria, multilevel voids). Everywhere else the slabs seal a floor, so the
// other floors' geometry could never be hit and only costs build time.
export function selectChunks(chunks, x, z, floor, radius = DEFAULT_GEOMETRY_RADIUS) {
  const list = [...chunks]
  const at = new Map()
  for (const c of list) at.set(`${c.cx},${c.cy ?? 0},${c.cz}`, c)
  const out = []
  for (const c of list) {
    const cy = c.cy ?? 0
    if (Math.abs(cy - floor) > 1) continue
    if (cy === floor + 1 && !hasApertures(at.get(`${c.cx},${floor},${c.cz}`))) continue
    if (cy === floor - 1 && !hasApertures(c)) continue
    if (chunkDistance(c, x, z) > radius) continue
    out.push(c)
  }
  return out
}

// Candidate lamps without the ChunkManager's cross-floor policy: the
// camera's floor only (a lamp on another floor is behind a slab unless an
// aperture says otherwise, and only collectLampsNear knows that).
export function floorLamps(chunks, floor) {
  const out = []
  for (const c of chunks) for (const lamp of c.lamps ?? []) if ((lamp.cy ?? floor) === floor) out.push(lamp)
  return out
}

// Of `candidates`, the lamps within `radius` (3D) of `origin`, nearest
// first, at most `max`. Returns { kept, culled }.
export function selectLamps(candidates, origin, radius = DEFAULT_LIGHT_RADIUS, max = DEFAULT_MAX_LIGHTS) {
  const near = []
  for (const lamp of candidates) {
    const d = lamp.distanceTo(origin)
    if (d <= radius) near.push({ lamp, d })
  }
  near.sort((a, b) => a.d - b.d)
  const kept = near.slice(0, max).map((e) => e.lamp)
  return { kept, culled: candidates.length - kept.length }
}

// The lit panels around `eye` as plain area-light descriptions (see the
// header): { lights: [{ color, intensity, width, height, position }], culled }.
// Every light points straight down (-Z rotated onto -Y) with its width on X
// like the panel. Plain data, so the realtime tracer's worker can rebuild
// them; the viewer turns them into RectAreaLights directly.
export function panelLights({
  eye,
  floor = 0,
  lamps = null,
  chunks = [],
  lampColor = white,
  lampPower = 1,
  lightRadius = DEFAULT_LIGHT_RADIUS,
  maxLights = DEFAULT_MAX_LIGHTS,
}) {
  const candidates = lamps ?? floorLamps(chunks, floor)
  const { kept, culled } = selectLamps(candidates, eye, lightRadius, maxLights)
  const lights = kept.map((lamp) => {
    lampTint(lamp.x, lamp.z, lamp.cy ?? floor, _tint, lamp.role ?? 0)
    return {
      color: [_tint[0] * lampColor.r, _tint[1] * lampColor.g, _tint[2] * lampColor.b],
      intensity: lampPower / PANEL_AREA,
      width: PANEL_W,
      height: PANEL_D,
      position: [lamp.x, lamp.y + PANEL_LIGHT_LIFT, lamp.z],
    }
  })
  return { lights, culled }
}

// A panel light description as a RectAreaLight (emitting side down).
export function rectAreaLight(desc) {
  const light = new THREE.RectAreaLight(new THREE.Color(...desc.color), desc.intensity, desc.width, desc.height)
  light.position.set(...desc.position)
  light.rotation.set(-Math.PI / 2, 0, 0)
  light.updateMatrixWorld()
  return light
}

// The torch as physical spot parameters: the engine's
// smoothstep(cosOuter, cosInner) cone mapped onto three's angle / penumbra,
// 1/d^2 out to the torch range.
export function flashlightParams({ color, intensity, range, cosInner, cosOuter }) {
  const outer = Math.acos(cosOuter)
  const inner = Math.acos(cosInner)
  return {
    color: [color.r, color.g, color.b],
    intensity,
    distance: range,
    angle: outer,
    penumbra: 1 - inner / outer,
    decay: 2,
    radius: FLASH_RADIUS,
  }
}

// Spot parameters as a SpotLight (aimed with aimFlashlight / flashPose).
export function spotFromParams(p, SpotLight = THREE.SpotLight, Color = THREE.Color) {
  const spot = new SpotLight(new Color(...p.color), p.intensity, p.distance, p.angle, p.penumbra, p.decay)
  spot.radius = p.radius
  return spot
}

export function flashlightSpot(flashlight) {
  return spotFromParams(flashlightParams(flashlight))
}

// Torch pose for `camera`: the hand-offset origin and a target 10 m along
// the camera's forward axis. Plain arrays, for the realtime worker.
export function flashPose(camera) {
  camera.updateMatrixWorld()
  _pos.set(...FLASH_HAND_OFFSET).applyMatrix4(camera.matrixWorld)
  camera.getWorldDirection(_dir)
  _v.copy(_pos).addScaledVector(_dir, 10)
  return { position: _pos.toArray(), target: _v.toArray() }
}

// Hand-offset origin, the camera's forward axis (the viewer re-aims it when
// the player looks around).
export function aimFlashlight(spot, camera) {
  const pose = flashPose(camera)
  spot.position.fromArray(pose.position)
  spot.target.position.fromArray(pose.target)
  spot.updateMatrixWorld()
  spot.target.updateMatrixWorld()
  return spot
}

// True when `node` and every ancestor below `root` is visible. The chunk
// group itself is skipped: its flag is the sight-culling result for the
// current eye, not whether the geometry exists (culled rooms still bounce).
function visibleBelow(node, root) {
  for (let n = node; n && n !== root; n = n.parent) if (!n.visible) return false
  return true
}

function triangleCount(geometry) {
  const n = geometry.index ? geometry.index.count : (geometry.attributes.position?.count ?? 0)
  return Math.floor(n / 3)
}

// Re-read a G-buffer material's live uniforms into its proxy.
function syncMaterial(proxy, src) {
  const u = src.uniforms ?? {}
  if ((u.uMatID?.value ?? 0) === 1) {
    proxy.emissive?.copy(u.uColor?.value ?? white)
    return
  }
  if (u.uColor) proxy.color.copy(u.uColor.value)
  proxy.map = u.map?.value ?? null
  proxy.roughness = u.uRoughness?.value ?? 0.6
  proxy.metalness = u.uMetalness?.value ?? 0
}

export class ProxySceneBuilder {
  constructor() {
    // Source geometry -> private clone (and, after the first setScene, its
    // BVH). Weak so furniture-model upgrades let old sources go.
    this._geometries = new WeakMap()
    this._clones = new Set()
    // G-buffer material -> proxy, for the builder's lifetime.
    this._materials = new Map()
    this._lights = []
    this._panelMaterial = null
  }

  _geometry(src) {
    let g = this._geometries.get(src)
    if (!g) {
      g = src.clone()
      this._geometries.set(src, g)
      this._clones.add(g)
    }
    return g
  }

  _material(src) {
    if (Array.isArray(src)) return src.map((m) => this._material(m))
    let m = this._materials.get(src)
    if (m) return m
    if (src === this._panelMaterial) {
      // Lit panels: the RectAreaLight below each one is the emitter (see the
      // header). A dark diffuser keeps the recess visible without emitting.
      m = new THREE.MeshStandardMaterial({ color: 0x202020, roughness: 0.4 })
    } else {
      m = mirrorMaterial(src)
    }
    m.side = src.side ?? THREE.FrontSide
    this._materials.set(src, m)
    return m
  }

  // Rebuild the proxy scene. Materials and geometry clones are cached; the
  // previous lights are released.
  //
  //   chunks         resident Chunk objects ({ cx, cy, cz, group, lamps })
  //   camera         the player camera (world matrix current)
  //   floor          the camera's layer index
  //   center         where geometry is gathered around (default: the camera)
  //   lamps          candidate lit lamps, normally ChunkManager.collectLampsNear
  //                  (the engine's own cross-floor spill policy); defaults to
  //                  the selected chunks' lamps on `floor`
  //   panelMaterial  the shared lit-panel G-buffer material
  //   lampColor      linear THREE.Color of the family's lamp (uLampColor)
  //   lampPower      engine lamp intensity (uLampIntensity)
  //   flashlight     null, or { color, intensity, range, cosInner, cosOuter }
  build({
    chunks,
    camera,
    floor = 0,
    center = null,
    lamps = null,
    panelMaterial = null,
    lampColor = new THREE.Color(1, 1, 1),
    lampPower = 1,
    flashlight = null,
    geometryRadius = DEFAULT_GEOMETRY_RADIUS,
    lightRadius = DEFAULT_LIGHT_RADIUS,
    maxLights = DEFAULT_MAX_LIGHTS,
  }) {
    this._disposeLights()
    this._panelMaterial = panelMaterial
    const scene = new THREE.Scene()
    const stats = {
      chunks: 0,
      meshes: 0,
      instances: 0,
      triangles: 0,
      lights: 0,
      culledLights: 0,
      flashlight: false,
    }

    camera.updateMatrixWorld()
    _pos.copy(center ?? _v.setFromMatrixPosition(camera.matrixWorld))
    const selected = selectChunks(chunks, _pos.x, _pos.z, floor, geometryRadius)
    stats.chunks = selected.length

    this._addInstanced(scene, selected, stats)
    // The lit-panel proxy is a fixed dark diffuser: never re-synced from its
    // (emissive) source.
    for (const [src, proxy] of this._materials) if (src !== panelMaterial) syncMaterial(proxy, src)

    const lit = this.setLights(scene, { camera, floor, lamps, chunks: selected, lampColor, lampPower, lightRadius, maxLights })
    stats.lights = lit.lights
    stats.culledLights = lit.culled

    let spot = null
    if (flashlight) {
      spot = flashlightSpot(flashlight)
      aimFlashlight(spot, camera)
      scene.add(spot, spot.target)
      this._lights.push(spot)
      stats.flashlight = true
    }

    scene.updateMatrixWorld(true)
    return { scene, stats, flashlight: spot }
  }

  _addInstanced(scene, selected, stats) {
    for (const chunk of selected) {
      const root = chunk.group
      root.updateWorldMatrix(true, true)
      root.traverse((node) => {
        if (!node.isMesh || node.isSkinnedMesh || !visibleBelow(node, root)) return
        const geometry = this._geometry(node.geometry)
        const material = this._material(node.material)
        let proxy
        if (node.isInstancedMesh) {
          if (node.count === 0) return
          proxy = new THREE.InstancedMesh(geometry, material, node.count)
          // Read-only share: the tracer reads matrices/colours at setScene.
          proxy.instanceMatrix = node.instanceMatrix
          if (node.instanceColor) proxy.instanceColor = node.instanceColor
          stats.instances += node.count
          stats.triangles += triangleCount(geometry) * node.count
        } else {
          proxy = new THREE.Mesh(geometry, material)
          stats.triangles += triangleCount(geometry)
        }
        proxy.matrixAutoUpdate = false
        proxy.matrix.copy(node.matrixWorld)
        proxy.matrixWorld.copy(node.matrixWorld)
        proxy.frustumCulled = false
        scene.add(proxy)
        stats.meshes++
      })
    }
  }

  // Replace the panel lights in `scene` (the flashlight is left alone).
  // Cheap: the tracer only re-packs its light buffer (updateLights()).
  setLights(scene, { camera, ...options }) {
    for (let i = this._lights.length - 1; i >= 0; i--) {
      const l = this._lights[i]
      if (!l.isRectAreaLight) continue
      l.removeFromParent()
      l.dispose()
      this._lights.splice(i, 1)
    }
    camera.updateMatrixWorld()
    const { lights, culled } = panelLights({ ...options, eye: _v.setFromMatrixPosition(camera.matrixWorld) })
    for (const desc of lights) {
      const light = rectAreaLight(desc)
      scene.add(light)
      this._lights.push(light)
    }
    return { lights: lights.length, culled }
  }

  _disposeLights() {
    for (const l of this._lights) {
      l.removeFromParent()
      l.dispose?.()
    }
    this._lights.length = 0
  }

  dispose() {
    this._disposeLights()
    for (const m of this._materials.values()) m.dispose()
    this._materials.clear()
    for (const g of this._clones) {
      g.boundsTree = null
      g.dispose()
    }
    this._clones.clear()
    this._geometries = new WeakMap()
  }
}
