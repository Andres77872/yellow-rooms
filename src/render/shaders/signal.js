import { glslFloat } from './common.js'

// Peaking kernels (resolution independent): the luma Gaussian's sigma spans
// at least SIGNAL_TAP_SIGMA taps (taps spread past 1 px once the sigma
// grows with the render height), and the peaking reference is
// SIGNAL_PEAK_RATIO x wider on the SAME taps, so y - yb stays a positive
// band-pass at 720p, 1080p, 1440p and 4K alike.
export const SIGNAL_TAP_SIGMA = 1.25
export const SIGNAL_PEAK_RATIO = 1.75

// Camcorder tape signal (chapter 14 P25, the camcorder look only).
//
// An LDR pass after the grade that REPLACES FXAA — the luma low-pass is the
// anti-aliasing. It emulates a consumer camcorder recording to tape:
//   raster   vertical samples at the centres of a `native`-line raster,
//            half-blended with bilinear so text stays legible
//   YIQ      separate luma / chroma bandwidths: a 9-tap luma Gaussian sized
//            for `lumaLines` TV lines, a much wider chroma Gaussian
//            (`chromaLines`) sampled `chromaDelay` native pixels late, so
//            colour bleeds to the right of edges
//   peaking  in-camera sharpening (the bright ringing halo on edges)
//   tape     streaky luma noise along lines (heavier in the shadows) and
//            quarter-resolution chroma noise
//   head     head-switching: the bottom lines shift sideways, desaturated
//   dropout  a rare single-frame white streak (<= 0.1/s, CPU-scheduled)
//   smear    CCD vertical smear: a streak through the tubes from the
//            column-averaged clipped emissive energy (SMEAR_FRAG)
// Accessibility: the NOISE setting 'off' removes tape noise, dropouts and
// head switching; CAMERA FX off removes head switching and dropouts. The
// HTML HUD is unaffected (it is not in this image).
export const SIGNAL_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tDiffuse;    // graded sRGB (LDR)
  uniform sampler2D tSmear;      // (W/4) x 1 column-averaged emissive energy
  uniform vec2 uTexel;           // 1 / full-res size
  uniform float uAspect;
  uniform float uNative;         // emulated raster lines
  uniform float uLumaLines;
  uniform float uChromaLines;
  uniform float uChromaDelay;    // native pixels
  uniform float uSharpen;
  uniform float uTapeNoise;
  uniform float uHeadSwitch;
  uniform float uCcdSmear;
  uniform float uTime;
  uniform float uFrame;
  uniform vec4 uDropout;         // x (uv), line (uv), length (uv), on

  // Integer hash for the per-frame noise: the float HASH loses every
  // fractional bit once line + frame counters pass a few thousand, which
  // froze the tape noise into static vertical stripes. PCG keeps full
  // entropy for any counter value.
  uint pcg(uint v){
    uint s = v * 747796405u + 2891336453u;
    uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
  }
  // [0, 1) from three integer coordinates (int -> uint keeps the bits, so a
  // negative column after the head-switch shift is still well defined).
  float uhash(int x, int y, uint z){
    return float(pcg(uint(x) ^ pcg(uint(y) ^ pcg(z))) >> 8u) * (1.0 / 16777216.0);
  }

  const mat3 RGB2YIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
  const mat3 YIQ2RGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);

  vec3 fetchYIQ(vec2 uv){
    return RGB2YIQ * texture(tDiffuse, clamp(uv, uTexel * 0.5, 1.0 - uTexel * 0.5)).rgb;
  }

  void main(){
    vec2 uv = vUv;
    float line = floor(uv.y * uNative);
    // Head switching: the bottom band of lines slips sideways.
    float headBand = uHeadSwitch * 0.015;
    float inHead = step(uv.y, headBand);
    float shift = inHead * (uhash(int(line), int(floor(uTime * 30.0)), 0x68u) - 0.5) * 8.0 * uTexel.x;
    uv.x += shift;
    // Native raster: half line-centred, half bilinear.
    uv.y = mix(uv.y, (line + 0.5) / uNative, 0.5);
    // Luma / chroma bandwidths in full-res pixels.
    float W = 1.0 / uTexel.x;
    float sY = max(W / (2.3 * uLumaLines * uAspect), 0.35);
    float sC = sY * uLumaLines / max(uChromaLines, 1.0);
    float delay = uChromaDelay * W / (uNative * uAspect) * uTexel.x;
    // Luma taps sit stepPx apart (bilinear fetches), so both kernels keep
    // their shape in tap units whatever the resolution.
    float stepPx = max(1.0, sY / ${glslFloat(SIGNAL_TAP_SIGMA)});
    float sYt = sY / stepPx;
    float sBt = ${glslFloat(SIGNAL_PEAK_RATIO)} * sYt;
    float y = 0.0;
    float wy = 0.0;
    float yb = 0.0;
    float wb = 0.0;
    vec2 iq = vec2(0.0);
    float wc = 0.0;
    for (int k = -4; k <= 4; k++) {
      float fk = float(k);
      float gY = exp(-0.5 * fk * fk / (sYt * sYt));
      float gB = exp(-0.5 * fk * fk / (sBt * sBt));
      vec2 ou = vec2(fk * stepPx * uTexel.x, 0.0);
      float ys = fetchYIQ(uv + ou).x;
      y += ys * gY;
      wy += gY;
      yb += ys * gB;
      wb += gB;
      // Chroma taps sit sC / 2 px apart, so a Gaussian of sigma sC px is
      // exp(-k^2 / 8) in tap units (independent of resolution).
      float gC = exp(-0.125 * fk * fk);
      iq += fetchYIQ(uv + vec2(delay + fk * sC * 0.5 * uTexel.x, 0.0)).yz * gC;
      wc += gC;
    }
    y /= wy;
    yb /= wb;
    iq /= max(wc, 1e-5);
    // In-camera peaking (edge ringing).
    y += uSharpen * (y - yb);
    // Tape noise: streaky along lines, stronger in the shadows.
    uint frame = uint(uFrame);
    float streak = uhash(int(floor(uv.x * W / 6.0)), int(line), frame) - 0.5;
    y += streak * uTapeNoise * 0.12 * (0.3 + 0.7 * (1.0 - clamp(y, 0.0, 1.0)));
    vec2 cq = floor(uv * vec2(W * 0.25, uNative * 0.5));
    ivec2 icq = ivec2(cq);
    iq += (vec2(uhash(icq.x, icq.y, frame ^ 0x51u), uhash(icq.x, icq.y, frame ^ 0xA7000u)) - 0.5) * uTapeNoise * 0.08;
    iq *= 1.0 - inHead * 0.8;
    // CCD smear through clipped emitters.
    float smear = texture(tSmear, vec2(uv.x, 0.5)).r;
    y += smear * uCcdSmear * (0.6 + 0.4 * (1.0 - abs(uv.y - 0.5) * 2.0));
    // Dropout streak.
    if (uDropout.w > 0.5 && abs(uv.y - uDropout.y) < 0.5 / uNative && uv.x > uDropout.x && uv.x < uDropout.x + uDropout.z) y = mix(y, 1.0, 0.8);
    vec3 rgb = YIQ2RGB * vec3(y, iq);
    outColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
  }
`

// Column-averaged clipped emissive energy for the CCD smear: each texel of a
// (W/4) x 1 target averages 32 vertical taps of the bloom prefilter (the
// emissive-dominated HDR excess).
export const SMEAR_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tBloomPre;
  void main(){
    float s = 0.0;
    for (int i = 0; i < 32; i++) {
      vec3 c = texture(tBloomPre, vec2(vUv.x, (float(i) + 0.5) / 32.0)).rgb;
      s += max(dot(c, vec3(0.2126, 0.7152, 0.0722)) - 1.0, 0.0);
    }
    outColor = vec4(vec3(s / 32.0), 1.0);
  }
`
