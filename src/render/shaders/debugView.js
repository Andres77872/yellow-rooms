import { COLOR_FNS } from './common.js'

// --- Debug channel viewer: blit one intermediate buffer straight to screen. ---
// uMode: 1 albedo · 2 matID · 3 view-normal · 4 linear depth · 5 AO · 6 lit ·
//        7 volumetrics · 8 bloom · 9 composite. (0 disables; the renderer skips it.)
export const DEBUG_VIEW_FRAG = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform int uMode;
  uniform sampler2D tColor, tNormal, tDepth, tAO, tLit, tVol, tBloom, tScene;
  uniform mat4 uProjInverse;
  uniform float uDepthScale; // 1.0 / camera.far
  ${COLOR_FNS}
  void main(){
    vec3 o;
    if (uMode == 1)      o = texture(tColor, vUv).rgb;            // albedo (linear)
    else if (uMode == 2) o = vec3(texture(tColor, vUv).a * 0.5); // matID {0,1,2}->{0,.5,1}
    else if (uMode == 3) o = texture(tNormal, vUv).rgb;          // encoded view normal
    else if (uMode == 4) {                                       // linearized depth
      float d = texture(tDepth, vUv).x;
      if (d >= 1.0) { o = vec3(1.0); }
      else {
        vec4 v = uProjInverse * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
        v /= v.w;
        o = vec3(clamp(-v.z * uDepthScale, 0.0, 1.0));
      }
    }
    else if (uMode == 5) o = vec3(texture(tAO, vUv).r);          // AO
    else if (uMode == 6) o = texture(tLit, vUv).rgb;             // lit HDR
    else if (uMode == 7) o = texture(tVol, vUv).rgb;             // volumetrics
    else if (uMode == 8) o = texture(tBloom, vUv).rgb;           // bloom
    else                 o = texture(tScene, vUv).rgb;           // composite (9)
    // Linear HDR channels need the sRGB encode; the rest are already display-ready.
    if (uMode == 1 || uMode >= 6) o = linearToSRGB(o);
    outColor = vec4(o, 1.0);
  }
`
