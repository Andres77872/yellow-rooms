import { describe, it, expect } from 'vitest'
import { buildChunk } from '../pipeline.js'
import { DEFAULT_WORLD_CONFIG as CFG } from '../config.js'
import {
  CHUNK,
  ZONE_OFFICE,
  ZONE_WAREHOUSE,
  chunkKey,
} from '../constants.js'
import {
  auditPatch,
  classifySeam,
  hSeamLine,
  vSeamLine,
} from '../audit.js'
import { PASSAGE_WIDE, WALL_PLAIN } from '../mapTypes.js'

// Proves canonical transition contracts remain safe while internal office
// chunk lines behave like ordinary cuts through a district plan:
//   - no open-zone, transition, or district-boundary contract is sealed;
//   - adjacent OPEN zones merge (near-fully-open seams);
//   - office<->open seams always have a wide transition MOUTH (smooth handoff);
//   - office district boundaries have sparse portals;
//   - internal district seam patterns vary and may be solid room walls.
// auditPatch is the same validator the debug world map uses.

const X0 = -7
const Z0 = -7
const N = 14
const SEEDS = [1, 42, 0xbeef, 314159, 0xc0ffee, 99999, 7, 2026]

const OFFICE_CONTINUITY_GOLDEN = [
  { seed: 1, open: 15, mouth: 14, office: 133, cornerWalls: 131, planned: 202, patterns: 55, officeChunks: 185, largestOpen: 11, maxOpenRun: 4 },
  { seed: 42, open: 0, mouth: 0, office: 140, cornerWalls: 139, planned: 224, patterns: 49, officeChunks: 196, largestOpen: 0, maxOpenRun: 0 },
  { seed: 0xbeef, open: 16, mouth: 20, office: 130, cornerWalls: 130, planned: 198, patterns: 67, officeChunks: 183, largestOpen: 11, maxOpenRun: 4 },
  { seed: 314159, open: 1, mouth: 6, office: 137, cornerWalls: 137, planned: 220, patterns: 57, officeChunks: 194, largestOpen: 2, maxOpenRun: 2 },
  { seed: 0xc0ffee, open: 1, mouth: 6, office: 137, cornerWalls: 136, planned: 220, patterns: 58, officeChunks: 194, largestOpen: 2, maxOpenRun: 2 },
  { seed: 99999, open: 4, mouth: 12, office: 136, cornerWalls: 136, planned: 212, patterns: 62, officeChunks: 191, largestOpen: 4, maxOpenRun: 2 },
  { seed: 7, open: 1, mouth: 10, office: 136, cornerWalls: 134, planned: 217, patterns: 53, officeChunks: 193, largestOpen: 2, maxOpenRun: 2 },
  { seed: 2026, open: 30, mouth: 28, office: 126, cornerWalls: 126, planned: 180, patterns: 56, officeChunks: 174, largestOpen: 11, maxOpenRun: 4 },
]

const inBounds = (bounds, gx, gz) =>
  gx >= bounds.x0 && gx <= bounds.x1 && gz >= bounds.z0 && gz <= bounds.z1

const participantsInclude = (structure, chunk) => structure.participants.some(
  ({ cx, cz }) => cx === chunk.cx && cz === chunk.cz
)

function sharedStructure(a, b, axis) {
  const structure = a.structure
  if (
    !structure ||
    structure.id !== b.structure?.id ||
    structure.bridgeAxis !== axis ||
    a.cy !== b.cy ||
    a.cy < structure.baseCy ||
    a.cy > structure.topCy ||
    !participantsInclude(structure, a) ||
    !participantsInclude(structure, b)
  ) return null
  return structure
}

function ownsVSeamCell(west, east, z) {
  const structure = sharedStructure(west, east, 'x')
  if (!structure) return false
  const carve = {
    x0: structure.globalBounds.x0 - 1,
    z0: structure.globalBounds.z0 - 1,
    x1: structure.globalBounds.x1 + 1,
    z1: structure.globalBounds.z1 + 1,
  }
  const gx = east.cx * CHUNK
  const gz = east.cz * CHUNK + z
  return inBounds(carve, gx - 1, gz) && inBounds(carve, gx, gz)
}

function ownsHSeamCell(north, south, x) {
  const structure = sharedStructure(north, south, 'z')
  if (!structure) return false
  const carve = {
    x0: structure.globalBounds.x0 - 1,
    z0: structure.globalBounds.z0 - 1,
    x1: structure.globalBounds.x1 + 1,
    z1: structure.globalBounds.z1 + 1,
  }
  const gx = south.cx * CHUNK + x
  const gz = south.cz * CHUNK
  return inBounds(carve, gx, gz - 1) && inBounds(carve, gx, gz)
}

// Office macro-border corners normally remain solid. A tall structure may
// deliberately cross that macro border, but only the exact footprint+gallery
// seam cells may override it, and those cells must carry a wide threshold.
function officeCornerEvidence(dataAt) {
  const result = { structureOwnedSeams: 0, invalid: [] }
  const check = (a, b, line, owns, passageAt, featureAt, axis, cx, cz) => {
    if (classifySeam(a.zone, b.zone, CFG, a, b) !== 'office') return
    const openCorners = [0, CHUNK - 1].filter((position) => line[position] === 0)
    if (openCorners.length === 0) return
    const invalid = openCorners.filter((position) =>
      !owns(a, b, position) ||
      passageAt(b, position) !== PASSAGE_WIDE ||
      featureAt(b, position) !== WALL_PLAIN
    )
    if (invalid.length > 0) {
      result.invalid.push({ axis, cx, cz, positions: invalid })
    } else {
      result.structureOwnedSeams++
    }
  }

  for (let cz = Z0; cz < Z0 + N; cz++) {
    for (let cx = X0; cx < X0 + N - 1; cx++) {
      const west = dataAt(cx, cz)
      const east = dataAt(cx + 1, cz)
      if (!west || !east) continue
      check(
        west,
        east,
        vSeamLine(east),
        ownsVSeamCell,
        (chunk, z) => chunk.passageVAt(0, z),
        (chunk, z) => chunk.wallFeatureVAt(0, z),
        'v',
        cx,
        cz
      )
    }
  }
  for (let cx = X0; cx < X0 + N; cx++) {
    for (let cz = Z0; cz < Z0 + N - 1; cz++) {
      const north = dataAt(cx, cz)
      const south = dataAt(cx, cz + 1)
      if (!north || !south) continue
      check(
        north,
        south,
        hSeamLine(south),
        ownsHSeamCell,
        (chunk, x) => chunk.passageHAt(x, 0),
        (chunk, x) => chunk.wallFeatureHAt(x, 0),
        'h',
        cx,
        cz
      )
    }
  }
  return result
}

function patch(seed) {
  const m = new Map()
  for (let cz = Z0; cz < Z0 + N; cz++) {
    for (let cx = X0; cx < X0 + N; cx++) m.set(chunkKey(cx, cz), buildChunk(seed, cx, 0, cz, CFG))
  }
  const dataAt = (cx, cz) => m.get(chunkKey(cx, cz)) ?? null
  const audit = auditPatch(dataAt, X0, Z0, N, N, CFG)
  audit.officeCornerEvidence = officeCornerEvidence(dataAt)
  return audit
}

function continuityPin(seed, audit) {
  return {
    seed,
    open: audit.open.n,
    mouth: audit.mouth.n,
    office: audit.office.n,
    cornerWalls: audit.office.cornerWalls,
    planned: audit.planned.n,
    patterns: audit.planned.patterns,
    officeChunks: audit.architecture.zoneCounts[ZONE_OFFICE],
    largestOpen: audit.architecture.largestOpenComponent,
    maxOpenRun: audit.architecture.maxOpenRun,
  }
}

function auditBelowOfficeShareFloor() {
  const size = CFG.region.roomDominance.districtChunks * 2
  const chunks = new Map()
  const openCells = []
  for (let cz = 0; cz < size; cz++) {
    for (let cx = 0; cx < size; cx++) {
      if ((cx + cz) % 2 === 0) openCells.push(chunkKey(cx, cz))
    }
  }
  const floor = CFG.region.roomDominance.minOfficeShare
  const openCount = Math.floor(size * size * (1 - floor)) + 1
  const openKeys = new Set(openCells.slice(0, openCount))

  for (let cz = 0; cz < size; cz++) {
    for (let cx = 0; cx < size; cx++) {
      chunks.set(chunkKey(cx, cz), {
        cx,
        cz,
        zone: openKeys.has(chunkKey(cx, cz)) ? ZONE_WAREHOUSE : ZONE_OFFICE,
        vAt: () => 0,
        hAt: () => 0,
      })
    }
  }

  return auditPatch(
    (cx, cz) => chunks.get(chunkKey(cx, cz)) ?? null,
    0,
    0,
    size,
    size,
    CFG
  )
}

describe('chunk continuity (not isolated boxes)', () => {
  const audits = SEEDS.map(patch)

  it('no canonical transition or district-boundary contract is sealed', () => {
    for (const a of audits) {
      expect(a.sealed).toBe(0)
      expect(a.minOpen).toBeGreaterThanOrEqual(1)
    }
  })

  it('adjacent open zones merge (seams stay mostly open)', () => {
    for (const a of audits) {
      if (a.open.n === 0) continue
      expect(a.openness).toBeGreaterThanOrEqual(0.85)
    }
  })

  it('office<->open transitions always carve a wide mouth', () => {
    for (const a of audits) {
      if (a.mouth.n === 0) continue
      expect(a.mouthCoverage).toBe(1) // every transition seam has a >= mouthWidth[0] run
    }
  })

  it('office district corners stay walled except at exact tall-structure cuts', () => {
    let exercised = 0
    for (const a of audits) {
      if (a.office.n === 0) continue
      expect(a.officeCornerEvidence.invalid).toEqual([])
      expect(
        a.office.cornerWalls + a.officeCornerEvidence.structureOwnedSeams
      ).toBe(a.office.n)
      expect(a.office.minDoors).toBeGreaterThanOrEqual(1)
      exercised += a.officeCornerEvidence.structureOwnedSeams
    }
    expect(exercised).toBeGreaterThan(0)
  })

  it('internal office seam slices have varied patterns instead of a periodic lattice', () => {
    for (const a of audits) {
      if (a.planned.n === 0) continue
      expect(a.planned.patterns).toBeGreaterThan(1)
      expect(a.planVariety).toBeGreaterThan(0.08)
    }
  })

  it('the test corpus actually exercises every seam category', () => {
    const sum = (k, sub) => audits.reduce((t, a) => t + a[k][sub], 0)
    expect(sum('open', 'n')).toBeGreaterThan(0)
    expect(sum('mouth', 'n')).toBeGreaterThan(0)
    expect(sum('office', 'n')).toBeGreaterThan(0)
    expect(sum('planned', 'n')).toBeGreaterThan(0)
  })

  it('pins the unchanged office transition and continuity corpus', () => {
    expect(SEEDS.map((seed, index) => continuityPin(seed, audits[index])))
      .toEqual(OFFICE_CONTINUITY_GOLDEN)
    for (const audit of audits) {
      expect(audit.sealed).toBe(0)
      expect(audit.minOpen).toBe(1)
      expect(audit.openness).toBe(1)
      expect(audit.mouthCoverage).toBe(1)
      expect(audit.portalCoverage).toBe(1)
      expect(audit.officeCornerEvidence.invalid).toEqual([])
    }
  })

  it('keeps the default office-share corpus independently gated at 0.75', () => {
    const floor = CFG.region.roomDominance.minOfficeShare
    expect(floor).toBe(0.75)
    for (const audit of audits) {
      expect(audit.architecture.officeShare).toBeGreaterThanOrEqual(floor)
      expect(audit.architecture.roomDominant).toBe(true)
    }
  })

  it('keeps an office-share regression visible below the independent floor', () => {
    const audit = auditBelowOfficeShareFloor()
    expect(audit.architecture.roomDominanceChecked).toBe(true)
    expect(audit.architecture.boundedOpen).toBe(true)
    expect(audit.architecture.officeShare)
      .toBeLessThan(CFG.region.roomDominance.minOfficeShare)
    expect(audit.architecture.roomDominant).toBe(false)
    expect(audit.architecture.ok).toBe(false)
  })

  it('reports room dominance and rejects the old unbounded-open failure mode', () => {
    const maxSpan = Math.max(
      CFG.region.roomDominance.maxSpanChunks,
      CFG.region.roomDominance.heroMaxSpanChunks
    )
    for (const a of audits) {
      expect(a.architecture.officeShare).toBeGreaterThan(0.7)
      expect(a.architecture.maxOpenRun).toBeLessThanOrEqual(maxSpan)
      expect(a.architecture.largestOpenComponent).toBeLessThanOrEqual(maxSpan * maxSpan)
      expect(a.architecture.roomDominant).toBe(true)
      expect(a.architecture.roomDominanceChecked).toBe(true)
      expect(a.architecture.boundedOpen).toBe(true)
      expect(a.architecture.ok).toBe(true)
    }
  })

  it('flags a continuous all-open custom patch even when its seam score is high', () => {
    const config = structuredClone(CFG)
    config.zoneBands = [{ id: ZONE_WAREHOUSE, max: 1.01 }]
    config.stairs.enabled = false
    config.multilevel.enabled = false
    const size = 6
    const chunks = new Map()
    for (let cz = 0; cz < size; cz++) {
      for (let cx = 0; cx < size; cx++) {
        chunks.set(chunkKey(cx, cz), buildChunk(77, cx, 0, cz, config))
      }
    }
    const audit = auditPatch(
      (cx, cz) => chunks.get(chunkKey(cx, cz)) ?? null,
      0,
      0,
      size,
      size,
      config
    )
    expect(audit.score).toBeGreaterThan(0.8)
    expect(audit.architecture.officeShare).toBe(0)
    expect(audit.architecture.largestOpenComponent).toBe(size * size)
    expect(audit.architecture.boundedOpen).toBe(false)
    expect(audit.architecture.ok).toBe(false)
  })

  it('flags a skinny open run even when its area fits the component cap', () => {
    const openChunk = { zone: ZONE_WAREHOUSE, vAt: () => 0, hAt: () => 0 }
    const width = 16
    const audit = auditPatch(
      (cx, cz) => cx >= 0 && cx < width && cz === 0 ? openChunk : null,
      0,
      0,
      width,
      1,
      CFG
    )
    expect(audit.architecture.largestOpenComponent).toBe(16)
    expect(audit.architecture.openComponentCap).toBe(16)
    expect(audit.architecture.maxOpenRun).toBe(16)
    expect(audit.architecture.openRunCap).toBe(4)
    expect(audit.architecture.boundedOpen).toBe(false)
    expect(audit.architecture.ok).toBe(false)
  })

  it('derives audit caps from normalized span configuration', () => {
    const config = structuredClone(CFG)
    config.region.roomDominance.minSpanChunks = 4
    config.region.roomDominance.maxSpanChunks = 1
    config.region.roomDominance.heroMinSpanChunks = 4
    config.region.roomDominance.heroMaxSpanChunks = 1
    const openChunk = { zone: ZONE_WAREHOUSE, vAt: () => 0, hAt: () => 0 }
    const audit = auditPatch(
      (cx, cz) => cx >= 0 && cx < 4 && cz >= 0 && cz < 4 ? openChunk : null,
      0,
      0,
      4,
      4,
      config
    )
    expect(audit.architecture.openComponentCap).toBe(16)
    expect(audit.architecture.maxOpenRun).toBe(4)
    expect(audit.architecture.openRunCap).toBe(4)
    expect(audit.architecture.boundedOpen).toBe(true)
    expect(audit.architecture.roomDominanceChecked).toBe(false)
    expect(audit.architecture.ok).toBe(true)
  })
})
