import { DEPTH_PX, IGN } from './common.js'

// --- Occlusion resolve (chapter 14 P11/P12), half resolution, MRT -----------
// One pass denoises both screen-space occlusion signals:
//   out 0  GTAO visibility + bent normal (from the GTAO pass)
//   out 1  residual contact: per-light channels r/g, aggregate b, cell hash a
// A CENTRED 5x5 joint bilateral with separable weights [0.5, 1, 1, 1, 0.5]:
// the half-weight end taps share a noise phase, so the kernel integrates
// exactly one period of the 4x4 interleaved noise both producers use (the
// v1 blurs smeared IGN instead). Taps are weighted by their distance to the
// centre's tangent plane (geometric normal from depth), so nothing bleeds
// across a silhouette or a crease. Contact channels r/g name list entries of
// the centre cell: taps from another cell (hash) drop out of them.
export const OCC_RESOLVE_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  in vec2 vUv;
  layout(location = 0) out vec4 outOcc;
  layout(location = 1) out vec4 outContact;
  uniform sampler2D tAORaw;
  uniform sampler2D tContactRaw;
  uniform sampler2D tDepth;
  uniform mat4 uProjInverse;
  uniform float uScale;
  ${DEPTH_PX}
  ${IGN}

  void main(){
    ivec2 ij = ivec2(gl_FragCoord.xy);
    ivec2 hs = textureSize(tAORaw, 0);
    ivec2 fs = textureSize(tDepth, 0);
    ivec2 pF = halfTexelToFull(ij, uScale, fs);
    if (texelFetch(tDepth, pF, 0).x >= 1.0) {
      outOcc = vec4(1.0, 0.5, 0.5, 1.0);
      outContact = vec4(1.0, 1.0, 1.0, 0.0);
      return;
    }
    vec3 P = viewPosPx(pF, fs);
    vec3 N = geomNormalPx(pF, fs, P, normalize(-P));
    float sigma = 0.02 + 0.03 * abs(P.z);
    vec4 cc = texelFetch(tContactRaw, ij, 0);
    float hash = cc.a;
    vec4 aoSum = vec4(0.0);
    float aoW = 0.0;
    vec2 rgSum = vec2(0.0);
    float rgW = 0.0;
    float bSum = 0.0;
    float bW = 0.0;
    for (int y = -2; y <= 2; y++){
      float wy = (y == -2 || y == 2) ? 0.5 : 1.0;
      for (int x = -2; x <= 2; x++){
        float wx = (x == -2 || x == 2) ? 0.5 : 1.0;
        ivec2 t = clamp(ij + ivec2(x, y), ivec2(0), hs - 1);
        vec3 Ps = viewPosPx(halfTexelToFull(t, uScale, fs), fs);
        float pd = dot(Ps - P, N) / sigma;
        float w = wx * wy * exp(-pd * pd);
        aoSum += texelFetch(tAORaw, t, 0) * w;
        aoW += w;
        vec4 cs = texelFetch(tContactRaw, t, 0);
        bSum += cs.b * w;
        bW += w;
        if (abs(cs.a - hash) < 0.002) { rgSum += cs.rg * w; rgW += w; }
      }
    }
    vec4 ao = aoW > 1e-5 ? aoSum / aoW : texelFetch(tAORaw, ij, 0);
    float dither = (ign(gl_FragCoord.xy) - 0.5) / 255.0;
    outOcc = vec4(clamp(ao.r + dither, 0.0, 1.0), ao.gb, 1.0);
    outContact = vec4(rgW > 1e-5 ? rgSum / rgW : cc.rg, bW > 1e-5 ? bSum / bW : cc.b, hash);
  }
`
