import { DEPTH_PX, LAMP_ATT, glslFloat } from './common.js'
import { GRID_GLSL, GRID_UNIFORMS_GLSL } from './grid.js'
import { LAMP_DATA_GLSL } from './lampData.js'
import { CAPSULE_ENEMIES_MAX, CAPSULE_MAX, CONTACT_STEPS_MAX, LIGHT_MAX } from '../../world/constants.js'
import { LAMP_Y, PANEL_EQ_R } from '../../world/lightGrid/gridSpec.js'

// --- Residual contact shadows (chapter 14 P12), half resolution -------------
// The lighting pass now owns three occluder classes per light, exactly and
// off-screen: walls/jambs/columns (gridTrace), proxied furniture (box
// coverage) and enemies (capsules). A screen-space march that also counted
// those hits would darken them twice (~v^2), and one aggregate mask spread a
// lamp's occlusion onto the others. So this pass marches only for what the
// analytic systems MISS — chair and table legs, monitors, trims, stairs,
// props, GLB detail beyond the proxy — and:
//   * ignores a hit whose depth-buffer surface an analytic system owns
//     (storey planes, closed wall edges incl. jambs, column squares, proxy
//     boxes, capsules);
//   * keeps per-light channels for list entries 0 and 1 (r, g) and an
//     aggregate over the next weaker entries (b), with a cell hash in a so
//     consumers never mix channels of different cells' lists.
// The march is screen-stepped and perspective-correct with a cone that
// widens with distance (Bend / UE contact shadows / Filament SSCT) instead
// of v1's fixed 0.7 m thickness and hard hit. Pixels without grid data keep
// the full-length legacy aggregate in b (r = g = 1, a = 0).
export const CONTACT_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  precision highp usampler2D;
  #define LIGHT_MAX ${LIGHT_MAX}
  #define STEPS_MAX ${CONTACT_STEPS_MAX}
  #define CAPSULE_MAX ${CAPSULE_MAX}
  #define CAP_GROUPS ${CAPSULE_ENEMIES_MAX}
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tNormal;
  uniform sampler2D tDepth;
  uniform mat4 uProj;
  uniform mat4 uProjInverse;
  uniform mat4 uCamToWorld;
  uniform mat4 uWorldToCam;
  uniform vec3 uUpView;
  uniform int uLampCount;
  uniform float uLampRange;
  uniform int uSteps;            // most march steps (tier)
  uniform int uChannels;         // per-light channels: 0, 1 or 2 (tier)
  uniform int uExtra;            // weaker entries folded into the aggregate (tier)
  uniform int uLegacyLamps;      // non-grid pixels: lamps marched (tier)
  uniform float uMaxDist;        // look: contact length (m)
  uniform float uScale;          // this target's resolution / full resolution
  uniform float uStridePx;       // full-res pixels per step before the step cap
  uniform float uEmitFloor;
  uniform float uEmitPow;
  uniform float uGridOn;
  uniform int uCapGroups;
  uniform ivec4 uCapN;
  uniform vec4 uCapA[CAPSULE_MAX];
  uniform vec4 uCapB[CAPSULE_MAX];
  uniform vec4 uCapBound[CAP_GROUPS];
  ${LAMP_DATA_GLSL}
  ${GRID_UNIFORMS_GLSL}
  ${LAMP_ATT}
  ${DEPTH_PX}
  ${GRID_GLSL}

  float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

  // Does an analytic occlusion system already own this depth-buffer
  // surface (view space)? Then a march hit on it is not "residual".
  bool owned(vec3 Sv){
    vec3 Sw = (uCamToWorld * vec4(Sv, 1.0)).xyz;
    int cy = int(floor((Sw.y + 0.02) / G_LAYER_H));
    // Storey planes (paths inside a storey never cross them), closed wall
    // edges incl. jambs, column / pier squares.
    if (gArchSurface(Sw, cy)) return true;
    // Furniture proxy boxes of this cell. gOcc has no ownership test of its
    // own: after vertical aliasing the texel holds the boxes of the floor
    // six storeys away, so read it only when this floor owns the slot.
    ivec2 c = ivec2(floor(Sw.xz / G_CELL));
    if (gridOwned(c.x, c.y, cy)) {
      uvec4 o = gOcc(c.x, c.y, cy);
      for (int w = 0; w < 2; w++){
        vec3 lo, hi;
        float T;
        if (!gOccBox(o, w, c.x, c.y, cy, lo, hi, T)) continue;
        if (T < 0.6 && all(greaterThan(Sw, lo - 0.03)) && all(lessThan(Sw, hi + 0.03))) return true;
      }
    }
    // Enemy capsules.
    for (int g = 0; g < CAP_GROUPS; g++){
      if (g >= uCapGroups) break;
      vec4 bnd = uCapBound[g];
      if (bnd.w <= 0.0 || length(Sw - bnd.xyz) > bnd.w + 0.1) continue;
      int n = min(uCapN[g], 3);
      for (int j = 0; j < 3; j++){
        if (j >= n) break;
        int i = g * 3 + j;
        vec3 A = uCapA[i].xyz;
        vec3 ab = uCapB[i].xyz - A;
        float t = clamp(dot(Sw - A, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
        if (length(A + ab * t - Sw) < uCapA[i].w + 0.05) return true;
      }
    }
    return false;
  }

  bool toScreen(vec3 p, out vec2 uv){
    if (p.z >= -1e-3) return false;
    uv = vec2(uProj[0][0] * p.x, uProj[1][1] * p.y) / -p.z * 0.5 + 0.5;
    return true;
  }

  // Residual visibility toward a light at view position Lv (1 = open).
  float march(vec3 P, vec3 Ng, vec3 Lv, float maxLen, float jit, ivec2 fs){
    vec3 toL = Lv - P;
    float dist = length(toL);
    vec3 L = toL / max(dist, 1e-4);
    float len = min(dist, maxLen);
    vec3 P0 = P + Ng * (0.01 + 0.002 * abs(P.z));
    vec3 P1 = P0 + L * len;
    // Clip to just beyond the near plane.
    const float zc = -0.12;
    if (P1.z > zc) {
      float t = (zc - P0.z) / (P1.z - P0.z);
      if (t <= 0.0) return 1.0;
      P1 = mix(P0, P1, t);
      len *= t;
    }
    vec2 uv0, uv1;
    if (!toScreen(P0, uv0) || !toScreen(P1, uv1)) return 1.0;
    float pixLen = length((uv1 - uv0) * vec2(fs));
    int n = int(clamp(pixLen / uStridePx, 4.0, float(uSteps)));
    float coneTan = ${glslFloat(PANEL_EQ_R)} * uPenumbraScale / max(dist, 0.5);
    float pixFoot = 2.0 / (uProj[1][1] * float(fs.y));
    float i0 = 1.0 / -P0.z;
    float i1 = 1.0 / -P1.z;
    float occ = 0.0;
    for (int i = 0; i < STEPS_MAX; i++){
      if (i >= n) break;
      float f = (float(i) + jit) / float(n);
      f *= f;
      vec2 uv = mix(uv0, uv1, f);
      if (uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) break;
      float invW = mix(i0, i1, f);
      float rayZ = -1.0 / invW;
      float tRay = f * i1 / invW * len;
      vec3 S = viewPosPx(ivec2(uv * vec2(fs)), fs);
      float dz = S.z - rayZ; // > 0: the scene surface is in front of the ray
      float rc = coneTan * tRay + pixFoot * abs(rayZ);
      float thick = clamp(0.02 + 0.015 * abs(rayZ), 0.03, 0.35);
      float o = clamp((dz + rc) / (2.0 * rc), 0.0, 1.0)
        * (1.0 - smoothstep(thick, thick + rc, dz - rc))
        * (1.0 - smoothstep(0.6, 1.0, tRay / maxLen));
      if (o > 0.01 && owned(S)) o = 0.0;
      occ = max(occ, o);
      if (occ > 0.99) break;
    }
    // Fade toward the screen border, where occluders leave the depth buffer.
    vec2 e = max(6.0 * abs(uv0 * 2.0 - 1.0) - 5.0, 0.0);
    occ *= clamp(1.0 - dot(e, e), 0.0, 1.0);
    return 1.0 - occ;
  }

  void main(){
    ivec2 ij = ivec2(gl_FragCoord.xy);
    ivec2 fs = textureSize(tDepth, 0);
    ivec2 pF = halfTexelToFull(ij, uScale, fs);
    float depth = texelFetch(tDepth, pF, 0).x;
    if (depth >= 1.0) { outColor = vec4(1.0, 1.0, 1.0, 0.0); return; }
    vec3 P = viewPosPx(pF, fs);
    vec3 Nf = normalize(texelFetch(tNormal, pF, 0).xyz * 2.0 - 1.0);
    vec3 Ng = geomNormalPx(pF, fs, P, Nf);
    // Same 4x4 interleaved period as GTAO: the resolve integrates it.
    float jit = float((((ij.x + ij.y) & 3) << 2) | (ij.x & 3)) / 16.0;
    vec3 Pw = (uCamToWorld * vec4(P, 1.0)).xyz;
    vec3 Nw = normalize(mat3(uCamToWorld) * Nf);
    vec3 Pl = Pw + Nw * 0.3;
    int cy = int(floor(Pl.y / G_LAYER_H));
    int gx = int(floor(Pl.x / G_CELL));
    int gz = int(floor(Pl.z / G_CELL));
    if (uGridOn > 0.5 && gridOwned(gx, gz, cy)) {
      uvec4 L = texelFetch(tGridList, gTexel(gx, gz, cy), 0);
      int n = gListCount(L);
      vec2 ch = vec2(1.0);
      float wsum = 0.0;
      float vsum = 0.0;
      for (int k = 0; k < G_LIST_MAX; k++){
        if (k >= n || k >= 2 + uExtra) break;
        GridLight gl;
        if (!gridEntry(L, k, gx, gz, cy, gl)) break;
        vec3 Lv = (uWorldToCam * vec4(gl.pos, 1.0)).xyz;
        vec3 toL = Lv - P;
        float d = length(toL);
        vec3 Ld = toL / max(d, 1e-4);
        float ndl = dot(Nf, Ld);
        if (k < 2) {
          if (k < uChannels && ndl > 0.0) {
            float v = march(P, Ng, Lv, uMaxDist, jit, fs);
            if (k == 0) ch.x = v; else ch.y = v;
          }
          continue;
        }
        // Weaker entries share the aggregate, weighted by what they light.
        float emit = mix(uEmitFloor, 1.0, pow(clamp(dot(Ld, uUpView), 0.0, 1.0), uEmitPow));
        float w = luma(gl.tint) * gl.flicker * gl.vis * lampAtt(d, uLampRange) * emit * max(ndl, 0.0);
        if (w <= 1e-4) continue;
        wsum += w;
        vsum += w * march(P, Ng, Lv, uMaxDist, jit, fs);
      }
      float hash = float((gx * 7 + gz * 13 + cy * 29) & 255) / 255.0;
      outColor = vec4(ch, wsum > 1e-5 ? vsum / wsum : 1.0, hash);
      return;
    }
    // No grid data (light room, streaming edge): the legacy full-length
    // aggregate over the nearest lamps.
    float wsum = 0.0;
    float vsum = 0.0;
    int marched = 0;
    for (int i = 0; i < LIGHT_MAX; i++){
      if (i >= uLampCount) break;
      vec3 Lv = lampViewPos(i) + uUpView * (uSourceY - ${glslFloat(LAMP_Y)});
      vec4 chr = lampChar(i);
      vec3 toL = Lv - P;
      float d = length(toL);
      if (d > uLampRange) continue;
      float w = luma(chr.rgb) * chr.a * max(dot(Nf, toL / max(d, 1e-4)), 0.0) * lampAtt(d, uLampRange);
      float v = 1.0;
      if (w > 0.04 && marched < uLegacyLamps) { v = march(P, Ng, Lv, 1e4, jit, fs); marched++; }
      wsum += w;
      vsum += w * v;
    }
    outColor = vec4(1.0, 1.0, wsum > 1e-5 ? vsum / wsum : 1.0, 0.0);
  }
`
