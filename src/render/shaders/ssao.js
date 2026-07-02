import { HASH, VIEW_RECON } from './common.js'
import { QUALITY } from '../../core/device.js'

// --- SSAO (half-res): normal-oriented hemisphere kernel + range check -------
export const AO_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  #define AO_SAMPLES ${QUALITY.aoSamples}
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
    for (int i = 0; i < AO_SAMPLES; i++){
      vec3 sp = P + (TBN * uKernel[i]) * uRadius;
      vec4 clip = uProj * vec4(sp, 1.0);
      if (clip.w <= 0.0) continue; // sample behind the eye: perspective divide flips xy -> false occlusion
      vec2 uv = (clip.xy / clip.w) * 0.5 + 0.5;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) continue;
      float sceneZ = viewPosFromDepth(uv).z;
      float rangeCheck = smoothstep(0.0, 1.0, uRadius / max(abs(P.z - sceneZ), 1e-4));
      occ += (sceneZ >= sp.z + uBias ? 1.0 : 0.0) * rangeCheck;
    }
    float ao = 1.0 - (occ / float(AO_SAMPLES)) * uIntensity;
    outColor = vec4(clamp(ao, 0.0, 1.0), 0.0, 0.0, 1.0);
  }
`

export const AO_BLUR_FRAG = /* glsl */ `
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
