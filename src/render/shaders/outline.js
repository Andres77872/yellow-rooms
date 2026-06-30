// Ink outline: depth + normal Sobel straight off the G-buffer, distance-faded.
export const OUTLINE_FRAG = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tDiffuse;
  uniform sampler2D tNormal;
  uniform sampler2D tDepth;
  uniform mat4 uProjInverse;     // per-frame, matches the live camera
  uniform float uDepthScale;     // 1.0 / camera.far -> normalized linear depth
  uniform vec2 uTexel;
  uniform float uThickness, uDepthThresh, uNormalThresh, uFadeNear, uFadeFar;
  uniform vec3 uInk;
  // Normalized [0,1] linear depth from the live projection. For a perspective
  // matrix view-Z depends only on clip-space z, so x/y can be 0. This replaces
  // the old build-time NEAR/FAR bake and matches the rest of the pipeline.
  float lin(float d){
    vec4 v = uProjInverse * vec4(0.0, 0.0, d * 2.0 - 1.0, 1.0);
    return clamp(-(v.z / v.w) * uDepthScale, 0.0, 1.0);
  }
  vec3 nrm(vec2 uv){ return normalize(texture(tNormal, uv).xyz * 2.0 - 1.0); }
  void main(){
    vec3 base = texture(tDiffuse, vUv).rgb;
    vec2 t = uTexel * uThickness;
    float dc = lin(texture(tDepth, vUv).x);
    float dd = abs(dc - lin(texture(tDepth, vUv + vec2(t.x, 0.0)).x))
             + abs(dc - lin(texture(tDepth, vUv - vec2(t.x, 0.0)).x))
             + abs(dc - lin(texture(tDepth, vUv + vec2(0.0, t.y)).x))
             + abs(dc - lin(texture(tDepth, vUv - vec2(0.0, t.y)).x));
    vec3 nc = nrm(vUv);
    float nd = (1.0 - dot(nc, nrm(vUv + vec2(t.x, 0.0))))
             + (1.0 - dot(nc, nrm(vUv - vec2(t.x, 0.0))))
             + (1.0 - dot(nc, nrm(vUv + vec2(0.0, t.y))))
             + (1.0 - dot(nc, nrm(vUv - vec2(0.0, t.y))));
    float distFade = 1.0 - smoothstep(uFadeNear, uFadeFar, dc);
    float edge = clamp(step(uDepthThresh, dd) + step(uNormalThresh, nd), 0.0, 1.0) * distFade;
    outColor = vec4(mix(base, uInk, edge), 1.0);
  }
`
