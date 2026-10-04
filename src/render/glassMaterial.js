import * as THREE from 'three'
import { LAYER_H } from '../world/constants.js'
import { glslFloat } from './shaders/common.js'
import { GLASS_CLEAR, GLASS_CRACKED, GLASS_DIRTY, GLASS_FROSTED, GLASS_LAYER, GLASS_TAPED, GLASS_WIRED } from '../world/glassKinds.js'

// Window glass (forward pass; DeferredRenderer._renderGlass).
//
// A deferred G-buffer holds one opaque surface per pixel, so glass cannot
// live in it: a pane would hide the atrium it exists to show. Panes are
// instanced thin boxes on their own render layer (GLASS_LAYER) that the
// G-buffer camera never sees; after the composite the renderer draws that
// layer alone into the HDR scene target with premultiplied-over blending,
// testing each fragment against the G-buffer depth by hand (the scene target
// has no depth attachment).
//
// What a pane adds over the bare aperture it used to be:
//   * Schlick Fresnel reflection of the lit room: the reflected ray is
//     probed a fixed 2.5 m out and looked up in the lit buffer when it lands
//     on screen (grazing views down a gallery, where glass reflects most),
//     else the family's ambient — cheap, and it reads as glass at once;
//   * per-pane grime from instanceColor (x kind, y seed, z dirt): dust
//     settling toward the sill, wipe arcs, handprints on dirty panes;
//   * pane kinds — clear, dirty, frosted privacy glass (a blurred view of
//     what is behind), masking-tape crosses, and a cracked pane with a
//     radial star of fractures;
//   * the same squared-exponential fog the lit surfaces get, so far panes
//     fade with the corridor instead of glowing through the haze.
export { GLASS_LAYER, GLASS_CLEAR, GLASS_DIRTY, GLASS_FROSTED, GLASS_TAPED, GLASS_CRACKED, GLASS_WIRED }

// Nearest visible fixtures a pane reflects (the lit pass's compact set is
// distance-ordered, so the first few are the ones that matter).
const GLASS_LAMP_MAX = 16

const VERT = /* glsl */ `
  precision highp float;
  in vec3 position;
  in vec3 normal;
  in mat4 instanceMatrix;
  in vec3 instanceColor;
  uniform mat4 modelMatrix;
  uniform mat4 viewMatrix;
  uniform mat4 projectionMatrix;
  out vec3 vWorldPos;
  out vec3 vNormal;
  out vec2 vPane;
  out vec2 vLocal;
  out vec3 vKind;
  void main(){
    vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    mat3 basis = mat3(modelMatrix) * mat3(instanceMatrix);
    vec3 n = basis * normal;
    vNormal = normalize(n);
    // Pane frame: metres along the wall and height above this storey's floor.
    vec3 sx = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
    bool alongZ = sx.z > sx.x;
    float along = alongZ ? wp.z : wp.x;
    vPane = vec2(along, mod(wp.y + 0.001, ${glslFloat(LAYER_H)}));
    // Unit-box local coordinates across the pane (0..1 along, 0..1 up).
    vLocal = vec2((alongZ ? position.z : position.x) + 0.5, position.y + 0.5);
    vKind = instanceColor;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`

const FRAG = /* glsl */ `
  precision highp float;
  in vec3 vWorldPos;
  in vec3 vNormal;
  in vec2 vPane;
  in vec2 vLocal;
  in vec3 vKind;
  out vec4 outColor;
  uniform highp sampler2D tDepth;
  uniform sampler2D tScene;
  uniform vec2 uResolution;
  uniform mat4 viewMatrix;
  uniform mat4 projectionMatrix;
  uniform vec3 cameraPosition;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform vec3 uAmbient;
  uniform float uStrength;
  // The lit pass's compact view-space lamp set (shaders/lampData.js).
  uniform highp sampler2D tLampData;
  uniform int uLampCount;
  uniform vec3 uLampColor;
  uniform float uLampFlicker;
  uniform float uLampGlow;

  float gh(vec2 p){
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float gn(vec2 p){
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(gh(i), gh(i + vec2(1.0, 0.0)), u.x), mix(gh(i + vec2(0.0, 1.0)), gh(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float gfbm(vec2 p){
    return 0.5 * gn(p) + 0.3 * gn(p * 2.1 + 5.3) + 0.2 * gn(p * 4.3 + 1.7);
  }
  // Distance from p to the segment a-b.
  float seg(vec2 p, vec2 a, vec2 b){
    vec2 pa = p - a;
    vec2 ba = b - a;
    return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
  }

  void main(){
    ivec2 px = ivec2(gl_FragCoord.xy);
    float sceneZ = texelFetch(tDepth, px, 0).r;
    // Behind opaque geometry (casing, glazing bars, blinds, the far wall).
    if (gl_FragCoord.z > sceneZ + 2e-6) discard;
    vec2 suv0 = gl_FragCoord.xy / uResolution;

    float kind = floor(vKind.x + 0.5);
    float seed = vKind.y;
    float dirt = vKind.z;
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 N = normalize(vNormal);
    if (dot(N, V) < 0.0) N = -N;
    float cosT = clamp(dot(N, V), 0.0, 1.0);
    float F = 0.04 + 0.96 * pow(1.0 - cosT, 5.0);

    // Reflection: probe the reflected ray 2.5 m out in the lit buffer.
    vec3 R = reflect(-V, N);
    vec4 clip = projectionMatrix * viewMatrix * vec4(vWorldPos + R * 2.5, 1.0);
    vec3 refl = uAmbient;
    if (clip.w > 0.05) {
      vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
      vec2 e = smoothstep(vec2(0.0), vec2(0.1), suv) * (1.0 - smoothstep(vec2(0.9), vec2(1.0), suv));
      vec3 s = texture(tScene, clamp(suv, 0.0, 1.0)).rgb;
      refl = mix(uAmbient, min(s, vec3(4.0)), e.x * e.y);
    }

    // Fixture reflections: trace the reflected ray to each lit panel's
    // ceiling plane and test the troffer rectangle (render/geometries.js:
    // 1.7 x 1.0 m, 0.48 m above the light point). Flat glass mirrors the
    // fixture crisply at its own brightness however far away it hangs; the
    // grime film adds a faint halo around it.
    mat3 toWorld = transpose(mat3(viewMatrix));
    vec3 glints = vec3(0.0);
    if (R.y > 0.02) {
      for (int i = 0; i < ${GLASS_LAMP_MAX}; i++) {
        if (i >= uLampCount) break;
        vec3 C = cameraPosition + toWorld * texelFetch(tLampData, ivec2(i, 0), 0).xyz;
        C.y += 0.48;
        float t = (C.y - vWorldPos.y) / R.y;
        if (t <= 0.0) continue;
        vec2 d = abs(vWorldPos.xz + R.xz * t - C.xz) - vec2(0.85, 0.5);
        float edge = max(d.x, d.y);
        vec4 ch = texelFetch(tLampData, ivec2(i, 1), 0);
        float image = 1.0 - smoothstep(-0.02, 0.02 + 0.002 * t, edge);
        // The diffuser frame reads as a dimmer border inside the image.
        image *= 1.0 - 0.45 * smoothstep(-0.1, -0.06, edge);
        float halo = (1.0 - smoothstep(0.0, 0.7, edge)) * step(0.0, edge) * 0.06 * (0.3 + dirt);
        glints += ch.rgb * ch.a * (image + halo);
      }
    }
    refl += glints * uLampColor * uLampFlicker * uLampGlow;

    vec2 pane = vPane;
    vec2 local = vLocal;
    // What light the pane's own grime scatters: the room behind and around it.
    vec3 behind = min(texture(tScene, suv0).rgb, vec3(2.0));
    vec3 lightHere = behind * 0.6 + uAmbient * 2.0 + glints * uLampColor * 0.05;

    // Dust: thicker toward the sill and the corners, wipe arcs through it.
    float dust = gfbm(pane * 7.0 + seed * 37.0) * (0.45 + 0.55 * (1.0 - smoothstep(0.0, 0.7, local.y)));
    float corner = 1.0 - smoothstep(0.0, 0.12, min(min(local.x, 1.0 - local.x), min(local.y, 1.0 - local.y)));
    dust = clamp(dust * dirt + corner * 0.35 * dirt, 0.0, 1.0);
    vec2 wc = vec2(0.5 + (gh(vec2(seed, 1.0)) - 0.5) * 0.4, -0.3);
    float wipe = abs(fract(length(local - wc) * 9.0) - 0.5);
    dust *= 0.75 + 0.25 * smoothstep(0.1, 0.3, wipe);
    float a = 0.035 + F * 0.85;
    vec3 col = refl * F;
    col += lightHere * dust * 0.18;
    a += dust * 0.22;

    if (kind == ${GLASS_DIRTY}.0) {
      // Handprints at hand height: palm blob and four finger ovals.
      for (int k = 0; k < 2; k++) {
        vec2 hc = vec2(0.25 + 0.5 * gh(vec2(seed + float(k), 3.0)), 1.15 + 0.5 * gh(vec2(seed, 7.0 + float(k))));
        vec2 q = vec2((local.x - hc.x) * 1.2, pane.y - hc.y) * 6.0;
        float palm = 1.0 - smoothstep(0.35, 0.55, length(q * vec2(1.0, 1.25)));
        float fingers = 0.0;
        for (int f = 0; f < 4; f++) {
          vec2 fc = vec2(-0.45 + 0.3 * float(f), 0.85 + 0.12 * sin(float(f) * 1.7));
          fingers = max(fingers, 1.0 - smoothstep(0.08, 0.16, length((q - fc) * vec2(1.0, 0.45))));
        }
        float print = max(palm, fingers) * (0.6 + 0.4 * gn(q * 6.0));
        col += lightHere * print * 0.12;
        a += print * 0.12;
      }
    } else if (kind == ${GLASS_FROSTED}.0) {
      // Privacy film: a soft blurred view of the room behind.
      vec3 blur = vec3(0.0);
      for (int i = 0; i < 8; i++) {
        float ang = float(i) * 0.785 + seed * 6.0;
        blur += texture(tScene, suv0 + vec2(cos(ang), sin(ang)) * vec2(0.012, 0.016) * (1.0 + float(i & 1))).rgb;
      }
      blur = blur / 8.0;
      float band = step(0.18, local.y) * step(local.y, 0.86);
      col = mix(col, blur * 0.9 + uAmbient * 0.6 + refl * F, band * 0.88);
      a = mix(a, 0.92, band);
    } else if (kind == ${GLASS_TAPED}.0) {
      // Masking-tape cross corner to corner, the window someone braced for.
      vec2 p = local;
      float w = 0.028;
      float d = min(seg(p, vec2(0.04, 0.05), vec2(0.96, 0.95)), seg(p, vec2(0.04, 0.95), vec2(0.96, 0.05)));
      float tape = 1.0 - smoothstep(w, w + 0.006, d);
      float torn = step(0.12, gn(p * 30.0 + seed * 11.0));
      tape *= torn;
      vec3 tapeCol = vec3(0.62, 0.55, 0.4) * (lightHere * 0.9 + 0.02);
      col = mix(col, tapeCol, tape);
      a = mix(a, 0.97, tape);
    } else if (kind == ${GLASS_CRACKED}.0) {
      // Impact star: radial fractures plus a concentric ring.
      vec2 c = vec2(0.25 + 0.5 * gh(vec2(seed, 9.0)), 0.3 + 0.45 * gh(vec2(seed, 13.0)));
      vec2 q = (local - c) * vec2(1.0, 0.75);
      float r = length(q);
      float ang = atan(q.y, q.x);
      float rays = 9.0;
      float sector = floor((ang + 3.14159) / 6.28318 * rays);
      float jitter = (gh(vec2(sector, seed)) - 0.5) * 0.3;
      float centre = (sector + 0.5 + jitter) / rays * 6.28318 - 3.14159;
      float da = abs(ang - centre) * r;
      float reach = 0.25 + 0.5 * gh(vec2(sector + 3.0, seed));
      float crack = (1.0 - smoothstep(0.0015, 0.004, da)) * (1.0 - smoothstep(reach * 0.8, reach, r));
      float ring = (1.0 - smoothstep(0.0, 0.004, abs(r - 0.07 - 0.03 * gn(vec2(ang * 3.0, seed))))) * step(r, 0.12);
      float k = max(crack, ring);
      col += (lightHere * 1.5 + refl * 0.5) * k * 0.6;
      a += k * 0.45;
    } else if (kind == ${GLASS_WIRED}.0) {
      // Georgian wired safety glass: a 12.5 mm square mesh cast into a
      // thicker, faintly green pane. Filtered by its screen footprint so the
      // mesh fades to its average cover instead of shimmering at distance.
      vec2 g = pane / 0.0125;
      vec2 fw = max(fwidth(g), vec2(1e-4));
      vec2 toLine = 0.5 - abs(fract(g) - 0.5);
      float w = 0.05;
      vec2 cov = 1.0 - smoothstep(vec2(w) - fw, vec2(w) + fw, toLine);
      cov = mix(cov, vec2(2.0 * w), smoothstep(0.25, 0.6, fw));
      float wire = max(cov.x, cov.y);
      col += lightHere * vec3(0.016, 0.022, 0.018);
      a += 0.07;
      col = mix(col, lightHere * 0.06 + refl * F * 0.5, wire);
      a = mix(a, 0.92, wire);
    }

    float dist = length(cameraPosition - vWorldPos);
    float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
    float keep = (1.0 - fog) * uStrength;
    a = clamp(a, 0.0, 0.97) * keep;
    outColor = vec4(col * keep, a);
  }
`

export function createGlassMaterial() {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      tDepth: { value: null },
      tScene: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uFogColor: { value: new THREE.Color(0, 0, 0) },
      uFogDensity: { value: 0 },
      uAmbient: { value: new THREE.Color(0.02, 0.02, 0.03) },
      uStrength: { value: 1 },
      tLampData: { value: null },
      uLampCount: { value: 0 },
      uLampColor: { value: new THREE.Color(1, 1, 1) },
      uLampFlicker: { value: 1 },
      uLampGlow: { value: 3 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  })
}
