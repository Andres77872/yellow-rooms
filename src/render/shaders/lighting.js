import { CEL_BAND, IGN, LAMP_ATT, glslFloat } from './common.js'
import { BRDF_GLSL } from './brdf.js'
import { GRID_GLSL, GRID_UNIFORMS_GLSL } from './grid.js'
import { LAMP_DATA_GLSL } from './lampData.js'
import {
  CAPSULE_ENEMIES_MAX,
  CAPSULE_MAX,
  LIGHT_MAX,
  CEL_BANDS,
  CEL_FLOOR,
  SPEC_REACH,
  ENTITY_FILL,
  FLASH_BLOCKER_TAPS_MAX,
  FLASH_TAPS_MAX,
  FURN_CELLS_MAX,
  FURN_LIGHTS_MAX,
  RIM_POW,
  RIM_MIX,
  SKY_ZENITH_MULT,
  SKY_NADIR_MULT,
} from '../../world/constants.js'
import { LAMP_Y, OCC_MAX_H, PANEL_EQ_R, PANEL_HALF_Z, SLAB_MID } from '../../world/lightGrid/gridSpec.js'

export { CAPSULE_MAX }

// --- Deferred lighting pass (engine-improvement S1–S5, chapter 14) --------
//
// Every light is shaded in WORLD space through ONE loop ("unified light
// loop", chapter 14 P6), so each occlusion function has a single textual
// call site (compile time on ANGLE/D3D11 grows with inlined copies):
//   kind 0  a ceiling fixture: a grid light-list entry (world/lightGrid) on
//           grid pixels, or a legacy nearest-lamp (tLampData) elsewhere;
//   kind 1  the flashlight's bounce light (a CPU-raycast VPL);
//   kind 2  the analytic flashlight (FLASH_ANALYTIC low tier, no map).
// Visibility per light: baked wall visibility, or a per-pixel gridTrace of
// the emitter footprint (partial entries up to the tier's cap), times exact
// furniture-box coverage (FURN), enemy capsule soft shadows and the
// per-light residual contact channel. Tiers cap WORK, never light: every
// entry shades, capped ones keep baked, wall-aware visibility.
// Indirect light (GI cube + dusk hemisphere) is occluded by
// min(screen AO, crease x box x capsule AO) with multi-bounce, and its
// specular by Lagarde specular occlusion.
// SHADING_PBR selects the physical model (GGX + Lambert, representative-
// point rectangle specular, inverse-square fixtures); otherwise the Classic
// painted/cel model runs, fed by the same wall-aware visibility.
// Variants (defines): SHADING_PBR, ATT_PHYSICAL, OCC_V2 (GTAO + per-light
// contact channels; else the legacy SSAO + aggregate mask), FURN (furniture
// boxes), FLASH_FILTER 0/1/2 (3x3 / Vogel / PCSS), FLASH_ANALYTIC, BENT.
export function lightingFrag({
  pbr = false,
  physicalAtt = false,
  occV2 = false,
  furn = false,
  flashFilter = 0,
  flashAnalytic = false,
  bent = false,
} = {}) {
  return /* glsl */ `
  precision highp float;
  precision highp int;
  precision highp usampler2D;
  ${pbr ? '#define SHADING_PBR' : ''}
  ${physicalAtt ? '#define ATT_PHYSICAL' : ''}
  ${occV2 ? '#define OCC_V2' : ''}
  ${furn ? '#define FURN' : ''}
  ${flashAnalytic ? '#define FLASH_ANALYTIC' : ''}
  ${bent && occV2 ? '#define BENT' : ''}
  #define FLASH_FILTER ${flashFilter | 0}
  #define LIGHT_MAX ${LIGHT_MAX}
  #define LOOP_MAX ${LIGHT_MAX + 2}
  #define CAPSULE_MAX ${CAPSULE_MAX}
  #define CAP_GROUPS ${CAPSULE_ENEMIES_MAX}
  #define FURN_LIGHTS ${FURN_LIGHTS_MAX}
  #define FURN_CELLS ${FURN_CELLS_MAX}
  #define FLASH_TAPS_MAX ${FLASH_TAPS_MAX}
  #define FLASH_BLOCKERS_MAX ${FLASH_BLOCKER_TAPS_MAX}
  #define OCC_MAX_H ${glslFloat(OCC_MAX_H)}
  #define PANEL_EQ_R ${glslFloat(PANEL_EQ_R)}
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tColor;
  uniform sampler2D tNormal;     // xyz view normal, a = perceptual roughness
  uniform sampler2D tMaterial;   // r metalness, g material AO, b legacy gloss
  uniform sampler2D tDepth;
  uniform sampler2D tOcc;        // OCC_V2: (ao, bent oct xy) half res; else blurred SSAO (r)
  uniform sampler2D tContact;    // OCC_V2: (vis entry 0, entry 1, rest, cell hash); else blurred mask (r)
  uniform mat4 uProjInverse;
  uniform mat4 uCamToWorld;      // camera.matrixWorld (view -> world)
  uniform vec3 uCamPosW;
  uniform float uShadowStrength;
  uniform vec3 uUpView;          // world up, in view space
  uniform int uLampCount;        // legacy visible set (tLampData rows)
  uniform vec3 uLampColor;
  uniform float uLampIntensity;
  uniform float uLampFlicker;    // per-frame fluorescent dip (1 = steady); driven by Engine
  uniform float uLampRange;
  uniform vec3 uAmbSky;          // family ambient, re-hued by the look (luminance kept)
  uniform vec3 uAmbGround;
  uniform float uHemi;           // look: hemisphere ambient share
  uniform float uLampWrap;       // half-Lambert wrap for lamp + flash N·L (toon)
  uniform float uCelHard;        // look: banded share of the painted ramp (toon)
  uniform float uRim;
  uniform float uRimLitGate;     // look: 1 = rim only where light actually falls
  uniform vec3 uRimColor;
  uniform vec3 uEntityRim;
  uniform float uEntityRimK;
  uniform float uEntityFill;
  uniform vec3 uTermColor;
  uniform float uTermStrength;
  uniform vec3 uBounceColor;
  uniform float uBounce;
  uniform float uSpecPower;
  uniform float uSpecStrength;
  uniform float uSpecK;          // look: specular multiplier
  uniform float uLampAO;         // share of screen AO applied to direct light (legacy looks)
  uniform float uGridOn;
  uniform float uGI;             // look: cell-graph bounce strength
  uniform float uGIStencil;      // tier: 2x2 wall-aware GI stencil (else own cell)
  uniform float uCeilingLift;    // look: GI boost on down-facing surfaces
  uniform float uEmitFloor;      // look: diffuser output at grazing
  uniform float uEmitPow;
  // Per-light occlusion caps (quality tier) and strengths (look).
  uniform int uMaxTraced;        // partial entries traced per pixel
  uniform int uTraceSubRays;
  uniform float uCrossFloor;     // tier: trace fixtures one floor away through their slab hole
  uniform int uFurnLights;
  uniform int uFurnCellsMax;
  uniform int uFurnBoxes;
  uniform float uFurnK;
  uniform float uBoxAOK;
  uniform int uBoxAOCells;
  uniform int uCapsuleLights;
  uniform int uCapsulesPerEnemy;
  uniform float uCapsuleK;
  uniform float uCapsuleAOK;
  uniform float uCapsuleMinVis;
  uniform float uSelfShadow;
  uniform float uCreaseK;
  uniform float uAORadius;
  uniform float uMultiBounce;
  uniform float uSpecOcc;
  uniform float uBentK;
  uniform int uContactChannels;
  uniform float uOccScale;       // resolution scale of tOcc / tContact (HALF_TEXEL mapping)
  // Flashlight.
  uniform float uFlashOn;
  uniform vec3 uFlashColor;
  uniform float uFlashRange;
  uniform float uFlashIntensity;
  uniform float uFlashCosInner;
  uniform float uFlashCosOuter;
  uniform vec3 uFlashPosV;       // flashlight emitter, view space (hand offset)
  uniform vec3 uFlashDirV;       // beam axis, view space
  uniform float uFlashShadowOn;
  uniform highp sampler2DShadow tFlashShadow;
  uniform mat4 uFlashShadowMatrix; // view space -> shadow texture space
  uniform mat4 uFlashFromView;     // view space -> flashlight camera space
  uniform vec4 uFlashParams;       // tan(half fov), 1 / map size, near, far
  uniform float uTorchSize;        // look: emitter size (m)
  uniform int uFlashTaps;
  uniform int uFlashBlockerTaps;
  #if FLASH_FILTER == 2
  uniform sampler2D tFlashDepth;   // 1 - window depth of the casters (0 = none)
  #endif
  uniform float uFlashBounce;
  // Flashlight bounce light (CPU grid raycast, Engine).
  uniform float uVplOn;
  uniform vec3 uVplPosW;
  uniform vec3 uVplN;
  uniform vec3 uVplColor;          // hit albedo x torch colour x falloff (smoothed)
  uniform float uVplOccl;          // tier: trace walls + capsules toward it
  // Enemy (and optional player) capsules, world space.
  uniform int uCapGroups;
  uniform ivec4 uCapN;             // capsules per group (group g at [g*3, g*3+n))
  uniform vec4 uCapA[CAPSULE_MAX]; // segment start + radius
  uniform vec4 uCapB[CAPSULE_MAX]; // segment end
  uniform vec4 uCapBound[CAP_GROUPS]; // bounding sphere per group (w <= 0: absent)
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  // Lighting diagnostics (F2 LightTool): 0 off, 1 grid list size heatmap,
  // 2 grid coverage (green grid / red legacy), 3 direct light only,
  // 4 indirect only (bounce + ambient), 5 per-pixel traced fixtures,
  // 6 furniture visibility of the strongest light (red = cell cap hit),
  // 7 world AO (crease x box x capsule), 8 flashlight visibility.
  uniform int uLightDebug;
  ${LAMP_DATA_GLSL}
  ${GRID_UNIFORMS_GLSL}

  ${CEL_BAND}
  ${BRDF_GLSL}
  ${GRID_GLSL}
  ${IGN}
  ${LAMP_ATT}

  vec3 skyColor(vec3 dirView){
    float up = dot(dirView, uUpView);
    float b = mix(1.0, ${glslFloat(SKY_ZENITH_MULT)}, smoothstep(0.02, 0.5, up))
            * mix(1.0, ${glslFloat(SKY_NADIR_MULT)}, smoothstep(0.02, 0.55, -up));
    return uFogColor * b;
  }
  float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

  // --- Classic (toon) building blocks --------------------------------------
  float gWrap;
  float wrapNL(float ndl){ return clamp((ndl + gWrap) / (1.0 + gWrap), 0.0, 1.0); }
  float paintedRamp(float x){
    return ${glslFloat(CEL_FLOOR)} + ${glslFloat(1 - CEL_FLOOR)} * smoothstep(0.02, 0.92, x);
  }
  float surfaceRamp(float x, float dither){ return mix(paintedRamp(x), band(x + dither), uCelHard); }
  float terminator(float w){ return smoothstep(0.02, 0.26, w) * (1.0 - smoothstep(0.26, 0.58, w)); }
  float specLobe(vec3 N, vec3 L, vec3 V){
    float nh = max(dot(N, normalize(L + V)), 0.0);
    return smoothstep(0.1, 0.55, pow(nh, uSpecPower));
  }

  // Fixture falloff for the active look.
  float fixtureAtt(float d, float range){
    #ifdef ATT_PHYSICAL
      float x = d / range;
      if (x >= 1.0) return 0.0;
      float w = 1.0 - x * x * x * x;
      return (w * w) / (d * d + 0.25);
    #else
      return lampAtt(d, range);
    #endif
  }

  // Representative point on the downward-facing emitter rectangle (centre
  // C, half extents h, plane y = C.y) for the reflection ray P + R t: the
  // glossy floor reflects the panel's rectangle instead of a streak.
  vec3 rectRepPoint(vec3 P, vec3 R, vec3 C, vec2 h){
    float t = (C.y - P.y) / (abs(R.y) > 1e-4 ? R.y : 1e-4);
    vec3 X = t > 0.0 ? P + R * t : P + R * 1e4;
    vec2 q = clamp(X.xz - C.xz, -h, h);
    return vec3(C.x + q.x, C.y, C.z + q.y);
  }

  // Per-pixel surface state shared by every light (WORLD space).
  vec3 sP, sN, sV, sAlbedo;
  float sRough, sMetal, sGloss, sDither;
  bool sGlossy;
  // Accumulators.
  vec3 aDiff, aSpec, aTerm, aOmni;
  float aLit;

  // Shade one ceiling fixture at world position lampPos (the emitter
  // centre). radiance = tint * flicker * visibility.
  void shadeFixture(vec3 lampPos, vec3 radiance){
    vec3 toL = lampPos - sP;
    float d = length(toL);
    vec3 L = toL / max(d, 1e-4);
    float ndl = dot(sN, L);
    #ifdef SHADING_PBR
      float att = fixtureAtt(d, uLampRange);
      if (att <= 0.0) return;
      // Diffuser profile: full output straight down, uEmitFloor at grazing,
      // so walls peak below the panel and darken toward the ceiling (the
      // downlight scallop) and ceilings are not lit like floors.
      float emit = mix(uEmitFloor, 1.0, pow(clamp(L.y, 0.0, 1.0), uEmitPow));
      vec3 Li = radiance * (att * emit);
      vec3 R = reflect(-sV, sN);
      vec3 Ls = normalize(rectRepPoint(sP, R, lampPos, G_PANEL_HALF) - sP);
      vec3 dif, spc;
      brdfDirect(sN, sV, L, Ls, d, ${glslFloat(PANEL_HALF_Z)}, sAlbedo, sRough, sMetal, dif, spc);
      aDiff += dif * Li;
      aSpec += spc * Li;
      aLit += luma(Li) * max(ndl, 0.0);
    #else
      float reach = sGlossy ? uLampRange * ${glslFloat(SPEC_REACH)} : uLampRange;
      if (d > reach) return;
      if (sGlossy && ndl > 0.0) aSpec += radiance * (lampAtt(d, reach) * specLobe(sN, L, sV));
      if (d > uLampRange) return;
      float w = wrapNL(ndl);
      vec3 lc = radiance * lampAtt(d, uLampRange);
      aDiff += lc * surfaceRamp(w, sDither);
      aTerm += lc * terminator(w);
      aOmni += lc;
      aLit += luma(lc) * w;
    #endif
  }

  // --- Enemy capsules ---------------------------------------------------------
  // Soft shadow of a spherical cap (the capsule seen from P, radius r at the
  // axis point nearest the ray) over the light's cap (angular radius aL):
  // Oat & Sander's cap intersection in its smoothstep form.
  float capOccluded(float aL, float aO, float beta){
    float dA = abs(aL - aO);
    float t = 1.0 - clamp((beta - dA) / max(aL + aO - dA, 1e-4), 0.0, 1.0);
    // (1 - cos m) / (1 - cos aL) written as sin^2 of the half angles: the
    // cos form loses fp32 precision for small lights (a 2 cm torch at 20 m),
    // where a point light must give a hard shadow.
    float sO = sin(0.5 * aO);
    float sL = sin(0.5 * aL);
    return min(1.0, sO * sO / max(sL * sL, 1e-12)) * smoothstep(0.0, 1.0, t);
  }

  // Occlusion of the light cap by one sphere (centre P + v, radius r); zero
  // when the sphere lies beyond the light.
  float sphereOcc(vec3 v, float r, vec3 Ld, float len, float aL){
    if (dot(v, Ld) > len - 0.05) return 0.0;
    float dist = max(length(v), 1e-4);
    float aO = asin(min(r / dist, 1.0));
    float beta = acos(clamp(dot(Ld, v / dist), -1.0, 1.0));
    return capOccluded(aL, aO, beta);
  }

  // Visibility of a light of radius lightR at Lp from P through the capsule
  // groups [0, groups). Entity pixels skip only the capsule they lie on, so
  // the torso still shades the legs (self-shadowing); the Classic look
  // (uSelfShadow 0) keeps enemies unshadowed by their own capsules.
  float capsuleShadow(vec3 P, vec3 Lp, float lightR, bool entityPx, int groups){
    if (entityPx && uSelfShadow < 0.5) return 1.0;
    vec3 d1 = Lp - P;
    float a = dot(d1, d1);
    float len = sqrt(a);
    vec3 Ld = d1 / max(len, 1e-4);
    float aL = atan(lightR / max(len, 1e-3));
    float vis = 1.0;
    for (int g = 0; g < CAP_GROUPS; g++){
      if (g >= groups) break;
      vec4 bnd = uCapBound[g];
      if (bnd.w <= 0.0) continue;
      float tb = clamp(dot(bnd.xyz - P, Ld), 0.0, len);
      if (length(P + Ld * tb - bnd.xyz) > bnd.w + lightR * tb / max(len, 1e-3) + 0.05) continue;
      int n = min(uCapN[g], uCapsulesPerEnemy);
      for (int j = 0; j < 3; j++){
        if (j >= n) break;
        int i = g * 3 + j;
        vec3 p2 = uCapA[i].xyz;
        float r = uCapA[i].w;
        vec3 d2 = uCapB[i].xyz - p2;
        vec3 rr = P - p2;
        float e = max(dot(d2, d2), 1e-6);
        float f = dot(d2, rr);
        float c = dot(d1, rr);
        float b = dot(d1, d2);
        float den = a * e - b * b;
        float s = den > 1e-6 * a * e ? clamp((b * f - c * e) / den, 0.0, 1.0) : 0.0;
        float t = (b * s + f) / e;
        if (t < 0.0) { t = 0.0; s = clamp(-c / a, 0.0, 1.0); }
        else if (t > 1.0) { t = 1.0; s = clamp((b - c) / a, 0.0, 1.0); }
        vec3 w = p2 - P;
        vec3 v = w + d2 * t;
        if (entityPx && length(v) < 1.25 * r) continue; // the capsule this pixel lies on
        // The sphere at the axis point nearest the ray, plus both end
        // spheres: when a ray runs along the axis (a lamp straight above a
        // standing figure) the nearest point flips ends and alone leaves a
        // seam through the shadow's foot.
        float occ = max(sphereOcc(v, r, Ld, len, aL), max(sphereOcc(w, r, Ld, len, aL), sphereOcc(w + d2, r, Ld, len, aL)));
        vis *= 1.0 - uCapsuleK * occ;
      }
    }
    return vis;
  }

  // Ambient occlusion of the capsules (Quilez sphere occlusion at the axis
  // point nearest P), every tier.
  float capsuleAO(vec3 P, vec3 N, bool entityPx){
    float ao = 1.0;
    for (int g = 0; g < CAP_GROUPS; g++){
      if (g >= uCapGroups) break;
      vec4 bnd = uCapBound[g];
      if (bnd.w <= 0.0 || length(P - bnd.xyz) > bnd.w * 3.0 + 0.6) continue;
      int n = min(uCapN[g], uCapsulesPerEnemy);
      for (int j = 0; j < 3; j++){
        if (j >= n) break;
        int i = g * 3 + j;
        vec3 A = uCapA[i].xyz;
        float r = uCapA[i].w;
        vec3 ab = uCapB[i].xyz - A;
        float t = clamp(dot(P - A, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
        vec3 v = A + ab * t - P;
        float dd = max(length(v), 1e-4);
        if (entityPx && dd < 1.25 * r) continue;
        float occ = clamp(dot(N, v / dd), 0.0, 1.0) * (r * r) / (dd * dd) * (1.0 - smoothstep(3.0 * r, 6.0 * r, dd));
        ao *= 1.0 - min(occ, 1.0);
      }
    }
    return max(mix(1.0, ao, uCapsuleAOK), uCapsuleMinVis);
  }

  // --- Flashlight shadow (view space) ------------------------------------------
  vec3 flashProj(vec3 Pv){
    vec4 sc = uFlashShadowMatrix * vec4(Pv, 1.0);
    return sc.xyz / sc.w;
  }
  float flashLinDepth(float zw){
    float n = uFlashParams.z;
    float f = uFlashParams.w;
    return n * f / (f - zw * (f - n));
  }
  vec2 vogel(int i, float n, float rot){
    float r = sqrt((float(i) + 0.5) / n);
    float th = float(i) * 2.3999632 + rot;
    return vec2(cos(th), sin(th)) * r;
  }
  // World-unit biased, receiver-plane filtered flashlight visibility. The
  // normal offset and the constant along L are sized in shadow-map texels at
  // the receiver's own distance, so the bias no longer grows with distance
  // squared (the v1 window-space constant was ~0.0075 d^2 metres: shadows
  // detached at 2-3 m and vanished past 6-8 m).
  float flashShadow(vec3 P, vec3 Ng, vec3 Lf){
    float zL = max(-(uFlashFromView * vec4(P, 1.0)).z, uFlashParams.z);
    float texel = uFlashParams.y;
    float texelW = 2.0 * zL * uFlashParams.x * texel;
    float NoL = clamp(dot(Ng, Lf), 0.0, 1.0);
    vec3 Pb = P + Ng * (1.5 * texelW * sqrt(1.0 - NoL * NoL)) + Lf * (0.5 * texelW + 0.002);
    vec4 sc = uFlashShadowMatrix * vec4(Pb, 1.0);
    if (sc.w <= 0.0) return 1.0;
    vec3 s0 = sc.xyz / sc.w;
    if (s0.x <= 0.0 || s0.x >= 1.0 || s0.y <= 0.0 || s0.y >= 1.0 || s0.z >= 1.0) return 1.0;
    // Receiver-plane depth gradient (Isidoro): taps follow the receiver's
    // own plane instead of the tap-centre depth, so a wide kernel on a
    // sloped floor neither acnes nor leaks.
    vec3 T1 = normalize(cross(Ng, abs(Ng.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 T2 = cross(Ng, T1);
    vec3 s1 = flashProj(Pb + T1 * texelW);
    vec3 s2 = flashProj(Pb + T2 * texelW);
    mat2 J = mat2(s1.xy - s0.xy, s2.xy - s0.xy);
    float det = J[0][0] * J[1][1] - J[1][0] * J[0][1];
    vec2 grad = vec2(0.0);
    if (abs(det) > 1e-14) {
      grad = transpose(inverse(J)) * vec2(s1.z - s0.z, s2.z - s0.z);
      float gl = length(grad) * texel;
      if (gl > 0.01) grad *= 0.01 / gl;
    }
    float sum = 0.0;
    #if FLASH_FILTER == 0
      for (int y = -1; y <= 1; y++)
        for (int x = -1; x <= 1; x++) {
          vec2 o = vec2(float(x), float(y)) * texel;
          sum += textureLod(tFlashShadow, vec3(s0.xy + o, s0.z + dot(grad, o)), 0.0);
        }
      return sum / 9.0;
    #else
      float rot = 6.2831853 * ign(gl_FragCoord.xy);
      #if FLASH_FILTER == 2
        // PCSS: blocker search sized by the emitter, then a filter whose
        // radius grows with the blocker-receiver gap (contact hardening).
        const float zMin = 0.35;
        float size = 1.0 / texel;
        float rSearch = clamp(uTorchSize * (zL - zMin) / (zL * 2.0 * zMin * uFlashParams.x) * size, 2.0, 24.0);
        float nb = float(max(uFlashBlockerTaps, 1));
        float zSum = 0.0;
        float cnt = 0.0;
        for (int i = 0; i < FLASH_BLOCKERS_MAX; i++){
          if (i >= uFlashBlockerTaps) break;
          vec2 o = vogel(i, nb, rot) * rSearch * texel;
          float v = textureLod(tFlashDepth, s0.xy + o, 0.0).r;
          float zw = 1.0 - v;
          if (v > 0.0 && zw < s0.z + dot(grad, o) - 1e-5) { zSum += flashLinDepth(zw); cnt += 1.0; }
        }
        if (cnt < 0.5) return 1.0;
        float zB = zSum / cnt;
        float rTex = clamp(uTorchSize * max(zL - zB, 0.0) / max(zB, 1e-3) * 0.5 / texelW, 1.0, 16.0);
      #else
        float rTex = clamp(uTorchSize * 0.3 / texelW, 1.0, 8.0);
      #endif
      float n = float(max(uFlashTaps, 1));
      for (int i = 0; i < FLASH_TAPS_MAX; i++){
        if (i >= uFlashTaps) break;
        vec2 o = vogel(i, n, rot) * rTex * texel;
        sum += textureLod(tFlashShadow, vec3(s0.xy + o, s0.z + dot(grad, o)), 0.0);
      }
      return sum / n;
    #endif
  }

  // View position of a full-resolution pixel (clamped to the target).
  vec3 viewPosPx(ivec2 px, ivec2 sz){
    px = clamp(px, ivec2(0), sz - 1);
    float d = texelFetch(tDepth, px, 0).x;
    vec2 uv = (vec2(px) + 0.5) / vec2(sz);
    vec4 v = uProjInverse * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return v.xyz / v.w;
  }
  // Geometric normal from depth (Turanszki: per axis the neighbour with the
  // smaller depth step), never the detail-mapped G-buffer normal, so shadow
  // offsets and horizon tests follow the real surface. Falls back to the
  // G-buffer normal on one-pixel features.
  vec3 geomNormalV(vec3 P, vec3 Nf){
    ivec2 sz = textureSize(tDepth, 0);
    ivec2 px = ivec2(gl_FragCoord.xy);
    vec3 l = viewPosPx(px - ivec2(1, 0), sz);
    vec3 r = viewPosPx(px + ivec2(1, 0), sz);
    vec3 d = viewPosPx(px - ivec2(0, 1), sz);
    vec3 u = viewPosPx(px + ivec2(0, 1), sz);
    float dl = abs(l.z - P.z);
    float dr = abs(r.z - P.z);
    float dd = abs(d.z - P.z);
    float du = abs(u.z - P.z);
    float lim = 0.25 * abs(P.z);
    if (min(dl, dr) > lim || min(dd, du) > lim) return Nf;
    vec3 ex = dr < dl ? r - P : P - l;
    vec3 ey = du < dd ? u - P : P - d;
    vec3 n = cross(ex, ey);
    float nl = length(n);
    if (nl < 1e-10) return Nf;
    n /= nl;
    return dot(n, Nf) < 0.0 ? -n : n;
  }

  // --- Occlusion inputs ---------------------------------------------------------
  #ifdef OCC_V2
    // Joint bilateral upsample (Kopf): the four half-res texels around this
    // pixel, bilinear x depth similarity, so AO and contact never bleed
    // across a silhouette. Contact channels r/g name list entries 0/1 of the
    // texel's own cell: taps from another cell (hash in a) drop out.
    vec4 gOccT; vec4 gContactT;
    void occUpsample(float zc, float cellHash){
      ivec2 hs = textureSize(tOcc, 0);
      ivec2 fs = textureSize(tDepth, 0);
      // HALF_TEXEL mapping: scaled texel ij was produced AT full-res pixel
      // floor(ij / scale), so even pixels land exactly on a texel.
      vec2 q = floor(gl_FragCoord.xy) * uOccScale;
      ivec2 i0 = ivec2(floor(q));
      vec2 f = q - vec2(i0);
      vec4 occ = vec4(0.0);
      vec4 con = vec4(0.0);
      float wo = 0.0;
      vec2 wc = vec2(0.0);
      float bestDz = 1e9;
      vec4 bestO = vec4(1.0, 0.5, 0.5, 1.0);
      vec4 bestC = vec4(1.0);
      for (int t = 0; t < 4; t++){
        ivec2 o = ivec2(t & 1, t >> 1);
        ivec2 ij = clamp(i0 + o, ivec2(0), hs - 1);
        vec2 bw = mix(1.0 - f, f, vec2(o));
        ivec2 pf = min(ivec2(floor(vec2(ij) / uOccScale)), fs - 1);
        float zi = viewPosPx(pf, fs).z;
        float rz = (zc - zi) / (0.05 * abs(zc));
        float w = bw.x * bw.y * max(1e-3, 1.0 - rz * rz);
        vec4 so = texelFetch(tOcc, ij, 0);
        vec4 sc = texelFetch(tContact, ij, 0);
        occ += so * w;
        wo += w;
        // Per-light channels only from taps of the same cell.
        float same = abs(sc.a - cellHash) < 0.002 ? 1.0 : 0.0;
        con.rg += sc.rg * (w * same);
        wc.x += w * same;
        con.b += sc.b * w;
        wc.y += w;
        if (abs(zc - zi) < bestDz) { bestDz = abs(zc - zi); bestO = so; bestC = sc; }
      }
      gOccT = wo > 1e-3 ? occ / wo : bestO;
      gContactT.rg = wc.x > 1e-3 ? con.rg / wc.x : (abs(bestC.a - cellHash) < 0.002 ? bestC.rg : vec2(1.0));
      gContactT.b = wc.y > 1e-3 ? con.b / wc.y : bestC.b;
      gContactT.a = 1.0;
    }
    vec3 octDecode(vec2 e){
      e = e * 2.0 - 1.0;
      vec3 n = vec3(e, 1.0 - abs(e.x) - abs(e.y));
      if (n.z < 0.0) n.xy = (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
      return normalize(n);
    }
  #endif

  void main(){
    float depth = texture(tDepth, vUv).x;
    vec4 ndc = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 vp = uProjInverse * ndc; vp /= vp.w;
    vec3 P = vp.xyz;               // view-space position (far plane when void)
    float dist = length(P);
    vec3 viewDir = P / max(dist, 1e-4);
    vec3 fogCol = skyColor(viewDir);

    // Void (no geometry): the graded sky, not a flat curtain.
    if (depth >= 1.0) { outColor = vec4(fogCol, 1.0); return; }

    vec4 c = texture(tColor, vUv);
    float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);

    // Emissive surfaces (lamps, exit, signs) bypass lighting.
    if (c.a > 0.5 && c.a < 1.5) {
      outColor = vec4(mix(c.rgb, fogCol, fog), 1.0);
      return;
    }
    bool entity = c.a > 1.5 && c.a < 2.5;

    vec4 nTex = texture(tNormal, vUv);
    vec3 N = normalize(nTex.xyz * 2.0 - 1.0);
    vec4 mTex = texture(tMaterial, vUv);
    vec3 V = -viewDir;
    float jitter = ign(gl_FragCoord.xy);
    sAlbedo = c.rgb;
    sRough = nTex.a;
    sMetal = mTex.r;
    sGloss = mTex.b;
    sGlossy = sGloss > 0.004;
    sDither = (jitter - 0.5) / ${glslFloat(CEL_BANDS)};
    float matAO = mTex.g;
    float hemi = 0.5 + 0.5 * dot(N, uUpView);
    gWrap = uLampWrap * mix(0.3, 1.0, smoothstep(0.0, 0.5, hemi));
    aDiff = vec3(0.0); aSpec = vec3(0.0); aTerm = vec3(0.0); aOmni = vec3(0.0); aLit = 0.0;

    // World-space frame: every light shades here.
    vec3 Pw = (uCamToWorld * vec4(P, 1.0)).xyz;
    vec3 Nw = normalize(mat3(uCamToWorld) * N);
    sP = Pw; sN = Nw; sV = normalize(uCamPosW - Pw);
    vec3 Ptrace = Pw + Nw * 0.04;
    vec3 Pl = Pw + Nw * 0.3; // pushed into the room the surface faces
    int gcy = int(floor(Pl.y / G_LAYER_H));
    int gx = int(floor(Pl.x / G_CELL));
    int gz = int(floor(Pl.z / G_CELL));
    bool gridPixel = uGridOn > 0.5 && gridOwned(gx, gz, gcy);
    float base = float(gcy) * G_LAYER_H;
    uvec4 L = gridPixel ? texelFetch(tGridList, gTexel(gx, gz, gcy), 0) : uvec4(0u);
    int nLights = gridPixel ? gListCount(L) : min(uLampCount, LIGHT_MAX);
    vec2 H = G_PANEL_HALF * uPenumbraScale;

    // --- Occlusion inputs ------------------------------------------------------
    float cellHash = gridPixel ? float((gx * 7 + gz * 13 + gcy * 29) & 255) / 255.0 : 0.0;
    #ifdef OCC_V2
      occUpsample(P.z, cellHash);
      float ao = gOccT.r;
      vec3 contactCh = gridPixel ? gContactT.rgb : vec3(gContactT.b);
      float contactAll = 1.0;
    #else
      float ao = texture(tOcc, vUv).r;
      vec3 contactCh = vec3(1.0);
      float contactAll = texture(tContact, vUv).r;
    #endif
    float shadowK = uShadowStrength * mix(0.25, 1.0, smoothstep(0.0, 0.45, hemi));
    contactCh = mix(vec3(1.0), contactCh, shadowK);
    contactAll = mix(1.0, contactAll, shadowK);

    // --- Furniture box shadows + box AO (prepass over the ring cells) -------
    float boxAO = 1.0;
    int nF = 0;
    bool furnTrunc = false;
    #ifdef FURN
      float fvis[FURN_LIGHTS];
      vec3 fpos[FURN_LIGHTS];
      uint fneed[FURN_LIGHTS];
      for (int k = 0; k < FURN_LIGHTS; k++) { fvis[k] = 1.0; fneed[k] = 0u; fpos[k] = vec3(0.0); }
      if (gridPixel) {
        uint ring = gOcc(gx, gz, gcy).w & G_OCC_MASK;
        if (ring != 0u) {
          nF = min(min(uFurnLights, FURN_LIGHTS), nLights);
          uint need = 0u;
          for (int k = 0; k < FURN_LIGHTS; k++){
            if (k >= nF) break;
            ivec3 r = gEntryRef(L, k);
            if (r.z != 0) continue;
            vec3 Lk = vec3((float(gx + r.x) + 0.5) * G_CELL, base + uSourceY, (float(gz + r.y) + 0.5) * G_CELL);
            fpos[k] = Lk;
            // Only cells inside the box spanned by the receiver and the
            // emitter pulled toward it to where rays clear the tallest
            // proxy can hold an occluder: a box entering or leaving this set
            // contributes exactly zero, so shadows never step at cell edges.
            float fr = clamp((OCC_MAX_H - (Ptrace.y - base)) / max(Lk.y - Ptrace.y, 0.05), 0.0, 1.0);
            vec2 rmin = min(Ptrace.xz, mix(Ptrace.xz, Lk.xz - H, fr));
            vec2 rmax = max(Ptrace.xz, mix(Ptrace.xz, Lk.xz + H, fr));
            fneed[k] = gOccRect(ivec2(floor(rmin / G_CELL)) - ivec2(gx, gz), ivec2(floor(rmax / G_CELL)) - ivec2(gx, gz));
            need |= fneed[k];
          }
          // Box AO: the receiver's own cell or ring 1 by tier, axis-aligned
          // receivers only (the form factor is exact for them). Ring 2 never
          // contributes: its boxes are at least CELL - 0.26 m = 2.74 m from
          // Ptrace horizontally, past the dh < 2.5 gate below.
          vec3 anw = abs(Nw);
          bool aoAxis = uBoxAOK > 0.0 && max(anw.x, max(anw.y, anw.z)) > 0.9;
          uint aoNeed = !aoAxis ? 0u : (uBoxAOCells <= 1 ? 1u : 511u);
          // Shadow cells first, in ring order; AO-only cells fill what is
          // left, so they never evict a cell a light's shadow needs (only a
          // dropped shadow cell counts as truncation).
          int cellsMax = min(uFurnCellsMax, FURN_CELLS);
          int cells[FURN_CELLS];
          int nc = 0;
          for (int phase = 0; phase < 2; phase++){
            uint todo = phase == 0 ? ring & need : ring & aoNeed & ~need;
            for (int b = 0; b < G_OCC_CELLS; b++){
              if ((todo & (1u << uint(b))) == 0u) continue;
              if (nc >= cellsMax) { if (phase == 0) furnTrunc = true; break; }
              cells[nc] = b;
              nc++;
            }
          }
          // Architecture receivers (storey planes, closed wall faces, jambs,
          // columns) never skip a box: outside one, gBoxCover and gBoxFF are
          // exact down to its face (the floor at a cabinet's foot, the wall
          // behind a desk), and inside a solid proxy (the floor of a desk's
          // knee hole) full cover is what a solid proxy means. Only the
          // proxy's outward rounding is undone (gBoxBeside), so the floor
          // right at a lit face stays lit. Only furniture pixels skip the
          // proxy they lie on or in (seats, basins, shelves).
          bool furnPx = !gArchSurface(Pw, gcy);
          float boxF = 0.0;
          for (int i = 0; i < FURN_CELLS; i++){
            if (i >= nc) break;
            int b = cells[i];
            ivec2 cc = ivec2(gx, gz) + G_OCC_OFF[b];
            uvec4 o = gOcc(cc.x, cc.y, gcy);
            uint bit = 1u << uint(b);
            for (int w = 0; w < 2; w++){
              if (w >= uFurnBoxes) break;
              vec3 blo, bhi;
              float T;
              if (!gOccBox(o, w, cc.x, cc.y, gcy, blo, bhi, T)) continue;
              if (furnPx && all(greaterThan(Ptrace, blo - 0.03)) && all(lessThan(Ptrace, bhi + 0.03))) continue;
              if (!furnPx) gBoxBeside(Ptrace, Nw, blo, bhi);
              vec2 dxz = max(max(blo.xz - Ptrace.xz, Ptrace.xz - bhi.xz), 0.0);
              float dh = length(dxz);
              if ((aoNeed & bit) != 0u && dh < 2.5) {
                vec3 dv = max(max(blo - Ptrace, Ptrace - bhi), 0.0);
                vec3 ext = bhi - blo;
                float area = max(ext.x * ext.y, max(ext.y * ext.z, ext.x * ext.z));
                if (area / max(dot(dv, dv), 1e-3) > 0.01) boxF += gBoxFF(Ptrace, Nw, blo, bhi) * (1.0 - T);
              }
              if (Ptrace.y >= bhi.y) continue;
              float fade = 1.0 - smoothstep(4.5, 6.0, dh);
              if (fade <= 0.0) continue;
              for (int k = 0; k < FURN_LIGHTS; k++){
                if (k >= nF) break;
                if ((fneed[k] & bit) == 0u) continue;
                vec3 Lk = fpos[k];
                if (dot(Nw, Lk - Ptrace) <= 0.0) continue;
                fvis[k] *= 1.0 - uFurnK * (1.0 - T) * fade * gBoxCover(Ptrace, Lk, H, blo, bhi);
              }
            }
          }
          boxAO = max(1.0 - uBoxAOK * boxF, 0.15);
        }
      }
    #endif

    // --- Unified light loop ------------------------------------------------------
    int listCount = gridPixel ? nLights : 0;
    int traced = 0;
    int traceCand = 0;
    float torchVis = 1.0;
    float vplVis = 1.0;
    int nLoop = nLights + 2;
    bool flashOn = uFlashOn > 0.5;
    vec3 flashPosW = (uCamToWorld * vec4(uFlashPosV, 1.0)).xyz;
    float furnDbg = 1.0;
    for (int k = 0; k < LOOP_MAX; k++){
      if (k >= nLoop) break;
      int kind = k < nLights ? 0 : k - nLights + 1;
      vec3 Lp = vec3(0.0);
      vec3 rad = vec3(0.0);
      float vis = 1.0;
      bool doTrace = false;
      // Up to two traced segments (a cross-floor path crosses the slab
      // through a hole: the full ray's parameter window [0, tExit] on this
      // storey, [tEnter, 1] on the lamp's) and the hole's openness.
      int nSeg = 1;
      float tExit = 1.0;
      float tEnter = 0.0;
      int segCy1 = gcy;
      float holeOpen = 1.0;
      vec2 Hk = H;
      float minW = 0.05;
      int maxIter = 11;
      int subRays = uTraceSubRays;
      float lightR = 0.0;
      bool caps = false;
      int groups = uCapGroups;
      float contact = 1.0;
      if (kind == 0) {
        if (gridPixel) {
          GridLight gl;
          if (!gridEntry(L, k, gx, gz, gcy, gl)) continue;
          Lp = gl.pos;
          rad = gl.tint * gl.flicker;
          vis = gl.vis;
          // The tier's trace budget counts the partial entries that could be
          // traced, in list order, not list positions (full-visibility lamps
          // fill the first slots). A slot is spent before any per-pixel test,
          // so which entries are traced is constant across the cell.
          bool crossOk = gl.partial && !gl.sameFloor && abs(gl.df) == 1 && uCrossFloor > 0.5;
          bool cand = (gl.partial && gl.sameFloor) || crossOk;
          bool inBudget = cand && traceCand < uMaxTraced;
          if (cand) traceCand++;
          doTrace = gl.partial && gl.sameFloor && inBudget;
          if (crossOk && inBudget) {
            // Cross-floor (P17): the emitter footprint over holed slab
            // cells, times a wall trace of the full ray on each storey.
            int lowF = min(gcy, gcy + gl.df);
            float lowBase = float(lowF) * G_LAYER_H;
            float dy = Lp.y - Ptrace.y;
            float yExit = gl.df > 0 ? lowBase + G_WALL_H - 0.01 : lowBase + G_LAYER_H + 0.01;
            float yEnter = gl.df > 0 ? lowBase + G_LAYER_H + 0.01 : lowBase + G_WALL_H - 0.01;
            tExit = (yExit - Ptrace.y) / dy;
            tEnter = (yEnter - Ptrace.y) / dy;
            if (tExit > 0.0 && tEnter < 1.0) {
              // The footprint must lie over holes where the ray leaves this
              // storey, at the slab's mid-plane and where it enters the
              // lamp's (like the CPU bake, which needs every cell the ray
              // crosses inside the slab band holed; for a convex hole the
              // two faces decide it). min, not a product: the three
              // coverages are strongly correlated.
              float sC = (lowBase + ${glslFloat(SLAB_MID)} - Ptrace.y) / dy;
              for (int pl = 0; pl < 3; pl++){
                float sp = pl == 0 ? tExit : (pl == 1 ? sC : tEnter);
                vec3 X = mix(Ptrace, Lp, sp);
                holeOpen = min(holeOpen, gHoleOpen(X.xz, max(sp * H, vec2(0.05)), lowF));
              }
              segCy1 = gcy + gl.df;
              nSeg = 2;
              doTrace = holeOpen > 0.004;
              if (!doTrace) vis = 0.0;
            }
          }
          contact = k == 0 ? contactCh.r : (k == 1 ? contactCh.g : contactCh.b);
          if (k >= uContactChannels) contact = contactCh.b;
        } else {
          Lp = (uCamToWorld * vec4(lampViewPos(k), 1.0)).xyz + vec3(0.0, uSourceY - ${glslFloat(LAMP_Y)}, 0.0);
          vec4 lc = lampChar(k);
          rad = lc.rgb * lc.a;
          contact = contactCh.b;
        }
        vec3 dl = Lp - Pw;
        lightR = PANEL_EQ_R * uPenumbraScale * sqrt(max(dl.y / max(length(dl), 1e-4), 0.15));
        caps = k < uCapsuleLights;
      } else if (kind == 1) {
        if (uVplOn < 0.5 || !flashOn) continue;
        Lp = uVplPosW;
        Hk = vec2(0.35);
        minW = 0.1;
        subRays = 1;
        lightR = 0.35;
        doTrace = uVplOccl > 0.5 && gridPixel && int(floor(Lp.y / G_LAYER_H)) == gcy;
        caps = uVplOccl > 0.5;
      } else {
        #ifdef FLASH_ANALYTIC
          if (!flashOn || !gridPixel || int(floor(flashPosW.y / G_LAYER_H)) != gcy) continue;
          Lp = flashPosW;
          Hk = vec2(uTorchSize);
          minW = 0.02;
          maxIter = 21;
          subRays = 1;
          lightR = uTorchSize;
          doTrace = true;
          caps = true;
          groups = min(uCapGroups, CAP_GROUPS - 1); // the player's body never shadows its own torch
        #else
          continue;
        #endif
      }
      if (doTrace) {
        // The ONLY gridTrace call site: fixtures (same floor, or both
        // storeys of a cross-floor path), the bounce light and the analytic
        // torch all share it.
        vis = holeOpen;
        for (int sg = 0; sg < 2; sg++){
          if (sg >= nSeg || vis <= 0.002) break;
          gTraceWin = nSeg == 1 ? vec2(0.0, 1.0) : (sg == 0 ? vec2(0.0, tExit) : vec2(tEnter, 1.0));
          vis *= gridTrace(Ptrace, Lp, sg == 0 ? gcy : segCy1, Hk, minW, maxIter, subRays, kind == 2);
        }
        gTraceWin = vec2(0.0, 1.0);
        traced++;
      }
      if (vis <= 0.002) {
        // A fully blocked bounce light or torch is dark: keep its zero (both
        // start at 1, the "no data" value of the early continues above).
        if (kind == 1) vplVis = 0.0;
        else if (kind == 2) torchVis = 0.0;
        continue;
      }
      #ifdef FURN
        if (kind == 0 && k < nF) { vis *= fvis[k]; if (k == 0) furnDbg = fvis[k]; }
      #endif
      if (caps) vis *= capsuleShadow(Pw, Lp, lightR, entity, groups);
      if (kind == 0) {
        shadeFixture(Lp, rad * (vis * contact));
      } else if (kind == 1) vplVis = vis;
      else torchVis = vis;
    }

    // Contact (legacy aggregate mask) and legacy AO on the direct term.
    vec3 lampScale = uLampColor * (uLampIntensity * uLampFlicker);
    vec3 directScale = lampScale * contactAll * mix(1.0, ao, uLampAO);

    // --- World-space AO (crease x furniture box x capsule) ---------------------
    float crease = gridPixel && uCreaseK > 0.0 ? gCreaseAO(Pw, Nw, gcy, uAORadius) : 0.0;
    float capAO = uCapGroups > 0 ? capsuleAO(Pw, Nw, entity) : 1.0;
    float worldAO = (1.0 - uCreaseK * crease) * boxAO * capAO;
    #ifdef OCC_V2
      float aoVis = min(ao, worldAO); // both see the same occluders on screen
    #else
      float aoVis = ao * boxAO * capAO * (1.0 - uCreaseK * crease);
    #endif

    // --- Flashlight: a spot from the hand, not the eye (view space) --------
    vec3 flashDiff = vec3(0.0);
    vec3 flashSpec = vec3(0.0);
    vec3 flashBounce = vec3(0.0);
    float fvisDbg = 1.0;
    if (flashOn) {
      vec3 toF = uFlashPosV - P;
      float dF = length(toF);
      vec3 Lf = toF / max(dF, 1e-4);
      float cone = smoothstep(uFlashCosOuter, uFlashCosInner, dot(-Lf, uFlashDirV));
      float fvis = 1.0;
      #ifdef FLASH_ANALYTIC
        fvis = torchVis;
      #else
        if (cone > 0.0 && uFlashShadowOn > 0.5) fvis = flashShadow(P, geomNormalV(P, N), Lf);
      #endif
      fvisDbg = fvis;
      #ifdef SHADING_PBR
        float fx = clamp(1.0 - dF / uFlashRange, 0.0, 1.0);
        float fatt = fx * fx / (dF * dF + 0.25);
        vec3 Li = uFlashColor * (uFlashIntensity * cone * fatt * fvis);
        vec3 dif, spc;
        brdfDirect(N, V, Lf, Lf, dF, 0.04, sAlbedo, sRough, sMetal, dif, spc);
        flashDiff = dif * Li;
        flashSpec = spc * Li;
        aLit += luma(Li) * max(dot(N, Lf), 0.0);
      #else
        float x = clamp(1.0 - dF / uFlashRange, 0.0, 1.0);
        float beam = x * x * cone * uFlashIntensity * fvis;
        flashDiff = sAlbedo * uFlashColor * (surfaceRamp(wrapNL(dot(N, Lf)), sDither) * beam);
        float ndl = dot(N, V);
        if (sGlossy && ndl > 0.0) flashSpec = uFlashColor * (specLobe(N, Lf, V) * beam * sGloss * uSpecStrength * 0.6);
      #endif
      // The torch lights the room, not just a disc: one virtual point light
      // at the beam's CPU-raycast hit, coloured by the surface it lands on,
      // occluded by walls and capsules on high tiers.
      if (uFlashBounce > 0.0 && uVplOn > 0.5) {
        vec3 toV = uVplPosW - Pw;
        float dv = length(toV);
        vec3 Lv = toV / max(dv, 1e-4);
        float geo = max(dot(Nw, Lv), 0.0) * max(dot(uVplN, -Lv), 0.0) / (dv * dv + 1.0);
        flashBounce = sAlbedo * (1.0 - sMetal) * uVplColor * (uFlashIntensity * uFlashBounce * geo * vplVis);
      }
    }

    float rimBase = pow(max(1.0 - max(dot(N, V), 0.0), 0.0), ${glslFloat(RIM_POW)});
    float rimGate = mix(1.0, clamp(aLit * 3.0, 0.0, 1.0), uRimLitGate);
    vec3 ambientRad = mix(uAmbGround, uAmbSky, hemi) * uHemi;

    // --- Indirect light (GI cube + hemisphere) ------------------------------------
    vec3 indirect = vec3(0.0);
    vec3 indirectSpec = vec3(0.0);
    vec3 Nb = Nw;
    #ifdef BENT
      vec3 bentV = octDecode(gOccT.gb);
      Nb = normalize(mat3(uCamToWorld) * normalize(mix(N, bentV, clamp(1.0 - gOccT.r, 0.0, 1.0) * uBentK)));
    #endif
    if (gridPixel && uGI > 0.0) {
      bool stencil = uGIStencil > 0.5;
      indirect = gridIndirect(Pl, Nb, gcy, stencil);
      #ifdef SHADING_PBR
        indirectSpec = gridIndirect(Pl, reflect(-sV, Nw), gcy, stencil);
      #endif
    }

    vec3 col;
    #ifdef SHADING_PBR
      float NoV = clamp(dot(N, V), 1e-4, 1.0);
      vec3 f0 = mix(vec3(0.04), sAlbedo, sMetal);
      float aoTot = aoVis * matAO;
      // Multi-bounce AO (Jimenez): interreflection in a coloured crease
      // brightens it back toward the albedo, so yellow corners stay yellow.
      vec3 aoMB = vec3(aoTot);
      if (uMultiBounce > 0.0) {
        vec3 ka = 2.0404 * sAlbedo - 0.3324;
        vec3 kb = -4.7951 * sAlbedo + 0.6417;
        vec3 kc = 2.7552 * sAlbedo + 0.6903;
        aoMB = mix(aoMB, max(vec3(aoTot), ((aoTot * ka + kb) * aoTot + kc) * aoTot), uMultiBounce);
      }
      // Lagarde specular occlusion: glossy reflection under a desk dims with
      // the ambient occlusion, weighted by how grazing the view is. It is
      // derived from aoTot and REPLACES it on both indirect specular terms
      // (a further aoTot factor would apply AO twice); with the look's
      // specular occlusion off, specular falls back to the plain AO.
      float alpha = max(sRough, MIN_ROUGHNESS) * max(sRough, MIN_ROUGHNESS);
      float so = clamp(pow(NoV + aoTot, exp2(-16.0 * alpha - 1.0)) - 1.0 + aoTot, 0.0, 1.0);
      so = mix(aoTot, so, uSpecOcc);
      float lift = mix(1.0, 1.0 + uCeilingLift, clamp(-Nw.y, 0.0, 1.0));
      vec3 giDiff = indirect * lampScale * (uGI * lift / PI) * aoMB;
      vec3 envK = envBRDFApprox(f0, sRough, NoV);
      vec3 giSpec = indirectSpec * lampScale * (uGI / PI) * envK * so;
      // The dusk hemisphere is also something to reflect: metals and glossy
      // dielectrics pick up the family's ambient instead of going black in
      // an unlit room.
      vec3 Rv = reflect(-V, N);
      giSpec += mix(uAmbGround, uAmbSky, 0.5 + 0.5 * dot(Rv, uUpView)) * (uHemi * so) * envK;
      vec3 ambient = ambientRad * aoMB;
      vec3 lit = aDiff * directScale + aSpec * directScale * uSpecK
        + sAlbedo * (1.0 - sMetal) * (ambient + giDiff) + giSpec * uSpecK
        + flashDiff + flashSpec * uSpecK + flashBounce * aoMB;
      if (entity) {
        // Smooth silhouette light (the Classic look bands it): enough to keep
        // a figure readable down a dark corridor, never a cel step.
        float entityRim = smoothstep(0.3, 0.95, rimBase);
        col = lit + sAlbedo * ${glslFloat(ENTITY_FILL)} * uEntityFill * aoVis
          + uEntityRim * (entityRim * 0.95 * uEntityRimK);
      } else {
        col = lit + uRimColor * (rimBase * uRim * ${glslFloat(RIM_MIX)} * rimGate);
      }
    #else
      vec3 ambient = ambientRad * (aoVis * matAO);
      vec3 lamps = aDiff * directScale;
      vec3 term = aTerm * directScale * uTermColor * uTermStrength;
      float fres = mix(0.4, 1.0, pow(1.0 - max(dot(N, V), 0.0), 3.0));
      vec3 spec = aSpec * directScale * (sGloss * uSpecStrength * fres * uSpecK) + flashSpec;
      vec3 bounce = aOmni * lampScale * uBounceColor * (uBounce * aoVis);
      vec3 giDiff = indirect * lampScale * (uGI * aoVis * matAO);
      if (entity) {
        float entityRim = max(band(rimBase + sDither) - ${glslFloat(CEL_FLOOR * 0.75)}, 0.0);
        col = sAlbedo * (ambient + lamps + ${glslFloat(ENTITY_FILL)} * uEntityFill) + flashDiff + spec
          + uEntityRim * (entityRim * 0.95 * uEntityRimK);
      } else {
        col = sAlbedo * (ambient + lamps + bounce + term + giDiff) + flashDiff + flashBounce + spec
            + uRimColor * (rimBase * uRim * ${glslFloat(RIM_MIX)} * rimGate);
      }
    #endif
    if (uLightDebug > 0) {
      vec3 heat3 = vec3(0.0);
      if (uLightDebug == 1) {
        float t = float(listCount) / float(G_LIST_MAX);
        heat3 = listCount == 0 ? vec3(0.05) : mix(vec3(0.1, 0.2, 1.0), vec3(1.0, 0.25, 0.05), t);
      } else if (uLightDebug == 2) {
        heat3 = mix(sAlbedo * 0.35, gridPixel ? vec3(0.1, 0.9, 0.2) : vec3(0.9, 0.15, 0.1), 0.55);
      } else if (uLightDebug == 3) {
        #ifdef SHADING_PBR
          heat3 = (aDiff + aSpec) * directScale;
        #else
          heat3 = aDiff * directScale * sAlbedo;
        #endif
      } else if (uLightDebug == 4) {
        #ifdef SHADING_PBR
          heat3 = sAlbedo * (1.0 - sMetal) * (ambientRad + indirect * lampScale * (uGI / PI)) * aoVis * matAO;
        #else
          heat3 = sAlbedo * (ambientRad + indirect * lampScale * uGI) * aoVis * matAO;
        #endif
      } else if (uLightDebug == 5) {
        heat3 = vec3(float(traced) / 4.0, float(listCount - traced) / 8.0, 0.1);
      } else if (uLightDebug == 6) {
        heat3 = furnTrunc ? vec3(1.0, 0.1, 0.1) : vec3(furnDbg);
      } else if (uLightDebug == 7) {
        heat3 = vec3(worldAO);
      } else {
        heat3 = vec3(fvisDbg);
      }
      outColor = vec4(heat3, 1.0);
      return;
    }
    col = mix(col, fogCol, fog);
    outColor = vec4(col, 1.0);
  }
`
}

// Default (Classic) build, kept as a named export for tooling/tests.
export const LIGHTING_FRAG = lightingFrag()
