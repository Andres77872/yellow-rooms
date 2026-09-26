import { DEPTH_PX } from './common.js'

// Camera motion blur (chapter 14 P26, opt-in). Reprojects each pixel's world
// position into the previous frame's view-projection to get its camera-
// motion velocity, then gathers 8 taps along it in HDR (after the composite,
// before the grade). Taps more than 5% closer than the centre are rejected so
// the foreground never smears over what it hides. Enemies have no velocity
// buffer, so they blur with the camera only (accepted).
export const MOTION_BLUR_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tScene;
  uniform sampler2D tDepth;
  uniform mat4 uProjInverse;
  uniform mat4 uCamToWorld;
  uniform mat4 uPrevViewProj;
  uniform float uBlur;           // shutter fraction x look strength
  ${DEPTH_PX}
  void main(){
    ivec2 fs = textureSize(tDepth, 0);
    ivec2 px = ivec2(gl_FragCoord.xy);
    vec3 P = viewPosPx(px, fs);
    vec3 Pw = (uCamToWorld * vec4(P, 1.0)).xyz;
    vec4 c = uPrevViewProj * vec4(Pw, 1.0);
    vec3 centre = texture(tScene, vUv).rgb;
    if (c.w <= 1e-4) { outColor = vec4(centre, 1.0); return; }
    vec2 uvPrev = c.xy / c.w * 0.5 + 0.5;
    vec2 vel = clamp((vUv - uvPrev) * uBlur, vec2(-0.04), vec2(0.04));
    if (length(vel * vec2(fs)) < 0.75) { outColor = vec4(centre, 1.0); return; }
    float zc = -P.z;
    vec3 sum = vec3(0.0);
    float ws = 0.0;
    for (int i = 0; i < 8; i++) {
      vec2 uv = vUv + vel * ((float(i) + 0.5) / 8.0 - 0.5);
      ivec2 sp = clamp(ivec2(uv * vec2(fs)), ivec2(0), fs - 1);
      float zs = -viewPosPx(sp, fs).z;
      float w = zs < zc * 0.95 ? 0.0 : 1.0;
      sum += texture(tScene, uv).rgb * w;
      ws += w;
    }
    outColor = vec4(ws > 0.5 ? sum / ws : centre, 1.0);
  }
`
