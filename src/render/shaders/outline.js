import { VIEW_RECON } from './common.js'

// Ink outline: depth + normal Sobel straight off the G-buffer, faded by the
// SAME exp^2 fog transmittance the lighting pass applies to surfaces (plus a
// wide smoothstep safety envelope), so lines die exactly when the surface
// melts into the haze — never ghost-wireframes floating on fog.
//
// World lines are COLOUR-TRACED (iro-tore): the ink is a darkened, more
// saturated version of the surface's own albedo, blended with the flat ink by
// uInkTint and drawn at uInkOpacity, so line art sits inside the painting
// instead of caging it in black. Thresholds are soft (smoothstep) so lines
// anti-alias and thin out on weak edges. Entities keep full flat ink.
export const OUTLINE_FRAG = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tDiffuse;
  uniform sampler2D tColor;      // G-buffer albedo+matID (ink persists on entities)
  uniform sampler2D tNormal;
  uniform sampler2D tDepth;
  uniform mat4 uProjInverse;     // per-frame, matches the live camera
  uniform float uDepthScale;     // 1.0 / camera.far -> normalized linear depth
  uniform float uFogDensity;     // shared value-object with the lighting pass
  uniform vec2 uTexel;
  uniform float uThickness, uDepthThresh, uNormalThresh, uFadeNear, uFadeFar;
  uniform vec3 uInk;
  uniform float uInkTint;        // 0 = flat ink, 1 = ink traced from the albedo
  uniform float uInkOpacity;     // world line strength (entities always 1)
  ${VIEW_RECON}
  // Normalized [0,1] linear depth. viewZAt is the shared symmetric-perspective
  // reconstruction (two MADs and a divide); the Sobel used to run a full mat4
  // unproject per tap, five times per pixel, plus a sixth for the fog distance.
  float lin(vec2 uv){ return clamp(-viewZAt(uv) * uDepthScale, 0.0, 1.0); }
  vec3 nrm(vec2 uv){ return normalize(texture(tNormal, uv).xyz * 2.0 - 1.0); }
  void main(){
    vec3 base = texture(tDiffuse, vUv).rgb;
    vec2 t = uTexel * uThickness;
    // One centre unproject serves BOTH the Sobel reference depth and the radial
    // fog distance below — the centre texel used to be fetched and unprojected
    // twice.
    vec3 vpc = viewPosFromDepth(vUv);
    float dc = clamp(-vpc.z * uDepthScale, 0.0, 1.0);
    float dd = abs(dc - lin(vUv + vec2(t.x, 0.0)))
             + abs(dc - lin(vUv - vec2(t.x, 0.0)))
             + abs(dc - lin(vUv + vec2(0.0, t.y)))
             + abs(dc - lin(vUv - vec2(0.0, t.y)));
    vec3 nc = nrm(vUv);
    float nd = (1.0 - dot(nc, nrm(vUv + vec2(t.x, 0.0))))
             + (1.0 - dot(nc, nrm(vUv - vec2(t.x, 0.0))))
             + (1.0 - dot(nc, nrm(vUv + vec2(0.0, t.y))))
             + (1.0 - dot(nc, nrm(vUv - vec2(0.0, t.y))));
    float distFade = 1.0 - smoothstep(uFadeNear, uFadeFar, dc);
    // Fog term must use the RADIAL view-space distance, exactly like the
    // lighting pass — the axial viewZ under-fades by 1/cos of the view ray
    // (1.6-1.8x at 16:9 edges/corners), which left ghost ink floating on fully
    // fogged surfaces in the outer third of the screen.
    float rdist = length(vpc);
    float fogT = exp(-uFogDensity * uFogDensity * rdist * rdist);
    // Entities (matID 2) keep a crisp ink silhouette at ANY distance — a black
    // outline lingering in the haze long after the body melts is the point.
    vec4 g = texture(tColor, vUv);
    bool entity = g.a > 1.5 && g.a < 2.5;
    float fade = entity ? 1.0 : distFade * fogT * uInkOpacity;
    float edge = clamp(
      smoothstep(uDepthThresh * 0.6, uDepthThresh * 1.4, dd) +
      smoothstep(uNormalThresh * 0.7, uNormalThresh * 1.3, nd), 0.0, 1.0) * fade;
    // Traced ink: the albedo (clamped — emissive albedo is HDR) darkened and
    // pushed ~40% more saturated, never lighter than the flat ink's intent.
    vec3 alb = min(g.rgb, vec3(1.0));
    vec3 traced = alb * 0.3;
    float ty = dot(traced, vec3(0.2126, 0.7152, 0.0722));
    traced = max(mix(vec3(ty), traced, 1.4), 0.0);
    vec3 ink = entity ? uInk : mix(uInk, traced, uInkTint);
    outColor = vec4(mix(base, ink, edge), 1.0);
  }
`
