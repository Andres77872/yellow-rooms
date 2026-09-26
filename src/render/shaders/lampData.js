import * as THREE from 'three'
import { LIGHT_MAX } from '../../world/constants.js'

// Legacy lamp set as a data texture (engine-improvement chapter 12 §3.5).
// The frustum-compacted nearest-lamp set used to travel as two uniform
// arrays — 144 of the 224 fragment uniform vectors WebGL 2 guarantees — in
// three passes at once, which left no room for fixture shape, flashlight
// shadow or capsule data. It now rides one LIGHT_MAX x 2 RGBA32F texture:
//   row 0  view-space position (xyz)
//   row 1  character: rgb tint, a = flicker x query-edge fade
// DeferredRenderer._updateFrame still compacts into the JS arrays (tests and
// tools read them) and mirrors the live prefix into the texture each frame.
export const LAMP_DATA_GLSL = /* glsl */ `
  uniform highp sampler2D tLampData;
  vec3 lampViewPos(int i){ return texelFetch(tLampData, ivec2(i, 0), 0).xyz; }
  vec4 lampChar(int i){ return texelFetch(tLampData, ivec2(i, 1), 0); }
`

export function createLampDataTexture() {
  const data = new Float32Array(LIGHT_MAX * 2 * 4)
  const tex = new THREE.DataTexture(data, LIGHT_MAX, 2, THREE.RGBAFormat, THREE.FloatType)
  tex.minFilter = THREE.NearestFilter
  tex.magFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.needsUpdate = true
  return tex
}

// Mirror the first `count` compacted lamps into the texture. Only the used
// prefix of each row is rewritten; the shaders never read past uLampCount.
export function packLampData(tex, viewPos, char, count) {
  const d = tex.image.data
  const row = LIGHT_MAX * 4
  for (let i = 0; i < count; i++) {
    const p = viewPos[i]
    const c = char[i]
    const o = i * 4
    d[o] = p.x
    d[o + 1] = p.y
    d[o + 2] = p.z
    d[o + 3] = 1
    d[row + o] = c.x
    d[row + o + 1] = c.y
    d[row + o + 2] = c.z
    d[row + o + 3] = c.w
  }
  tex.needsUpdate = true
}
