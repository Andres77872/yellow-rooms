// --- Emissive bloom: selective by matID (only lamps/exit), blurred ---------
export const BLOOM_PREFILTER_FRAG = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tLit;
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  void main(){
    // The G-buffer clears with alpha=1 (matID 1 == emissive), so uncovered void
    // pixels would wrongly bloom the fog color. Gate on depth so only real
    // emissive geometry (lamps/exit) contributes.
    float depth = texture(tDepth, vUv).x;
    float matID = texture(tColor, vUv).a;
    vec3 c = texture(tLit, vUv).rgb;
    bool emissive = depth < 1.0 && matID > 0.5 && matID < 1.5;
    outColor = vec4(emissive ? c : vec3(0.0), 1.0);
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
