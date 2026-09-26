import * as THREE from 'three'
import { floorTexture, wallTexture, ceilingTexture, surfaceDetailTexture } from './textures.js'
import { familyPalette } from '../world/familyPalette.js'
import { MAP_FAMILY_OFFICE } from '../world/mapTypes.js'
import { CELL, LAYER_H, WALL_H } from '../world/constants.js'
import { glslFloat } from './shaders/common.js'
import { MIN_ROUGHNESS, surfaceStyle } from './surfaces.js'

// G-buffer materials for the deferred pipeline — G-buffer v2
// (engine-improvement ADR-001 §3). Each writes three MRT targets:
//   location 0  gColor    = vec4(albedoLinear.rgb, matID)          RGBA16F
//   location 1  gNormal   = vec4(viewNormal*0.5+0.5, roughness)    RGBA8
//   location 2  gMaterial = vec4(metalness, materialAO, gloss, 1)  RGBA8
// matID: 0 = lit surface, 1 = emissive (passed through), 2 = entity.
// roughness: PERCEPTUAL roughness after geometric specular anti-aliasing.
// materialAO: baked/cavity occlusion (1 = open; distinct from screen SSAO).
// gloss: the legacy stylised highlight strength, retained so the Classic look
//   profile renders exactly as before; the PBR profiles ignore it.
//
// Architecture (floor, ceiling, walls, columns, steps) samples WORLD-space
// UVs: the dominant axis of the geometric normal picks the projection, so
// wallpaper keeps one texel density on sills, headers, end caps and beams,
// and continues across chunk seams (chapter 12 §4.5.1). Each axis has an
// explicit tangent frame, so the procedural detail maps need no MikkTSpace.
//
// RawShaderMaterial (GLSL3) is used so we fully control the MRT outputs and the
// instancing transform — three's ShaderMaterial would inject its own fragment
// output which collides with explicit `layout(location=...)` declarations.

const VARYINGS_OUT = /* glsl */ `
  out vec2 vUv;
  out vec3 vViewNormal;
  out vec3 vTint;
  out vec3 vWorldPos;
  out vec3 vWorldNormal;
  out vec2 vSurface;
`

// Linear-blend skinning for the rigged enemy GLBs (render/enemyModels.js).
// A RawShaderMaterial gets none of three's skinning chunks, but the renderer
// still binds bindMatrix/bindMatrixInverse/boneTexture for any SkinnedMesh
// that declares them (the same contract as skinning_pars_vertex), and the
// flashlight depth override (MeshDepthMaterial) skins itself — so the visible
// G-buffer pose and the torch shadow agree.
const SKINNING_PARS = /* glsl */ `
  #ifdef USE_SKINNING
    in vec4 skinIndex;
    in vec4 skinWeight;
    uniform mat4 bindMatrix;
    uniform mat4 bindMatrixInverse;
    uniform highp sampler2D boneTexture;
    mat4 getBoneMatrix(const in float i){
      int size = textureSize(boneTexture, 0).x;
      int j = int(i) * 4;
      int x = j % size;
      int y = j / size;
      return mat4(
        texelFetch(boneTexture, ivec2(x, y), 0),
        texelFetch(boneTexture, ivec2(x + 1, y), 0),
        texelFetch(boneTexture, ivec2(x + 2, y), 0),
        texelFetch(boneTexture, ivec2(x + 3, y), 0));
    }
  #endif
`

const VERT_STATIC = /* glsl */ `
  precision highp float;
  in vec3 position;
  in vec3 normal;
  in vec2 uv;
  #ifdef USE_PART_COLOR
    in vec3 color;
  #endif
  #ifdef USE_PART_SURFACE
    in vec2 surface;
  #endif
  uniform mat4 modelMatrix;
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  uniform mat3 normalMatrix;
  ${SKINNING_PARS}
  ${VARYINGS_OUT}
  void main(){
    vec3 pos = position;
    vec3 nrm = normal;
    #ifdef USE_SKINNING
      mat4 skinMatrix =
        skinWeight.x * getBoneMatrix(skinIndex.x) +
        skinWeight.y * getBoneMatrix(skinIndex.y) +
        skinWeight.z * getBoneMatrix(skinIndex.z) +
        skinWeight.w * getBoneMatrix(skinIndex.w);
      skinMatrix = bindMatrixInverse * skinMatrix * bindMatrix;
      pos = (skinMatrix * vec4(pos, 1.0)).xyz;
      // Rigid bone transforms: the blended upper 3x3 keeps normals within
      // the bend's blend region close enough before renormalization.
      nrm = mat3(skinMatrix) * nrm;
    #endif
    vUv = uv;
    vViewNormal = normalize(normalMatrix * nrm);
    vWorldNormal = normalize(mat3(modelMatrix) * nrm);
    vWorldPos = (modelMatrix * vec4(pos, 1.0)).xyz;
    vTint = vec3(1.0);
    // Per-vertex part color baked from the Blender GLB materials
    // (enemyModels.js): one merged mesh tints each part separately.
    #ifdef USE_PART_COLOR
      vTint *= color;
    #endif
    #ifdef USE_PART_SURFACE
      vSurface = surface;
    #else
      vSurface = vec2(-1.0);
    #endif
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
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
  #ifdef USE_PART_SURFACE
    in vec2 surface;
  #endif
  uniform mat4 modelMatrix;
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  uniform mat3 normalMatrix;
  ${VARYINGS_OUT}
  void main(){
    vUv = uv;
    // Inverse-transpose for the orthogonal rotation/scale instance basis.
    // Multiplying normals by the position matrix bends the lighting across
    // bevels whenever a model is stretched along only one axis.
    mat3 basis = mat3(instanceMatrix);
    vec3 scaleSq = vec3(dot(basis[0], basis[0]), dot(basis[1], basis[1]), dot(basis[2], basis[2]));
    vec3 iNormal = basis * (normal / max(scaleSq, vec3(1e-8)));
    vViewNormal = normalize(normalMatrix * iNormal);
    vWorldNormal = normalize(mat3(modelMatrix) * iNormal);
    vWorldPos = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
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
    #ifdef USE_PART_SURFACE
      vSurface = surface;
    #else
      vSurface = vec2(-1.0);
    #endif
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`

const FRAG = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  in vec3 vViewNormal;
  in vec3 vTint;
  in vec3 vWorldPos;
  in vec3 vWorldNormal;
  in vec2 vSurface;
  layout(location = 0) out vec4 gColor;
  layout(location = 1) out vec4 gNormal;
  layout(location = 2) out vec4 gMaterial;
  uniform mat4 viewMatrix;
  uniform vec3 uColor;       // tint (map path) or flat/emissive color (linear)
  uniform float uIntensity;  // emissive multiplier (flicker)
  uniform float uMatID;
  uniform float uGloss;      // legacy stylised highlight (Classic look)
  uniform float uRoughness;  // perceptual roughness (flat path) / scale (map path)
  uniform float uMetalness;
  uniform float uNormalScale;
  #ifdef USE_TROFFER
    uniform float uPanelPattern; // look: procedural troffer face (0 = flat panel)
  #endif
  #ifdef USE_MAP
    uniform sampler2D map;
  #endif
  #ifdef USE_DETAIL
    uniform sampler2D tDetail; // rg normal, b roughness, a cavity (textures.js)
  #endif

  // Geometric specular anti-aliasing (Tokuyoshi & Kaplanyan 2019, Filament's
  // form): widen roughness by the screen-space variance of the shading normal
  // so sub-pixel normal detail cannot alias into sparkling highlights under
  // head-bob, long before any temporal filter exists.
  float specularAA(vec3 N, float rough){
    vec3 du = dFdx(N);
    vec3 dv = dFdy(N);
    float variance = 0.15 * (dot(du, du) + dot(dv, dv));
    float a = rough * rough;
    float a2 = clamp(a * a + min(2.0 * variance, 0.2), 0.0, 1.0);
    return sqrt(sqrt(a2));
  }

  void main(){
    vec3 Nw = normalize(vWorldNormal);
    vec3 albedo;
    float rough = uRoughness;
    float metal = uMetalness;
    float matAO = 1.0;
    #ifdef USE_MAP
      vec2 uvw = vUv;
      #ifdef USE_WORLD_UV
        vec3 T = vec3(1.0, 0.0, 0.0);
        vec3 B = vec3(0.0, 0.0, -1.0);
        vec3 an = abs(Nw);
        float yl = mod(vWorldPos.y + 0.001, ${glslFloat(LAYER_H)}) - 0.001;
        if (an.y >= an.x && an.y >= an.z) {
          float s = Nw.y >= 0.0 ? 1.0 : -1.0;
          uvw = vec2(vWorldPos.x, -s * vWorldPos.z) / ${glslFloat(CELL)};
          B = vec3(0.0, 0.0, -s);
        } else if (an.x >= an.z) {
          float s = Nw.x >= 0.0 ? 1.0 : -1.0;
          uvw = vec2(-s * vWorldPos.z / ${glslFloat(CELL)}, yl / ${glslFloat(WALL_H)});
          T = vec3(0.0, 0.0, -s);
          B = vec3(0.0, 1.0, 0.0);
        } else {
          float s = Nw.z >= 0.0 ? 1.0 : -1.0;
          uvw = vec2(s * vWorldPos.x / ${glslFloat(CELL)}, yl / ${glslFloat(WALL_H)});
          T = vec3(s, 0.0, 0.0);
          B = vec3(0.0, 1.0, 0.0);
        }
      #endif
      // Textures are tagged THREE.SRGBColorSpace (textures.js), so the GPU sampler
      // already returns linear values — decoding again here would double-decode and
      // darken every textured surface (~5.7x at mid grey).
      albedo = texture(map, uvw).rgb * uColor * vTint;
      #if defined(USE_DETAIL) && defined(USE_WORLD_UV)
        vec4 det = texture(tDetail, uvw);
        vec2 nxy = (det.rg * 2.0 - 1.0) * uNormalScale;
        vec3 nts = vec3(nxy, sqrt(max(1.0 - dot(nxy, nxy), 0.0)));
        Nw = normalize(T * nts.x + B * nts.y + Nw * nts.z);
        rough = det.b * uRoughness;
        matAO = det.a;
      #endif
    #else
      albedo = uColor * uIntensity * vTint;
      #ifdef USE_TROFFER
        // Procedural troffer face (chapter 14 P19), emissive only, so it adds
        // no lighting cost: a 4 cm metal frame, a 2 cm prismatic lens grid
        // (+-6%), two tube bands along the long axis (+30%) and a 10% end
        // falloff. vUv spans the 1.7 x 1.0 m panel, u along its long axis.
        vec2 pm = vec2(vUv.x * 1.7, vUv.y);
        float rim = min(min(pm.x, 1.7 - pm.x), min(pm.y, 1.0 - pm.y));
        vec2 cellP = fract(pm / 0.02) - 0.5;
        float prism = 1.0 + 0.06 * (1.0 - 4.0 * max(abs(cellP.x), abs(cellP.y)));
        float ty0 = (pm.y - 0.333) / 0.06;
        float ty1 = (pm.y - 0.667) / 0.06;
        float tubes = 1.0 + 0.3 * (exp(-ty0 * ty0) + exp(-ty1 * ty1));
        float ends = 1.0 - 0.1 * (1.0 - smoothstep(0.0, 0.25, min(pm.x, 1.7 - pm.x)));
        float face = mix(prism * tubes * ends, 0.35, step(rim, 0.04));
        albedo *= mix(1.0, face, uPanelPattern);
      #endif
    #endif
    // Preserved glTF surface (furniture / enemy parts): per-vertex roughness
    // and metalness resolved from the Blender material vocabulary.
    if (vSurface.x >= 0.0) {
      rough = vSurface.x;
      metal = vSurface.y;
    }
    rough = specularAA(Nw, max(rough, ${glslFloat(MIN_ROUGHNESS)}));
    vec3 Nv = normalize(mat3(viewMatrix) * Nw);
    gColor = vec4(albedo, uMatID);
    gNormal = vec4(Nv * 0.5 + 0.5, rough);
    gMaterial = vec4(metal, matAO, uGloss, 1.0);
  }
`

// Linear THREE.Color from an sRGB hex. THREE.ColorManagement.enabled (set in
// Engine) makes the Color constructor decode sRGB -> linear once, so we must NOT
// call convertSRGBToLinear() on top (double-decode darkened every flat color).
const lin = (hex) => new THREE.Color(hex)

// Surface gloss by palette style: soft furnishings are matte, glazed tile and
// bare metal carry the painted lamp streaks anime corridors are known for.
// (Classic look only; the physical profiles read roughness/metalness.)
export const SURFACE_GLOSS = Object.freeze({
  carpet: 0, concrete: 0.16, tile: 0.55, deck: 0.38,
  wallpaper: 0.03, brick: 0.05, panel: 0.28, steel: 0.34,
  vault: 0.06,
})
const glossOf = (spec) => SURFACE_GLOSS[spec?.style] ?? 0

function baseUniforms(color, matID, gloss, roughness = 0.6, metalness = 0) {
  return {
    map: { value: null },
    tDetail: { value: null },
    uColor: { value: color },
    uIntensity: { value: 1 },
    uMatID: { value: matID },
    uGloss: { value: gloss },
    uRoughness: { value: roughness },
    uMetalness: { value: metalness },
    uNormalScale: { value: 1 },
  }
}

function surfaceMaterial(map, detail, instanced) {
  const m = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    defines: { USE_MAP: '', USE_WORLD_UV: '', ...(detail ? { USE_DETAIL: '' } : {}) },
    uniforms: baseUniforms(new THREE.Color(1, 1, 1), 0, 0, 1),
    vertexShader: instanced ? VERT_INSTANCED : VERT_STATIC,
    fragmentShader: FRAG,
  })
  m.uniforms.map.value = map
  m.uniforms.tDetail.value = detail
  return m
}

function flatMaterial(colorLinear, matID, instanced, tinted = false, partColor = false, gloss = 0, surface = {}) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    defines: {
      ...(tinted ? { USE_INSTANCING_COLOR: '' } : {}),
      ...(partColor ? { USE_PART_COLOR: '' } : {}),
      ...(surface.part ? { USE_PART_SURFACE: '' } : {}),
      ...(surface.skinning ? { USE_SKINNING: '' } : {}),
    },
    uniforms: baseUniforms(colorLinear, matID, gloss, surface.roughness ?? 0.6, surface.metalness ?? 0),
    vertexShader: instanced ? VERT_INSTANCED : VERT_STATIC,
    fragmentShader: FRAG,
  })
}

function emissiveMaterial(colorLinear, instanced, tinted = false, troffer = false) {
  const uniforms = baseUniforms(colorLinear, 1, 0, 1) // uIntensity: flicker multiplier, updated per frame
  if (troffer) uniforms.uPanelPattern = { value: 0 }
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    defines: { ...(tinted ? { USE_INSTANCING_COLOR: '' } : {}), ...(troffer ? { USE_TROFFER: '' } : {}) },
    uniforms,
    vertexShader: instanced ? VERT_INSTANCED : VERT_STATIC,
    fragmentShader: FRAG,
  })
}

// One canvas-texture set per family, built lazily and kept for the renderer's
// lifetime (a handful of 256² canvases — cheaper than regenerating on every
// family switch at the title screen). Each albedo gets a companion detail map
// derived from the same seeded canvas.
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
    const floor = floorTexture(aniso, pal.floor)
    const wall = wallTexture(aniso, pal.wall)
    const ceiling = ceilingTexture(aniso, pal.ceiling)
    set = {
      floor,
      wall,
      ceiling,
      floorDetail: surfaceDetailTexture(floor, pal.floor),
      wallDetail: surfaceDetailTexture(wall, pal.wall),
      ceilingDetail: surfaceDetailTexture(ceiling, pal.ceiling),
    }
    owner.sets.set(family, set)
  }
  return set
}

// Architectural surface: albedo + detail maps and the style's physical
// parameters (roughness is a multiplier on the detail map's roughness).
function applySurface(material, map, detail, spec, glossScale = 1) {
  const style = surfaceStyle(spec?.style)
  const u = material.uniforms
  u.map.value = map
  u.tDetail.value = detail
  u.uGloss.value = glossOf(spec) * glossScale
  u.uRoughness.value = 1
  u.uMetalness.value = style.metalness
  const wantsDetail = !!detail
  const hasDetail = material.defines.USE_DETAIL !== undefined
  if (wantsDetail !== hasDetail) {
    if (wantsDetail) material.defines.USE_DETAIL = ''
    else delete material.defines.USE_DETAIL
    material.needsUpdate = true
  }
}

// Swap the family-driven surfaces/colors on an EXISTING material set in place.
// Everything holding a reference (ChunkManager, chunk meshes about to rebuild,
// entities) keeps working; chunks re-mesh on the next level setup anyway.
export function applyFamilyMaterials(materials, renderer, family) {
  const pal = familyPalette(family)
  const tex = familyTextures(renderer, family)
  applySurface(materials.carpet, tex.floor, tex.floorDetail, pal.floor)
  applySurface(materials.ceiling, tex.ceiling, tex.ceilingDetail, pal.ceiling, 0.5)
  applySurface(materials.wallpaper, tex.wall, tex.wallDetail, pal.wall)
  materials.panel.uniforms.uColor.value = lin(pal.panel)
  materials.panelDead.uniforms.uColor.value = lin(pal.panelDead)
  materials.doorFrame.uniforms.uColor.value = lin(pal.trim)
  materials.doorLeaf.uniforms.uColor.value = lin(pal.leaf)
  return pal
}

export function createGBufferMaterials(renderer, family = MAP_FAMILY_OFFICE) {
  const pal = familyPalette(family)
  const tex = familyTextures(renderer, family)

  const carpet = surfaceMaterial(tex.floor, tex.floorDetail, false) // floor mesh
  const ceiling = surfaceMaterial(tex.ceiling, tex.ceilingDetail, false) // ceiling mesh
  const wallpaper = surfaceMaterial(tex.wall, tex.wallDetail, true) // instanced walls, columns, steps
  applySurface(carpet, tex.floor, tex.floorDetail, pal.floor)
  applySurface(ceiling, tex.ceiling, tex.ceilingDetail, pal.ceiling, 0.5)
  applySurface(wallpaper, tex.wall, tex.wallDetail, pal.wall)

  // Instanced lit lamps, per-tube identity tint, procedural troffer face.
  const panel = emissiveMaterial(lin(pal.panel), true, true, true)
  // Dead tubes: an unlit opal diffuser — smooth, milky plastic.
  const panelDead = flatMaterial(lin(pal.panelDead), 0, true, false, false, 0.35, { roughness: 0.32 })
  // Entities carry a faint wet sheen: under a tube their silhouettes catch
  // one hard highlight, which reads as "alive" more than any texture could.
  const entity = flatMaterial(lin(0x16161c), 2, false, false, false, 0.3, { roughness: 0.45 }) // Stalker capsule silhouette (near-black)
  const pursuer = flatMaterial(lin(0x3a0d0d), 2, false, false, false, 0.45, { roughness: 0.38 }) // Pursuer silhouette (dark blood-red, distinct)
  const husk = flatMaterial(lin(0x5c5847), 2, false, false, false, 0.2, { roughness: 0.85 }) // Husk silhouette (pale ash — the weak one)
  // Blender-built enemy GLBs (render/enemyModels.js): merged per-entity
  // geometry whose baked vertex colors carry the per-part palette and whose
  // `surface` attribute carries each part's resolved roughness/metalness.
  // Same matID-2 entity lane as the capsule silhouettes.
  const entityModel = flatMaterial(lin(0xffffff), 2, false, false, true, 0.3, { part: true })
  // The same lane for the rigged enemy GLBs: one SkinnedMesh per entity,
  // deformed in the vertex shader from its own skeleton's bone texture.
  const entityModelSkinned = flatMaterial(lin(0xffffff), 2, false, false, true, 0.3, { part: true, skinning: true })
  const exit = emissiveMaterial(lin(0xeafff2), false) // glowing anomaly

  // Instanced door/window casings: family trim, satin enamel.
  const doorFrame = flatMaterial(lin(pal.trim), 0, true, false, false, 0.3, { roughness: 0.4 })
  // Painted leaf base; per-door instanceColor tones it (brightness band,
  // rare dark stain) and darkens the knob to metal — see mesh.js leafTint.
  const doorLeaf = flatMaterial(lin(pal.leaf), 0, true, true, false, 0.25, { roughness: 0.46 })
  // Interior props (thresholds, radiators, clocks, boards, extinguisher
  // cabinets, vents): white base tinted per instance by the objects/dressing
  // palettes. Mostly painted metal and plastic.
  const prop = flatMaterial(lin(0xffffff), 0, true, true, false, 0.25, { roughness: 0.5 })
  // Emissive wayfinding signs (exit + hanging blades): they glow and bloom
  // but are NOT in the light field — beacons, not lamps. Steady (no flicker
  // wiring), tinted per instance (exit green / blade amber).
  const signGlow = emissiveMaterial(lin(0xffffff), true, true)
  // Collision-real office furniture (procedural fallback): white base tinted
  // per part by the objects/furniture palette (laminate, metal, fabric...).
  const furniture = flatMaterial(lin(0xffffff), 0, true, true, false, 0.22, { roughness: 0.62 })
  // Blender-built furniture GLBs (render/furnitureModels.js): merged
  // per-kind geometry whose baked vertex colors carry the per-part palette
  // and whose `surface` attribute preserves each part's material identity,
  // multiplied by the per-instance tint.
  const furnitureModel = flatMaterial(lin(0xffffff), 0, true, true, true, 0.22, { part: true })

  const materials = { carpet, ceiling, wallpaper, panel, panelDead, entity, pursuer, husk, entityModel, entityModelSkinned, exit, doorFrame, doorLeaf, prop, signGlow, furniture, furnitureModel }
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
        for (const tex of Object.values(set)) tex?.dispose?.()
      }
      owner.sets.clear()
    }
  }
  for (const m of Object.values(mats)) {
    if (!m) continue
    m.dispose?.()
  }
}
