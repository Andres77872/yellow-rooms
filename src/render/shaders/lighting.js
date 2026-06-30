import { IGN, glslFloat } from './common.js'
import { LIGHT_MAX, CEL_BANDS, RIM_POW, RIM_MIX, LAMP_AO_MIX } from '../../world/constants.js'

// --- Deferred lighting: hemispheric ambient + MANY cel-banded lamps +
//     analytic flashlight cone + rim, all in view space. ---
// Screen-space lamp shadows are computed in a separate half-res pass (shadow.js)
// and arrive pre-blurred as a single visibility mask in tShadow; this pass just
// multiplies the summed lamp term by it (see shadow.js for why that's exact).
export const LIGHTING_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  #define LIGHT_MAX ${LIGHT_MAX}
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tColor;
  uniform sampler2D tNormal;
  uniform sampler2D tDepth;
  uniform sampler2D tRamp;
  uniform sampler2D tAO;
  uniform sampler2D tShadow;     // half-res, bilateral-blurred lamp visibility mask
  uniform mat4 uProjInverse;
  uniform float uShadowStrength;
  uniform vec3 uUpView;          // world up, in view space
  uniform vec3 uLampViewPos[LIGHT_MAX]; // lamp positions in VIEW space (CPU-precomputed)
  uniform int uLampCount;
  uniform vec3 uLampColor;
  uniform float uLampIntensity;
  uniform float uLampFlicker;    // per-frame fluorescent dip (1 = steady); driven by Engine
  uniform float uLampRange;
  uniform vec3 uAmbSky;
  uniform vec3 uAmbGround;
  uniform float uLampWrap;       // half-Lambert wrap for lamp + flash N·L
  uniform float uRim;
  uniform float uFlashOn;
  uniform vec3 uFlashColor;
  uniform float uFlashRange;
  uniform float uFlashIntensity;
  uniform float uFlashCosInner;
  uniform float uFlashCosOuter;
  uniform vec3 uFogColor;
  uniform float uFogDensity;

  float band(float x){ return texture(tRamp, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }
  // Half-Lambert wrap: lifts grazing / under-facing surfaces toward the lit band
  // so ceilings & wall undersides read consistently with lit floors. Pure Lambert
  // when uLampWrap == 0.
  float wrapNL(float ndl){ return clamp((ndl + uLampWrap) / (1.0 + uLampWrap), 0.0, 1.0); }
  ${IGN}

  void main(){
    float depth = texture(tDepth, vUv).x;
    if (depth >= 1.0) { outColor = vec4(uFogColor, 1.0); return; }

    vec4 c = texture(tColor, vUv);
    vec4 ndc = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 vp = uProjInverse * ndc; vp /= vp.w;
    vec3 P = vp.xyz;               // view-space position
    float dist = length(P);
    float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);

    // Emissive surfaces (lamps, exit) bypass lighting.
    if (c.a > 0.5 && c.a < 1.5) {
      outColor = vec4(mix(c.rgb, uFogColor, fog), 1.0);
      return;
    }

    vec3 N = normalize(texture(tNormal, vUv).xyz * 2.0 - 1.0);
    vec3 albedo = c.rgb;
    float jitter = ign(gl_FragCoord.xy);
    // Dither the cel-ramp lookup by up to +/-half a band so the hard N·L terminator
    // reads as a smooth gradient on big flat surfaces instead of concentric rings.
    // Flat mid-band fields are unaffected (the offset never crosses a boundary
    // there); only band edges dissolve — the same trick the grade posterize uses.
    float celDither = (jitter - 0.5) / ${glslFloat(CEL_BANDS)};

    // Ambient occlusion (contact darkening) — mostly on the ambient/indirect term.
    float ao = texture(tAO, vUv).r;

    // Warm hemispheric ambient fills shadows (keeps lamp-less zones dark-warm).
    float hemi = 0.5 + 0.5 * dot(N, uUpView);
    vec3 ambient = mix(uAmbGround, uAmbSky, hemi) * ao;

    // Many lamps, cel-banded by N·L, attenuated to 0 at range.
    vec3 lamps = vec3(0.0);
    for (int i = 0; i < LIGHT_MAX; i++) {
      if (i >= uLampCount) break;
      vec3 Lv = uLampViewPos[i];
      vec3 toL = Lv - P;
      float d = length(toL);
      if (d > uLampRange) continue;
      float ndl = wrapNL(dot(N, toL / max(d, 1e-4)));
      float x = clamp(1.0 - d / uLampRange, 0.0, 1.0);
      lamps += band(ndl + celDither) * (x * x);
    }
    // Screen-space lamp shadows (half-res, blurred) modulate the whole lamp term.
    // tShadow is the contribution-weighted visibility, so this equals per-lamp
    // shadowing of the sum (pre-blur). uShadowStrength scales how dark it gets.
    float shadowMask = texture(tShadow, vUv).r;
    lamps *= mix(1.0, shadowMask, uShadowStrength);
    lamps *= uLampColor * uLampIntensity * uLampFlicker * mix(1.0, ao, ${glslFloat(LAMP_AO_MIX)});

    // Flashlight: cone from the camera (view origin, axis -z).
    vec3 flash = vec3(0.0);
    if (uFlashOn > 0.5) {
      float d = dist;
      vec3 Ld = -P / max(d, 1e-4);
      float cosA = -P.z / max(d, 1e-4);
      float cone = smoothstep(uFlashCosOuter, uFlashCosInner, cosA);
      float ndl = wrapNL(dot(N, Ld));
      float x = clamp(1.0 - d / uFlashRange, 0.0, 1.0);
      flash = uFlashColor * (band(ndl + celDither) * x * x * cone * uFlashIntensity);
    }

    // pow() of a negative base is undefined in GLSL; dot() of renormalized
    // vectors can exceed 1 by an fp epsilon, so clamp the base to >= 0.
    float rim = pow(max(1.0 - max(dot(N, -P / max(dist, 1e-4)), 0.0), 0.0), ${glslFloat(RIM_POW)}) * uRim;

    vec3 col = albedo * (ambient + lamps + flash) + uLampColor * rim * ${glslFloat(RIM_MIX)};
    col = mix(col, uFogColor, fog);
    outColor = vec4(col, 1.0);
  }
`
