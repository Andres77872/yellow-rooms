import { glslFloat } from './common.js'
import { MIN_ROUGHNESS } from '../surfaces.js'

// Physically based shading helpers for the semi-realistic look profile
// (engine-improvement ADR-001 §3, chapter 12 §4.5). Conventions follow the
// glTF / Filament metallic-roughness model: perceptual roughness r, GGX
// alpha = r^2, dielectric F0 = 0.04, metal F0 = base colour. Space-agnostic:
// callers pass N, V, L in one consistent space.
export const BRDF_GLSL = /* glsl */ `
  #define PI 3.14159265
  #define MIN_ROUGHNESS ${glslFloat(MIN_ROUGHNESS)}

  float D_GGX(float NoH, float a){
    float a2 = a * a;
    float f = (NoH * a2 - NoH) * NoH + 1.0;
    return a2 / (PI * f * f + 1e-7);
  }

  // Height-correlated Smith visibility (Heitz 2014), Filament's form.
  float V_SmithGGX(float NoV, float NoL, float a){
    float a2 = a * a;
    float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
    float gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
    return 0.5 / max(gv + gl, 1e-5);
  }

  vec3 F_Schlick(vec3 f0, float VoH){
    float f = pow(1.0 - VoH, 5.0);
    return f0 + (vec3(1.0) - f0) * f;
  }

  // Karis' representative point for a fluorescent tube: the point on the
  // tube segment [c - ax, c + ax] closest to the reflection ray. Returns the
  // specular light vector (unnormalised, from P) and widens roughness by the
  // tube's angular size so energy stays roughly conserved.
  vec3 tubeSpecularL(vec3 P, vec3 R, vec3 c, vec3 ax){
    vec3 L0 = c - ax - P;
    vec3 L1 = c + ax - P;
    vec3 Ld = L1 - L0;
    float RoLd = dot(R, Ld);
    float t = clamp((dot(R, L0) * RoLd - dot(L0, Ld)) / max(dot(Ld, Ld) - RoLd * RoLd, 1e-5), 0.0, 1.0);
    return L0 + t * Ld;
  }

  // Direct light from one source: returns diffuse and specular radiance
  // factors (to be multiplied by the light's incident irradiance). Ls is the
  // (possibly representative-point) specular direction; srcR the source
  // radius for the Karis sphere normalisation.
  void brdfDirect(vec3 N, vec3 V, vec3 L, vec3 Ls, float dist, float srcR,
                  vec3 albedo, float rough, float metal, out vec3 diff, out vec3 spec){
    float NoL = clamp(dot(N, L), 0.0, 1.0);
    float NoV = clamp(dot(N, V), 1e-4, 1.0);
    float r = max(rough, MIN_ROUGHNESS);
    float a = r * r;
    // Sphere-light normalisation (Karis 2013): widen the lobe, then scale the
    // peak down so a large emitter does not add energy.
    float aw = clamp(a + srcR / (2.0 * max(dist, 0.1)), 0.0, 1.0);
    float norm = (a / aw) * (a / aw);
    vec3 H = normalize(Ls + V);
    float NoLs = clamp(dot(N, Ls), 0.0, 1.0);
    float NoH = clamp(dot(N, H), 0.0, 1.0);
    float VoH = clamp(dot(V, H), 0.0, 1.0);
    vec3 f0 = mix(vec3(0.04), albedo, metal);
    vec3 F = F_Schlick(f0, VoH);
    spec = F * (D_GGX(NoH, aw) * V_SmithGGX(NoV, NoLs, aw) * norm * NoLs);
    diff = (vec3(1.0) - F) * (1.0 - metal) * albedo * (NoL / PI);
  }

  // Split-sum-free environment approximation for the indirect specular term
  // (Karis' mobile analytic DFG fit): scales an irradiance estimate into the
  // reflected energy for this roughness and view angle.
  vec3 envBRDFApprox(vec3 f0, float rough, float NoV){
    const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
    const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
    vec4 r = rough * c0 + c1;
    float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
    vec2 AB = vec2(-1.04, 1.04) * a004 + r.zw;
    return f0 * AB.x + AB.y;
  }
`

// Output transforms available to the grade pass. AgX and Khronos PBR Neutral
// are ported from three.js r185 ShaderChunk/tonemapping_pars_fragment (MIT),
// minus the renderer's toneMappingExposure (the grade applies exposure).
export const TONEMAP_GLSL = /* glsl */ `
  const mat3 LIN_REC2020_TO_LIN_SRGB = mat3(
    vec3(1.6605, -0.1246, -0.0182),
    vec3(-0.5876, 1.1329, -0.1006),
    vec3(-0.0728, -0.0083, 1.1187)
  );
  const mat3 LIN_SRGB_TO_LIN_REC2020 = mat3(
    vec3(0.6274, 0.0691, 0.0164),
    vec3(0.3293, 0.9195, 0.0880),
    vec3(0.0433, 0.0113, 0.8956)
  );
  vec3 agxContrast(vec3 x){
    vec3 x2 = x * x;
    vec3 x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
  }
  vec3 toneAgX(vec3 color){
    const mat3 inset = mat3(
      vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
      vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
      vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859)
    );
    const mat3 outset = mat3(
      vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
      vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
      vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405)
    );
    const float minEv = -12.47393;
    const float maxEv = 4.026069;
    color = LIN_SRGB_TO_LIN_REC2020 * color;
    color = inset * color;
    color = max(color, 1e-10);
    color = log2(color);
    color = clamp((color - minEv) / (maxEv - minEv), 0.0, 1.0);
    color = agxContrast(color);
    color = outset * color;
    color = pow(max(vec3(0.0), color), vec3(2.2));
    color = LIN_REC2020_TO_LIN_SRGB * color;
    return clamp(color, 0.0, 1.0);
  }
  vec3 toneNeutral(vec3 color){
    const float start = 0.8 - 0.04;
    const float desat = 0.15;
    float x = min(color.r, min(color.g, color.b));
    float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
    color -= offset;
    float peak = max(color.r, max(color.g, color.b));
    if (peak < start) return color;
    float d = 1.0 - start;
    float newPeak = 1.0 - d * d / (peak + d - start);
    color *= newPeak / peak;
    float g = 1.0 - 1.0 / (desat * (peak - newPeak) + 1.0);
    return mix(color, vec3(newPeak), g);
  }
`
