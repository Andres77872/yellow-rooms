import * as THREE from 'three'
import { floorTexture, wallTexture, ceilingTexture, surfaceDetailTexture } from './textures.js'
import { familyPalette } from '../world/familyPalette.js'
import { MAP_FAMILY_OFFICE } from '../world/mapTypes.js'
import { byFamily } from '../world/families/registry.js'
import { CELL, LAYER_H, WALL_H } from '../world/constants.js'
import { SURFACE_MAX_LAYERS, ZONE_MAP_SIZE, worldSurfaceSet } from '../world/surfaceSet.js'
import { buildSurfaceArrays, disposeSurfaceArrays } from './surfaceArrays.js'
import { createGlassMaterial } from './glassMaterial.js'
import { blankDecalTexture, buildDecalAtlas } from './decalAtlas.js'
import { DECAL_GRID } from '../world/decalKinds.js'
import { glslFloat } from './shaders/common.js'
import { MIN_ROUGHNESS, surfaceStyle } from './surfaces.js'
import { BEVEL_GLSL } from './bevel.js'

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
// Instanced unit-box batches (walls, trim, props, signs, leaves, fallback
// furniture) carry USE_BEVEL: the vertex stage resolves the geometry's
// `bevel` attribute into edges rounded at a constant world radius however
// the instance is stretched (bevel.js), and transforms the rounded normals by
// the instance ROTATION only — the inverse-transpose used for stretched
// models would flatten a 45-degree bevel normal onto the thin axis.
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
  #ifdef USE_BEVEL
    in vec4 bevel;
    ${BEVEL_GLSL}
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
    vec3 pos = position;
    #ifdef USE_BEVEL
      if (bevel.w < 0.0) {
        pos = bevelUnitPosition(position, bevel, instanceMatrix);
        iNormal = basis * (normal / sqrt(max(scaleSq, vec3(1e-8))));
      }
    #endif
    vViewNormal = normalize(normalMatrix * iNormal);
    vWorldNormal = normalize(mat3(modelMatrix) * iNormal);
    vWorldPos = (modelMatrix * instanceMatrix * vec4(pos, 1.0)).xyz;
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
    #ifdef USE_DECAL
      // Wall decals: the printed image goes on the two broad faces (normal
      // along the plate's thinnest axis); the edges show the board.
      vec3 an = abs(normal);
      float thin = scaleSq.x <= scaleSq.y && scaleSq.x <= scaleSq.z ? an.x : scaleSq.y <= scaleSq.z ? an.y : an.z;
      vSurface = vec2(-1.0, step(0.5, thin));
    #endif
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(pos, 1.0);
  }
`

// World surface sets (world/surfaceSet.js, render/surfaceArrays.js) and the
// per-room wear layer. `tZoneMap` is the chunk's (CHUNK+2)^2 zone texture
// (floor layer | edge flags, wall, ceiling layer, wear | lamp bit), bound
// per mesh by mesh.js with the chunk's world origin. A wall face reads the
// room it LOOKS INTO: the lookup steps 0.2 m off the face along its normal
// (past the 8 cm half-wall, short of a 1.1 m pier's own cell), so the two
// faces of one thin wall can carry two rooms' finishes. Floor edge flags mark
// where the floor finish changes across a cell edge; the floor lays a metal
// transition strip on that line.
// Hash without sine (Hoskins) + value noise: stable at world coordinates.
// Shared by the zone wear layer and the door-leaf finishes.
const NOISE_PARS = /* glsl */ `
  float zh12(vec2 p){
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float zNoise(vec2 p){
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(zh12(i), zh12(i + vec2(1.0, 0.0)), u.x), mix(zh12(i + vec2(0.0, 1.0)), zh12(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float zFbm(vec2 p){
    return 0.5 * zNoise(p) + 0.3 * zNoise(p * 2.03 + 7.1) + 0.2 * zNoise(p * 4.11 + 3.7);
  }
`

// Door-leaf finishes (objects/joinery/doorKit.js), procedural in world space
// on the flat instanced path so every leaf of a corridor grains differently:
//   0 painted timber — roller stipple, handling grime, scuffed foot
//   1 sliced veneer  — cathedral grain, latewood bands, open pores
//   2 painted steel  — the paint layer plus rust blooming from the foot
//   3 brushed metal  — hardware: streaked roughness, tarnish drift
// The horizontal coordinate is the face's own (z on x-facing faces), so the
// grain runs continuously across one leaf and differs between leaves.
const LEAF_PARS = /* glsl */ `
  uniform float uLeafFinish;
  uniform float uLeafRust;
  void leafFinish(inout vec3 albedo, inout float rough, vec3 N, vec3 wp){
    vec3 an = abs(N);
    float along = an.x > an.z ? wp.z : wp.x;
    float y = mod(wp.y + 0.001, ${glslFloat(LAYER_H)}) - 0.001;
    if (uLeafFinish > 2.5) {
      float brush = zNoise(vec2(along * 260.0, y * 2.5));
      rough = clamp(rough * (0.75 + 0.5 * brush), 0.08, 1.0);
      albedo *= 0.88 + 0.12 * zFbm(vec2(along, y) * 9.0);
      return;
    }
    if (uLeafFinish > 0.5 && uLeafFinish < 1.5) {
      // Cathedral figure: rings warped by a slow field, so the bands arch
      // and pinch up the leaf instead of running ruler-straight.
      float warp = zFbm(vec2(along * 3.0, y * 0.35)) * 3.2;
      float ring = fract(along * 20.0 + warp + 0.6 * sin(y * 1.1 + along * 5.0));
      float late = smoothstep(0.55, 0.9, ring) * (1.0 - smoothstep(0.9, 1.0, ring));
      float fine = zNoise(vec2(along * 260.0, y * 4.0));
      float pores = smoothstep(0.8, 0.92, zNoise(vec2(along * 520.0, y * 30.0)));
      float flitch = 0.94 + 0.12 * zNoise(vec2(floor(along * 6.0), 3.7));
      albedo *= mix(1.05, 0.8, late) * (0.95 + 0.1 * fine) * (1.0 - 0.14 * pores) * flitch;
      rough = min(1.0, rough * mix(1.0, 1.3, late + pores * 0.5));
      return;
    }
    albedo *= 0.975 + 0.05 * zNoise(vec2(along * 70.0, y * 1.4));
    float grime = (1.0 - smoothstep(0.0, 0.35, abs(y - 1.05))) * smoothstep(0.45, 0.8, zFbm(vec2(along * 3.0, y * 2.0) + 4.0));
    float scuff = (1.0 - smoothstep(0.04, 0.42, y)) * smoothstep(0.5, 0.8, zFbm(vec2(along * 7.0, y * 5.0)));
    albedo *= (1.0 - 0.12 * grime) * (1.0 - 0.28 * scuff);
    rough = min(1.0, rough + 0.12 * grime + 0.2 * scuff);
    if (uLeafFinish > 1.5) {
      // Blooms creep up from the wet foot; elsewhere only pitting through
      // chipped paint.
      float foot = 1.0 - smoothstep(0.0, 0.8, y);
      float bloom = smoothstep(0.62, 0.7, zFbm(vec2(along * 3.1, y * 2.3) + 9.1) + 0.3 * foot) * (0.25 + 0.75 * foot);
      float pits = smoothstep(0.9, 0.96, zNoise(vec2(along, y) * 55.0)) * 0.8;
      float rust = clamp(max(bloom, pits), 0.0, 1.0) * uLeafRust;
      vec3 oxide = vec3(0.17, 0.065, 0.022) * (0.65 + 0.7 * zNoise(vec2(along, y) * 37.0));
      albedo = mix(albedo, oxide, rust);
      rough = mix(rough, 0.88, rust);
    }
  }
`

const ZONE_PARS = /* glsl */ `
  uniform highp sampler2DArray tMapArray;
  uniform highp sampler2DArray tDetailArray;
  uniform highp sampler2D tZoneMap;
  uniform vec3 uZoneOrigin;
  uniform float uZoneSlot;   // 0 floor (r), 1 wall (g), 2 ceiling (b)
  uniform float uZoneArray;  // 1 once the arrays hold this world's set
  uniform float uWear;       // global wear strength
  uniform float uLayerMetal[${SURFACE_MAX_LAYERS}];
  uniform float uLayerGloss[${SURFACE_MAX_LAYERS}];
  uniform float uLayerTile[${SURFACE_MAX_LAYERS}]; // ceiling tile pitch (m), 0 = no tiles

  vec4 zoneAt(vec3 wp, vec3 n){
    vec2 p = wp.xz - uZoneOrigin.xz;
    if (abs(n.y) < 0.5) p += normalize(n.xz + vec2(1e-5)) * 0.2;
    ivec2 c = clamp(ivec2(floor(p / ${glslFloat(CELL)})) + 1, ivec2(0), ivec2(${ZONE_MAP_SIZE - 1}));
    return texelFetch(tZoneMap, c, 0);
  }

  // Lived-in wear in world space, so it never repeats with the texture tile:
  // macro tone drift everywhere (anti-tiling), then per slot — floors: traffic
  // grime and damp patches; walls: scuffed base band, soot under the ceiling
  // line, drip streaks and tide-marked water blooms; ceilings: water stains,
  // and missing tiles only on tiled ceilings, on their own tile grid (never
  // in a lamp's cell). Strength follows the room's wear; a pristine room only
  // gets the macro drift.
  void zoneWear(inout vec3 albedo, inout float rough, inout float ao, vec3 wp, vec3 an, float along, float yl, float wear, float lamp, float pitch){
    bool vertical = an.y < 0.5;
    vec2 mp = vertical ? vec2(along, yl) : wp.xz;
    albedo *= 0.95 + 0.1 * zFbm(mp * 0.37 + wp.y * 0.013);
    if (uZoneSlot < 0.5) {
      float grime = smoothstep(0.5, 0.85, zFbm(wp.xz * 0.45 + 3.0)) * wear;
      albedo *= 1.0 - 0.28 * grime;
      rough = min(1.0, rough + 0.12 * grime);
      float damp = smoothstep(0.66, 0.71, zFbm(wp.xz * 0.16 + 11.3)) * wear;
      albedo *= 1.0 - 0.22 * damp;
      rough *= mix(1.0, 0.55, damp);
    } else if (uZoneSlot < 1.5) {
      if (!vertical) return;
      float band = (1.0 - smoothstep(0.0, 0.32, yl)) * (0.55 + 0.45 * zNoise(vec2(along * 2.3, 0.0)));
      albedo *= 1.0 - 0.3 * band * wear;
      float soot = smoothstep(${glslFloat(WALL_H - 0.6)}, ${glslFloat(WALL_H)}, yl);
      albedo *= 1.0 - 0.16 * soot * wear;
      // Drip streaks from the ceiling line, 12 cm columns.
      float col = floor(along * 8.0);
      float storey = floor(wp.y / ${glslFloat(LAYER_H)});
      float h = zh12(vec2(col, storey * 17.0 + 3.0));
      if (h < wear * 0.3) {
        float len = 0.5 + 2.2 * zh12(vec2(col + 0.5, storey));
        float fromTop = ${glslFloat(WALL_H)} - yl;
        float x = fract(along * 8.0) - 0.5;
        float streak = exp(-x * x * 40.0) * clamp(1.0 - fromTop / len, 0.0, 1.0);
        albedo *= 1.0 - 0.22 * streak;
        rough *= 1.0 - 0.3 * streak;
      }
      // Water bloom high on the wall, with a darker tide line.
      float bloom = zFbm(vec2(along * 0.55, yl * 0.9) + storey * 5.0);
      float reach = smoothstep(1.6, 3.0, yl) * wear;
      float inside = smoothstep(0.6, 0.64, bloom) * reach;
      float tide = (smoothstep(0.58, 0.61, bloom) - smoothstep(0.61, 0.64, bloom)) * reach;
      albedo = mix(albedo, albedo * vec3(0.86, 0.78, 0.6), inside * 0.7);
      albedo *= 1.0 - 0.25 * tide;
    } else {
      if (vertical) return;
      float grid = pitch > 0.0 ? pitch : 1.5;
      vec2 tile = floor(wp.xz / grid);
      vec2 f = fract(wp.xz / grid) - 0.5;
      float h = zh12(tile + 0.37);
      if (pitch > 0.0 && lamp < 0.5 && h < 0.012 * wear) {
        // Missing tile: a dark void into the plenum.
        albedo *= 0.05;
        ao = 0.2;
        return;
      }
      if (h < 0.02 + 0.2 * wear * wear) {
        vec2 c = (vec2(zh12(tile + 1.7), zh12(tile + 2.9)) - 0.5) * 0.4;
        float r = length(f - c) / (0.18 + 0.3 * zh12(tile + 4.1));
        r += (zNoise((f - c) * 9.0 + tile) - 0.5) * 0.35;
        float stain = 1.0 - smoothstep(0.85, 1.0, r);
        float ring = smoothstep(0.75, 0.9, r) * (1.0 - smoothstep(0.9, 1.02, r));
        albedo = mix(albedo, albedo * vec3(0.84, 0.74, 0.52), stain * 0.75);
        albedo *= 1.0 - 0.3 * ring;
      }
    }
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
  #ifdef USE_DECAL
    uniform sampler2D tDecal; // world decal atlas (render/decalAtlas.js)
  #endif
  #if defined(USE_ZONES) || defined(USE_LEAF_FINISH)
    ${NOISE_PARS}
  #endif
  #ifdef USE_ZONES
    ${ZONE_PARS}
  #endif
  #ifdef USE_LEAF_FINISH
    ${LEAF_PARS}
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
    float gloss = uGloss;
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
      #if defined(USE_ZONES) && defined(USE_WORLD_UV)
        // World surface set: this fragment's room picks the array layer.
        vec4 zone = zoneAt(vWorldPos, Nw);
        float zRaw = floor((uZoneSlot < 0.5 ? zone.r : uZoneSlot < 1.5 ? zone.g : zone.b) * 255.0 + 0.5);
        // The floor byte carries edge flags above its layer index.
        float zLayer = mod(zRaw, 8.0);
        float zStrip = 0.0;
        vec3 zN = Nw;
        // Derivatives outside the branch: it is not uniform across a quad.
        float aa = length(fwidth(vWorldPos.xz)) + 1e-4;
        if (uZoneSlot < 0.5 && Nw.y > 0.5 && zRaw >= 8.0) {
          vec2 q = fract((vWorldPos.xz - uZoneOrigin.xz) / ${glslFloat(CELL)}) * ${glslFloat(CELL)};
          float edges = floor(zRaw / 8.0);
          float d = 1e3;
          if (mod(edges, 2.0) >= 1.0) d = min(d, q.x);
          if (mod(floor(edges / 2.0), 2.0) >= 1.0) d = min(d, ${glslFloat(CELL)} - q.x);
          if (mod(floor(edges / 4.0), 2.0) >= 1.0) d = min(d, q.y);
          if (mod(floor(edges / 8.0), 2.0) >= 1.0) d = min(d, ${glslFloat(CELL)} - q.y);
          zStrip = 1.0 - smoothstep(0.022 - aa, 0.022 + aa, d);
        }
        float zByte = floor(zone.a * 255.0 + 0.5);
        float zLamp = step(127.5, zByte);
        float zWear = mod(zByte, 128.0) / 127.0 * uWear;
        vec4 det;
        if (uZoneArray > 0.5) {
          albedo = texture(tMapArray, vec3(uvw, zLayer)).rgb * uColor * vTint;
          det = texture(tDetailArray, vec3(uvw, zLayer));
          int li = int(zLayer);
          metal = uLayerMetal[li];
          gloss = uLayerGloss[li];
        } else {
          albedo = texture(map, uvw).rgb * uColor * vTint;
          det = texture(tDetail, uvw);
        }
      #else
        albedo = texture(map, uvw).rgb * uColor * vTint;
      #endif
      #if defined(USE_DETAIL) && defined(USE_WORLD_UV)
        #ifndef USE_ZONES
          vec4 det = texture(tDetail, uvw);
        #endif
        vec2 nxy = (det.rg * 2.0 - 1.0) * uNormalScale;
        vec3 nts = vec3(nxy, sqrt(max(1.0 - dot(nxy, nxy), 0.0)));
        Nw = normalize(T * nts.x + B * nts.y + Nw * nts.z);
        rough = det.b * uRoughness;
        matAO = det.a;
      #endif
      #if defined(USE_ZONES) && defined(USE_WORLD_UV)
        float zPitch = uZoneArray > 0.5 ? uLayerTile[int(zLayer)] : 0.0;
        zoneWear(albedo, rough, matAO, vWorldPos, an, uvw.x * ${glslFloat(CELL)}, yl, zWear, zLamp, zPitch);
        if (zStrip > 0.0) {
          // Transition strip: a flat brushed-metal reducer, dulled by wear.
          albedo = mix(albedo, vec3(0.55, 0.51, 0.44) * (1.0 - 0.35 * zWear), zStrip);
          metal = mix(metal, 0.8, zStrip);
          rough = mix(rough, 0.4 + 0.2 * zWear, zStrip);
          Nw = normalize(mix(Nw, zN, zStrip));
        }
      #endif
    #else
      albedo = uColor * uIntensity * vTint;
      #ifdef USE_DECAL
        // Instance colour carries (atlas cell, brightness, roughness).
        float cell = floor(vTint.r + 0.5);
        vec2 cuv = (vec2(mod(cell, ${glslFloat(DECAL_GRID)}), ${glslFloat(DECAL_GRID - 1)} - floor(cell / ${glslFloat(DECAL_GRID)})) + clamp(vUv, 0.006, 0.994)) / ${glslFloat(DECAL_GRID)};
        albedo = mix(uColor, texture(tDecal, cuv).rgb, vSurface.y) * vTint.g;
        rough = vTint.b;
      #endif
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
      #ifdef USE_LEAF_FINISH
        leafFinish(albedo, rough, Nw, vWorldPos);
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
    gMaterial = vec4(metal, matAO, gloss, 1.0);
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
  // World surface-set variants.
  carpetPattern: 0, carpetTile: 0, vct: 0.4, checker: 0.45, parquet: 0.3, planks: 0.25,
  terrazzo: 0.5, polished: 0.35, mosaic: 0.5, grate: 0.3, diamond: 0.35,
  stripe: 0.03, damask: 0.05, wainscot: 0.15, tileWainscot: 0.4, subway: 0.5, plaster: 0.02,
  cmu: 0.03, woodPanel: 0.2, formwork: 0.05, corrugated: 0.3,
  acoustic: 0, slats: 0.15, exposed: 0.04,
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

// Instanced unit-box materials resolve the geometry's bevel (see bevel.js).
// The attribute default keeps them correct on any geometry without it.
function withBevel(material) {
  material.defines.USE_BEVEL = ''
  material.defaultAttributeValues = { ...material.defaultAttributeValues, bevel: [0, 0, 0, 0] }
  return material
}

// The empty zone map every surface material starts with: all rooms on layer
// 0 (the family's canonical surface), no wear. Chunks bind their own.
let defaultZoneMap = null
export function defaultSurfaceZoneMap() {
  if (!defaultZoneMap) defaultZoneMap = createZoneMapTexture(new Uint8Array(ZONE_MAP_SIZE * ZONE_MAP_SIZE * 4))
  return defaultZoneMap
}

// A chunk's zone map texture (world/surfaceSet.js buildSurfaceZoneMap bytes).
export function createZoneMapTexture(bytes) {
  const tex = new THREE.DataTexture(bytes, ZONE_MAP_SIZE, ZONE_MAP_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.colorSpace = THREE.NoColorSpace
  tex.magFilter = tex.minFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.needsUpdate = true
  return tex
}

// `slot`: 0 floor, 1 wall, 2 ceiling — which zone-map channel this
// material's surfaces read.
function surfaceMaterial(map, detail, instanced, slot) {
  const uniforms = baseUniforms(new THREE.Color(1, 1, 1), 0, 0, 1)
  Object.assign(uniforms, {
    tMapArray: { value: null },
    tDetailArray: { value: null },
    tZoneMap: { value: defaultSurfaceZoneMap() },
    uZoneOrigin: { value: new THREE.Vector3() },
    uZoneSlot: { value: slot },
    uZoneArray: { value: 0 },
    uWear: { value: 1 },
    uLayerMetal: { value: new Float32Array(SURFACE_MAX_LAYERS) },
    uLayerGloss: { value: new Float32Array(SURFACE_MAX_LAYERS) },
    uLayerTile: { value: new Float32Array(SURFACE_MAX_LAYERS) },
  })
  const m = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    defines: { USE_MAP: '', USE_WORLD_UV: '', USE_ZONES: '', ...(detail ? { USE_DETAIL: '' } : {}) },
    uniforms,
    vertexShader: instanced ? VERT_INSTANCED : VERT_STATIC,
    fragmentShader: FRAG,
  })
  m.uniforms.map.value = map
  m.uniforms.tDetail.value = detail
  return instanced ? withBevel(m) : m
}

function flatMaterial(colorLinear, matID, instanced, tinted = false, partColor = false, gloss = 0, surface = {}) {
  const m = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    defines: {
      ...(tinted ? { USE_INSTANCING_COLOR: '' } : {}),
      ...(partColor ? { USE_PART_COLOR: '' } : {}),
      ...(surface.part ? { USE_PART_SURFACE: '' } : {}),
      ...(surface.skinning ? { USE_SKINNING: '' } : {}),
      ...(surface.leafFinish !== undefined ? { USE_LEAF_FINISH: '' } : {}),
      ...(surface.decal ? { USE_DECAL: '' } : {}),
    },
    uniforms: {
      ...baseUniforms(colorLinear, matID, gloss, surface.roughness ?? 0.6, surface.metalness ?? 0),
      ...(surface.leafFinish !== undefined
        ? { uLeafFinish: { value: surface.leafFinish }, uLeafRust: { value: 0 } }
        : {}),
      ...(surface.decal ? { tDecal: { value: blankDecalTexture() } } : {}),
    },
    vertexShader: instanced ? VERT_INSTANCED : VERT_STATIC,
    fragmentShader: FRAG,
  })
  if (surface.decal) m.userData.blankDecal = m.uniforms.tDecal.value
  return surface.bevel ? withBevel(m) : m
}

function emissiveMaterial(colorLinear, instanced, tinted = false, troffer = false, bevel = false) {
  const uniforms = baseUniforms(colorLinear, 1, 0, 1) // uIntensity: flicker multiplier, updated per frame
  if (troffer) uniforms.uPanelPattern = { value: 0 }
  const m = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    defines: { ...(tinted ? { USE_INSTANCING_COLOR: '' } : {}), ...(troffer ? { USE_TROFFER: '' } : {}) },
    uniforms,
    vertexShader: instanced ? VERT_INSTANCED : VERT_STATIC,
    fragmentShader: FRAG,
  })
  return bevel ? withBevel(m) : m
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

// Painted-leaf finish per family: hollow-metal doors in the tower, plant-room
// steel rusting from the foot in the sewer and the lattice.
export const LEAF_FINISH = Object.freeze({
  default: { finish: 0, rust: 0 },
  tower: { finish: 2, rust: 0.08 },
  sewer: { finish: 2, rust: 0.75 },
  lattice: { finish: 2, rust: 0.35 },
})

// Swap the family-driven surfaces/colors on an EXISTING material set in place.
// Everything holding a reference (ChunkManager, chunk meshes about to rebuild,
// entities) keeps working; chunks re-mesh on the next level setup anyway.
//
// `world` ({ seed, size }) also binds that world's surface set: the per-room
// finish arrays every chunk's zone map indexes (world/surfaceSet.js). Without
// it the arrays stay off and every room shows the family's base surfaces.
export function applyFamilyMaterials(materials, renderer, family, world = null) {
  const pal = familyPalette(family)
  const tex = familyTextures(renderer, family)
  applySurface(materials.carpet, tex.floor, tex.floorDetail, pal.floor)
  if (materials.stairTread) applySurface(materials.stairTread, tex.floor, tex.floorDetail, pal.floor)
  applySurface(materials.ceiling, tex.ceiling, tex.ceilingDetail, pal.ceiling, 0.5)
  applySurface(materials.wallpaper, tex.wall, tex.wallDetail, pal.wall)
  materials.panel.uniforms.uColor.value = lin(pal.panel)
  materials.panelDead.uniforms.uColor.value = lin(pal.panelDead)
  materials.doorFrame.uniforms.uColor.value = lin(pal.trim)
  materials.doorLeaf.uniforms.uColor.value = lin(pal.leaf)
  const leaf = byFamily(LEAF_FINISH, family, 'default')
  if (materials.doorLeaf.uniforms.uLeafFinish) {
    materials.doorLeaf.uniforms.uLeafFinish.value = leaf.finish
    materials.doorLeaf.uniforms.uLeafRust.value = leaf.rust
  }
  if (world) applyWorldSurfaces(materials, renderer, family, world)
  return pal
}

// Per-renderer cache of painted world surface arrays, newest last. A level
// change paints a fresh set (each level is its own world seed); keeping the
// previous two makes a retry or a title round-trip free.
const ARRAY_CACHE_SIZE = 3

function worldArrays(renderer, family, seed, size) {
  familyTextures(renderer, family) // creates the renderer's cache owner
  const owner = TEXTURE_CACHE.get(renderer)
  owner.arrays ??= []
  const key = `${family}|${seed >>> 0}|${size}`
  const at = owner.arrays.findIndex((a) => a.key === key)
  if (at >= 0) {
    const [hit] = owner.arrays.splice(at, 1)
    owner.arrays.push(hit)
    return hit.arrays
  }
  const set = worldSurfaceSet(family, seed)
  const arrays = buildSurfaceArrays(set, { size, aniso: renderer.capabilities.getMaxAnisotropy(), glossOf })
  owner.arrays.push({ key, arrays })
  while (owner.arrays.length > ARRAY_CACHE_SIZE) disposeSurfaceArrays(owner.arrays.shift().arrays)
  return arrays
}

// The world's decal atlas, cached beside its surface arrays (same key, same
// eviction). Atlas resolution follows the surface size: 4 x 4 cells' worth.
function worldDecals(renderer, family, seed, size) {
  familyTextures(renderer, family)
  const owner = TEXTURE_CACHE.get(renderer)
  owner.decals ??= []
  const key = `${family}|${seed >>> 0}|${size}`
  const at = owner.decals.findIndex((a) => a.key === key)
  if (at >= 0) {
    const [hit] = owner.decals.splice(at, 1)
    owner.decals.push(hit)
    return hit.atlas
  }
  const atlas = buildDecalAtlas(family, seed, { size: size * 4, aniso: renderer.capabilities.getMaxAnisotropy() })
  owner.decals.push({ key, atlas })
  while (owner.decals.length > ARRAY_CACHE_SIZE) owner.decals.shift().atlas.texture.dispose()
  return atlas
}

// Bind one world's surface set to the three architecture materials, and its
// decal atlas to the decal plates.
export function applyWorldSurfaces(materials, renderer, family, { seed = 0, size = 256 } = {}) {
  if (materials.decal) {
    const atlas = worldDecals(renderer, family, seed, size)
    materials.decal.uniforms.tDecal.value = atlas.texture
    materials.decal.userData.decalAverages = atlas.averages
  }
  const arrays = worldArrays(renderer, family, seed, size)
  const slots = [['carpet', 'floor'], ['stairTread', 'floor'], ['wallpaper', 'wall'], ['ceiling', 'ceiling']]
  for (const [name, slot] of slots) {
    if (!materials[name]) continue
    const u = materials[name].uniforms
    const a = arrays[slot]
    u.tMapArray.value = a.map
    u.tDetailArray.value = a.detail
    u.uLayerMetal.value = a.metal
    u.uLayerTile.value = a.tile
    // Ceilings carry half the gloss of their style, like the base surface.
    u.uLayerGloss.value = slot === 'ceiling' ? a.gloss.map((g) => g * 0.5) : a.gloss
    u.uZoneArray.value = 1
  }
  return arrays
}

export function createGBufferMaterials(renderer, family = MAP_FAMILY_OFFICE) {
  const pal = familyPalette(family)
  const tex = familyTextures(renderer, family)

  const carpet = surfaceMaterial(tex.floor, tex.floorDetail, false, 0) // floor mesh
  const ceiling = surfaceMaterial(tex.ceiling, tex.ceilingDetail, false, 2) // ceiling mesh
  const wallpaper = surfaceMaterial(tex.wall, tex.wallDetail, true, 1) // instanced walls, columns
  // Stair steps wear the floor finish of their flight (carpeted stairs,
  // tiled stairs), not the wallpaper they used to borrow.
  const stairTread = surfaceMaterial(tex.floor, tex.floorDetail, true, 0)
  applySurface(carpet, tex.floor, tex.floorDetail, pal.floor)
  applySurface(stairTread, tex.floor, tex.floorDetail, pal.floor)
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
  const doorFrame = flatMaterial(lin(pal.trim), 0, true, false, false, 0.3, { roughness: 0.4, bevel: true })
  // Painted leaf base; per-door instanceColor tones it (brightness band,
  // rare dark stain) and darkens the knob to metal — see mesh.js leafTint.
  // The finish (painted timber / painted steel) follows the family.
  const doorLeaf = flatMaterial(lin(pal.leaf), 0, true, true, false, 0.25, { roughness: 0.46, bevel: true, leafFinish: 0 })
  // Veneered leaves (office flush doors, hotel mahogany): white base, the
  // species tint per instance, lacquered grain in the shader.
  const doorVeneer = flatMaterial(lin(0xffffff), 0, true, true, false, 0.3, { roughness: 0.38, bevel: true, leafFinish: 1 })
  // Door hardware: hinges, levers, closers, kick and number plates. Metal
  // (F0 = the per-instance tint), brushed; a little diffuse kept so a plate
  // facing a dark floor still reads as steel without an environment probe.
  const doorHardware = flatMaterial(lin(0xffffff), 0, true, true, false, 0.5, { roughness: 0.34, metalness: 0.82, bevel: true, leafFinish: 3 })
  // Printed wall decals (posters, notices, plans, dials, signs): sharp thin
  // plates whose broad faces sample the world's decal atlas; the instance
  // colour picks the cell. Board-coloured edges.
  const decal = flatMaterial(lin(0xd8d4c8), 0, true, true, false, 0.12, { roughness: 0.7, decal: true })
  // Interior props (thresholds, radiators, clocks, boards, extinguisher
  // cabinets, vents): white base tinted per instance by the objects/dressing
  // palettes. Mostly painted metal and plastic.
  const prop = flatMaterial(lin(0xffffff), 0, true, true, false, 0.25, { roughness: 0.5, bevel: true })
  // Emissive wayfinding signs (exit + hanging blades): they glow and bloom
  // but are NOT in the light field — beacons, not lamps. Steady (no flicker
  // wiring), tinted per instance (exit green / blade amber).
  const signGlow = emissiveMaterial(lin(0xffffff), true, true, false, true)
  // Collision-real office furniture (procedural fallback): white base tinted
  // per part by the objects/furniture palette (laminate, metal, fabric...).
  const furniture = flatMaterial(lin(0xffffff), 0, true, true, false, 0.22, { roughness: 0.62, bevel: true })
  // Blender-built furniture GLBs (render/furnitureModels.js): merged
  // per-kind geometry whose baked vertex colors carry the per-part palette
  // and whose `surface` attribute preserves each part's material identity,
  // multiplied by the per-instance tint.
  const furnitureModel = flatMaterial(lin(0xffffff), 0, true, true, true, 0.22, { part: true })

  // Window panes: the forward glass pass (glassMaterial.js), not a G-buffer
  // material — DeferredRenderer.setGlassMaterial binds its inputs.
  const glass = createGlassMaterial()

  const materials = { carpet, stairTread, ceiling, wallpaper, panel, panelDead, entity, pursuer, husk, entityModel, entityModelSkinned, exit, doorFrame, doorLeaf, doorVeneer, doorHardware, prop, decal, signGlow, furniture, furnitureModel, glass }
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
      for (const entry of owner.arrays ?? []) disposeSurfaceArrays(entry.arrays)
      owner.arrays = []
      for (const entry of owner.decals ?? []) entry.atlas.texture.dispose()
      owner.decals = []
    }
  }
  for (const m of Object.values(mats)) {
    if (!m) continue
    m.userData?.blankDecal?.dispose()
    m.dispose?.()
  }
}
