import { ZONE_OFFICE, ZONE_PILLARS, ZONE_WAREHOUSE } from './constants.js'
import { domainWarp2D, valueNoise2D } from './core/noise.js'
import { hash3i } from './core/hash.js'

const U32 = 4294967296

const finite = (value, fallback) => Number.isFinite(value) ? value : fallback
const integer = (value, fallback, minimum = 0) =>
  Math.max(minimum, Math.floor(finite(value, fallback)))
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value))

export function roomDominanceConfig(config) {
  const raw = config?.region?.roomDominance || {}
  const districtChunks = integer(raw.districtChunks, 6, 3)
  const maxMargin = Math.max(1, Math.floor((districtChunks - 1) / 2))
  const marginChunks = clamp(integer(raw.marginChunks, 1, 1), 1, maxMargin)
  const available = Math.max(1, districtChunks - marginChunks * 2)
  const minSpanChunks = clamp(integer(raw.minSpanChunks, 1, 1), 1, available)
  const maxSpanChunks = clamp(
    integer(raw.maxSpanChunks, 2, minSpanChunks),
    minSpanChunks,
    available
  )
  const heroMinSpanChunks = clamp(
    integer(raw.heroMinSpanChunks, 3, 1),
    1,
    available
  )
  const heroMaxSpanChunks = clamp(
    integer(raw.heroMaxSpanChunks, 4, heroMinSpanChunks),
    heroMinSpanChunks,
    available
  )
  return {
    enabled: raw.enabled !== false,
    districtChunks,
    marginChunks,
    minSpanChunks,
    maxSpanChunks,
    heroMinSpanChunks,
    heroMaxSpanChunks,
    heroChance: clamp(finite(raw.heroChance, 0.3), 0, 1),
    chance: clamp(finite(raw.chance, 0.8), 0, 1),
    minOfficeShare: clamp(finite(raw.minOfficeShare, 0.75), 0, 1),
    spawnOfficeRadius: integer(raw.spawnOfficeRadius, 1, 0),
    salt: finite(raw.salt, 0x4c41) | 0,
    spanSalt: finite(raw.spanSalt, 0x5350) | 0,
    heroSalt: finite(raw.heroSalt, 0x4845) | 0,
    signatureSalt: finite(raw.signatureSalt, 0x5347) | 0,
    positionSalt: finite(raw.positionSalt, 0x504f) | 0,
    shapeSalt: finite(raw.shapeSalt, 0x5348) | 0,
  }
}

const districtCoord = (chunk, size) => Math.floor(chunk / size)

function footprintContains(landmark, cx, cz) {
  if (
    !landmark?.active ||
    cx < landmark.x0 || cx > landmark.x1 ||
    cz < landmark.z0 || cz > landmark.z1
  ) return false
  if (!landmark.notch) return true
  return cx !== landmark.notch.cx || cz !== landmark.notch.cz
}

export const regionLandmarkContains = footprintContains

// One immutable, rootless (layer-seed keyed) open-space descriptor per macro
// district. Every requested chunk can recover the same footprint without
// generation order or neighbour communication. The footprint always retains
// an office margin around the district, so two open landmarks can never merge
// across district boundaries.
export function regionLandmark(seed, districtX, districtZ, config) {
  const cfg = roomDominanceConfig(config)
  const K = cfg.districtChunks
  const originCx = districtX * K
  const originCz = districtZ * K
  const sampleCx = originCx + Math.floor(K / 2)
  const sampleCz = originCz + Math.floor(K / 2)
  const sampledZone = selectRawZone(sampleCx, sampleCz, seed, config)
  const spacingPhase = hash3i(
    (seed ^ cfg.salt) | 0,
    0,
    0,
    0x5048
  ) & 1
  const spacingEligible = ((districtX + districtZ) & 1) === spacingPhase
  const presentRoll = hash3i(
    (seed ^ cfg.salt) | 0,
    districtX,
    districtZ,
    0x4c4d
  ) / U32
  const active = cfg.enabled && spacingEligible && presentRoll < cfg.chance
  if (!active) {
    return Object.freeze({
      active: false,
      districtX,
      districtZ,
      districtChunks: K,
      sampledZone,
      spacingPhase,
    })
  }

  const hero = hash3i(
    (seed ^ cfg.heroSalt) | 0,
    districtX,
    districtZ,
    0x484f
  ) / U32 < cfg.heroChance
  const minSpan = hero ? cfg.heroMinSpanChunks : cfg.minSpanChunks
  const maxSpan = hero ? cfg.heroMaxSpanChunks : cfg.maxSpanChunks
  const spanRange = maxSpan - minSpan + 1
  const spanHash = hash3i(
    (seed ^ cfg.spanSalt) | 0,
    districtX,
    districtZ,
    0x535a
  )
  const width = minSpan + (spanHash % spanRange)
  const height = minSpan + ((spanHash >>> 8) % spanRange)
  const usableStart = cfg.marginChunks
  const usableEnd = K - cfg.marginChunks - 1
  const xSlots = usableEnd - usableStart - width + 2
  const zSlots = usableEnd - usableStart - height + 2
  const positionHash = hash3i(
    (seed ^ cfg.positionSalt) | 0,
    districtX,
    districtZ,
    0x504c
  )
  const localX0 = usableStart + (positionHash % xSlots)
  const localZ0 = usableStart + ((positionHash >>> 8) % zSlots)
  const x0 = originCx + localX0
  const z0 = originCz + localZ0
  const x1 = x0 + width - 1
  const z1 = z0 + height - 1

  const signatureHash = hash3i(
    (seed ^ cfg.signatureSalt) | 0,
    districtX,
    districtZ,
    0x5349
  )

  // A missing outer corner breaks the repeated rectangle silhouette while
  // preserving one connected footprint. Two-cell spans stay rectangular.
  let notch = null
  if (width >= 3 && height >= 3) {
    const shapeHash = hash3i(
      (seed ^ cfg.shapeSalt) | 0,
      districtX,
      districtZ,
      0x4e43
    )
    if ((shapeHash & 3) !== 0) {
      const corner = (shapeHash >>> 2) & 3
      notch = Object.freeze({
        cx: corner === 0 || corner === 2 ? x0 : x1,
        cz: corner < 2 ? z0 : z1,
      })
    }
  }

  const kind = hero && sampledZone === ZONE_WAREHOUSE
    ? 'warehouseCourt'
    : 'pillarHall'
  const axis = width > height
    ? 'x'
    : height > width
      ? 'z'
      : (signatureHash & 1) === 0 ? 'x' : 'z'
  const patternRoll = (signatureHash >>> 1) & 3
  const pierPattern = kind === 'warehouseCourt'
    ? 'courtColonnade'
    : hero
      ? patternRoll < 2 ? 'brokenBay' : 'monumentalGrid'
      : patternRoll < 2 ? 'processionalAisle' : 'monumentalGrid'

  return Object.freeze({
    active: true,
    districtX,
    districtZ,
    districtChunks: K,
    sampledZone,
    spacingPhase,
    hero,
    intensityRole: hero ? 'hero' : 'ordinary',
    // A warehouse needs a colonnade plus a real inner court, so keep that
    // character for the rare 3-4 chunk hero footprints. Compact landmarks are
    // bounded hypostyle rooms even when the warped style sample is warehouse.
    kind,
    axis,
    pierPattern,
    landmarkSignature: `${pierPattern}:${axis}:${notch ? 'notched' : 'rect'}`,
    x0,
    z0,
    x1,
    z1,
    width,
    height,
    notch,
  })
}

export function regionLandmarkAt(cx, cz, seed, config) {
  const cfg = roomDominanceConfig(config)
  return regionLandmark(
    seed,
    districtCoord(cx, cfg.districtChunks),
    districtCoord(cz, cfg.districtChunks),
    config
  )
}

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
  const dominance = roomDominanceConfig(config)
  // A single explicit band is a useful designer/test override ("show only
  // this archetype"). Do not silently replace it with the default room fabric.
  const forcedProfile = config.zoneBands?.length === 1
  if (!dominance.enabled || forcedProfile) {
    const raw = selectRawZone(cx, cz, seed, config)
    if (!config.region.bufferTransitions || raw !== ZONE_WAREHOUSE) return raw

    for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      if (selectRawZone(cx + dx, cz + dz, seed, config) === ZONE_OFFICE) {
        return ZONE_PILLARS
      }
    }
    return raw
  }

  if (
    Math.abs(cx) <= dominance.spawnOfficeRadius &&
    Math.abs(cz) <= dominance.spawnOfficeRadius
  ) return ZONE_OFFICE

  const landmark = regionLandmarkAt(cx, cz, seed, config)
  if (!footprintContains(landmark, cx, cz)) return ZONE_OFFICE
  if (landmark.kind === 'pillarHall') return ZONE_PILLARS

  // Warehouse courts are wrapped in a one-chunk colonnade. It supplies a
  // readable threshold and guarantees that office never meets the emptiest
  // archetype directly, even around a notched footprint.
  for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    if (!footprintContains(landmark, cx + dx, cz + dz)) return ZONE_PILLARS
  }
  return ZONE_WAREHOUSE
}
