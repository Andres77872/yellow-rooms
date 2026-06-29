import * as THREE from 'three'

// Quantised lighting ramp for MeshToonMaterial. NearestFilter is MANDATORY —
// linear filtering interpolates the steps and silently degrades the toon
// material back to plain Phong shading (the #1 cel-shading mistake).
export function makeToonGradient(steps = 4, floor = 0.0) {
  // Quantised N·L ramp. For the deferred per-lamp term we use floor=0 so a
  // surface facing away from a lamp gets no contribution (the warm hemispheric
  // ambient fills shadows instead); a lifted floor would leak light onto back
  // faces. `steps` controls how many hard cel bands the lit side shows.
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
