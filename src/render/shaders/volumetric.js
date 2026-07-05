import { HASH, VIEW_RECON, glslFloat } from './common.js'
import { LIGHT_MAX, VOL_LIGHT_MAX, VOL_OCC_NEAR, VOL_OCC_FAR } from '../../world/constants.js'
import { QUALITY } from '../../core/device.js'

// --- Volumetric light shafts (half-res in-scatter raymarch) ----------------
// Marches the camera ray and, at each step, gathers in-scatter from the nearest
// VOL_LIGHT_MAX lamps + the flashlight cone. Each sample is gated by a SHORT
// screen-space depth march toward the light (visToLight) so shafts stop at walls
// and only beam through real openings — instead of glowing through solid geometry.
// A Henyey-Greenstein phase biases scatter forward, so a lamp roughly ahead reads
// as a directional god-ray. Like the shadow pass this is screen-space: occluders
// off-screen or behind the camera can't block (acceptable for the look).
export const VOL_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  #define VOL_STEPS ${QUALITY.volSteps}
  #define LIGHT_MAX ${LIGHT_MAX}
  #define VOL_LIGHT_MAX ${VOL_LIGHT_MAX}
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tDepth;
  uniform mat4 uProj;            // view -> clip (project march samples for occlusion)
  uniform mat4 uProjInverse;
  uniform vec3 uLampViewPos[LIGHT_MAX]; // lamp positions in VIEW space (CPU-precomputed)
  uniform int uLampCount;
  uniform vec3 uLampColor;
  uniform float uLampIntensity;  // shared with the lit pass so shafts track lamp brightness
  uniform float uLampFlicker;    // shared fluorescent dip so shafts flicker with the lamps
  uniform float uLampRange;
  uniform float uDensity;
  uniform float uMaxDist;
  uniform float uPhaseG;         // Henyey-Greenstein anisotropy (forward beams)
  uniform float uFogDensity;     // shared with the lit pass: shafts sink into the same haze
  uniform float uFlashOn;
  uniform vec3 uFlashColor;
  uniform float uFlashRange;
  uniform float uFlashIntensity;
  uniform float uFlashCosInner;
  uniform float uFlashCosOuter;

  ${HASH}
  ${VIEW_RECON}

  // Henyey-Greenstein phase, normalised so the spherical average is ~1 (keeps the
  // overall brightness stable while concentrating scatter toward the light).
  float phaseHG(float cosT){
    float g2 = uPhaseG * uPhaseG;
    float denom = 1.0 + g2 - 2.0 * uPhaseG * cosT;
    return (1.0 - g2) / pow(max(denom, 1e-4), 1.5);
  }

  // Screen-space visibility of view-space sample S toward light Lv: a couple of
  // depth taps along the ray; if an on-screen surface lies between them, occluded.
  float visToLight(vec3 S, vec3 Lv){
    vec3 toL = Lv - S;
    float len = length(toL);
    vec3 dir = toL / max(len, 1e-4);
    for (int k = 1; k <= 2; k++){
      vec3 Q = S + dir * (len * (float(k) / 3.0));
      vec4 clip = uProj * vec4(Q, 1.0);
      if (clip.w <= 0.0) continue;
      vec2 uv = (clip.xy / clip.w) * 0.5 + 0.5;
      if (uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) continue;
      float dz = viewZAt(uv) - Q.z;       // >0: scene surface nearer than the ray sample
      if (dz > ${glslFloat(VOL_OCC_NEAR)} && dz < ${glslFloat(VOL_OCC_FAR)}) return 0.0;
    }
    return 1.0;
  }

  void main(){
    float d = texture(tDepth, vUv).x;
    float zc = (d >= 1.0) ? 1.0 : d * 2.0 - 1.0;
    vec4 v = uProjInverse * vec4(vUv * 2.0 - 1.0, zc, 1.0); v /= v.w;
    vec3 P = v.xyz;
    float plen = length(P);
    float maxT = min(plen, uMaxDist);
    vec3 dir = P / max(plen, 1e-4);
    float step = maxT / float(VOL_STEPS);
    float jitter = hash(gl_FragCoord.xy);

    // Single outer step loop: compute the ray sample S once per step, then gather
    // in-scatter from each lamp (was re-walking the whole ray per lamp).
    // Each sample's in-scatter is attenuated by the camera->sample fog
    // transmittance (same exp^2 curve as the lit pass), so shafts melt into the
    // haze with everything else instead of gluing full-brightness streaks onto
    // an already-fogged background (and the uMaxDist clamp edge disappears).
    vec3 acc = vec3(0.0);
    float t = step * jitter;
    for (int i = 0; i < VOL_STEPS; i++){
      vec3 S = dir * t;
      float trans = exp(-uFogDensity * uFogDensity * t * t);
      for (int j = 0; j < LIGHT_MAX; j++){
        if (j >= uLampCount || j >= VOL_LIGHT_MAX) break;
        vec3 Lv = uLampViewPos[j];
        float dl = distance(S, Lv);
        if (dl < uLampRange){
          float a = 1.0 - dl / uLampRange;
          float phase = phaseHG(dot(dir, (Lv - S) / max(dl, 1e-4)));
          acc += a * a * phase * visToLight(S, Lv) * trans;
        }
      }
      t += step;
    }
    // Scale the lamp in-scatter by lamp intensity (parity with the lit pass and
    // with the flashlight shaft's uFlashIntensity). Runs before the flashlight
    // term so only the lamp shafts are affected.
    acc *= uLampColor * uLampIntensity * uLampFlicker;

    // Flashlight in-scatter: a dusty cone from the camera (view origin, axis -z).
    if (uFlashOn > 0.5){
      float fl = 0.0;
      float t = step * jitter;
      for (int i = 0; i < VOL_STEPS; i++){
        vec3 S = dir * t;
        float ds = length(S);
        float cosA = -S.z / max(ds, 1e-4);
        float cone = smoothstep(uFlashCosOuter, uFlashCosInner, cosA);
        if (cone > 0.0){
          float a = clamp(1.0 - ds / uFlashRange, 0.0, 1.0);
          fl += a * a * cone;
        }
        t += step;
      }
      acc += uFlashColor * (fl * uFlashIntensity);
    }

    acc *= uDensity * step;
    outColor = vec4(acc, 1.0);
  }
`
