// Compact FXAA (Timothy Lottes, public domain) on the final LDR image.
export const FXAA_FRAG = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;
  void main(){
    vec3 luma = vec3(0.299, 0.587, 0.114);
    vec3 rgbNW = texture(tDiffuse, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
    vec3 rgbNE = texture(tDiffuse, vUv + vec2(1.0, -1.0) * uTexel).rgb;
    vec3 rgbSW = texture(tDiffuse, vUv + vec2(-1.0, 1.0) * uTexel).rgb;
    vec3 rgbSE = texture(tDiffuse, vUv + vec2(1.0, 1.0) * uTexel).rgb;
    vec3 rgbM = texture(tDiffuse, vUv).rgb;
    float lNW = dot(rgbNW, luma), lNE = dot(rgbNE, luma);
    float lSW = dot(rgbSW, luma), lSE = dot(rgbSE, luma), lM = dot(rgbM, luma);
    float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
    float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
    vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
    float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
    float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
    dir = clamp(dir * rcp, -8.0, 8.0) * uTexel;
    vec3 rA = 0.5 * (texture(tDiffuse, vUv + dir * (1.0 / 3.0 - 0.5)).rgb
                   + texture(tDiffuse, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
    vec3 rB = rA * 0.5 + 0.25 * (texture(tDiffuse, vUv + dir * -0.5).rgb
                               + texture(tDiffuse, vUv + dir * 0.5).rgb);
    float lB = dot(rB, luma);
    outColor = vec4((lB < lMin || lB > lMax) ? rA : rB, 1.0);
  }
`
