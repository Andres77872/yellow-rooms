import { DEPTH_PX } from './common.js'

// Composite lit + volumetrics + bloom into a single linear buffer.
//
// The half-res shafts come up through a DEPTH-AWARE upsample (chapter 14
// P14): the four shaft texels around this pixel (HALF_TEXEL registration)
// blend bilinearly when their depths (alpha) agree with the full-res depth
// within 10%, else the nearest-depth texel wins, so a shaft never haloes
// across a silhouette. Bloom carries three levels — tight halo, wide veil,
// and the eighth-res tail — plus an optional halation tint on the veil.
export const COMPOSITE_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tInput;
  uniform sampler2D tVol;
  uniform sampler2D tBloom;      // tight halo (half res)
  uniform sampler2D tBloomWide;  // wide veil (quarter res)
  uniform sampler2D tBloomTail;  // tail (sixteenth res)
  uniform sampler2D tDepth;
  uniform mat4 uProjInverse;
  uniform float uVolScale;
  uniform float uVolIntensity;
  uniform float uBloomIntensity;
  uniform float uBloomWide;
  uniform float uBloomTail;
  uniform vec4 uHalation;        // rgb tint + strength added from the veil's luminance
  ${DEPTH_PX}

  vec3 volUpsample(){
    ivec2 fs = textureSize(tDepth, 0);
    ivec2 hs = textureSize(tVol, 0);
    ivec2 px = ivec2(gl_FragCoord.xy);
    float zc = max(-viewPosPx(px, fs).z, 1e-3);
    vec2 q = vec2(px) * uVolScale;
    ivec2 i0 = ivec2(floor(q));
    vec2 f = q - vec2(i0);
    vec3 sum = vec3(0.0);
    float ws = 0.0;
    bool agree = true;
    float best = 1e9;
    vec3 bestC = vec3(0.0);
    for (int t = 0; t < 4; t++){
      ivec2 o = ivec2(t & 1, t >> 1);
      vec4 s = texelFetch(tVol, clamp(i0 + o, ivec2(0), hs - 1), 0);
      vec2 bw = mix(1.0 - f, f, vec2(o));
      float w = bw.x * bw.y;
      sum += s.rgb * w;
      ws += w;
      float dz = abs(s.a - zc);
      if (dz > 0.1 * zc) agree = false;
      if (dz < best) { best = dz; bestC = s.rgb; }
    }
    return agree ? sum / max(ws, 1e-5) : bestC;
  }

  void main(){
    vec3 veil = texture(tBloomWide, vUv).rgb * uBloomWide + texture(tBloomTail, vUv).rgb * uBloomTail;
    float vl = dot(veil, vec3(0.2126, 0.7152, 0.0722));
    outColor = vec4(
      texture(tInput, vUv).rgb
        + volUpsample() * uVolIntensity
        + texture(tBloom, vUv).rgb * uBloomIntensity
        + veil + uHalation.rgb * (uHalation.w * vl),
      1.0);
  }
`
