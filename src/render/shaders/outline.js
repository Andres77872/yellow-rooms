// Ink outline: depth + normal Sobel straight off the G-buffer, faded by the
// SAME exp^2 fog transmittance the lighting pass applies to surfaces (plus a
// wide smoothstep safety envelope), so lines die exactly when the surface
// melts into the haze — never ghost-wireframes floating on fog.
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
    // Fog term must use the RADIAL view-space distance (full-NDC unproject),
    // exactly like the lighting pass — the axial viewZ under-fades by 1/cos of
    // the view ray (1.6-1.8x at 16:9 edges/corners), which left ghost ink
    // floating on fully fogged surfaces in the outer third of the screen.
    vec4 vpc = uProjInverse * vec4(vUv * 2.0 - 1.0, texture(tDepth, vUv).x * 2.0 - 1.0, 1.0);
    float rdist = length(vpc.xyz / vpc.w);
    float fogT = exp(-uFogDensity * uFogDensity * rdist * rdist);
    // Entities (matID 2) keep a crisp ink silhouette at ANY distance — a black
    // outline lingering in the haze long after the body melts is the point.
    float matID = texture(tColor, vUv).a;
    float fade = (matID > 1.5 && matID < 2.5) ? 1.0 : distFade * fogT;
    float edge = clamp(step(uDepthThresh, dd) + step(uNormalThresh, nd), 0.0, 1.0) * fade;
    outColor = vec4(mix(base, uInk, edge), 1.0);
  }
`
