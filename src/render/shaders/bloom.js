// --- Bloom: emissives in full + the soft-kneed HDR excess of lit surfaces ---
export const BLOOM_PREFILTER_FRAG = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tLit;
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform float uThreshold;   // HDR level where lit surfaces start to glow
  uniform float uKnee;        // soft-knee width around the threshold
  uniform float uSurface;     // weight of the lit-surface excess vs emissives
  uniform float uClamp;       // look: emissive input clamp (0 = off) keeps a panel's glare rectangular
  void main(){
    // The G-buffer clears with alpha=1 (matID 1 == emissive), so uncovered void
    // pixels would wrongly bloom the fog color. Gate on depth so only real
    // geometry contributes.
    float depth = texture(tDepth, vUv).x;
    if (depth >= 1.0) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    float matID = texture(tColor, vUv).a;
    vec3 c = texture(tLit, vUv).rgb;
    // Emissives (lamps/exit/signs) glow in full; lit surfaces contribute only
    // their soft-kneed excess over the threshold, so a pool centre or a
    // flashlit wall halos faintly and mid-tones never haze the frame.
    if (matID > 0.5 && matID < 1.5) { outColor = vec4(uClamp > 0.0 ? min(c, vec3(uClamp)) : c, 1.0); return; }
    float peak = max(c.r, max(c.g, c.b));
    float soft = clamp(peak - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 1e-4);
    float w = max(soft, peak - uThreshold) / max(peak, 1e-4);
    outColor = vec4(c * (w * uSurface), 1.0);
  }
`

export const BLOOM_BLUR_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tInput;
  uniform vec2 uDir;
  void main(){
    float w[5] = float[](0.227027, 0.194594, 0.121622, 0.054054, 0.016216);
    vec3 s = texture(tInput, vUv).rgb * w[0];
    for (int i = 1; i < 5; i++){
      s += texture(tInput, vUv + uDir * float(i)).rgb * w[i];
      s += texture(tInput, vUv - uDir * float(i)).rgb * w[i];
    }
    outColor = vec4(s, 1.0);
  }
`
