import { ZONE_OFFICE, ZONE_PILLARS, ZONE_WAREHOUSE } from './constants.js'
import { domainWarp2D, valueNoise2D } from './core/noise.js'

export function sampleRegionValue(cx, cz, seed, config) {
  const { scale, salt, warpAmp = 0, octaves = 3, lacunarity = 2, gain = 0.5 } = config.region
  const x = cx / scale
  const z = cz / scale
  if (warpAmp <= 0) return valueNoise2D(x, z, (seed ^ salt) | 0)
  return domainWarp2D(x, z, {
    amp: warpAmp,
    octaves,
    lacunarity,
    gain,
    seed: (seed ^ salt) | 0,
  })
}

export function selectRawZone(cx, cz, seed, config) {
  const v = sampleRegionValue(cx, cz, seed, config)
  for (const band of config.zoneBands) {
    if (v < band.max) return band.id
  }
  return config.zoneBands[config.zoneBands.length - 1].id
}

export function selectZone(cx, cz, seed, config) {
  const raw = selectRawZone(cx, cz, seed, config)
  if (!config.region.bufferTransitions || raw !== ZONE_WAREHOUSE) return raw

  // Morphologically erode warehouse cells along raw office boundaries. This
  // guarantees a pillars handoff even when the scalar crosses both thresholds
  // between two adjacent chunk samples.
  for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    if (selectRawZone(cx + dx, cz + dz, seed, config) === ZONE_OFFICE) {
      return ZONE_PILLARS
    }
  }
  return raw
}
