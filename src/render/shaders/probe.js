// Float probe readback (engine-improvement chapter 14 P1).
//
// Copies up to PROBE_MAX texels of any pipeline target into a PROBE_MAX x 2
// RGBA32F target that is read back once: row 0 holds the source texel (HDR
// lit, occlusion, contact, shafts...), row 1 the view-space position the
// depth buffer reconstructs at that pixel plus the raw depth. RGBA/FLOAT is
// the readback EXT_color_buffer_float guarantees, unlike reading a HalfFloat
// target directly. Debug/evidence only: the readback stalls the GPU.
export const PROBE_MAX = 64

export const PROBE_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  #define PROBE_MAX ${PROBE_MAX}
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tSrc;
  uniform sampler2D tDepth;
  uniform mat4 uProjInverse;
  uniform vec2 uPx[PROBE_MAX];   // full-resolution pixel (gl_FragCoord convention)
  uniform float uSrcScale;       // tSrc resolution / full resolution
  uniform int uCount;
  void main(){
    int i = int(gl_FragCoord.x);
    int row = int(gl_FragCoord.y);
    if (i >= uCount) { outColor = vec4(0.0); return; }
    vec2 px = uPx[i];
    if (row == 0) {
      ivec2 sz = textureSize(tSrc, 0);
      outColor = texelFetch(tSrc, clamp(ivec2(floor(px * uSrcScale)), ivec2(0), sz - 1), 0);
    } else {
      ivec2 sz = textureSize(tDepth, 0);
      ivec2 p = clamp(ivec2(px), ivec2(0), sz - 1);
      float d = texelFetch(tDepth, p, 0).x;
      vec2 uv = (vec2(p) + 0.5) / vec2(sz);
      vec4 v = uProjInverse * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
      outColor = vec4(v.xyz / v.w, d);
    }
  }
`
