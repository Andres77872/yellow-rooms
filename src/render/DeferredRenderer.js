import * as THREE from 'three'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import { makeToonGradient } from './gradientRamp.js'
import { makeLampUniforms } from './LightField.js'
import {
  NEAR,
  FAR,
  FOG_COLOR,
  FOG_DENSITY,
  PANEL_COLOR,
  LIGHT_MAX,
  LIGHT_RANGE,
  LIGHT_INTENSITY,
  AMBIENT_SKY,
  AMBIENT_GROUND,
  LAMP_WRAP,
  RIM_STRENGTH,
  FLASH_RANGE,
  FLASH_INTENSITY,
  FLASH_COS_INNER,
  FLASH_COS_OUTER,
  SHADOW_STEPS,
  SHADOW_MAX,
  SHADOW_THICKNESS,
  SHADOW_STRENGTH,
  AO_SCALE,
  AO_SAMPLES,
  AO_RADIUS,
  AO_BIAS,
  AO_INTENSITY,
  VOL_SCALE,
  VOL_STEPS,
  VOL_LIGHT_MAX,
  VOL_MAXDIST,
  VOL_DENSITY,
  VOL_PHASE_G,
  VOL_INTENSITY,
  BLOOM_SCALE,
  BLOOM_SPREAD,
  BLOOM_INTENSITY,
  GRADE_LEVELS,
} from '../world/constants.js'

// Deferred toon renderer. Stage A: render the scene into a G-buffer (MRT:
// albedo+matID, viewNormal) + depth, then a fullscreen lighting pass produces a
// linear HDR buffer, and an output pass converts to sRGB on screen. Later stages
// add the many-lamp lighting, shadows, AO, volumetrics, bloom, outline & grade.

const FS_VERT = /* glsl */ `
  precision highp float;
  in vec3 position;
  in vec2 uv;
  out vec2 vUv;
  void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

const COLOR_FNS = /* glsl */ `
  vec3 linearToSRGB(vec3 c){
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }
`

// Interleaved Gradient Noise (Jimenez). Pure-float, no sin/transcendentals and
// only tiny arguments, so it returns IDENTICAL well-distributed [0,1) noise on
// every WebGL2 backend — unlike the canonical fract(sin(dot(...))) hash, whose
// sin() of a large argument is implementation-defined and degenerates into
// correlated diagonal streaks on some drivers (notably ANGLE/NVIDIA-GL, i.e.
// Chromium/Brave on Linux). Feed it INTEGER pixel coords (gl_FragCoord.xy); fed
// 0..1 UVs the pattern collapses to ~constant.
const IGN = /* glsl */ `
  float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`

// --- Deferred lighting: hemispheric ambient + MANY cel-banded lamps +
//     analytic flashlight cone + rim, all in view space. ---
const LIGHTING_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  #define LIGHT_MAX ${LIGHT_MAX}
  in vec2 vUv;
  out vec4 outColor;
  #define SHADOW_STEPS ${SHADOW_STEPS}
  #define SHADOW_MAX ${SHADOW_MAX}
  uniform sampler2D tColor;
  uniform sampler2D tNormal;
  uniform sampler2D tDepth;
  uniform sampler2D tRamp;
  uniform sampler2D tAO;
  uniform mat4 uProj;            // view -> clip (for screen-space shadow march)
  uniform mat4 uProjInverse;
  uniform mat4 uView;            // world -> view (for lamp positions)
  uniform float uShadowThickness;
  uniform float uShadowStrength;
  uniform vec3 uUpView;          // world up, in view space
  uniform vec3 uLampPos[LIGHT_MAX];
  uniform int uLampCount;
  uniform vec3 uLampColor;
  uniform float uLampIntensity;
  uniform float uLampRange;
  uniform vec3 uAmbSky;
  uniform vec3 uAmbGround;
  uniform float uLampWrap;       // half-Lambert wrap for lamp + flash N·L
  uniform float uRim;
  uniform float uFlashOn;
  uniform vec3 uFlashColor;
  uniform float uFlashRange;
  uniform float uFlashIntensity;
  uniform float uFlashCosInner;
  uniform float uFlashCosOuter;
  uniform vec3 uFogColor;
  uniform float uFogDensity;

  float band(float x){ return texture(tRamp, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }
  // Half-Lambert wrap: lifts grazing / under-facing surfaces toward the lit band
  // so ceilings & wall undersides read consistently with lit floors. Pure Lambert
  // when uLampWrap == 0.
  float wrapNL(float ndl){ return clamp((ndl + uLampWrap) / (1.0 + uLampWrap), 0.0, 1.0); }
  ${IGN}

  float viewZAt(vec2 uv){
    float d = texture(tDepth, uv).x;
    vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 vp = uProjInverse * ndc;
    return vp.z / vp.w;
  }

  // Screen-space shadow: march the depth buffer from P toward a lamp; if an
  // on-screen surface lies between them, the fragment is occluded. Screen-space
  // limitation: occluders off-screen or behind the camera can't cast (inherent to
  // a depth march — same caveat as the volumetric pass). The per-pixel jittered
  // start + contact-hardening grade below turn the march into a soft penumbra
  // rather than a hard, noisy binary edge.
  float lampShadow(vec3 P, vec3 Lv, float jitter){
    float maxd = distance(P, Lv);
    vec3 dir = (Lv - P) / max(maxd, 1e-4);
    float step = maxd / float(SHADOW_STEPS);
    float t = step * (0.5 + jitter);
    for (int i = 0; i < SHADOW_STEPS; i++){
      vec3 S = P + dir * t;
      vec4 clip = uProj * vec4(S, 1.0);
      if (clip.w > 0.0){
        vec2 uv = (clip.xy / clip.w) * 0.5 + 0.5;
        if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0){
          float dz = viewZAt(uv) - S.z; // >0: scene surface closer than the ray sample
          if (dz > 0.04 && dz < uShadowThickness){
            // Contact hardening: an occluder hugging the receiver throws a sharp,
            // dark shadow; a distant occluder fades to a soft penumbra. With the
            // jittered start this reads as a gradient across neighbouring pixels.
            return clamp(t / maxd, 0.0, 1.0) * 0.85;
          }
        }
      }
      t += step;
    }
    return 1.0;
  }

  void main(){
    float depth = texture(tDepth, vUv).x;
    if (depth >= 1.0) { outColor = vec4(uFogColor, 1.0); return; }

    vec4 c = texture(tColor, vUv);
    vec4 ndc = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 vp = uProjInverse * ndc; vp /= vp.w;
    vec3 P = vp.xyz;               // view-space position
    float dist = length(P);
    float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);

    // Emissive surfaces (lamps, exit) bypass lighting.
    if (c.a > 0.5 && c.a < 1.5) {
      outColor = vec4(mix(c.rgb, uFogColor, fog), 1.0);
      return;
    }

    vec3 N = normalize(texture(tNormal, vUv).xyz * 2.0 - 1.0);
    vec3 albedo = c.rgb;
    float jitter = ign(gl_FragCoord.xy);

    // Ambient occlusion (contact darkening) — mostly on the ambient/indirect term.
    float ao = texture(tAO, vUv).r;

    // Warm hemispheric ambient fills shadows (keeps lamp-less zones dark-warm).
    float hemi = 0.5 + 0.5 * dot(N, uUpView);
    vec3 ambient = mix(uAmbGround, uAmbSky, hemi) * ao;

    // Many lamps, cel-banded by N·L, attenuated to 0 at range. The N nearest
    // lamps (LightField sorts nearest-first) also cast screen-space shadows.
    vec3 lamps = vec3(0.0);
    int shadowed = 0;
    for (int i = 0; i < LIGHT_MAX; i++) {
      if (i >= uLampCount) break;
      vec3 Lv = (uView * vec4(uLampPos[i], 1.0)).xyz;
      vec3 toL = Lv - P;
      float d = length(toL);
      if (d > uLampRange) continue;
      float ndl = wrapNL(dot(N, toL / max(d, 1e-4)));
      float x = clamp(1.0 - d / uLampRange, 0.0, 1.0);
      float contrib = band(ndl) * (x * x);
      // Only cast (and pay for) a shadow march on meaningfully-lit fragments;
      // skip the faint wrap/ramp-floor fill on near-back faces (contrib ~0.06).
      if (contrib > 0.08 && shadowed < SHADOW_MAX) {
        contrib *= mix(1.0, lampShadow(P, Lv, jitter), uShadowStrength);
        shadowed++;
      }
      lamps += contrib;
    }
    lamps *= uLampColor * uLampIntensity * mix(1.0, ao, 0.5);

    // Flashlight: cone from the camera (view origin, axis -z).
    vec3 flash = vec3(0.0);
    if (uFlashOn > 0.5) {
      float d = dist;
      vec3 Ld = -P / max(d, 1e-4);
      float cosA = -P.z / max(d, 1e-4);
      float cone = smoothstep(uFlashCosOuter, uFlashCosInner, cosA);
      float ndl = wrapNL(dot(N, Ld));
      float x = clamp(1.0 - d / uFlashRange, 0.0, 1.0);
      flash = uFlashColor * (band(ndl) * x * x * cone * uFlashIntensity);
    }

    // pow() of a negative base is undefined in GLSL; dot() of renormalized
    // vectors can exceed 1 by an fp epsilon, so clamp the base to >= 0.
    float rim = pow(max(1.0 - max(dot(N, -P / max(dist, 1e-4)), 0.0), 0.0), 3.0) * uRim;

    vec3 col = albedo * (ambient + lamps + flash) + uLampColor * rim * 0.5;
    col = mix(col, uFogColor, fog);
    outColor = vec4(col, 1.0);
  }
`

// Composite lit + volumetrics + bloom into a single linear buffer.
const COMPOSITE_FRAG = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tInput;
  uniform sampler2D tVol;
  uniform sampler2D tBloom;
  uniform float uVolIntensity;
  uniform float uBloomIntensity;
  void main(){
    outColor = vec4(
      texture(tInput, vUv).rgb
        + texture(tVol, vUv).rgb * uVolIntensity
        + texture(tBloom, vUv).rgb * uBloomIntensity,
      1.0);
  }
`

// Ink outline: depth + normal Sobel straight off the G-buffer, distance-faded.
const OUTLINE_FRAG = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tDiffuse;
  uniform sampler2D tNormal;
  uniform sampler2D tDepth;
  uniform vec2 uTexel;
  uniform float uThickness, uDepthThresh, uNormalThresh, uFadeNear, uFadeFar;
  uniform vec3 uInk;
  float lin(float d){
    float z = d * 2.0 - 1.0;
    float vz = (2.0 * ${NEAR.toFixed(3)} * ${FAR.toFixed(1)}) /
               (${FAR.toFixed(1)} + ${NEAR.toFixed(3)} - z * (${FAR.toFixed(1)} - ${NEAR.toFixed(3)}));
    return (vz - ${NEAR.toFixed(3)}) / (${FAR.toFixed(1)} - ${NEAR.toFixed(3)});
  }
  vec3 nrm(vec2 uv){ return normalize(texture(tNormal, uv).xyz * 2.0 - 1.0); }
  void main(){
    vec3 base = texture(tDiffuse, vUv).rgb;
    vec2 t = uTexel * uThickness;
    float dc = lin(texture(tDepth, vUv).x);
    float dd = abs(dc - lin(texture(tDepth, vUv + vec2(t.x, 0.0)).x))
             + abs(dc - lin(texture(tDepth, vUv - vec2(t.x, 0.0)).x))
             + abs(dc - lin(texture(tDepth, vUv + vec2(0.0, t.y)).x))
             + abs(dc - lin(texture(tDepth, vUv - vec2(0.0, t.y)).x));
    vec3 nc = nrm(vUv);
    float nd = (1.0 - dot(nc, nrm(vUv + vec2(t.x, 0.0))))
             + (1.0 - dot(nc, nrm(vUv - vec2(t.x, 0.0))))
             + (1.0 - dot(nc, nrm(vUv + vec2(0.0, t.y))))
             + (1.0 - dot(nc, nrm(vUv - vec2(0.0, t.y))));
    float distFade = 1.0 - smoothstep(uFadeNear, uFadeFar, dc);
    float edge = clamp(step(uDepthThresh, dd) + step(uNormalThresh, nd), 0.0, 1.0) * distFade;
    outColor = vec4(mix(base, uInk, edge), 1.0);
  }
`

// Grade: chromatic aberration + warm tint + luminance posterize + vignette +
// grain + dead-static, then linear -> sRGB. Sanity FX drive the uniforms.
const GRADE_FRAG = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tDiffuse;
  uniform float time, levels, vignette, grain, aberration, dead;
  uniform vec3 tint;
  ${COLOR_FNS}
  ${IGN}
  float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  void main(){
    vec2 uv = vUv;
    vec2 d = uv - 0.5;
    float ca = aberration * (0.4 + dot(d, d) * 2.5);
    vec3 col;
    col.r = texture(tDiffuse, uv + d * ca).r;
    col.g = texture(tDiffuse, uv).g;
    col.b = texture(tDiffuse, uv - d * ca).b;
    col *= tint;
    float v = max(max(col.r, col.g), col.b);
    if (v > 1e-4) {
      float vg = pow(v, 0.4545);
      // Dither BEFORE quantizing: +/-0.5 step of driver-stable noise perturbs
      // only pixels within half a band of a boundary (flat cel fields, being
      // mid-band, stay flat), so the few-level posterize reads as a smooth
      // gradient instead of hard bands — identically on every GL backend.
      // clamp() pins the dithered index to [0, levels]; without the lower clamp
      // near-black pixels go negative and pow(negative, 2.2) -> NaN (black specks).
      float vd = (ign(gl_FragCoord.xy) - 0.5) / levels;
      float vq = pow(clamp(floor((vg + vd) * levels), 0.0, levels) / levels, 2.2);
      col *= vq / v;
    }
    float vig = smoothstep(1.0, 0.25, length(d));
    col *= mix(1.0, vig, vignette);
    col += (hash(uv * vec2(1280.0, 720.0) + time) - 0.5) * grain;
    float st = hash(uv * vec2(640.0, 480.0) + time * 57.0);
    col = mix(col, vec3(st), dead);
    outColor = vec4(linearToSRGB(col), 1.0);
  }
`

// Compact FXAA (Timothy Lottes, public domain) on the final LDR image.
const FXAA_FRAG = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;
  void main(){
    vec3 luma = vec3(0.299, 0.587, 0.114);
    vec3 rgbNW = texture(tDiffuse, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
    vec3 rgbNE = texture(tDiffuse, vUv + vec2(1.0, -1.0) * uTexel).rgb;
    vec3 rgbSW = texture(tDiffuse, vUv + vec2(-1.0, 1.0) * uTexel).rgb;
    vec3 rgbSE = texture(tDiffuse, vUv + vec2(1.0, 1.0) * uTexel).rgb;
    vec3 rgbM = texture(tDiffuse, vUv).rgb;
    float lNW = dot(rgbNW, luma), lNE = dot(rgbNE, luma);
    float lSW = dot(rgbSW, luma), lSE = dot(rgbSE, luma), lM = dot(rgbM, luma);
    float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
    float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
    vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
    float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
    float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
    dir = clamp(dir * rcp, -8.0, 8.0) * uTexel;
    vec3 rA = 0.5 * (texture(tDiffuse, vUv + dir * (1.0 / 3.0 - 0.5)).rgb
                   + texture(tDiffuse, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
    vec3 rB = rA * 0.5 + 0.25 * (texture(tDiffuse, vUv + dir * -0.5).rgb
                               + texture(tDiffuse, vUv + dir * 0.5).rgb);
    float lB = dot(rB, luma);
    outColor = vec4((lB < lMin || lB > lMax) ? rA : rB, 1.0);
  }
`

// --- Emissive bloom: selective by matID (only lamps/exit), blurred ---------
const BLOOM_PREFILTER_FRAG = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tLit;
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  void main(){
    // The G-buffer clears with alpha=1 (matID 1 == emissive), so uncovered void
    // pixels would wrongly bloom the fog color. Gate on depth so only real
    // emissive geometry (lamps/exit) contributes.
    float depth = texture(tDepth, vUv).x;
    float matID = texture(tColor, vUv).a;
    vec3 c = texture(tLit, vUv).rgb;
    bool emissive = depth < 1.0 && matID > 0.5 && matID < 1.5;
    outColor = vec4(emissive ? c : vec3(0.0), 1.0);
  }
`
const BLOOM_BLUR_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tInput;
  uniform vec2 uDir;
  void main(){
    float w[5] = float[](0.227027, 0.194594, 0.121622, 0.054054, 0.016216);
    vec3 s = texture(tInput, vUv).rgb * w[0];
    for (int i = 1; i < 5; i++){
      s += texture(tInput, vUv + uDir * float(i)).rgb * w[i];
      s += texture(tInput, vUv - uDir * float(i)).rgb * w[i];
    }
    outColor = vec4(s, 1.0);
  }
`

// --- Volumetric light shafts (half-res in-scatter raymarch) ----------------
// Marches the camera ray and, at each step, gathers in-scatter from the nearest
// VOL_LIGHT_MAX lamps + the flashlight cone. Each sample is gated by a SHORT
// screen-space depth march toward the light (visToLight) so shafts stop at walls
// and only beam through real openings — instead of glowing through solid geometry.
// A Henyey-Greenstein phase biases scatter forward, so a lamp roughly ahead reads
// as a directional god-ray. Like the shadow pass this is screen-space: occluders
// off-screen or behind the camera can't block (acceptable for the look).
const VOL_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  #define VOL_STEPS ${VOL_STEPS}
  #define LIGHT_MAX ${LIGHT_MAX}
  #define VOL_LIGHT_MAX ${VOL_LIGHT_MAX}
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tDepth;
  uniform mat4 uProj;            // view -> clip (project march samples for occlusion)
  uniform mat4 uProjInverse;
  uniform mat4 uView;            // world -> view (lamp positions)
  uniform vec3 uLampPos[LIGHT_MAX];
  uniform int uLampCount;
  uniform vec3 uLampColor;
  uniform float uLampRange;
  uniform float uDensity;
  uniform float uMaxDist;
  uniform float uPhaseG;         // Henyey-Greenstein anisotropy (forward beams)
  uniform float uFlashOn;
  uniform vec3 uFlashColor;
  uniform float uFlashRange;
  uniform float uFlashIntensity;
  uniform float uFlashCosInner;
  uniform float uFlashCosOuter;

  float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }

  float viewZAt(vec2 uv){
    float dd = texture(tDepth, uv).x;
    vec4 vp = uProjInverse * vec4(uv * 2.0 - 1.0, dd * 2.0 - 1.0, 1.0);
    return vp.z / vp.w;
  }

  // Henyey-Greenstein phase, normalised so the spherical average is ~1 (keeps the
  // overall brightness stable while concentrating scatter toward the light).
  float phaseHG(float cosT){
    float g2 = uPhaseG * uPhaseG;
    float denom = 1.0 + g2 - 2.0 * uPhaseG * cosT;
    return (1.0 - g2) / pow(max(denom, 1e-4), 1.5);
  }

  // Screen-space visibility of view-space sample S toward light Lv: a couple of
  // depth taps along the ray; if an on-screen surface lies between them, occluded.
  float visToLight(vec3 S, vec3 Lv){
    vec3 toL = Lv - S;
    float len = length(toL);
    vec3 dir = toL / max(len, 1e-4);
    for (int k = 1; k <= 2; k++){
      vec3 Q = S + dir * (len * (float(k) / 3.0));
      vec4 clip = uProj * vec4(Q, 1.0);
      if (clip.w <= 0.0) continue;
      vec2 uv = (clip.xy / clip.w) * 0.5 + 0.5;
      if (uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) continue;
      float dz = viewZAt(uv) - Q.z;       // >0: scene surface nearer than the ray sample
      if (dz > 0.05 && dz < 4.0) return 0.0;
    }
    return 1.0;
  }

  void main(){
    float d = texture(tDepth, vUv).x;
    float zc = (d >= 1.0) ? 1.0 : d * 2.0 - 1.0;
    vec4 v = uProjInverse * vec4(vUv * 2.0 - 1.0, zc, 1.0); v /= v.w;
    vec3 P = v.xyz;
    float plen = length(P);
    float maxT = min(plen, uMaxDist);
    vec3 dir = P / max(plen, 1e-4);
    float step = maxT / float(VOL_STEPS);
    float jitter = hash(gl_FragCoord.xy);

    vec3 acc = vec3(0.0);
    for (int j = 0; j < LIGHT_MAX; j++){
      if (j >= uLampCount || j >= VOL_LIGHT_MAX) break;
      vec3 Lv = (uView * vec4(uLampPos[j], 1.0)).xyz;
      float t = step * jitter;
      for (int i = 0; i < VOL_STEPS; i++){
        vec3 S = dir * t;
        float dl = distance(S, Lv);
        if (dl < uLampRange){
          float a = 1.0 - dl / uLampRange;
          float phase = phaseHG(dot(dir, (Lv - S) / max(dl, 1e-4)));
          acc += a * a * phase * visToLight(S, Lv);
        }
        t += step;
      }
    }
    acc *= uLampColor;

    // Flashlight in-scatter: a dusty cone from the camera (view origin, axis -z).
    if (uFlashOn > 0.5){
      float fl = 0.0;
      float t = step * jitter;
      for (int i = 0; i < VOL_STEPS; i++){
        vec3 S = dir * t;
        float ds = length(S);
        float cosA = -S.z / max(ds, 1e-4);
        float cone = smoothstep(uFlashCosOuter, uFlashCosInner, cosA);
        if (cone > 0.0){
          float a = clamp(1.0 - ds / uFlashRange, 0.0, 1.0);
          fl += a * a * cone;
        }
        t += step;
      }
      acc += uFlashColor * (fl * uFlashIntensity);
    }

    acc *= uDensity * step;
    outColor = vec4(acc, 1.0);
  }
`

// --- SSAO (half-res) -------------------------------------------------------
const AO_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  #define AO_SAMPLES ${AO_SAMPLES}
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tNormal;
  uniform sampler2D tDepth;
  uniform mat4 uProj;
  uniform mat4 uProjInverse;
  uniform vec2 uResolution;       // full-res, for noise rotation
  uniform vec3 uKernel[AO_SAMPLES];
  uniform float uRadius;
  uniform float uBias;
  uniform float uIntensity;

  vec3 viewPos(vec2 uv){
    float d = texture(tDepth, uv).x;
    vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 v = uProjInverse * ndc; return v.xyz / v.w;
  }
  float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }

  void main(){
    float d = texture(tDepth, vUv).x;
    if (d >= 1.0) { outColor = vec4(1.0); return; }
    vec3 P = viewPos(vUv);
    vec3 N = normalize(texture(tNormal, vUv).xyz * 2.0 - 1.0);

    float ang = hash(vUv * uResolution) * 6.2831853;
    vec3 randv = vec3(cos(ang), sin(ang), 0.0);
    // Gram-Schmidt; guard against randv (near-)parallel to N -> normalize(~0) = NaN.
    vec3 rd = randv - N * dot(randv, N);
    if (dot(rd, rd) < 1e-6) rd = abs(N.y) < 0.99 ? cross(N, vec3(0.0, 1.0, 0.0)) : cross(N, vec3(1.0, 0.0, 0.0));
    vec3 T = normalize(rd);
    vec3 B = cross(N, T);
    mat3 TBN = mat3(T, B, N);

    float occ = 0.0;
    for (int i = 0; i < AO_SAMPLES; i++){
      vec3 sp = P + (TBN * uKernel[i]) * uRadius;
      vec4 clip = uProj * vec4(sp, 1.0);
      vec2 uv = (clip.xy / clip.w) * 0.5 + 0.5;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) continue;
      float sceneZ = viewPos(uv).z;
      float rangeCheck = smoothstep(0.0, 1.0, uRadius / max(abs(P.z - sceneZ), 1e-4));
      occ += (sceneZ >= sp.z + uBias ? 1.0 : 0.0) * rangeCheck;
    }
    float ao = 1.0 - (occ / float(AO_SAMPLES)) * uIntensity;
    outColor = vec4(clamp(ao, 0.0, 1.0), 0.0, 0.0, 1.0);
  }
`

const AO_BLUR_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tAO;
  uniform vec2 uTexel;
  void main(){
    float s = 0.0;
    for (int y = -2; y <= 2; y++)
      for (int x = -2; x <= 2; x++)
        s += texture(tAO, vUv + vec2(float(x), float(y)) * uTexel).r;
    outColor = vec4(s / 25.0, 0.0, 0.0, 1.0);
  }
`

const linVec = (hex) => new THREE.Color(hex).convertSRGBToLinear()

function aoKernel(n) {
  const k = []
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random())
    v.normalize()
    let s = i / n
    s = 0.1 + 0.9 * s * s // cluster samples near the origin
    v.multiplyScalar(s)
    k.push(v)
  }
  return k
}

function fsMaterial(fragmentShader, uniforms) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms,
    vertexShader: FS_VERT,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
  })
}

// --- Debug channel viewer: blit one intermediate buffer straight to screen. ---
// uMode: 1 albedo · 2 matID · 3 view-normal · 4 linear depth · 5 AO · 6 lit ·
//        7 volumetrics · 8 bloom · 9 composite. (0 disables; the renderer skips it.)
const DEBUG_VIEW_FRAG = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform int uMode;
  uniform sampler2D tColor, tNormal, tDepth, tAO, tLit, tVol, tBloom, tScene;
  uniform mat4 uProjInverse;
  uniform float uDepthScale; // 1.0 / camera.far
  ${COLOR_FNS}
  void main(){
    vec3 o;
    if (uMode == 1)      o = texture(tColor, vUv).rgb;            // albedo (linear)
    else if (uMode == 2) o = vec3(texture(tColor, vUv).a * 0.5); // matID {0,1,2}->{0,.5,1}
    else if (uMode == 3) o = texture(tNormal, vUv).rgb;          // encoded view normal
    else if (uMode == 4) {                                       // linearized depth
      float d = texture(tDepth, vUv).x;
      if (d >= 1.0) { o = vec3(1.0); }
      else {
        vec4 v = uProjInverse * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
        v /= v.w;
        o = vec3(clamp(-v.z * uDepthScale, 0.0, 1.0));
      }
    }
    else if (uMode == 5) o = vec3(texture(tAO, vUv).r);          // AO
    else if (uMode == 6) o = texture(tLit, vUv).rgb;             // lit HDR
    else if (uMode == 7) o = texture(tVol, vUv).rgb;             // volumetrics
    else if (uMode == 8) o = texture(tBloom, vUv).rgb;           // bloom
    else                 o = texture(tScene, vUv).rgb;           // composite (9)
    // Linear HDR channels need the sRGB encode; the rest are already display-ready.
    if (uMode == 1 || uMode >= 6) o = linearToSRGB(o);
    outColor = vec4(o, 1.0);
  }
`

export class DeferredRenderer {
  constructor(renderer, scene, camera) {
    this.renderer = renderer
    this.scene = scene
    this.camera = camera
    renderer.setClearColor(0x000000, 1)

    const { dw, dh } = this._dims()

    // G-buffer: 2 color targets (albedo+matID, viewNormal) + depth texture.
    const depthTexture = new THREE.DepthTexture(dw, dh)
    depthTexture.type = THREE.UnsignedIntType
    this.gBuffer = new THREE.WebGLRenderTarget(dw, dh, {
      count: 2,
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthTexture,
    })
    this.gColor = this.gBuffer.textures[0]
    this.gNormal = this.gBuffer.textures[1]
    this.depthTex = depthTexture

    // Linear HDR lit buffer.
    this.litRT = new THREE.WebGLRenderTarget(dw, dh, { type: THREE.HalfFloatType })

    // SSAO (half-res) + blur.
    const aw = Math.max(1, Math.floor(dw * AO_SCALE))
    const ah = Math.max(1, Math.floor(dh * AO_SCALE))
    const aoOpts = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }
    this.aoRT = new THREE.WebGLRenderTarget(aw, ah, aoOpts)
    this.aoBlurRT = new THREE.WebGLRenderTarget(aw, ah, aoOpts)
    this.aoUniforms = {
      tNormal: { value: this.gNormal },
      tDepth: { value: this.depthTex },
      uProj: { value: new THREE.Matrix4() },
      uProjInverse: { value: new THREE.Matrix4() },
      uResolution: { value: new THREE.Vector2(dw, dh) },
      uKernel: { value: aoKernel(AO_SAMPLES) },
      uRadius: { value: AO_RADIUS },
      uBias: { value: AO_BIAS },
      uIntensity: { value: AO_INTENSITY },
    }
    this.aoQuad = new FullScreenQuad(fsMaterial(AO_FRAG, this.aoUniforms))
    this.aoBlurUniforms = {
      tAO: { value: this.aoRT.texture },
      uTexel: { value: new THREE.Vector2(1 / aw, 1 / ah) },
    }
    this.aoBlurQuad = new FullScreenQuad(fsMaterial(AO_BLUR_FRAG, this.aoBlurUniforms))

    // Cel ramp for per-lamp N·L banding. 6 bands + a tiny warm floor so grazing
    // walls keep a dim step instead of snapping to black (the wrap above already
    // lifts under-facing surfaces); ambient still fills the truly unlit zones.
    this.ramp = makeToonGradient(6, 0.06)

    // Lamp field uniforms (positions array + count), driven by LightField.
    this.lamps = makeLampUniforms()

    // Lighting pass.
    this.lightUniforms = {
      tColor: { value: this.gColor },
      tNormal: { value: this.gNormal },
      tDepth: { value: this.depthTex },
      tRamp: { value: this.ramp },
      tAO: { value: this.aoBlurRT.texture },
      uProj: { value: new THREE.Matrix4() },
      uProjInverse: { value: new THREE.Matrix4() },
      uView: { value: new THREE.Matrix4() },
      uShadowThickness: { value: SHADOW_THICKNESS },
      uShadowStrength: { value: SHADOW_STRENGTH },
      uUpView: { value: new THREE.Vector3(0, 1, 0) },
      uLampPos: this.lamps.uLampPos,
      uLampCount: this.lamps.uLampCount,
      uLampColor: { value: linVec(PANEL_COLOR) },
      uLampIntensity: { value: LIGHT_INTENSITY },
      uLampRange: { value: LIGHT_RANGE },
      uAmbSky: { value: linVec(AMBIENT_SKY) },
      uAmbGround: { value: linVec(AMBIENT_GROUND) },
      uLampWrap: { value: LAMP_WRAP },
      uRim: { value: RIM_STRENGTH },
      uFlashOn: { value: 0 },
      uFlashColor: { value: linVec(0xfff0c4) },
      uFlashRange: { value: FLASH_RANGE },
      uFlashIntensity: { value: FLASH_INTENSITY },
      uFlashCosInner: { value: FLASH_COS_INNER },
      uFlashCosOuter: { value: FLASH_COS_OUTER },
      uFogColor: { value: linVec(FOG_COLOR) },
      uFogDensity: { value: FOG_DENSITY },
    }
    this.lightQuad = new FullScreenQuad(fsMaterial(LIGHTING_FRAG, this.lightUniforms))
    this._up = new THREE.Vector3()

    // Volumetric light shafts (half-res), sharing the lamp field.
    const vw = Math.max(1, Math.floor(dw * VOL_SCALE))
    const vh = Math.max(1, Math.floor(dh * VOL_SCALE))
    this.volRT = new THREE.WebGLRenderTarget(vw, vh, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    })
    this.volUniforms = {
      tDepth: { value: this.depthTex },
      uProj: { value: new THREE.Matrix4() },
      uProjInverse: { value: new THREE.Matrix4() },
      uView: { value: new THREE.Matrix4() },
      uLampPos: this.lamps.uLampPos,
      uLampCount: this.lamps.uLampCount,
      uLampColor: { value: linVec(PANEL_COLOR) },
      uLampRange: { value: LIGHT_RANGE },
      uDensity: { value: VOL_DENSITY },
      uMaxDist: { value: VOL_MAXDIST },
      uPhaseG: { value: VOL_PHASE_G },
      // Share the flashlight value-objects with the lighting pass so the cone
      // stays in sync (incl. LightTool edits + the per-frame on/off toggle).
      uFlashOn: this.lightUniforms.uFlashOn,
      uFlashColor: this.lightUniforms.uFlashColor,
      uFlashRange: this.lightUniforms.uFlashRange,
      uFlashIntensity: this.lightUniforms.uFlashIntensity,
      uFlashCosInner: this.lightUniforms.uFlashCosInner,
      uFlashCosOuter: this.lightUniforms.uFlashCosOuter,
    }
    this.volQuad = new FullScreenQuad(fsMaterial(VOL_FRAG, this.volUniforms))

    // Emissive bloom (half-res): prefilter (matID-selective) -> separable blur.
    const bw = Math.max(1, Math.floor(dw * BLOOM_SCALE))
    const bh = Math.max(1, Math.floor(dh * BLOOM_SCALE))
    const bloomOpts = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }
    this.bloomPreRT = new THREE.WebGLRenderTarget(bw, bh, bloomOpts)
    this.bloomTmpRT = new THREE.WebGLRenderTarget(bw, bh, bloomOpts)
    this.bloomRT = new THREE.WebGLRenderTarget(bw, bh, bloomOpts)
    this.bloomPreUniforms = {
      tLit: { value: this.litRT.texture },
      tColor: { value: this.gColor },
      tDepth: { value: this.depthTex },
    }
    this.bloomPreQuad = new FullScreenQuad(fsMaterial(BLOOM_PREFILTER_FRAG, this.bloomPreUniforms))
    this.bloomBlurUniforms = {
      tInput: { value: null },
      uDir: { value: new THREE.Vector2() },
    }
    this.bloomBlurQuad = new FullScreenQuad(fsMaterial(BLOOM_BLUR_FRAG, this.bloomBlurUniforms))
    this._bloomTexel = new THREE.Vector2(1 / bw, 1 / bh)

    // Composite (lit + volumetrics + bloom) -> linear sceneRT.
    this.sceneRT = new THREE.WebGLRenderTarget(dw, dh, { type: THREE.HalfFloatType })
    this.outlineRT = new THREE.WebGLRenderTarget(dw, dh, { type: THREE.HalfFloatType })
    this.gradeRT = new THREE.WebGLRenderTarget(dw, dh) // LDR sRGB for FXAA input
    this.compositeUniforms = {
      tInput: { value: this.litRT.texture },
      tVol: { value: this.volRT.texture },
      tBloom: { value: this.bloomRT.texture },
      uVolIntensity: { value: VOL_INTENSITY },
      uBloomIntensity: { value: BLOOM_INTENSITY },
    }
    this.compositeQuad = new FullScreenQuad(fsMaterial(COMPOSITE_FRAG, this.compositeUniforms))

    // Ink outline (off the G-buffer).
    this.outlineUniforms = {
      tDiffuse: { value: this.sceneRT.texture },
      tNormal: { value: this.gNormal },
      tDepth: { value: this.depthTex },
      uTexel: { value: new THREE.Vector2(1 / dw, 1 / dh) },
      uThickness: { value: 1.6 },
      uDepthThresh: { value: 0.009 },
      uNormalThresh: { value: 0.3 },
      uFadeNear: { value: 0.08 },
      uFadeFar: { value: 0.34 },
      uInk: { value: linVec(0x140e03) },
    }
    this.outlineQuad = new FullScreenQuad(fsMaterial(OUTLINE_FRAG, this.outlineUniforms))

    // Grade (posterize + sanity FX) -> sRGB.
    this.gradeUniforms = {
      tDiffuse: { value: this.outlineRT.texture },
      time: { value: 0 },
      levels: { value: GRADE_LEVELS },
      tint: { value: new THREE.Vector3(1.06, 0.98, 0.66) },
      vignette: { value: 0.18 },
      grain: { value: 0.025 },
      aberration: { value: 0.0015 },
      dead: { value: 0 },
    }
    this.gradeQuad = new FullScreenQuad(fsMaterial(GRADE_FRAG, this.gradeUniforms))
    this.grade = this.gradeUniforms // Engine._applyFX drives these

    // FXAA -> screen.
    this.fxaaUniforms = {
      tDiffuse: { value: this.gradeRT.texture },
      uTexel: { value: new THREE.Vector2(1 / dw, 1 / dh) },
    }
    this.fxaaQuad = new FullScreenQuad(fsMaterial(FXAA_FRAG, this.fxaaUniforms))

    // Debug channel viewer (dev only). Binds the RT textures once; they survive
    // setSize (the RT keeps the same texture object), so no resize plumbing.
    this.debugView = 0
    this.debugViewUniforms = {
      uMode: { value: 0 },
      tColor: { value: this.gColor },
      tNormal: { value: this.gNormal },
      tDepth: { value: this.depthTex },
      tAO: { value: this.aoBlurRT.texture },
      tLit: { value: this.litRT.texture },
      tVol: { value: this.volRT.texture },
      tBloom: { value: this.bloomRT.texture },
      tScene: { value: this.sceneRT.texture },
      uProjInverse: { value: new THREE.Matrix4() },
      uDepthScale: { value: 1 / FAR },
    }
    this.debugQuad = new FullScreenQuad(fsMaterial(DEBUG_VIEW_FRAG, this.debugViewUniforms))

    this.outlineEnabled = true
  }

  // 0 disables; 1..9 blit a pipeline channel to screen (see DEBUG_VIEW_FRAG).
  setDebugView(mode) {
    this.debugView = mode | 0
  }

  _dims() {
    const pr = this.renderer.getPixelRatio()
    const size = this.renderer.getSize(new THREE.Vector2())
    return { dw: Math.floor(size.x * pr), dh: Math.floor(size.y * pr) }
  }

  setOutline(on) {
    this.outlineEnabled = on
  }

  setSize(w, h) {
    const { dw, dh } = this._dims()
    this.gBuffer.setSize(dw, dh)
    this.litRT.setSize(dw, dh)
    const aw = Math.max(1, Math.floor(dw * AO_SCALE))
    const ah = Math.max(1, Math.floor(dh * AO_SCALE))
    this.aoRT.setSize(aw, ah)
    this.aoBlurRT.setSize(aw, ah)
    this.aoUniforms.uResolution.value.set(dw, dh)
    this.aoBlurUniforms.uTexel.value.set(1 / aw, 1 / ah)
    this.volRT.setSize(Math.max(1, Math.floor(dw * VOL_SCALE)), Math.max(1, Math.floor(dh * VOL_SCALE)))
    const bw = Math.max(1, Math.floor(dw * BLOOM_SCALE))
    const bh = Math.max(1, Math.floor(dh * BLOOM_SCALE))
    this.bloomPreRT.setSize(bw, bh)
    this.bloomTmpRT.setSize(bw, bh)
    this.bloomRT.setSize(bw, bh)
    this._bloomTexel.set(1 / bw, 1 / bh)
    this.sceneRT.setSize(dw, dh)
    this.outlineRT.setSize(dw, dh)
    this.gradeRT.setSize(dw, dh)
    this.outlineUniforms.uTexel.value.set(1 / dw, 1 / dh)
    this.fxaaUniforms.uTexel.value.set(1 / dw, 1 / dh)
  }

  render(time) {
    const r = this.renderer
    const { scene, camera } = this

    // 1. G-buffer
    const prevBg = scene.background
    scene.background = null
    r.setRenderTarget(this.gBuffer)
    r.render(scene, camera)
    scene.background = prevBg

    // 2. SSAO -> aoRT -> aoBlurRT
    const au = this.aoUniforms
    au.uProj.value.copy(camera.projectionMatrix)
    au.uProjInverse.value.copy(camera.projectionMatrix).invert()
    r.setRenderTarget(this.aoRT)
    this.aoQuad.render(r)
    r.setRenderTarget(this.aoBlurRT)
    this.aoBlurQuad.render(r)

    // 3. Lighting -> litRT
    const lu = this.lightUniforms
    lu.uProj.value.copy(camera.projectionMatrix)
    lu.uProjInverse.value.copy(camera.projectionMatrix).invert()
    lu.uView.value.copy(camera.matrixWorldInverse)
    lu.uUpView.value.set(0, 1, 0).transformDirection(camera.matrixWorldInverse)
    r.setRenderTarget(this.litRT)
    this.lightQuad.render(r)

    // 4. Volumetric shafts -> volRT (half-res)
    const vu = this.volUniforms
    vu.uProj.value.copy(camera.projectionMatrix)
    vu.uProjInverse.value.copy(lu.uProjInverse.value)
    vu.uView.value.copy(camera.matrixWorldInverse)
    r.setRenderTarget(this.volRT)
    this.volQuad.render(r)

    // 5. Emissive bloom: prefilter -> blur H -> blur V
    r.setRenderTarget(this.bloomPreRT)
    this.bloomPreQuad.render(r)
    const bb = this.bloomBlurUniforms
    bb.tInput.value = this.bloomPreRT.texture
    bb.uDir.value.set(this._bloomTexel.x * BLOOM_SPREAD, 0)
    r.setRenderTarget(this.bloomTmpRT)
    this.bloomBlurQuad.render(r)
    bb.tInput.value = this.bloomTmpRT.texture
    bb.uDir.value.set(0, this._bloomTexel.y * BLOOM_SPREAD)
    r.setRenderTarget(this.bloomRT)
    this.bloomBlurQuad.render(r)

    // 6. Composite lit + volumetrics + bloom -> linear sceneRT
    r.setRenderTarget(this.sceneRT)
    this.compositeQuad.render(r)

    // Debug: blit a single pipeline channel to screen, skip grade/FXAA.
    if (this.debugView) {
      const du = this.debugViewUniforms
      du.uMode.value = this.debugView
      du.uProjInverse.value.copy(lu.uProjInverse.value) // matches the G-buffer camera
      du.uDepthScale.value = 1 / camera.far
      r.setRenderTarget(null)
      this.debugQuad.render(r)
      return
    }

    // 7. Ink outline (off the G-buffer), optional
    let graded = this.sceneRT.texture
    if (this.outlineEnabled) {
      this.outlineUniforms.tDiffuse.value = this.sceneRT.texture
      r.setRenderTarget(this.outlineRT)
      this.outlineQuad.render(r)
      graded = this.outlineRT.texture
    }

    // 8. Grade (posterize + sanity FX) -> sRGB gradeRT
    this.gradeUniforms.tDiffuse.value = graded
    this.gradeUniforms.time.value = time
    r.setRenderTarget(this.gradeRT)
    this.gradeQuad.render(r)

    // 9. FXAA -> screen
    r.setRenderTarget(null)
    this.fxaaQuad.render(r)
  }

  dispose() {
    this.gBuffer.dispose()
    this.litRT.dispose()
    this.aoRT.dispose()
    this.aoBlurRT.dispose()
    this.volRT.dispose()
    this.bloomPreRT.dispose()
    this.bloomTmpRT.dispose()
    this.bloomRT.dispose()
    this.sceneRT.dispose()
    this.outlineRT.dispose()
    this.gradeRT.dispose()
    this.ramp.dispose()
    this.lightQuad.dispose()
    this.aoQuad.dispose()
    this.aoBlurQuad.dispose()
    this.volQuad.dispose()
    this.bloomPreQuad.dispose()
    this.bloomBlurQuad.dispose()
    this.compositeQuad.dispose()
    this.outlineQuad.dispose()
    this.gradeQuad.dispose()
    this.fxaaQuad.dispose()
    this.debugQuad.dispose()
  }
}
