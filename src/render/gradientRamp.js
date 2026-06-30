import * as THREE from 'three'

// Quantised N·L ramp (1D LUT) for the deferred per-lamp cel term — sampled by
// band() in the lighting shader. NearestFilter is MANDATORY — linear filtering
// interpolates the steps and silently degrades cel shading back to smooth
// gradients (the #1 cel-shading mistake).
export function makeToonGradient(steps = 4, floor = 0.0) {
  // `steps` controls how many hard cel bands the lit side shows. `floor` is the
  // value at N·L=0: the deferred caller uses a small CEL_FLOOR (~0.06) so grazing
  // / under-facing walls keep a dim warm step (the half-Lambert wrap already
  // lifts them) instead of snapping to black; the warm hemispheric ambient fills
  // the truly unlit zones. Pass floor=0 for a hard terminator with no back-face fill.
  const data = new Uint8Array(steps)
  for (let i = 0; i < steps; i++) {
    data[i] = Math.round((floor + (1 - floor) * (i / (steps - 1))) * 255)
  }
  const tex = new THREE.DataTexture(data, steps, 1, THREE.RedFormat)
  tex.minFilter = THREE.NearestFilter
  tex.magFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.colorSpace = THREE.NoColorSpace
  tex.needsUpdate = true
  return tex
}
