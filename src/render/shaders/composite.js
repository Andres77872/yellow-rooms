// Composite lit + volumetrics + bloom into a single linear buffer.
export const COMPOSITE_FRAG = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tInput;
  uniform sampler2D tVol;
  uniform sampler2D tBloom;      // tight halo (half res)
  uniform sampler2D tBloomWide;  // wide veil (quarter res)
  uniform float uVolIntensity;
  uniform float uBloomIntensity;
  uniform float uBloomWide;
  void main(){
    outColor = vec4(
      texture(tInput, vUv).rgb
        + texture(tVol, vUv).rgb * uVolIntensity
        + texture(tBloom, vUv).rgb * uBloomIntensity
        + texture(tBloomWide, vUv).rgb * uBloomWide,
      1.0);
  }
`
