import { CEL_BAND, IGN, LAMP_ATT, LIT_RAMP, glslFloat } from './common.js'
import {
  LIGHT_MAX,
  CEL_BANDS,
  CEL_FLOOR,
  SPEC_REACH,
  ENTITY_FILL,
  RIM_POW,
  RIM_MIX,
  LAMP_AO_MIX,
  SKY_ZENITH_MULT,
  SKY_NADIR_MULT,
} from '../../world/constants.js'

// --- Deferred lighting: hemispheric ambient + MANY painted/cel lamps +
//     analytic flashlight cone + rim, all in view space. ---
// Screen-space lamp shadows are computed in a separate half-res pass (shadow.js)
// and arrive pre-blurred as a single visibility mask in tShadow; this pass just
// multiplies the summed lamp term by it (see shadow.js for why that's exact).
//
// Semi-realistic anime model, per lamp:
//   diffuse     surfaceRamp(): a painted smooth ramp with a hint of the cel band
//   terminator  a thin band of saturated lamp colour where lit turns to shadow
//               (the painted warm edge of anime shading), tinted uTermColor
//   specular    a soft-thresholded Blinn lobe, scaled by per-material gloss
//               from the G-buffer normal alpha (0 on carpet, high on tile/metal)
//   bounce      a non-directional share of the lamp's irradiance, tinted by
//               the family floor colour: cheap one-bounce fill for ceilings and
//               wall undersides.
export const LIGHTING_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  #define LIGHT_MAX ${LIGHT_MAX}
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tColor;
  uniform sampler2D tNormal;     // xyz view normal, a = material gloss
  uniform sampler2D tDepth;
  uniform sampler2D tAO;
  uniform sampler2D tShadow;     // half-res, bilateral-blurred lamp visibility mask
  uniform mat4 uProjInverse;
  uniform float uShadowStrength;
  uniform vec3 uUpView;          // world up, in view space
  uniform vec3 uLampViewPos[LIGHT_MAX]; // lamp positions in VIEW space (CPU-precomputed)
  uniform int uLampCount;
  uniform vec4 uLampChar[LIGHT_MAX];   // per-fixture identity: rgb tint, a flicker
  uniform vec3 uLampColor;
  uniform float uLampIntensity;
  uniform float uLampFlicker;    // per-frame fluorescent dip (1 = steady); driven by Engine
  uniform float uLampRange;
  uniform vec3 uAmbSky;
  uniform vec3 uAmbGround;
  uniform float uLampWrap;       // half-Lambert wrap for lamp + flash N·L
  uniform float uRim;
  uniform vec3 uRimColor;        // cool anime edge light (decoupled from lamp warmth)
  uniform vec3 uEntityRim;       // stepped slate rim on matID-2 entities
  uniform vec3 uTermColor;       // saturated lamp colour for the terminator band
  uniform float uTermStrength;
  uniform vec3 uBounceColor;     // family floor tint for the one-bounce fill
  uniform float uBounce;
  uniform float uSpecPower;
  uniform float uSpecStrength;
  uniform float uFlashOn;
  uniform vec3 uFlashColor;
  uniform float uFlashRange;
  uniform float uFlashIntensity;
  uniform float uFlashCosInner;
  uniform float uFlashCosOuter;
  uniform vec3 uFogColor;
  uniform float uFogDensity;

  ${CEL_BAND}
  ${LIT_RAMP}
  // Vertical sky/fog gradient: uFogColor is the HORIZON amber; rays tilting up
  // sink into a dark warm void, rays tilting down into a dim floor haze. Used
  // both for the raw void (depth == 1) and as the per-pixel fog target, so
  // distant surfaces converge exactly into the sky behind them instead of a
  // flat amber curtain (which used to glare through unloaded holes in dark
  // zones and flatten all depth).
  vec3 skyColor(vec3 dirView){
    float up = dot(dirView, uUpView);
    float b = mix(1.0, ${glslFloat(SKY_ZENITH_MULT)}, smoothstep(0.02, 0.5, up))
            * mix(1.0, ${glslFloat(SKY_NADIR_MULT)}, smoothstep(0.02, 0.55, -up));
    return uFogColor * b;
  }
  // Half-Lambert wrap: lifts grazing / under-facing surfaces toward the lit band
  // so wall undersides read consistently with lit floors. Pure Lambert when
  // the wrap is 0. The wrap is scaled per pixel (see main): fixtures throw
  // light DOWN, so a ceiling takes only part of it and stays a step darker
  // than the walls — the old full wrap lit ceilings like floors.
  float gWrap;
  float wrapNL(float ndl){ return clamp((ndl + gWrap) / (1.0 + gWrap), 0.0, 1.0); }
  // Bell over the wrapped N·L where the lit side turns: zero in full shadow
  // and in full light, peaking just inside the terminator.
  float terminator(float w){ return smoothstep(0.02, 0.26, w) * (1.0 - smoothstep(0.26, 0.58, w)); }
  // Soft-thresholded Blinn lobe: a painted highlight shape with a clean edge,
  // not a plastic falloff tail.
  float specLobe(vec3 N, vec3 L, vec3 V){
    float nh = max(dot(N, normalize(L + V)), 0.0);
    return smoothstep(0.1, 0.55, pow(nh, uSpecPower));
  }
  ${IGN}
  ${LAMP_ATT}

  void main(){
    float depth = texture(tDepth, vUv).x;
    vec4 ndc = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 vp = uProjInverse * ndc; vp /= vp.w;
    vec3 P = vp.xyz;               // view-space position (far plane when void)
    float dist = length(P);
    vec3 viewDir = P / max(dist, 1e-4);
    vec3 fogCol = skyColor(viewDir);

    // Void (no geometry): the graded sky, not a flat curtain.
    if (depth >= 1.0) { outColor = vec4(fogCol, 1.0); return; }

    vec4 c = texture(tColor, vUv);
    float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);

    // Emissive surfaces (lamps, exit) bypass lighting.
    if (c.a > 0.5 && c.a < 1.5) {
      outColor = vec4(mix(c.rgb, fogCol, fog), 1.0);
      return;
    }

    vec4 nTex = texture(tNormal, vUv);
    vec3 N = normalize(nTex.xyz * 2.0 - 1.0);
    float gloss = nTex.a;
    vec3 V = -viewDir;
    vec3 albedo = c.rgb;
    float jitter = ign(gl_FragCoord.xy);
    // Dither the banded share of the ramp by up to +/-half a band so its step
    // reads as a smooth gradient on big flat surfaces instead of concentric
    // rings. Flat mid-band fields are unaffected (the offset never crosses a
    // boundary there); only band edges dissolve.
    float celDither = (jitter - 0.5) / ${glslFloat(CEL_BANDS)};

    // Ambient occlusion (contact darkening) — mostly on the ambient/indirect term.
    float ao = texture(tAO, vUv).r;

    // Cool hemispheric ambient fills shadows (keeps lamp-less zones dusk-blue).
    float hemi = 0.5 + 0.5 * dot(N, uUpView);
    vec3 ambient = mix(uAmbGround, uAmbSky, hemi) * ao;
    gWrap = uLampWrap * mix(0.3, 1.0, smoothstep(0.0, 0.5, hemi));

    // Many lamps, attenuated to 0 at range. Each lamp's uLampChar.a already
    // folds the query-edge set fade into its flicker (DeferredRenderer.
    // _updateFrame computes it per lamp per frame on the CPU — it only depends
    // on the lamp's camera distance, never on the pixel), so lamps entering/
    // leaving the LightField candidate set ramp in smoothly instead of snapping
    // their whole floor pool on/off mid-walk — and the shadow + volumetric
    // passes see the exact same fade. Every lamp carries its own tint + flicker
    // identity, so neighbouring fixtures never pulse in lockstep.
    vec3 lamps = vec3(0.0);
    vec3 term = vec3(0.0);
    vec3 spec = vec3(0.0);
    vec3 omni = vec3(0.0);
    bool glossy = gloss > 0.004;
    // A glossy floor mirrors lamps well beyond their diffuse pool (the
    // reflected image of a panel does not fade like the irradiance it casts),
    // so the highlight gets a longer reach than the diffuse window.
    float reach = glossy ? uLampRange * ${glslFloat(SPEC_REACH)} : uLampRange;
    for (int i = 0; i < LIGHT_MAX; i++) {
      if (i >= uLampCount) break;
      vec3 toL = uLampViewPos[i] - P;
      float d = length(toL);
      if (d > reach) continue;
      vec3 L = toL / max(d, 1e-4);
      float ndl = dot(N, L);
      if (glossy && ndl > 0.0) {
        spec += uLampChar[i].rgb * (uLampChar[i].a * lampAtt(d, reach) * specLobe(N, L, V));
      }
      if (d > uLampRange) continue;
      float w = wrapNL(ndl);
      vec3 lc = uLampChar[i].rgb * (uLampChar[i].a * lampAtt(d, uLampRange));
      lamps += lc * surfaceRamp(w, celDither);
      term += lc * terminator(w);
      omni += lc;
    }
    // Screen-space lamp shadows (half-res, blurred) modulate the direct lamp
    // terms. tShadow is the luminance-contribution-weighted visibility, so this
    // matches per-lamp shadowing of the summed brightness (pre-blur; a scalar
    // mask can't match each tint channel exactly). uShadowStrength scales how
    // dark it gets. The bounce is indirect light and ignores it.
    // Ceilings take only a quarter of the mask: every lamp hangs at the
    // ceiling, so the only thing a ceiling point's march can hit is the
    // fixture's own housing at a grazing angle — which painted a dirty dark
    // disc around every tube instead of a believable shadow.
    float shadowK = uShadowStrength * mix(0.25, 1.0, smoothstep(0.0, 0.45, hemi));
    float shadowMask = mix(1.0, texture(tShadow, vUv).r, shadowK);
    vec3 lampScale = uLampColor * uLampIntensity * uLampFlicker;
    vec3 direct = lampScale * shadowMask;
    lamps *= direct * mix(1.0, ao, ${glslFloat(LAMP_AO_MIX)});
    term *= direct * uTermColor * uTermStrength;
    // Schlick-style grazing boost: glossy floors mirror hardest at the low
    // angles a first-person camera sees them — the anime corridor look.
    float fres = mix(0.4, 1.0, pow(1.0 - max(dot(N, V), 0.0), 3.0));
    spec *= direct * (gloss * uSpecStrength * fres);
    vec3 bounce = omni * lampScale * uBounceColor * (uBounce * ao);

    // Flashlight: cone from the camera (view origin, axis -z). Its highlight
    // on glossy surfaces is the lobe straight back at the eye (L == V).
    vec3 flash = vec3(0.0);
    if (uFlashOn > 0.5) {
      float d = dist;
      float cosA = -P.z / max(d, 1e-4);
      float cone = smoothstep(uFlashCosOuter, uFlashCosInner, cosA);
      float ndl = dot(N, V);
      float x = clamp(1.0 - d / uFlashRange, 0.0, 1.0);
      float beam = x * x * cone * uFlashIntensity;
      flash = uFlashColor * (surfaceRamp(wrapNL(ndl), celDither) * beam);
      if (glossy && ndl > 0.0) spec += uFlashColor * (specLobe(N, V, V) * beam * gloss * uSpecStrength * 0.6);
    }

    // pow() of a negative base is undefined in GLSL; dot() of renormalized
    // vectors can exceed 1 by an fp epsilon, so clamp the base to >= 0.
    float rimBase = pow(max(1.0 - max(dot(N, V), 0.0), 0.0), ${glslFloat(RIM_POW)});

    vec3 col;
    if (c.a > 1.5 && c.a < 2.5) {
      // Entity (matID 2): dark mass + a STEPPED cool rim through the cel ramp,
      // so a silhouette down a corridor reads as a deliberate presence. The
      // band's floor is mostly removed: at full CEL_FLOOR it washed the whole
      // body slate-blue, so the near-black ink figures read navy-grey. Now
      // the rim lives on the silhouette edge and the mass stays ink-dark. The
      // gloss lobe gives the models a faint wet sheen under the tubes.
      float entityRim = max(band(rimBase + celDither) - ${glslFloat(CEL_FLOOR * 0.75)}, 0.0);
      // Albedo-proportional fill: ink bodies (albedo ~0.01) gain nothing,
      // but pale parts — the Husk's ash, the Stalker's blank head and hands,
      // the Pursuer's pinpoint eyes — hold a faint glow in the dark, so each
      // entity stays readable (the Husk is the touchable one) and the pale
      // shapes float out of the silhouette.
      col = albedo * (ambient + lamps + flash + ${glslFloat(ENTITY_FILL)}) + spec + uEntityRim * entityRim * 0.95;
    } else {
      col = albedo * (ambient + lamps + flash + bounce + term) + spec
          + uRimColor * rimBase * uRim * ${glslFloat(RIM_MIX)};
    }
    col = mix(col, fogCol, fog);
    outColor = vec4(col, 1.0);
  }
`
