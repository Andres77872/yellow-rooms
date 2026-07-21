import { HASH, VIEW_RECON } from './common.js'
import { AO_SAMPLES_MAX } from '../../world/constants.js'

// --- SSAO (half-res): normal-oriented hemisphere kernel + range check -------
// The kernel array is sized to the AO_SAMPLES_MAX ceiling; uSamples (runtime
// quality tier) sets the live trip count. The kernel radii are stratified with
// a radical-inverse sequence so ANY prefix of the array is a well-distributed
// sub-kernel — a low tier reads the first 8 samples and still covers the
// hemisphere instead of clustering at the origin.
export const AO_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  #define AO_MAX ${AO_SAMPLES_MAX}
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tNormal;
  uniform sampler2D tDepth;
  uniform mat4 uProj;
  uniform mat4 uProjInverse;
  uniform vec2 uResolution;       // full-res, for noise rotation
  uniform vec3 uKernel[AO_MAX];
  uniform int uSamples;           // live sample count (quality tier), <= AO_MAX
  uniform float uRadius;
  uniform float uBias;
  uniform float uIntensity;

  ${VIEW_RECON}
  ${HASH}

  void main(){
    float d = texture(tDepth, vUv).x;
    if (d >= 1.0) { outColor = vec4(1.0); return; }
    vec3 P = viewPosFromDepth(vUv);
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
    for (int i = 0; i < AO_MAX; i++){
      if (i >= uSamples) break;
      vec3 sp = P + (TBN * uKernel[i]) * uRadius;
      vec4 clip = uProj * vec4(sp, 1.0);
      if (clip.w <= 0.0) continue; // sample behind the eye: perspective divide flips xy -> false occlusion
      vec2 uv = (clip.xy / clip.w) * 0.5 + 0.5;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) continue;
      float sceneZ = viewPosFromDepth(uv).z;
      float rangeCheck = smoothstep(0.0, 1.0, uRadius / max(abs(P.z - sceneZ), 1e-4));
      occ += (sceneZ >= sp.z + uBias ? 1.0 : 0.0) * rangeCheck;
    }
    float ao = 1.0 - (occ / float(uSamples)) * uIntensity;
    outColor = vec4(clamp(ao, 0.0, 1.0), 0.0, 0.0, 1.0);
  }
`

// Depth-aware (bilateral) 5x5 blur — same kernel as the shadow-mask blur — so
// contact darkening can't halo across depth edges (a flat box blur bled AO from
// pillars onto the wall far behind them).
export const AO_BLUR_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tAO;
  uniform sampler2D tDepth;
  uniform mat4 uProjInverse;
  uniform vec2 uTexel;
  uniform float uDepthSigma;     // view-Z falloff for the bilateral weight
  ${VIEW_RECON}
  void main(){
    float zc = viewZAt(vUv);
    float sum = 0.0, wsum = 0.0;
    for (int y = -2; y <= 2; y++)
      for (int x = -2; x <= 2; x++) {
        vec2 uv = vUv + vec2(float(x), float(y)) * uTexel;
        float dz = (viewZAt(uv) - zc) / uDepthSigma;
        float w = exp(-dz * dz);
        sum += texture(tAO, uv).r * w;
        wsum += w;
      }
    outColor = vec4(sum / max(wsum, 1e-4), 0.0, 0.0, 1.0);
  }
`
