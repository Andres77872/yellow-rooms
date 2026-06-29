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
  void main(){
    vUv = uv;
    vViewNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const VERT_INSTANCED = /* glsl */ `
  precision highp float;
  in vec3 position;
  in vec3 normal;
  in vec2 uv;
  in mat4 instanceMatrix;
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  uniform mat3 normalMatrix;
  out vec2 vUv;
  out vec3 vViewNormal;
  void main(){
    vUv = uv;
    vec3 iNormal = mat3(instanceMatrix) * normal;
    vViewNormal = normalize(normalMatrix * iNormal);
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`

const FRAG = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  in vec3 vViewNormal;
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
      albedo = texture(map, vUv).rgb * uColor;
    #else
      albedo = uColor * uIntensity;
    #endif
    gColor = vec4(albedo, uMatID);
    gNormal = vec4(normalize(vViewNormal) * 0.5 + 0.5, 1.0);
  }
`

// linear THREE.Color from an sRGB hex
const lin = (hex) => new THREE.Color(hex).convertSRGBToLinear()

function surfaceMaterial(map, instanced) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    defines: { USE_MAP: '' },
    uniforms: {
      map: { value: map },
      uColor: { value: new THREE.Color(1, 1, 1) },
      uIntensity: { value: 1 },
      uMatID: { value: 0 },
    },
    vertexShader: instanced ? VERT_INSTANCED : VERT_STATIC,
    fragmentShader: FRAG,
  })
}

function flatMaterial(colorLinear, matID, instanced) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
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

function emissiveMaterial(colorLinear, instanced) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
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

  const panel = emissiveMaterial(lin(PANEL_COLOR), true) // instanced lit lamps
  const panelDead = flatMaterial(lin(0x5c563a), 0, true) // instanced dead tubes
  const entity = flatMaterial(lin(0x16161c), 2, false) // Stalker capsule silhouette (near-black)
  const pursuer = flatMaterial(lin(0x3a0d0d), 2, false) // Pursuer silhouette (dark blood-red, distinct)
  const exit = emissiveMaterial(lin(0xeafff2), false) // glowing anomaly

  const doorFrame = flatMaterial(lin(0xd8d4c4), 0, true) // instanced door casings (off-white trim)
  const doorLeaf = flatMaterial(lin(0x9a9387), 0, true) // instanced open door leaves (grey)

  return { carpet, ceiling, wallpaper, panel, panelDead, entity, pursuer, exit, doorFrame, doorLeaf }
}

export function disposeGBufferMaterials(mats) {
  for (const m of Object.values(mats)) {
    if (!m) continue
    if (m.uniforms?.map?.value) m.uniforms.map.value.dispose()
    m.dispose?.()
  }
}
