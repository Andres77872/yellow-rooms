import { CEL_BAND, IGN, LAMP_ATT, LIT_RAMP, VIEW_PROJ, VIEW_RECON, glslFloat } from './common.js'
import { GRID_GLSL, GRID_UNIFORMS_GLSL } from './grid.js'
import { LAMP_DATA_GLSL } from './lampData.js'
import { LIGHT_MAX, SHADOW_STEPS_MAX, SHADOW_BIAS, SHADOW_MAX_DARK } from '../../world/constants.js'
import { LAMP_Y } from '../../world/lightGrid/gridSpec.js'

// --- Screen-space lamp shadows (half-res) ----------------------------------
// Produces a single contribution-weighted VISIBILITY mask per fragment, then a
// depth-aware bilateral blur turns the per-pixel march noise into a soft penumbra
// (mirrors the AO half-res + blur path). The lighting pass multiplies the summed
// lamp term by this mask.
//
// Role since the world-grid lighting (engine-improvement §4.3): walls and
// columns are occluded exactly by the grid, independent of the camera, so on
// grid pixels this pass is CONTACT detail only — the march is capped at
// uMaxDist and the lamps it weighs come from the pixel's own grid list (so a
// fixture behind a wall no longer dilutes the mask). Pixels without grid data
// (debug light room, streaming edge) keep the original full-length march over
// the nearest visible lamps.
//
// Why the contribution-weighted average is EXACT (pre-blur): the lit pass shades
// lamps as Σ contrib_i, and a per-lamp shadow would give Σ contrib_i·vis_i. Here
// mask = Σ(contrib_i·vis_i)/Σ contrib_i, and the lit pass multiplies Σ contrib_i
// by mask → Σ contrib_i·vis_i.
export const SHADOW_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  precision highp usampler2D;
  #define LIGHT_MAX ${LIGHT_MAX}
  #define STEPS_MAX ${SHADOW_STEPS_MAX}
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tNormal;
  uniform sampler2D tDepth;
  uniform mat4 uProj;            // view -> clip (for the screen-space march)
  uniform mat4 uProjInverse;
  uniform mat4 uCamToWorld;
  uniform mat4 uWorldToCam;
  uniform float uShadowThickness;
  uniform int uLampCount;
  uniform float uLampRange;
  uniform float uLampWrap;
  uniform int uSteps;            // live march steps (quality tier), <= STEPS_MAX
  uniform int uMaxLamps;         // most lamps marched per fragment (quality tier)
  uniform float uMaxDist;        // contact march length on grid pixels
  uniform float uGridOn;
  uniform vec3 uUpView;          // world up in view space (legacy lamps -> source height)
  ${LAMP_DATA_GLSL}
  ${GRID_UNIFORMS_GLSL}

  ${IGN}
  ${LAMP_ATT}
  ${VIEW_RECON}
  ${VIEW_PROJ}
  ${CEL_BAND}
  ${LIT_RAMP}
  ${GRID_GLSL}
  float wrapNL(float ndl){ return clamp((ndl + uLampWrap) / (1.0 + uLampWrap), 0.0, 1.0); }

  // March the depth buffer from P toward a lamp for at most maxLen; return
  // contact-hardened visibility (0 = occluded near the receiver, ->1 = open).
  float march(vec3 P, vec3 Lv, float jitter, float maxLen){
    float full = distance(P, Lv);
    float maxd = min(full, maxLen);
    vec3 dir = (Lv - P) / max(full, 1e-4);
    float step = maxd / float(max(uSteps, 1));
    float t = step * (0.5 + jitter);
    for (int i = 0; i < STEPS_MAX; i++){
      if (i >= uSteps) break;
      vec3 S = P + dir * t;
      vec2 uv;
      if (projectView(S, uv) && uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0){
        float dz = viewZAt(uv) - S.z; // >0: scene surface closer than the ray sample
        if (dz > ${glslFloat(SHADOW_BIAS)} && dz < uShadowThickness){
          return clamp(t / maxd, 0.0, 1.0) * ${glslFloat(SHADOW_MAX_DARK)};
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
    float wsum = 0.0, vissum = 0.0;
    int shadowed = 0;

    bool gridPixel = false;
    if (uGridOn > 0.5) {
      vec3 Pw = (uCamToWorld * vec4(P, 1.0)).xyz;
      vec3 Nw = normalize(mat3(uCamToWorld) * N);
      vec3 Pl = Pw + Nw * 0.3;
      int cy = int(floor(Pl.y / G_LAYER_H));
      int gx = int(floor(Pl.x / G_CELL));
      int gz = int(floor(Pl.z / G_CELL));
      if (gridOwned(gx, gz, cy)) {
        gridPixel = true;
        uvec4 L = texelFetch(tGridList, gTexel(gx, gz, cy), 0);
        for (int k = 0; k < G_LIST_MAX; k++) {
          GridLight gl;
          if (!gridEntry(L, k, gx, gz, cy, gl)) break;
          vec3 Lv = (uWorldToCam * vec4(gl.pos, 1.0)).xyz;
          vec3 toL = Lv - P;
          float d = length(toL);
          if (d > uLampRange) continue;
          float ndl = wrapNL(dot(N, toL / max(d, 1e-4)));
          float tintY = dot(gl.tint, vec3(0.2126, 0.7152, 0.0722));
          float contrib = tintY * gl.flicker * gl.vis * surfaceRamp(ndl, 0.0) * lampAtt(d, uLampRange);
          float vis = 1.0;
          if (contrib > 0.04 && shadowed < uMaxLamps) { vis = march(P, Lv, jitter, uMaxDist); shadowed++; }
          wsum += contrib;
          vissum += contrib * vis;
        }
      }
    }
    if (!gridPixel) {
      // Same lamp selection as the lit pass: nearest-first, in range, the
      // meaningfully-lit nearest uMaxLamps marched over the full distance.
      for (int i = 0; i < LIGHT_MAX; i++) {
        if (i >= uLampCount) break;
        vec3 Lv = lampViewPos(i) + uUpView * (uSourceY - ${glslFloat(LAMP_Y)});
        vec4 ch = lampChar(i);
        vec3 toL = Lv - P;
        float d = length(toL);
        if (d > uLampRange) continue;
        float ndl = wrapNL(dot(N, toL / max(d, 1e-4)));
        float tintY = dot(ch.rgb, vec3(0.2126, 0.7152, 0.0722));
        float contrib = tintY * ch.a * surfaceRamp(ndl, 0.0) * lampAtt(d, uLampRange);
        float vis = 1.0;
        if (contrib > 0.08 && shadowed < uMaxLamps) { vis = march(P, Lv, jitter, 1e6); shadowed++; }
        wsum += contrib;
        vissum += contrib * vis;
      }
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
