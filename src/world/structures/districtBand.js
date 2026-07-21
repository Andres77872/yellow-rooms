import { hash3i } from '../core/hash.js'

// Shared district/band planning machinery. Every structure family recovers its
// canonical descriptor the same way — split the chunk grid into K-chunk
// districts, hash a per-district vertical phase, snap any floor to its band
// base — and each planner used to carry its own copy of this math. One
// implementation keeps the families bit-compatible with their legacy hash
// streams (the hash inputs are unchanged) while making the shared cadence
// impossible to fork accidentally.

// Hard ceiling for any structure band's top floor.
export const MAX_STRUCTURE_TOP_CY = 64

// Vertical band cadence shared by the fixed-height planners (tower, lattice).
// Office multilevel keeps its own configurable verticalPeriod.
export const STRUCTURE_VERTICAL_PERIOD = 17

export function districtCoordinate(chunkCoordinate, districtChunks) {
  return Math.floor(chunkCoordinate / districtChunks)
}

export function plannerHash(seed, salt, districtX, bandIndex, districtZ) {
  return hash3i(
    ((seed >>> 0) ^ salt) | 0,
    districtX,
    bandIndex,
    districtZ
  )
}

export function verticalBandPhase(
  seed,
  phaseSalt,
  districtX,
  districtZ,
  verticalPeriod
) {
  return plannerHash(seed, phaseSalt, districtX, 0, districtZ) % verticalPeriod
}

export function bandBaseAtLevel(
  seed,
  phaseSalt,
  districtX,
  districtZ,
  levelCy,
  verticalPeriod
) {
  const phase = verticalBandPhase(
    seed,
    phaseSalt,
    districtX,
    districtZ,
    verticalPeriod
  )
  return phase + Math.floor((levelCy - phase) / verticalPeriod) * verticalPeriod
}

export function bandIndexAtBase(
  seed,
  phaseSalt,
  districtX,
  districtZ,
  baseCy,
  verticalPeriod
) {
  const phase = verticalBandPhase(
    seed,
    phaseSalt,
    districtX,
    districtZ,
    verticalPeriod
  )
  return (baseCy - phase) / verticalPeriod
}

export function participantKey(cx, cz) {
  return `${cx},${cz}`
}

const compareParticipants = (a, b) => a.cz - b.cz || a.cx - b.cx

export function canonicalParticipants(participants) {
  const unique = new Map()
  for (const participant of participants) {
    const key = participantKey(participant.cx, participant.cz)
    if (!unique.has(key)) unique.set(key, participant)
  }
  return [...unique.values()].sort(compareParticipants)
}

// Enumerate a district's candidate participant polygons. Pair mode retains its
// exact legacy enumeration and byte order; lattice is deliberately one complete
// KxK polygon rather than a generalized polyomino.
export function polygonCandidates(
  districtX,
  districtZ,
  normalized,
  { shape, bridgeAxis = null, avoidSpawn = false } = {}
) {
  if (
    shape === 'lattice' &&
    Number.isInteger(districtX) &&
    Number.isInteger(districtZ) &&
    Number.isInteger(normalized?.districtChunks) &&
    normalized.districtChunks >= 2
  ) {
    const K = normalized.districtChunks
    const originCx = districtX * K
    const originCz = districtZ * K
    const participants = []
    for (let localZ = 0; localZ < K; localZ++) {
      for (let localX = 0; localX < K; localX++) {
        participants.push({
          cx: originCx + localX,
          cz: originCz + localZ,
        })
      }
    }
    if (
      avoidSpawn &&
      participants.some(({ cx, cz }) => participantKey(cx, cz) === '0,0')
    ) return []
    return [{ anchor: participants[0], participants }]
  }

  if (
    shape !== 'pair' ||
    (bridgeAxis !== 'x' && bridgeAxis !== 'z') ||
    !Number.isInteger(normalized?.districtChunks) ||
    normalized.districtChunks < 2
  ) return []

  const K = normalized.districtChunks
  const originCx = districtX * K
  const originCz = districtZ * K
  const candidates = []

  const xCount = bridgeAxis === 'x' ? K - 1 : K
  const zCount = bridgeAxis === 'z' ? K - 1 : K
  for (let localZ = 0; localZ < zCount; localZ++) {
    for (let localX = 0; localX < xCount; localX++) {
      const anchor = { cx: originCx + localX, cz: originCz + localZ }
      const neighbor = bridgeAxis === 'x'
        ? { cx: anchor.cx + 1, cz: anchor.cz }
        : { cx: anchor.cx, cz: anchor.cz + 1 }
      if (
        avoidSpawn &&
        (participantKey(anchor.cx, anchor.cz) === '0,0' ||
          participantKey(neighbor.cx, neighbor.cz) === '0,0')
      ) continue
      const participants = canonicalParticipants([anchor, neighbor])
      if (participants.length !== 2) continue
      candidates.push({ anchor: participants[0], participants })
    }
  }
  return candidates
}
