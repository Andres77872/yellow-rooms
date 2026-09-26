import { DEPTH_PX } from './common.js'
import { GTAO_SLICES_MAX, GTAO_STEPS_MAX } from '../../world/constants.js'

// --- Ground-truth ambient occlusion (chapter 14 P11) ------------------------
// Half-resolution GTAO (Jimenez et al. 2016, XeGTAO's formulation) for the
// physically based looks: per slice, the horizon on each side is found over
// quadratically spaced full-resolution depth taps, clamped to the normal's
// hemisphere, and the cosine-weighted visible arc integrated in closed
// form; the bent normal is accumulated the XeGTAO way. The normal is the
// GEOMETRIC one rebuilt from depth (detail normals would mottle the AO).
// Noise: Jimenez's 4x4 interleaved slice rotation + step offset, which the
// resolve pass integrates exactly over one 4x4 period.
// Output (RGBA8): r = visibility, gb = octahedral view-space bent normal.
export const GTAO_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  #define SLICES_MAX ${GTAO_SLICES_MAX}
  #define STEPS_MAX ${GTAO_STEPS_MAX}
  #define PI 3.14159265
  #define HALF_PI 1.57079633
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tDepth;
  uniform mat4 uProjInverse;
  uniform int uSlices;
  uniform int uSteps;
  uniform float uRadius;      // view-space AO radius (m)
  uniform float uProjScale;   // 0.5 * fullHeight * proj[1][1]: metres at z=1 -> pixels
  uniform float uScale;       // this target's resolution / full resolution
  uniform float uPower;       // final visibility exponent
  ${DEPTH_PX}

  void main(){
    ivec2 ij = ivec2(gl_FragCoord.xy);
    ivec2 fs = textureSize(tDepth, 0);
    ivec2 pF = halfTexelToFull(ij, uScale, fs);
    float d = texelFetch(tDepth, pF, 0).x;
    if (d >= 1.0) { outColor = vec4(1.0, 0.5, 0.5, 1.0); return; }
    vec3 P = viewPosPx(pF, fs);
    vec3 V = normalize(-P);
    vec3 N = geomNormalPx(pF, fs, P, V);
    float rPx = min(uProjScale * uRadius / max(-P.z, 1e-3), 64.0);
    if (rPx < 1.5) { outColor = vec4(1.0, octEncode(N), 1.0); return; }
    // Jimenez 4x4 noise: slice rotation and step offset.
    float dirNoise = float((((ij.x + ij.y) & 3) << 2) | (ij.x & 3)) / 16.0;
    float offNoise = float((ij.y - ij.x) & 3) / 4.0;
    // XeGTAO falloff over the outer 61.5% of the radius.
    float fRange = 0.615 * uRadius;
    float fMul = -1.0 / fRange;
    float fAdd = (uRadius - fRange) / fRange + 1.0;
    float minS = 1.3 / rPx;
    float vis = 0.0;
    vec3 bent = vec3(0.0);
    float nSlices = float(uSlices);
    for (int s = 0; s < SLICES_MAX; s++){
      if (s >= uSlices) break;
      float phi = (float(s) + dirNoise) * PI / nSlices;
      vec2 dir = vec2(cos(phi), sin(phi));
      vec3 dirV = vec3(dir, 0.0);
      vec3 ortho = dirV - dot(dirV, V) * V;
      vec3 axis = normalize(cross(ortho, V));
      vec3 projN = N - axis * dot(N, axis);
      float projNLen = length(projN);
      float sgnN = dot(ortho, projN) >= 0.0 ? 1.0 : -1.0;
      float cosN = clamp(dot(projN, V) / max(projNLen, 1e-5), -1.0, 1.0);
      float n = sgnN * acos(cosN);
      float low0 = cos(n + HALF_PI);
      float low1 = cos(n - HALF_PI);
      float hc0 = low0;
      float hc1 = low1;
      for (int k = 0; k < STEPS_MAX; k++){
        if (k >= uSteps) break;
        float t = (float(k) + offNoise) / float(uSteps);
        t = t * t + minS;
        vec2 off = floor(dir * (t * rPx) + 0.5);
        vec3 S0 = viewPosPx(pF + ivec2(off), fs) - P;
        vec3 S1 = viewPosPx(pF - ivec2(off), fs) - P;
        float l0 = length(S0);
        float l1 = length(S1);
        float c0 = dot(S0 / max(l0, 1e-5), V);
        float c1 = dot(S1 / max(l1, 1e-5), V);
        float w0 = clamp(l0 * fMul + fAdd, 0.0, 1.0);
        float w1 = clamp(l1 * fMul + fAdd, 0.0, 1.0);
        hc0 = max(hc0, mix(low0, c0, w0));
        hc1 = max(hc1, mix(low1, c1, w1));
      }
      float h0 = -acos(clamp(hc1, -1.0, 1.0));
      float h1 = acos(clamp(hc0, -1.0, 1.0));
      h0 = n + clamp(h0 - n, -HALF_PI, HALF_PI);
      h1 = n + clamp(h1 - n, -HALF_PI, HALF_PI);
      float sinN = sin(n);
      float ia0 = (cosN + 2.0 * h0 * sinN - cos(2.0 * h0 - n)) * 0.25;
      float ia1 = (cosN + 2.0 * h1 * sinN - cos(2.0 * h1 - n)) * 0.25;
      vis += projNLen * (ia0 + ia1);
      float t0 = (6.0 * sin(h0 - n) - sin(3.0 * h0 - n) + 6.0 * sin(h1 - n) - sin(3.0 * h1 - n)
        + 16.0 * sinN - 3.0 * (sin(h0 + n) + sin(h1 + n))) / 12.0;
      float t1 = (-cos(3.0 * h0 - n) - cos(3.0 * h1 - n) + 8.0 * cosN
        - 3.0 * (cos(h0 + n) + cos(h1 + n))) / 12.0;
      vec3 od = ortho / max(length(ortho), 1e-5);
      bent += projNLen * (od * t0 + V * t1);
    }
    vis = pow(clamp(vis / nSlices, 0.0, 1.0), uPower);
    vec3 B = length(bent) > 1e-5 ? normalize(bent) : N;
    outColor = vec4(vis, octEncode(B), 1.0);
  }
`
