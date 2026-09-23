import { COLOR_FNS, IGN, HASH } from './common.js'

// Grade: filmic tone map + chromatic aberration + family tint + saturation +
// split toning + shadow lift + faint posterize + vignette + grain + dead-static,
// then linear -> sRGB + TPDF dither.
// Sanity FX drive the uniforms (vignette/grain/aberration/dead from Engine._applyFX).
export const GRADE_FRAG = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tDiffuse;
  uniform float time, levels, vignette, grain, aberration, dead, exposure, sat, lift;
  uniform vec3 tint;
  uniform vec3 shadowTint;   // split-tone multiplier at the dark end
  uniform vec3 highTint;     // split-tone multiplier at the bright end
  ${COLOR_FNS}
  ${IGN}
  ${HASH}

  // Filmic tone curve: the Narkowicz ACES fit (a real toe and a long
  // shoulder). The old Khronos PBR Neutral map was linear up to ~0.76, so lamp
  // pools on light walls went straight to the shoulder and flattened to cream.
  // Applied mostly to LUMINANCE (hue-preserving: yellow walls stay yellow, the
  // anime palette survives), blending toward the per-channel curve as values
  // climb so hot cores roll off to warm white instead of clipping one channel.
  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
  float aces(float x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
  vec3 aces3(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
  vec3 toneMap(vec3 c){
    c = max(c, 0.0);
    float L = dot(c, LUMA);
    vec3 hue = c * (aces(L) / max(L, 1e-5));
    vec3 chan = aces3(c);
    return min(mix(hue, chan, 0.3 + 0.5 * smoothstep(0.3, 1.4, L)), vec3(1.0));
  }

  void main(){
    vec2 uv = vUv;
    vec2 d = uv - 0.5;
    float ca = aberration * (0.4 + dot(d, d) * 2.5);
    vec3 col;
    col.r = texture(tDiffuse, uv + d * ca).r;
    col.g = texture(tDiffuse, uv).g;
    col.b = texture(tDiffuse, uv - d * ca).b;
    // Tone map the linear HDR scene before the look-tint / posterize.
    col = toneMap(col * exposure);
    col *= tint;
    // Post-tonemap saturation push (anime palette pop). After the tone map so
    // it can't fight the hue-preserving rolloff; clamped at 0 so deep shadows
    // can't go negative and NaN the posterize below.
    float luma = dot(col, LUMA);
    col = max(mix(vec3(luma), col, sat), 0.0);
    // Split tone: dusk-blue shadows, warm highlights (anime background
    // colour script), then lift the deepest values toward a shadow blue so
    // nothing reads as dead black ink except the ink itself.
    float tl = dot(col, LUMA);
    col *= mix(shadowTint, highTint, smoothstep(0.02, 0.5, tl));
    col += lift * vec3(0.6, 0.7, 1.0) * (1.0 - smoothstep(0.0, 0.2, tl));
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
    // GLSL leaves smoothstep undefined for reversed edges. Invert the valid
    // ascending ramp so vignette shading stays consistent across GPU drivers.
    float vig = 1.0 - smoothstep(0.25, 1.0, length(d));
    col *= mix(1.0, vig, vignette);
    col += (hash(uv * vec2(1280.0, 720.0) + time) - 0.5) * grain;
    float st = hash(uv * vec2(640.0, 480.0) + time * 57.0);
    col = mix(col, vec3(st), dead);
    // Encode, then triangular-PDF dither at ~1 LSB to kill banding in the 8-bit
    // sRGB write (the only LDR boundary). Two IGN taps -> a triangular distribution.
    vec3 srgb = linearToSRGB(col);
    float tri = (ign(gl_FragCoord.xy) + ign(gl_FragCoord.xy + vec2(11.0, 17.0))) - 1.0;
    srgb += tri * (1.0 / 255.0);
    outColor = vec4(srgb, 1.0);
  }
`
