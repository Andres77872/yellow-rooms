import * as THREE from 'three'
import { floorTexture, wallTexture, ceilingTexture } from './textures.js'
import { familyPalette } from '../world/familyPalette.js'
import { MAP_FAMILY_OFFICE } from '../world/mapTypes.js'

// G-buffer materials for the deferred pipeline. Each writes two MRT targets:
//   layout(location=0) gColor  = vec4(albedoLinear.rgb, matID)
//   layout(location=1) gNormal = vec4(viewNormal*0.5+0.5, gloss)
// matID: 0 = lit surface, 1 = emissive (passed through), 2 = entity.
// gloss: 0..1 strength of the stylised lamp highlight (lighting.js). It rides
// in the normal target's otherwise-constant alpha, so it costs no bandwidth.
//
// RawShaderMaterial (GLSL3) is used so we fully control the MRT outputs and the
// instancing transform — three's ShaderMaterial would inject its own fragment
// output which collides with explicit `layout(location=...)` declarations.

const VERT_STATIC = /* glsl */ `
  precision highp float;
  in vec3 position;
  in vec3 normal;
  in vec2 uv;
  #ifdef USE_PART_COLOR
    in vec3 color;
  #endif
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
    // Per-vertex part color baked from the Blender GLB materials
    // (enemyModels.js): one merged mesh tints each part separately.
    #ifdef USE_PART_COLOR
      vTint *= color;
    #endif
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
  #ifdef USE_PART_COLOR
    in vec3 color;
  #endif
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  uniform mat3 normalMatrix;
  out vec2 vUv;
  out vec3 vViewNormal;
  out vec3 vTint;
  void main(){
    vUv = uv;
    // Inverse-transpose for the orthogonal rotation/scale instance basis.
    // Multiplying normals by the position matrix bends the lighting across
    // bevels whenever a model is stretched along only one axis.
    mat3 basis = mat3(instanceMatrix);
    vec3 scaleSq = vec3(dot(basis[0], basis[0]), dot(basis[1], basis[1]), dot(basis[2], basis[2]));
    vec3 iNormal = basis * (normal / max(scaleSq, vec3(1e-8)));
    vViewNormal = normalize(normalMatrix * iNormal);
    // Per-instance albedo multiplier (door-leaf tones, panel tube identity).
    // Only enabled on materials whose meshes ALWAYS setColorAt — an unbound
    // attribute reads as black, so it stays opt-in via the define.
    #ifdef USE_INSTANCING_COLOR
      vTint = instanceColor;
    #else
      vTint = vec3(1.0);
    #endif
    // Per-vertex part color baked from the Blender GLB materials
    // (furnitureModels.js): one merged mesh tints each part separately.
    #ifdef USE_PART_COLOR
      vTint *= color;
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
  uniform float uGloss;
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
    gNormal = vec4(normalize(vViewNormal) * 0.5 + 0.5, uGloss);
  }
`

// Linear THREE.Color from an sRGB hex. THREE.ColorManagement.enabled (set in
// Engine) makes the Color constructor decode sRGB -> linear once, so we must NOT
// call convertSRGBToLinear() on top (double-decode darkened every flat color).
const lin = (hex) => new THREE.Color(hex)

// Surface gloss by palette style: soft furnishings are matte, glazed tile and
// bare metal carry the painted lamp streaks anime corridors are known for.
export const SURFACE_GLOSS = Object.freeze({
  carpet: 0, concrete: 0.16, tile: 0.55, deck: 0.38,
  wallpaper: 0.03, brick: 0.05, panel: 0.28, steel: 0.34,
  vault: 0.06,
})
const glossOf = (spec) => SURFACE_GLOSS[spec?.style] ?? 0

function surfaceMaterial(map, instanced) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    defines: { USE_MAP: '' },
    uniforms: {
      map: { value: map },
      uColor: { value: new THREE.Color(1, 1, 1) },
      uIntensity: { value: 1 }, // unused in the USE_MAP branch; kept so all three factories share one uniform block
      uMatID: { value: 0 },
      uGloss: { value: 0 },
    },
    vertexShader: instanced ? VERT_INSTANCED : VERT_STATIC,
    fragmentShader: FRAG,
  })
}

function flatMaterial(colorLinear, matID, instanced, tinted = false, partColor = false, gloss = 0) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    defines: {
      ...(tinted ? { USE_INSTANCING_COLOR: '' } : {}),
      ...(partColor ? { USE_PART_COLOR: '' } : {}),
    },
    uniforms: {
      map: { value: null },
      uColor: { value: colorLinear },
      uIntensity: { value: 1 },
      uMatID: { value: matID },
      uGloss: { value: gloss },
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
      uGloss: { value: 0 },
    },
    vertexShader: instanced ? VERT_INSTANCED : VERT_STATIC,
    fragmentShader: FRAG,
  })
}

// One canvas-texture set per family, built lazily and kept for the renderer's
// lifetime (a handful of 256² canvases — cheaper than regenerating on every
// family switch at the title screen).
const TEXTURE_CACHE = new WeakMap()
const MATERIAL_OWNERS = new WeakMap()

function familyTextures(renderer, family) {
  const aniso = renderer.capabilities.getMaxAnisotropy()
  let owner = TEXTURE_CACHE.get(renderer)
  if (!owner) {
    owner = { sets: new Map(), references: 0 }
    TEXTURE_CACHE.set(renderer, owner)
  }
  let set = owner.sets.get(family)
  if (!set) {
    const pal = familyPalette(family)
    set = {
      floor: floorTexture(aniso, pal.floor),
      wall: wallTexture(aniso, pal.wall),
      ceiling: ceilingTexture(aniso, pal.ceiling),
    }
    owner.sets.set(family, set)
  }
  return set
}

// Swap the family-driven surfaces/colors on an EXISTING material set in place.
// Everything holding a reference (ChunkManager, chunk meshes about to rebuild,
// entities) keeps working; chunks re-mesh on the next level setup anyway.
export function applyFamilyMaterials(materials, renderer, family) {
  const pal = familyPalette(family)
  const tex = familyTextures(renderer, family)
  materials.carpet.uniforms.map.value = tex.floor
  materials.ceiling.uniforms.map.value = tex.ceiling
  materials.wallpaper.uniforms.map.value = tex.wall
  materials.carpet.uniforms.uGloss.value = glossOf(pal.floor)
  materials.ceiling.uniforms.uGloss.value = glossOf(pal.ceiling) * 0.5
  materials.wallpaper.uniforms.uGloss.value = glossOf(pal.wall)
  materials.panel.uniforms.uColor.value = lin(pal.panel)
  materials.panelDead.uniforms.uColor.value = lin(pal.panelDead)
  materials.doorFrame.uniforms.uColor.value = lin(pal.trim)
  materials.doorLeaf.uniforms.uColor.value = lin(pal.leaf)
  return pal
}

export function createGBufferMaterials(renderer, family = MAP_FAMILY_OFFICE) {
  const pal = familyPalette(family)
  const tex = familyTextures(renderer, family)

  const carpet = surfaceMaterial(tex.floor, false) // floor mesh
  const ceiling = surfaceMaterial(tex.ceiling, false) // ceiling mesh
  const wallpaper = surfaceMaterial(tex.wall, true) // instanced pillars
  carpet.uniforms.uGloss.value = glossOf(pal.floor)
  ceiling.uniforms.uGloss.value = glossOf(pal.ceiling) * 0.5
  wallpaper.uniforms.uGloss.value = glossOf(pal.wall)

  const panel = emissiveMaterial(lin(pal.panel), true, true) // instanced lit lamps, per-tube identity tint
  const panelDead = flatMaterial(lin(pal.panelDead), 0, true, false, false, 0.35) // instanced dead tubes (diffuser plastic)
  // Entities carry a faint wet sheen: under a tube their silhouettes catch
  // one hard highlight, which reads as "alive" more than any texture could.
  const entity = flatMaterial(lin(0x16161c), 2, false, false, false, 0.3) // Stalker capsule silhouette (near-black)
  const pursuer = flatMaterial(lin(0x3a0d0d), 2, false, false, false, 0.45) // Pursuer silhouette (dark blood-red, distinct)
  const husk = flatMaterial(lin(0x5c5847), 2, false, false, false, 0.2) // Husk silhouette (pale ash — the weak one)
  // Blender-built enemy GLBs (render/enemyModels.js): merged per-entity
  // geometry whose baked vertex colors carry the per-part palette (ink body,
  // pale oval head / pinpoint eyes / hollow void face). Same matID-2 entity
  // lane as the capsule silhouettes; entities swap to this on upgradeModel.
  const entityModel = flatMaterial(lin(0xffffff), 2, false, false, true, 0.3)
  const exit = emissiveMaterial(lin(0xeafff2), false) // glowing anomaly

  const doorFrame = flatMaterial(lin(pal.trim), 0, true, false, false, 0.3) // instanced door/window casings (family trim, painted gloss)
  // Painted leaf base; per-door instanceColor tones it (brightness band,
  // rare dark stain) and darkens the knob to metal — see mesh.js leafTint.
  const doorLeaf = flatMaterial(lin(pal.leaf), 0, true, true, false, 0.25)
  // Interior props (thresholds, radiators, clocks, boards, extinguisher
  // cabinets, vents): white base tinted per instance by the objects/dressing
  // palettes.
  const prop = flatMaterial(lin(0xffffff), 0, true, true, false, 0.25)
  // Emissive wayfinding signs (exit + hanging blades): they glow and bloom
  // but are NOT in the light field — beacons, not lamps. Steady (no flicker
  // wiring), tinted per instance (exit green / blade amber).
  const signGlow = emissiveMaterial(lin(0xffffff), true, true)
  // Collision-real office furniture: white base tinted per part by the
  // objects/furniture palette (laminate, metal, fabric, screens, leaves).
  const furniture = flatMaterial(lin(0xffffff), 0, true, true, false, 0.22)
  // Blender-built furniture GLBs (render/furnitureModels.js): merged
  // per-kind geometry whose baked vertex colors carry the per-part palette,
  // multiplied by the per-instance tint. Same deferred lane as `furniture`;
  // mesh.js picks this path once the model library has loaded.
  const furnitureModel = flatMaterial(lin(0xffffff), 0, true, true, true, 0.22)

  const materials = { carpet, ceiling, wallpaper, panel, panelDead, entity, pursuer, husk, entityModel, exit, doorFrame, doorLeaf, prop, signGlow, furniture, furnitureModel }
  const owner = TEXTURE_CACHE.get(renderer)
  owner.references++
  MATERIAL_OWNERS.set(materials, owner)
  return materials
}

export function disposeGBufferMaterials(mats) {
  // Release only this renderer's cache, once its last material set leaves.
  // Disposing a second engine/preview must not invalidate a live world's
  // textures, and devices can have different anisotropy limits.
  const owner = MATERIAL_OWNERS.get(mats)
  if (owner) {
    MATERIAL_OWNERS.delete(mats)
    if (--owner.references === 0) {
      for (const set of owner.sets.values()) {
        set.floor.dispose()
        set.wall.dispose()
        set.ceiling.dispose()
      }
      owner.sets.clear()
    }
  }
  for (const m of Object.values(mats)) {
    if (!m) continue
    m.dispose?.()
  }
}
