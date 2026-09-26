import * as THREE from 'three'
import { LIGHT_INTENSITY, LIGHT_RANGE, PANEL_GLOW } from '../world/constants.js'

// Standard-material reference for the debug light room (engine-improvement
// R1 / ADR-001 option B). Mirrors a scene built from G-buffer materials into
// stock MeshStandardMaterial meshes lit by stock PointLights, so the custom
// deferred BRDF can be compared against three.js's own physical shading at
// the identical camera, geometry, albedo maps, roughness/metalness, fixture
// power and falloff window — and, because the renderer grades this HDR image
// with the same output pass, the identical exposure and tone mapper.
//
// Deliberate differences (named, not hidden): stock point lights have no
// downward diffuser profile or tube specular, and the ambient is a stock
// HemisphereLight rather than the grid bounce; the light room has no grid.

const white = new THREE.Color(1, 1, 1)

function mirrorMaterial(src) {
  const u = src.uniforms ?? {}
  const color = (u.uColor?.value ?? white).clone()
  const matID = u.uMatID?.value ?? 0
  if (matID === 1) {
    // Emissive fixture: same HDR glow the deferred panels carry.
    return new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: color,
      emissiveIntensity: PANEL_GLOW,
      vertexColors: false,
    })
  }
  const m = new THREE.MeshStandardMaterial({
    color,
    map: u.map?.value ?? null,
    roughness: u.uRoughness?.value ?? 0.6,
    metalness: u.uMetalness?.value ?? 0,
    vertexColors: !!src.defines?.USE_PART_COLOR,
  })
  return m
}

export class PbrReference {
  constructor() {
    this.scene = new THREE.Scene()
    this._owned = []
  }

  // Rebuild the mirror from a light room: its meshes, its lamp set and the
  // renderer's live lamp colour / power / ambient so both views agree.
  build(room, deferred) {
    this.dispose()
    this.scene = new THREE.Scene()
    const materials = new Map()
    const matFor = (src) => {
      if (!materials.has(src)) {
        const m = mirrorMaterial(src)
        materials.set(src, m)
        this._owned.push(m)
      }
      return materials.get(src)
    }
    room.scene.traverse((node) => {
      if (!node.isMesh) return
      const mat = matFor(node.material)
      let copy
      if (node.isInstancedMesh) {
        copy = new THREE.InstancedMesh(node.geometry, mat, node.count)
        copy.instanceMatrix = node.instanceMatrix
        if (node.instanceColor) copy.instanceColor = node.instanceColor
      } else {
        copy = new THREE.Mesh(node.geometry, mat)
      }
      node.updateWorldMatrix(true, false)
      copy.matrixAutoUpdate = false
      copy.matrix.copy(node.matrixWorld)
      copy.matrixWorld.copy(node.matrixWorld)
      copy.frustumCulled = false
      this.scene.add(copy)
    })
    const lu = deferred.lightUniforms
    const color = lu.uLampColor.value
    const power = lu.uLampIntensity.value ?? LIGHT_INTENSITY
    for (const p of room.lampPos) {
      // decay 2 + distance cutoff is three's physical point light: I / d^2
      // windowed by (1 - (d / range)^4)^2 — the same window the deferred
      // physical fixtures use. Lambert's 1/pi is applied by both BRDFs.
      const light = new THREE.PointLight(color, power, LIGHT_RANGE, 2)
      light.position.copy(p)
      this.scene.add(light)
    }
    // The deferred ambient is albedo x ambient (no 1/pi); stock Lambert divides
    // irradiance by pi, so the hemisphere carries pi to match.
    const hemi = (lu.uHemi?.value ?? 1) * Math.PI
    this.scene.add(new THREE.HemisphereLight(lu.uAmbSky.value.clone(), lu.uAmbGround.value.clone(), hemi))
    return this.scene
  }

  dispose() {
    for (const m of this._owned) m.dispose()
    this._owned.length = 0
  }
}
