import { COLOR_FNS, IGN, HASH } from './common.js'
import { TONEMAP_GLSL } from './brdf.js'

// Grade: a camera model (chapter 14 P20) on top of the look grade. In order:
//   lens    Brown–Conrady barrel distortion (k1, k2, zoomed so the corners
//           stay filled) with lateral chromatic aberration per channel, plus
//           the survival FX's legacy aberration
//   expose  fixed or auto exposure x scene-linear white balance (the look's
//           camera white balance, the family tint when tintStage is 'scene',
//           and the auto white-balance gains)
//   desat   highlight desaturation above the knee (tubes clip toward white)
//   tone    filmic (custom), AgX, Khronos PBR Neutral, or the video knee
//   sensor  exposure-scaled sensor noise, then the white clip (every tone
//           mapper; identity at 1)
//   toe     display-referred toe crush (slope 1 at 2t, white stays 1)
//   post    legacy post-tone-map family tint (tintStage 'post': Classic),
//           saturation, split tone, shadow lift colour, optional posterize
//   optics  the survival vignette (unchanged) x an optical falloff
//   grain   survival grain + dead static
//   out     linear -> sRGB, display pedestal (milky blacks), TPDF dither
// The ONLY output transform in the pipeline (renderer tone mapping is
// NoToneMapping), so exactly one conversion is ever applied. Every stylised
// stage is scaled by the active look profile: the renderer pre-blends family
// values toward neutral by the look's amounts, `levels <= 0` is an explicit
// posterize BYPASS branch, and every camera lever at its identity value
// reproduces the v1 grade exactly. Sanity FX drive vignette/grain/
// aberration/dead from Engine._applyFX.
export const GRADE_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tDiffuse;
  uniform sampler2D tExposure;   // AutoExposure 2x1: texel 0 r = exposure, texel 1 rgb = AWB gains
  uniform float time, levels, vignette, grain, grainK, aberration, dead, exposure, sat, lift;
  uniform float autoExposure;    // 1 = read tExposure, 0 = fixed exposure uniform
  uniform float sensorNoise;     // exposure-scaled camera noise (0 = off)
  uniform float exposureRef;     // family exposure: the gain sensor noise is relative to
  uniform int toneMapper;        // 0 filmic (custom), 1 AgX, 2 Khronos PBR Neutral, 3 video
  uniform vec3 tint;             // post-tone-map tint (identity when tintStage is 'scene')
  uniform vec3 wb;               // scene-linear white balance
  uniform vec3 shadowTint;       // split-tone multiplier at the dark end
  uniform vec3 highTint;         // split-tone multiplier at the bright end
  uniform vec3 liftColor;
  uniform float hiDesat, knee, whiteClip, toe, blackLevel, vigBase;
  uniform float lensK1, lensK2, caK;
  ${COLOR_FNS}
  ${IGN}
  ${HASH}
  ${TONEMAP_GLSL}

  // Filmic tone curve: the Narkowicz ACES fit, mostly on LUMINANCE
  // (hue-preserving: yellow walls stay yellow), blending toward the
  // per-channel curve as values climb so hot cores roll off to warm white.
  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
  float aces(float x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
  vec3 aces3(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
  vec3 toneFilmic(vec3 c){
    c = max(c, 0.0);
    float L = dot(c, LUMA);
    vec3 hue = c * (aces(L) / max(L, 1e-5));
    vec3 chan = aces3(c);
    return min(mix(hue, chan, 0.3 + 0.5 * smoothstep(0.3, 1.4, L)), vec3(1.0));
  }
  // Video camera response: linear to the knee, an exponential shoulder
  // above it (the hard white clip follows every tone mapper in main).
  vec3 toneVideo(vec3 x){
    float kp = clamp(knee, 0.05, 0.98);
    vec3 over = kp + (1.0 - kp) * (1.0 - exp(-(x - kp) / ((1.0 - kp) * 1.6)));
    return mix(x, over, step(kp, x));
  }
  vec3 toneMap(vec3 c){
    c = max(c, 0.0);
    if (toneMapper == 1) return toneAgX(c);
    if (toneMapper == 2) return clamp(toneNeutral(c), 0.0, 1.0);
    if (toneMapper == 3) return toneVideo(c);
    return toneFilmic(c);
  }

  void main(){
    vec2 uv = vUv;
    vec2 d = uv - 0.5;
    // Lens: radius^2 is 1 at the corners; the zoom keeps them filled.
    float r2 = dot(d, d) * 2.0;
    float zoom = 1.0 / (1.0 + lensK1 + lensK2);
    float k2t = lensK2 * r2 * r2;
    vec2 uvR = 0.5 + d * (1.0 + lensK1 * (1.0 + caK) * r2 + k2t) * zoom;
    vec2 uvG = 0.5 + d * (1.0 + lensK1 * r2 + k2t) * zoom;
    vec2 uvB = 0.5 + d * (1.0 + lensK1 * (1.0 - caK) * r2 + k2t) * zoom;
    float ca = aberration * (0.4 + dot(d, d) * 2.5);
    vec3 col;
    col.r = texture(tDiffuse, uvR + d * ca).r;
    col.g = texture(tDiffuse, uvG).g;
    col.b = texture(tDiffuse, uvB - d * ca).b;
    float ex = autoExposure > 0.5 ? texelFetch(tExposure, ivec2(0, 0), 0).r : exposure;
    vec3 awb = autoExposure > 0.5 ? texelFetch(tExposure, ivec2(1, 0), 0).rgb : vec3(1.0);
    col *= ex * wb * awb;
    // Highlight desaturation: a sensor channel clips toward white.
    float peak = max(col.r, max(col.g, col.b));
    col = mix(col, vec3(dot(col, LUMA)), hiDesat * smoothstep(knee, 1.6, peak));
    col = toneMap(col);
    // Sensor noise: a camera pushing gain into darkness gets noisier, and the
    // noise lives in the shadows (found-footage behaviour, not uniform grain).
    // It goes in before the toe, as on a real sensor, so the toe crushes
    // noise and signal together. Added after the crush, it buried dark
    // surfaces in noise, and its clamp at 0 lifted every black to the same
    // noise floor.
    if (sensorNoise > 0.0) {
      float gain = sqrt(max(ex / max(exposureRef, 1e-3), 0.25));
      float n = hash(uv * vec2(1543.0, 911.0) + fract(time * 7.13) * 91.0) - 0.5;
      float shadow = 1.0 - smoothstep(0.0, 0.35, dot(col, LUMA));
      col += n * sensorNoise * 0.022 * gain * (0.35 + 0.65 * shadow);
    }
    // White clip for every tone mapper (identity at 1); the lower clamp keeps
    // noise from going negative, which the toe's square would fold upward.
    col = clamp(col, 0.0, whiteClip);
    // Toe crush (display-referred): continuous, slope 1 at x = 2t.
    if (toe > 0.0) col = mix(col * col / (4.0 * toe), col - toe, step(2.0 * toe, col)) / (1.0 - toe);
    col *= tint;
    float luma = dot(col, LUMA);
    col = max(mix(vec3(luma), col, sat), 0.0);
    // Split tone + shadow lift (pre-scaled toward neutral by the look).
    float tl = dot(col, LUMA);
    col *= mix(shadowTint, highTint, smoothstep(0.02, 0.5, tl));
    col += lift * liftColor * (1.0 - smoothstep(0.0, 0.2, tl));
    float v = max(max(col.r, col.g), col.b);
    if (levels > 0.5 && v > 1e-4) {
      float vg = pow(v, 0.4545);
      // Dither BEFORE quantizing so the posterize reads as a gradient; clamp
      // keeps near-black pixels from going negative (pow -> NaN).
      float vd = (ign(gl_FragCoord.xy) - 0.5) / levels;
      float vq = pow(clamp(floor((vg + vd) * levels), 0.0, levels) / levels, 2.2);
      col *= vq / v;
    }
    // Survival vignette (legacy curve, unchanged) x optical falloff.
    float rv = length(d);
    float vig = 1.0 - smoothstep(0.25, 1.0, rv);
    float optic = 1.0 / pow(1.0 + 1.2 * r2, 2.0);
    col *= mix(1.0, vig, vignette) * mix(1.0, optic, vigBase);
    col += (hash(uv * vec2(1280.0, 720.0) + time) - 0.5) * grain * grainK;
    float st = hash(uv * vec2(640.0, 480.0) + time * 57.0);
    col = mix(col, vec3(st), dead);
    vec3 srgb = linearToSRGB(col);
    // Display pedestal: the black level a cheap sensor/monitor chain lifts.
    srgb = blackLevel + (1.0 - blackLevel) * srgb;
    float tri = (ign(gl_FragCoord.xy) + ign(gl_FragCoord.xy + vec2(11.0, 17.0))) - 1.0;
    srgb += tri * (1.0 / 255.0);
    outColor = vec4(srgb, 1.0);
  }
`
