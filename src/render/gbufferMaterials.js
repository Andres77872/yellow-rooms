import * as THREE from 'three'
import { carpetTexture, wallpaperTexture, ceilingTexture } from './textures.js'
import { PANEL_COLOR } from '../world/constants.js'

// G-buffer materials for the deferred pipeline. Each writes two MRT targets:
//   layout(location=0) gColor  = vec4(albedoLinear.rgb, matID)
//   layout(location=1) gNormal = vec4(viewNormal*0.5+0.5, 1)
// matID: 0 = lit surface, 1 = emissive (passed through), 2 = entity.
//
// RawShaderMaterial (GLSL3) is used so we fully control the MRT outputs and the
// instancing transform — three's ShaderMaterial would inject its own fragment
// output which collides with explicit `layout(location=...)` declarations.

const VERT_STATIC = /* glsl */ `
  precision highp float;
  in vec3 position;
  in vec3 normal;
  in vec2 uv;
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  uniform mat3 normalMatrix;
  out vec2 vUv;
  out vec3 vViewNormal;
  out vec3 vTint;
  void main(){
    vUv = uv;
    vViewNormal = normalize(normalMatrix * normal);
    vTint = vec3(1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const VERT_INSTANCED = /* glsl */ `
  precision highp float;
  in vec3 position;
  in vec3 normal;
  in vec2 uv;
  in mat4 instanceMatrix;
  #ifdef USE_INSTANCING_COLOR
    in vec3 instanceColor;
  #endif
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  uniform mat3 normalMatrix;
  out vec2 vUv;
  out vec3 vViewNormal;
  out vec3 vTint;
  void main(){
    vUv = uv;
    vec3 iNormal = mat3(instanceMatrix) * normal;
    vViewNormal = normalize(normalMatrix * iNormal);
    // Per-instance albedo multiplier (door-leaf tones, panel tube identity).
    // Only enabled on materials whose meshes ALWAYS setColorAt — an unbound
    // attribute reads as black, so it stays opt-in via the define.
    #ifdef USE_INSTANCING_COLOR
      vTint = instanceColor;
    #else
      vTint = vec3(1.0);
    #endif
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`

const FRAG = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  in vec3 vViewNormal;
  in vec3 vTint;
  layout(location = 0) out vec4 gColor;
  layout(location = 1) out vec4 gNormal;
  uniform vec3 uColor;       // tint (map path) or flat/emissive color (linear)
  uniform float uIntensity;  // emissive multiplier (flicker)
  uniform float uMatID;
  #ifdef USE_MAP
    uniform sampler2D map;
  #endif
  void main(){
    vec3 albedo;
    #ifdef USE_MAP
      // Textures are tagged THREE.SRGBColorSpace (textures.js), so the GPU sampler
      // already returns linear values — decoding again here would double-decode and
      // darken every textured surface (~5.7x at mid grey).
      albedo = texture(map, vUv).rgb * uColor * vTint;
    #else
      albedo = uColor * uIntensity * vTint;
    #endif
    gColor = vec4(albedo, uMatID);
    gNormal = vec4(normalize(vViewNormal) * 0.5 + 0.5, 1.0);
  }
`

// Linear THREE.Color from an sRGB hex. THREE.ColorManagement.enabled (set in
// Engine) makes the Color constructor decode sRGB -> linear once, so we must NOT
// call convertSRGBToLinear() on top (double-decode darkened every flat color).
const lin = (hex) => new THREE.Color(hex)

function surfaceMaterial(map, instanced) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    defines: { USE_MAP: '' },
    uniforms: {
      map: { value: map },
      uColor: { value: new THREE.Color(1, 1, 1) },
      uIntensity: { value: 1 }, // unused in the USE_MAP branch; kept so all three factories share one uniform block
      uMatID: { value: 0 },
    },
    vertexShader: instanced ? VERT_INSTANCED : VERT_STATIC,
    fragmentShader: FRAG,
  })
}

function flatMaterial(colorLinear, matID, instanced, tinted = false) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    defines: tinted ? { USE_INSTANCING_COLOR: '' } : {},
    uniforms: {
      map: { value: null },
      uColor: { value: colorLinear },
      uIntensity: { value: 1 },
      uMatID: { value: matID },
    },
    vertexShader: instanced ? VERT_INSTANCED : VERT_STATIC,
    fragmentShader: FRAG,
  })
}

function emissiveMaterial(colorLinear, instanced, tinted = false) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    defines: tinted ? { USE_INSTANCING_COLOR: '' } : {},
    uniforms: {
      map: { value: null },
      uColor: { value: colorLinear },
      uIntensity: { value: 1 }, // flicker multiplier, updated per frame
      uMatID: { value: 1 },
    },
    vertexShader: instanced ? VERT_INSTANCED : VERT_STATIC,
    fragmentShader: FRAG,
  })
}

export function createGBufferMaterials(renderer) {
  const aniso = renderer.capabilities.getMaxAnisotropy()

  const carpet = surfaceMaterial(carpetTexture(aniso), false) // floor mesh
  const ceiling = surfaceMaterial(ceilingTexture(aniso), false) // ceiling mesh
  const wallpaper = surfaceMaterial(wallpaperTexture(aniso), true) // instanced pillars

  const panel = emissiveMaterial(lin(PANEL_COLOR), true, true) // instanced lit lamps, per-tube identity tint
  const panelDead = flatMaterial(lin(0x5c563a), 0, true) // instanced dead tubes
  const entity = flatMaterial(lin(0x16161c), 2, false) // Stalker capsule silhouette (near-black)
  const pursuer = flatMaterial(lin(0x3a0d0d), 2, false) // Pursuer silhouette (dark blood-red, distinct)
  const exit = emissiveMaterial(lin(0xeafff2), false) // glowing anomaly

  const doorFrame = flatMaterial(lin(0xd8d4c4), 0, true) // instanced door/window casings (off-white trim)
  // Painted-cream leaf base; per-door instanceColor tones it (brightness band,
  // rare dark stain) and darkens the knob to metal — see mesh.js leafTint.
  const doorLeaf = flatMaterial(lin(0xbfb49a), 0, true, true)
  // Interior props (thresholds, radiators, clocks, boards, extinguisher
  // cabinets, vents): white base tinted per instance by the objects/dressing
  // palettes.
  const prop = flatMaterial(lin(0xffffff), 0, true, true)
  // Emissive wayfinding signs (exit + hanging blades): they glow and bloom
  // but are NOT in the light field — beacons, not lamps. Steady (no flicker
  // wiring), tinted per instance (exit green / blade amber).
  const signGlow = emissiveMaterial(lin(0xffffff), true, true)
  // Collision-real office furniture: white base tinted per part by the
  // objects/furniture palette (laminate, metal, fabric, screens, leaves).
  const furniture = flatMaterial(lin(0xffffff), 0, true, true)

  return { carpet, ceiling, wallpaper, panel, panelDead, entity, pursuer, exit, doorFrame, doorLeaf, prop, signGlow, furniture }
}

export function disposeGBufferMaterials(mats) {
  for (const m of Object.values(mats)) {
    if (!m) continue
    if (m.uniforms?.map?.value) m.uniforms.map.value.dispose()
    m.dispose?.()
  }
}
