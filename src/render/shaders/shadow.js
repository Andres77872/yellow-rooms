import { IGN, VIEW_RECON, glslFloat } from './common.js'
import { LIGHT_MAX, SHADOW_MAX, SHADOW_BIAS, SHADOW_MAX_DARK } from '../../world/constants.js'
import { QUALITY } from '../../core/device.js'

// --- Screen-space lamp shadows (half-res) ----------------------------------
// Produces a single contribution-weighted VISIBILITY mask per fragment, then a
// depth-aware bilateral blur turns the per-pixel march noise into a soft penumbra
// (mirrors the AO half-res + blur path). The lighting pass multiplies the summed
// lamp term by this mask.
//
// Why the contribution-weighted average is EXACT (pre-blur): the lit pass shades
// lamps as Σ contrib_i, and a per-lamp shadow would give Σ contrib_i·vis_i. Here
// mask = Σ(contrib_i·vis_i)/Σ contrib_i, and the lit pass multiplies Σ contrib_i
// by mask → Σ contrib_i·vis_i. So a fragment lit by one lamp it's shadowed from
// and another it can see resolves correctly, not as a single blanket shadow.
export const SHADOW_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  #define LIGHT_MAX ${LIGHT_MAX}
  #define SHADOW_STEPS ${QUALITY.shadowSteps}
  #define SHADOW_MAX ${SHADOW_MAX}
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tNormal;
  uniform sampler2D tDepth;
  uniform sampler2D tRamp;
  uniform mat4 uProj;            // view -> clip (for the screen-space march)
  uniform mat4 uProjInverse;
  uniform float uShadowThickness;
  uniform vec3 uLampViewPos[LIGHT_MAX]; // lamp positions in VIEW space (CPU-precomputed)
  uniform int uLampCount;
  uniform float uLampRange;
  uniform float uLampWrap;

  ${IGN}
  ${VIEW_RECON}
  float band(float x){ return texture(tRamp, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }
  float wrapNL(float ndl){ return clamp((ndl + uLampWrap) / (1.0 + uLampWrap), 0.0, 1.0); }

  // March the depth buffer from P toward a lamp; return contact-hardened
  // visibility (0 = occluded near the receiver, ->1 = open / distant occluder).
  float march(vec3 P, vec3 Lv, float jitter){
    float maxd = distance(P, Lv);
    vec3 dir = (Lv - P) / max(maxd, 1e-4);
    float step = maxd / float(SHADOW_STEPS);
    float t = step * (0.5 + jitter);
    for (int i = 0; i < SHADOW_STEPS; i++){
      vec3 S = P + dir * t;
      vec4 clip = uProj * vec4(S, 1.0);
      if (clip.w > 0.0){
        vec2 uv = (clip.xy / clip.w) * 0.5 + 0.5;
        if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0){
          float dz = viewZAt(uv) - S.z; // >0: scene surface closer than the ray sample
          if (dz > ${glslFloat(SHADOW_BIAS)} && dz < uShadowThickness){
            return clamp(t / maxd, 0.0, 1.0) * ${glslFloat(SHADOW_MAX_DARK)};
          }
        }
      }
      t += step;
    }
    return 1.0;
  }

  void main(){
    float depth = texture(tDepth, vUv).x;
    if (depth >= 1.0) { outColor = vec4(1.0); return; } // void: fully visible

    vec3 P = viewPosFromDepth(vUv);
    vec3 N = normalize(texture(tNormal, vUv).xyz * 2.0 - 1.0);
    float jitter = ign(gl_FragCoord.xy);

    // Same lamp selection as the lit pass: array order (nearest-first), in-range,
    // shadow-march only the meaningfully-lit nearest SHADOW_MAX.
    float wsum = 0.0, vissum = 0.0;
    int shadowed = 0;
    for (int i = 0; i < LIGHT_MAX; i++) {
      if (i >= uLampCount) break;
      vec3 Lv = uLampViewPos[i];
      vec3 toL = Lv - P;
      float d = length(toL);
      if (d > uLampRange) continue;
      float ndl = wrapNL(dot(N, toL / max(d, 1e-4)));
      float x = clamp(1.0 - d / uLampRange, 0.0, 1.0);
      float contrib = band(ndl) * (x * x);
      float vis = 1.0;
      if (contrib > 0.08 && shadowed < SHADOW_MAX) { vis = march(P, Lv, jitter); shadowed++; }
      wsum += contrib;
      vissum += contrib * vis;
    }
    float mask = wsum > 1e-5 ? vissum / wsum : 1.0;
    outColor = vec4(mask, 0.0, 0.0, 1.0);
  }
`

// Depth-aware (bilateral) blur of the half-res shadow mask: a 5x5 kernel weighted
// by view-Z similarity so the soft penumbra does NOT bleed across depth edges
// (walls / pillars keep crisp shadow boundaries while flat surfaces smooth out).
export const SHADOW_BLUR_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tShadow;
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
        sum += texture(tShadow, uv).r * w;
        wsum += w;
      }
    outColor = vec4(sum / max(wsum, 1e-4), 0.0, 0.0, 1.0);
  }
`
