import { DEPTH_PX, IGN, LAMP_ATT, VIEW_PROJ, VIEW_RECON, glslFloat } from './common.js'
import { GRID_GLSL, GRID_UNIFORMS_GLSL } from './grid.js'
import { LAMP_DATA_GLSL } from './lampData.js'
import {
  CAPSULE_ENEMIES_MAX,
  CAPSULE_MAX,
  LIGHT_MAX,
  VOL_NEAR_STEPS_MAX,
  VOL_STEPS_MAX,
  VOL_LIGHTS_MAX,
  VOL_OCC_NEAR,
  VOL_OCC_FAR,
  VOL_CONTRIB_EPS,
} from '../../world/constants.js'
import { LAMP_Y, PANEL_EQ_R } from '../../world/lightGrid/gridSpec.js'

// --- Volumetric light shafts (half-res in-scatter raymarch, chapter 14 P14) --
// Marches the camera ray and, at each step, gathers in-scatter from nearby
// fixtures + the flashlight cone. A Henyey-Greenstein phase biases scatter
// forward, so a lamp roughly ahead reads as a directional god-ray.
//
//   * Steps are QUADRATIC (t_i = maxT ((i + j) / N)^2, weighted by their
//     span): v1's uniform 1.15 m steps left the first metres of haze — where
//     shafts are closest and largest — with one to three samples.
//   * A near-field march (uNearSteps over the first 8 m) carries only the
//     flashlight, whose cone lives near the lens; the main march skips it
//     there.
//   * Fixture visibility comes from the sample cell's baked light list (walls
//     cut shafts whether or not they are on screen). Within uTraceDist the
//     strongest partial entries are TRACED through the grid on every
//     uTraceEvery-th step (held between traced steps inside a cell), so a
//     doorway throws a wedge-shaped shaft instead of a 3 m block. One
//     gridTrace call site, as in the lighting pass.
//   * VOL_HAZE (ultra): enemies cut the strongest shaft (torso capsule).
//   * The flashlight cone samples its shadow map with the world-unit bias.
// Output alpha is the representative pixel's linear view depth, for the
// depth-aware blur and the composite's nearest-depth upsample. The sample
// point for texel ij is full-res pixel floor(ij / scale) (HALF_TEXEL).
export function volFrag({ haze = false } = {}) {
  return /* glsl */ `
  precision highp float;
  precision highp int;
  precision highp usampler2D;
  ${haze ? '#define VOL_HAZE' : ''}
  #define STEPS_MAX ${VOL_STEPS_MAX}
  #define NEAR_MAX ${VOL_NEAR_STEPS_MAX}
  #define LIGHT_MAX ${LIGHT_MAX}
  #define VOL_LIGHTS_MAX ${VOL_LIGHTS_MAX}
  #define CAPSULE_MAX ${CAPSULE_MAX}
  #define CAP_GROUPS ${CAPSULE_ENEMIES_MAX}
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tDepth;
  uniform mat4 uProj;            // view -> clip (project march samples for occlusion)
  uniform mat4 uProjInverse;
  uniform mat4 uCamToWorld;
  uniform vec3 uUpView;
  uniform int uLampCount;
  uniform vec3 uLampColor;
  uniform float uLampIntensity;  // shared with the lit pass so shafts track lamp brightness
  uniform float uLampFlicker;    // shared fluorescent dip so shafts flicker with the lamps
  uniform float uLampRange;
  uniform int uSteps;            // live march steps (quality tier), <= STEPS_MAX
  uniform int uNearSteps;        // near-field flashlight steps (tier), <= NEAR_MAX
  uniform int uMaxLights;        // most lamps that in-scatter (quality tier)
  uniform int uTraceLights;      // first list entries (strongest first) traced when partial (tier)
  uniform int uTraceEvery;       // trace on every n-th step (tier)
  uniform float uTraceDist;      // ... within this distance (tier)
  uniform int uFlashEvery;       // flashlight shadow tap on every n-th step (tier)
  uniform float uScale;          // this target's resolution / full resolution
  uniform float uDensity;
  uniform float uMaxDist;
  uniform float uPhaseG;         // Henyey-Greenstein anisotropy (forward beams)
  uniform float uFogDensity;     // shared with the lit pass: shafts sink into the same haze
  uniform float uVolEmit;        // 1: physically based looks weight shafts by the diffuser profile
  uniform float uEmitFloor;
  uniform float uEmitPow;
  uniform float uGridOn;
  uniform float uFlashOn;
  uniform vec3 uFlashColor;
  uniform float uFlashRange;
  uniform float uFlashIntensity;
  uniform float uFlashCosInner;
  uniform float uFlashCosOuter;
  uniform vec3 uFlashPosV;
  uniform vec3 uFlashDirV;
  uniform float uFlashPhys;      // 1 = physical looks: in-scatter falls off like the lit beam
  uniform float uFlashShadowOn;
  uniform highp sampler2DShadow tFlashShadow;
  uniform mat4 uFlashShadowMatrix;
  uniform mat4 uFlashFromView;
  uniform vec4 uFlashParams;     // tan(half fov), 1 / map size, near, far
  #ifdef VOL_HAZE
  uniform int uCapGroups;
  uniform ivec4 uCapN;
  uniform vec4 uCapA[CAPSULE_MAX];
  uniform vec4 uCapB[CAPSULE_MAX];
  uniform vec4 uCapBound[CAP_GROUPS];
  #endif
  ${LAMP_DATA_GLSL}
  ${GRID_UNIFORMS_GLSL}

  ${IGN}
  ${LAMP_ATT}
  ${VIEW_RECON}
  ${VIEW_PROJ}
  ${DEPTH_PX}
  ${GRID_GLSL}

  // Henyey-Greenstein phase, normalised so the spherical average is ~1.
  float phaseHG(float cosT){
    float g2 = uPhaseG * uPhaseG;
    float denom = max(1.0 + g2 - 2.0 * uPhaseG * cosT, 1e-4);
    return (1.0 - g2) / (denom * sqrt(denom));
  }

  // Screen-space visibility of view-space sample S toward light Lv: a couple of
  // depth taps along the ray; if an on-screen surface lies between them, occluded.
  float visToLight(vec3 S, vec3 Lv){
    vec3 toL = Lv - S;
    float len = length(toL);
    vec3 dir = toL / max(len, 1e-4);
    for (int k = 1; k <= 2; k++){
      vec3 Q = S + dir * (len * (float(k) / 3.0));
      vec2 uv;
      if (!projectView(Q, uv)) continue;
      if (uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) continue;
      float dz = viewZAt(uv) - Q.z;
      if (dz > ${glslFloat(VOL_OCC_NEAR)} && dz < ${glslFloat(VOL_OCC_FAR)}) return 0.0;
    }
    return 1.0;
  }

  // One world-biased tap: the sample moves 1.5 shadow-map texels (at its
  // own distance) toward the emitter, instead of the v1 window-space
  // constant that grew with distance squared and leaked the beam past jambs.
  float flashVis(vec3 S){
    float zL = max(-(uFlashFromView * vec4(S, 1.0)).z, uFlashParams.z);
    float texelW = 2.0 * zL * uFlashParams.x * uFlashParams.y;
    vec3 Sb = S + normalize(uFlashPosV - S) * (1.5 * texelW);
    vec4 sc = uFlashShadowMatrix * vec4(Sb, 1.0);
    if (sc.w <= 0.0) return 1.0;
    vec3 s = sc.xyz / sc.w;
    if (s.x <= 0.0 || s.x >= 1.0 || s.y <= 0.0 || s.y >= 1.0 || s.z >= 1.0) return 1.0;
    return textureLod(tFlashShadow, s, 0.0);
  }

  // Flashlight in-scatter at view-space sample S (per metre of ray).
  float flashTerm(vec3 S, vec3 dir, float trans, bool shadowTap){
    vec3 toS = S - uFlashPosV;
    float ds = length(toS);
    float cone = smoothstep(uFlashCosOuter, uFlashCosInner, dot(toS / max(ds, 1e-4), uFlashDirV));
    if (cone <= 0.0) return 0.0;
    float a = clamp(1.0 - ds / uFlashRange, 0.0, 1.0);
    float fv = uFlashShadowOn > 0.5 && shadowTap ? flashVis(S) : 1.0;
    // Physical looks: the scattered beam dims with the same inverse square
    // as the light it carries, so the dusty column lives near the lens.
    // A mild forward phase (g 0.35): looking straight down your own beam you
    // mostly see back-scatter, which a dusty medium suppresses.
    float fall = 1.0;
    if (uFlashPhys > 0.5) {
      float cosS = dot(toS / max(ds, 1e-4), -dir);
      float den = max(1.1225 - 0.7 * cosS, 1e-4);
      fall = 0.8775 / (den * sqrt(den)) / (ds * ds * 0.18 + 1.0);
    }
    return a * a * cone * trans * fv * fall;
  }

  #ifdef VOL_HAZE
  // Soft torso-capsule cut of a fixture's shaft (enemies in the haze).
  float hazeCapsules(vec3 Sw, vec3 Lw){
    float vis = 1.0;
    for (int g = 0; g < CAP_GROUPS - 1; g++){
      if (g >= uCapGroups) break;
      vec4 bnd = uCapBound[g];
      if (bnd.w <= 0.0 || uCapN[g] < 1 || length(Sw - bnd.xyz) > bnd.w + 6.0) continue;
      int i = g * 3;
      vec3 p2 = uCapA[i].xyz;
      vec3 d2 = uCapB[i].xyz - p2;
      vec3 d1 = Lw - Sw;
      vec3 rr = Sw - p2;
      float a = dot(d1, d1);
      float e = max(dot(d2, d2), 1e-6);
      float f = dot(d2, rr);
      float c = dot(d1, rr);
      float b = dot(d1, d2);
      float den = a * e - b * b;
      float s = den > 1e-6 ? clamp((b * f - c * e) / den, 0.0, 1.0) : 0.0;
      float t = clamp((b * s + f) / e, 0.0, 1.0);
      s = clamp((b * t - c) / a, 0.0, 1.0);
      float dist = length(Sw + d1 * s - (p2 + d2 * t));
      float r = uCapA[i].w;
      float pen = ${glslFloat(PANEL_EQ_R)} * uPenumbraScale * s + 0.03;
      vis *= smoothstep(r - pen, r + pen, dist);
    }
    return vis;
  }
  #endif

  void main(){
    ivec2 ij = ivec2(gl_FragCoord.xy);
    ivec2 fs = textureSize(tDepth, 0);
    ivec2 pF = halfTexelToFull(ij, uScale, fs);
    vec3 P = viewPosPx(pF, fs);
    float plen = length(P);
    float maxT = min(plen, uMaxDist);
    vec3 dir = P / max(plen, 1e-4);
    // Same 4x4 interleaved period the blur integrates.
    float jitter = float((((ij.x + ij.y) & 3) << 2) | (ij.x & 3)) / 16.0;
    bool flashOn = uFlashOn > 0.5;
    vec3 camW = (uCamToWorld * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vec3 dirW = mat3(uCamToWorld) * dir;
    vec2 H = G_PANEL_HALF * uPenumbraScale;

    vec3 acc = vec3(0.0);
    float fl = 0.0;
    // Near field: the flashlight's first metres, finely sampled.
    float nearT = (flashOn && uNearSteps > 0) ? min(8.0, maxT) : 0.0;
    if (nearT > 0.0) {
      float nN = float(uNearSteps);
      for (int i = 0; i < NEAR_MAX; i++){
        if (i >= uNearSteps) break;
        float u0 = (float(i) + jitter) / nN;
        float u1 = min((float(i) + 1.0 + jitter) / nN, 1.0);
        float t = nearT * u0 * u0;
        float dt = nearT * (u1 * u1 - u0 * u0);
        float trans = exp(-uFogDensity * uFogDensity * t * t);
        fl += flashTerm(dir * t, dir, trans, true) * dt;
      }
    }

    // Traced-shaft memory for the two strongest entries: the cell it was
    // traced in and the visibility, held between traced steps.
    ivec3 tCell0 = ivec3(-99999);
    ivec3 tCell1 = ivec3(-99999);
    float tVis0 = 1.0;
    float tVis1 = 1.0;
    float N = float(max(uSteps, 1));
    for (int i = 0; i < STEPS_MAX; i++){
      if (i >= uSteps) break;
      float u0 = (float(i) + jitter) / N;
      float u1 = min((float(i) + 1.0 + jitter) / N, 1.0);
      float t = maxT * u0 * u0;
      float dt = maxT * (u1 * u1 - u0 * u0);
      vec3 S = dir * t;
      float trans = exp(-uFogDensity * uFogDensity * t * t);
      bool gridSample = false;
      if (uGridOn > 0.5) {
        vec3 Sw = camW + dirW * t;
        int cy = int(floor(Sw.y / G_LAYER_H));
        int gx = int(floor(Sw.x / G_CELL));
        int gz = int(floor(Sw.z / G_CELL));
        if (gridOwned(gx, gz, cy)) {
          gridSample = true;
          uvec4 L = texelFetch(tGridList, gTexel(gx, gz, cy), 0);
          bool traceStep = t < uTraceDist && (i - (i / uTraceEvery) * uTraceEvery) == 0;
          ivec3 cell = ivec3(gx, gz, cy);
          for (int k = 0; k < 4; k++) {
            if (k >= uMaxLights) break;
            GridLight gl;
            if (!gridEntry(L, k, gx, gz, cy, gl)) break;
            vec3 toL = gl.pos - Sw;
            float dl = length(toL);
            float vis = gl.vis;
            // Gate on the CHEAP weight before paying for a trace, like the
            // fallback below: flicker x attenuation bounds w from above (the
            // traced vis and the emitter factor are both <= 1), so a sample
            // it rejects would have been dropped at the epsilon anyway and
            // the image is unchanged. List entries whose fixture has faded
            // out at this step no longer pay for a wall trace.
            bool worth = gl.flicker * lampAtt(dl, uLampRange) > ${glslFloat(VOL_CONTRIB_EPS)};
            if (worth && k < uTraceLights && gl.partial && gl.sameFloor && t < uTraceDist) {
              bool fresh = k == 0 ? tCell0 == cell : tCell1 == cell;
              if (traceStep || !fresh) {
                // The pass's only gridTrace call site.
                vis = gridTrace(Sw, gl.pos, cy, H, 0.25, 11, 1, false);
                if (k == 0) { tCell0 = cell; tVis0 = vis; } else { tCell1 = cell; tVis1 = vis; }
              } else {
                vis = k == 0 ? tVis0 : tVis1;
              }
            }
            float emit = mix(uEmitFloor, 1.0, pow(clamp(toL.y / max(dl, 1e-4), 0.0, 1.0), uEmitPow));
            float w = gl.flicker * vis * lampAtt(dl, uLampRange) * mix(1.0, emit, uVolEmit);
            #ifdef VOL_HAZE
              if (k == 0 && w > ${glslFloat(VOL_CONTRIB_EPS)}) w *= hazeCapsules(Sw, gl.pos);
            #endif
            if (w > ${glslFloat(VOL_CONTRIB_EPS)}) {
              float phase = phaseHG(dot(dirW, toL / max(dl, 1e-4)));
              acc += gl.tint * (w * phase * trans * dt);
            }
          }
        }
      }
      if (!gridSample) {
        for (int j = 0; j < VOL_LIGHTS_MAX; j++){
          if (j >= uLampCount || j >= uMaxLights) break;
          vec3 Lv = lampViewPos(j) + uUpView * (uSourceY - ${glslFloat(LAMP_Y)});
          vec4 ch = lampChar(j);
          float dl = distance(S, Lv);
          // Gate on the CHEAP weight before paying for the occlusion taps.
          float w = ch.a * lampAtt(dl, uLampRange);
          if (w > ${glslFloat(VOL_CONTRIB_EPS)}){
            float phase = phaseHG(dot(dir, (Lv - S) / max(dl, 1e-4)));
            acc += ch.rgb * (w * phase * visToLight(S, Lv) * trans * dt);
          }
        }
      }
      // Flashlight in-scatter beyond the near field: a dusty cone from the
      // hand, cut by its shadow map (every uFlashEvery-th step on low tiers).
      // Each step contributes only its part past nearT, so the step that
      // straddles the near-field end still covers [nearT, t + dt] instead of
      // leaving a jitter-dependent hole there. The part is sampled at its
      // midpoint: a left-end sample of the falling cone overweights it.
      float tF = max(t, nearT);
      float dtF = t + dt - tF;
      if (flashOn && dtF > 0.0) {
        float tm = tF + 0.5 * dtF;
        bool tap = (i - (i / uFlashEvery) * uFlashEvery) == 0;
        fl += flashTerm(dir * tm, dir, exp(-uFogDensity * uFogDensity * tm * tm), tap) * dtF;
      }
    }
    acc = acc * (uLampColor * uLampIntensity * uLampFlicker) + uFlashColor * (fl * uFlashIntensity);
    acc *= uDensity;
    outColor = vec4(acc, -P.z);
  }
`
}

export const VOL_FRAG = volFrag()

// Depth-aware separable blur of the half-res shafts (high/ultra): 5 taps
// weighted [0.5, 1, 1, 1, 0.5] — exactly one period of the march's 4x4
// jitter — times depth similarity against the texel's own linear depth
// (alpha), so shafts never smear across a silhouette.
export const VOL_BLUR_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tVol;
  uniform ivec2 uDir;
  void main(){
    ivec2 ij = ivec2(gl_FragCoord.xy);
    ivec2 hs = textureSize(tVol, 0);
    vec4 c = texelFetch(tVol, ij, 0);
    float zc = max(c.a, 1e-3);
    vec3 sum = vec3(0.0);
    float ws = 0.0;
    for (int k = -2; k <= 2; k++){
      vec4 s = texelFetch(tVol, clamp(ij + uDir * k, ivec2(0), hs - 1), 0);
      float dz = (s.a - zc) / (0.1 * zc);
      float w = (k == -2 || k == 2 ? 0.5 : 1.0) * exp(-dz * dz);
      sum += s.rgb * w;
      ws += w;
    }
    outColor = vec4(sum / max(ws, 1e-4), c.a);
  }
`
