// Shared GLSL snippets for the deferred fullscreen passes. Injected into the
// per-pass fragment shaders with ${...} template interpolation. Keeping these in
// one place means the lighting / SSAO / volumetric / grade passes can't drift on
// the noise hash or the depth-reconstruction math they all depend on.
//
// Implicit contract: snippets that read the depth buffer assume the including
// shader declares `uniform sampler2D tDepth;` and `uniform mat4 uProjInverse;`
// (every depth-consuming pass already does), exactly like the existing IGN /
// COLOR_FNS pattern.

// Format a JS number as a GLSL float literal. Integer-valued constants (3.0, 4.0)
// would otherwise inject as `3`/`4`, which are int literals and break float-typed
// GLSL calls like pow(x, 3). Use ONLY for float contexts — pass integer #define
// values (LIGHT_MAX, *_STEPS) through raw so they stay ints.
export const glslFloat = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n))

// Fullscreen-triangle/quad vertex stage shared by every post pass.
export const FS_VERT = /* glsl */ `
  precision highp float;
  in vec3 position;
  in vec2 uv;
  out vec2 vUv;
  void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

// Linear -> sRGB OETF (manual; RawShaderMaterial gets no auto color conversion).
export const COLOR_FNS = /* glsl */ `
  vec3 linearToSRGB(vec3 c){
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }
`

// Interleaved Gradient Noise (Jimenez). Pure-float, no sin/transcendentals and
// only tiny arguments, so it returns IDENTICAL well-distributed [0,1) noise on
// every WebGL2 backend — unlike the canonical fract(sin(dot(...))) hash, whose
// sin() of a large argument is implementation-defined and degenerates into
// correlated diagonal streaks on some drivers (notably ANGLE/NVIDIA-GL, i.e.
// Chromium/Brave on Linux). Feed it INTEGER pixel coords (gl_FragCoord.xy); fed
// 0..1 UVs the pattern collapses to ~constant.
export const IGN = /* glsl */ `
  float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`

// Cheap per-pixel hash used for raymarch start-jitter and grain. Driver-quality
// caveats apply (see IGN above); kept for the existing grain/jitter look.
export const HASH = /* glsl */ `
  float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
`

// Windowed lamp attenuation shared by the lighting, shadow and volumetric
// passes (and mirrored on the CPU by ChunkManager.lightAt for the AI). CUBIC,
// not quadratic: on the 12u lamp grid the quadratic window overlapped so many
// lamps that the summed field went flat — the cube makes each fixture cast a
// distinct pool that decays before the next one, which is what lets the light
// read as light instead of fog. Change all consumers together or the shadow
// mask / AI light sense drift off the visible pools.
export const LAMP_ATT = /* glsl */ `
  float lampAtt(float d, float range){
    float x = clamp(1.0 - d / range, 0.0, 1.0);
    return x * x * x;
  }
`

// View-space position / Z from the depth buffer (perspective unproject). Used by
// SSAO, the lighting shadow march and the volumetric occlusion taps.
// viewZAt exploits the symmetric-perspective inverse structure: its z-row is
// (0,0,0,-1) and its w-row is (0,0,ip23,ip33), so viewZ collapses to two MADs
// and a divide instead of a full mat4 transform. The bilateral blurs tap it 25x
// per pixel and the shadow/volumetric marches dozens of times, so this is one
// of the hottest expressions in the pipeline. Exact for every camera the game
// uses (PerspectiveCamera, symmetric frustum).
export const VIEW_RECON = /* glsl */ `
  vec3 viewPosFromDepth(vec2 uv){
    float d = texture(tDepth, uv).x;
    vec4 v = uProjInverse * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return v.xyz / v.w;
  }
  float viewZAt(vec2 uv){
    float ndcZ = texture(tDepth, uv).x * 2.0 - 1.0;
    return -1.0 / (ndcZ * uProjInverse[2][3] + uProjInverse[3][3]);
  }
`
