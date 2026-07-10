import { COLOR_FNS, IGN, HASH } from './common.js'

// Grade: tone map (hue-preserving) + chromatic aberration + warm tint + luminance
// posterize + vignette + grain + dead-static, then linear -> sRGB + TPDF dither.
// Sanity FX drive the uniforms (vignette/grain/aberration/dead from Engine._applyFX).
export const GRADE_FRAG = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tDiffuse;
  uniform float time, levels, vignette, grain, aberration, dead, exposure, sat;
  uniform vec3 tint;
  ${COLOR_FNS}
  ${IGN}
  ${HASH}

  // Khronos PBR Neutral tone map: hue-preserving, leaves values below ~0.8 almost
  // untouched and rolls bright lamp/flashlight/bloom cores off toward white instead
  // of hard-clipping (which had been blowing the warm hue out to flat white).
  vec3 toneMap(vec3 color){
    const float startCompression = 0.8 - 0.04;
    const float desaturation = 0.15;
    float x = min(color.r, min(color.g, color.b));
    float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
    color -= offset;
    float peak = max(color.r, max(color.g, color.b));
    if (peak < startCompression) return color;
    float dd = 1.0 - startCompression;
    float newPeak = 1.0 - dd * dd / (peak + dd - startCompression);
    color *= newPeak / peak;
    float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
    return mix(color, newPeak * vec3(1.0), g);
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
    float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = max(mix(vec3(luma), col, sat), 0.0);
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
    // Encode, then triangular-PDF dither at ~1 LSB to kill banding in the 8-bit
    // sRGB write (the only LDR boundary). Two IGN taps -> a triangular distribution.
    vec3 srgb = linearToSRGB(col);
    float tri = (ign(gl_FragCoord.xy) + ign(gl_FragCoord.xy + vec2(11.0, 17.0))) - 1.0;
    srgb += tri * (1.0 / 255.0);
    outColor = vec4(srgb, 1.0);
  }
`
