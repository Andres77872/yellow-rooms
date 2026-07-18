import { describe, it, expect } from 'vitest'
import { buildChunk } from '../pipeline.js'
import { vBorderContract, hBorderContract } from '../border.js'
import { DEFAULT_WORLD_CONFIG as CFG } from '../config.js'
import {
  CHUNK,
  ZONE_OFFICE,
  ZONE_PILLARS,
  WORLD_GEN_VERSION,
  fmod,
} from '../constants.js'
import { fmix32, hash2i } from '../core/hash.js'
import {
  CELL_BRIDGE,
  CELL_CORRIDOR,
  CELL_LOBBY,
  COLUMN_NONE,
  COLUMN_MONUMENTAL,
  COLUMN_STANDARD,
  PASSAGE_OPEN,
  PASSAGE_WIDE,
  WALL_PLAIN,
} from '../mapTypes.js'
import { countChunkComponents } from '../topology.js'
import { layerSeed } from '../pipeline.js'
import {
  multilevelBandBase,
  multilevelConfig,
  multilevelContract,
} from '../multilevel.js'
import { pillarColumnKindAt } from '../zones/pillars.js'
import {
  regionLandmark,
  regionLandmarkAt,
  regionLandmarkContains,
} from '../regions.js'

// Stable fold over a chunk's full state — pins the generator output so any
// accidental algorithm drift fails CI (intentional changes bump WORLD_GEN_VERSION
// and re-pin these). Computed from the committed implementation.
function digest(d) {
  let h = 0x9e3779b1 | 0
  const fold = (v) => {
    h = fmix32((h ^ v) | 0) | 0
  }
  const foldMaybeInt = (v) => {
    if (!Number.isInteger(v)) {
      fold(0)
      return
    }
    fold(1)
    fold(v)
  }
  const foldBounds = (bounds) => {
    if (!bounds) {
      fold(0)
      return
    }
    fold(1)
    for (const key of ['x0', 'z0', 'x1', 'z1']) fold(bounds[key])
  }
  const foldAxis = (axis) => fold(axis === 'x' ? 1 : axis === 'z' ? 2 : 0)
  const foldKind = (kind) => fold(kind === 'bridged' ? 1 : kind === 'openVoid' ? 2 : 0)
  const foldCells = (cells, xKey = 'lx', zKey = 'lz') => {
    fold(cells.length)
    for (const cell of cells) {
      fold(cell[xKey])
      fold(cell[zKey])
    }
  }
  fold(d.version)
  fold(d.cx)
  fold(d.cy)
  fold(d.cz)
  for (const arr of [
    d.wallV,
    d.wallH,
    d.passageV,
    d.passageH,
    d.wallFeatureV,
    d.wallFeatureH,
    d.cols,
    d.cellKind,
    d.spaceId,
    d.spaceRole,
  ]) {
    for (const v of arr) fold(v)
  }
  for (const l of d.lamps) {
    fold(l.lx)
    fold(l.lz)
    fold(l.lit ? 1 : 0)
  }
  // Furniture records: positions/sizes are quantized to millimetres so the
  // fold stays integer-exact while still pinning every piece's placement.
  fold(d.furniture.length)
  for (const f of d.furniture) {
    fold(f.kind)
    fold(f.lx)
    fold(f.lz)
    fold(f.facing)
    for (const v of [f.x, f.z, f.w, f.d]) fold(Math.round(v * 1000))
  }
  fold(d.zone)
  fold(d.repairs.connectivity)
  fold(d.repairs.navigation)
  fold(d.repairs.columns)
  if (d.exit) {
    fold(1)
    fold(d.exit.lx)
    fold(d.exit.lz)
  } else fold(0)
  const foldStair = (s) => {
    if (!s) {
      fold(0)
      return
    }
    fold(1)
    fold(s.dir)
    for (const c of [s.landing, s.run[0], s.run[1], s.exit]) {
      fold(c.lx)
      fold(c.lz)
    }
  }
  foldStair(d.stairUp)
  foldStair(d.stairDown)
  const foldMultilevel = (room) => {
    if (!room) {
      fold(0)
      return
    }
    fold(1)
    fold(room.hasRoom ? 1 : 0)
    fold(room.id)
    fold(room.baseCy)
    fold(room.topCy)
    fold(room.lowerCy)
    fold(room.levelCy)
    foldKind(room.kind)
    foldAxis(room.bridgeAxis)
    // Keep both aliases in the digest: changing either coordinate contract is
    // observable generator drift even when the other remains intact.
    foldBounds(room.bounds)
    foldBounds(room.localBounds)
    foldBounds(room.globalBounds)
    foldMaybeInt(room.bridgeLine)
    foldMaybeInt(room.globalBridgeLine)
    foldCells(room.voidCells)
    foldCells(room.bridgeCells)
  }
  const foldStructure = (structure) => {
    if (!structure) {
      fold(0)
      return
    }
    fold(1)
    fold(structure.hasRoom ? 1 : 0)
    fold(structure.id)
    foldKind(structure.kind)
    fold(structure.district.x)
    fold(structure.district.z)
    fold(structure.district.size)
    fold(structure.bandIndex)
    fold(structure.baseCy)
    fold(structure.bottomCy)
    fold(structure.topCy)
    fold(structure.levelCount)
    fold(structure.height)
    foldAxis(structure.bridgeAxis)
    fold(structure.longSpan)
    fold(structure.shortSpan)
    fold(structure.anchor.cx)
    fold(structure.anchor.cz)
    for (const participants of [structure.participants, structure.participantChunks]) {
      fold(participants.length)
      for (const participant of participants) {
        fold(participant.cx)
        fold(participant.cz)
      }
    }
    foldBounds(structure.bounds)
    foldBounds(structure.globalBounds)
    fold(structure.centerLines.length)
    for (const line of structure.centerLines) fold(line)
    fold(structure.bridgeLevels.length)
    for (const level of structure.bridgeLevels) fold(level)
    fold(structure.decks.length)
    for (const deck of structure.decks) {
      fold(deck.levelCy)
      fold(deck.lowerCy)
      fold(deck.globalBridgeLine)
      foldBounds(deck.globalBounds)
      foldCells(deck.globalCells, 'gx', 'gz')
    }
  }
  foldStructure(d.multilevelStructure)
  foldMultilevel(d.multilevelUp)
  foldMultilevel(d.multilevelDown)
  return (h >>> 0).toString(16).padStart(8, '0')
}

// Re-pinned whenever WORLD_GEN_VERSION changes. Coordinates cover all three
// zones AND multiple layers; the digest includes semantic passages, spaces,
// repair metadata, plan-aware stairs, furniture records, and representative
// v13 structures. The final twelve entries pin bottom/middle/top in both
// chunks of deterministic maximum-height bridged and open-void structures.
const GOLDEN = {
  '0,0,0': 'a00be492',
  '3,0,-2': '7f74001d',
  '12,0,12': 'd766df34',
  '-10,0,10': '1697b6b5',
  '0,1,0': '5006baca',
  '3,-1,-2': '700ed5ec',
  '12,2,12': '37b75671',
  '3,-2,-12': '55005550',
  '3,-1,-12': '0f9451b6',
  '1,0,-2': '148a53f9',
  '2,1,-2': '2b79d965',
  '1,7,-2': '312793b0',
  '-1,0,2': 'a9f88b91',
  '-1,3,3': 'abb758f0',
  '-7,9,-8': '0a81483f',
  '-3,-15,-1': 'ca68f8a0',
  '-2,-15,-1': '0c946c33',
  '-3,-8,-1': '191e78f2',
  '-2,-8,-1': 'ecb63571',
  '-3,-1,-1': '4c089718',
  '-2,-1,-1': 'ece8cdca',
  '-10,0,8': '903520f2',
  '-10,0,9': '20f6d139',
  '-10,7,8': 'bcea2b8e',
  '-10,7,9': '54a16a91',
  '-10,14,8': '0c1e5bc2',
  '-10,14,9': 'c7af4d6d',
}

const MAX_HEIGHT_GOLDEN = {
  bridged: ['-3,-15,-1', '-2,-15,-1', '-3,-8,-1', '-2,-8,-1', '-3,-1,-1', '-2,-1,-1'],
  openVoid: ['-10,0,8', '-10,0,9', '-10,7,8', '-10,7,9', '-10,14,8', '-10,14,9'],
}

const SEEDS = [1, 42, 0xbeef, 1234567, 0x5a5a5a]
const COORDS = [
  [0, 0, 0],
  [1, 0, 0],
  [3, 0, -2],
  [-4, 1, 5],
  [12, -1, 12],
  [-7, 2, -9],
]

function districtStructure(seed, districtX, districtZ, levelCy = 0) {
  const K = multilevelConfig(CFG).districtChunks
  const baseCy = multilevelBandBase(
    seed,
    districtX * K,
    districtZ * K,
    levelCy,
    CFG
  )
  for (let dz = 0; dz < K; dz++) {
    for (let dx = 0; dx < K; dx++) {
      const structure = multilevelContract(
        seed,
        districtX * K + dx,
        districtZ * K + dz,
        baseCy,
        CFG
      )
      if (structure.hasRoom) return structure
    }
  }
  throw new Error('expected deterministic multilevel structure')
}

describe('determinism', () => {
  it('regenerates byte-identical chunks', () => {
    for (const s of SEEDS) {
      for (const [cx, cy, cz] of COORDS) {
        const a = buildChunk(s, cx, cy, cz, CFG)
        const b = buildChunk(s, cx, cy, cz, CFG)
        expect(a.version).toBe(WORLD_GEN_VERSION)
        expect(a.zone).toBe(b.zone)
        expect(Array.from(a.wallV)).toEqual(Array.from(b.wallV))
        expect(Array.from(a.wallH)).toEqual(Array.from(b.wallH))
        expect(Array.from(a.passageV)).toEqual(Array.from(b.passageV))
        expect(Array.from(a.passageH)).toEqual(Array.from(b.passageH))
        expect(Array.from(a.wallFeatureV)).toEqual(Array.from(b.wallFeatureV))
        expect(Array.from(a.wallFeatureH)).toEqual(Array.from(b.wallFeatureH))
        expect(Array.from(a.cols)).toEqual(Array.from(b.cols))
        expect(Array.from(a.cellKind)).toEqual(Array.from(b.cellKind))
        expect(Array.from(a.spaceId)).toEqual(Array.from(b.spaceId))
        expect(a.lamps).toEqual(b.lamps)
        expect(a.repairs).toEqual(b.repairs)
        expect(a.stairUp).toEqual(b.stairUp)
        expect(a.stairDown).toEqual(b.stairDown)
        expect(a.multilevelStructure).toEqual(b.multilevelStructure)
        expect(a.multilevelUp).toEqual(b.multilevelUp)
        expect(a.multilevelDown).toEqual(b.multilevelDown)
      }
    }
  })

  it('matches pinned golden digests', () => {
    const actual = {}
    for (const key of Object.keys(GOLDEN)) {
      const [cx, cy, cz] = key.split(',').map(Number)
      actual[key] = digest(buildChunk(12345, cx, cy, cz, CFG))
    }
    expect(actual).toEqual(GOLDEN)

    for (const [kind, keys] of Object.entries(MAX_HEIGHT_GOLDEN)) {
      for (const key of keys) {
        const [cx, cy, cz] = key.split(',').map(Number)
        const structure = buildChunk(12345, cx, cy, cz, CFG).multilevelStructure
        expect(structure?.kind).toBe(kind)
        expect(structure?.levelCount).toBe(15)
        expect(structure?.topCy - structure?.baseCy).toBe(14)
        expect(cy).toBeGreaterThanOrEqual(structure.baseCy)
        expect(cy).toBeLessThanOrEqual(structure.topCy)
      }
    }
  })

  it('layer 0 uses the root seed; other layers get decorrelated seeds', () => {
    expect(layerSeed(12345, 0)).toBe(12345)
    expect(layerSeed(12345, 1)).not.toBe(12345)
    expect(layerSeed(12345, -1)).not.toBe(layerSeed(12345, 1))
    // Layers must differ (zones/walls decorrelate across floors).
    let differing = 0
    for (const [cx, , cz] of COORDS) {
      const a = buildChunk(42, cx, 0, cz, CFG)
      const b = buildChunk(42, cx, 1, cz, CFG)
      if (digest(a) !== digest(b)) differing++
    }
    expect(differing).toBe(COORDS.length)
  })

  it('keeps ordinary chunk generation available above the cy-64 landmark cap', () => {
    const data = buildChunk(12345, 0, 65, 0, CFG)
    expect(data.version).toBe(WORLD_GEN_VERSION)
    expect(data.cy).toBe(65)
    expect(data.multilevelStructure).toBeNull()
    expect(data.wallV.length).toBeGreaterThan(0)
  })
})

describe('seam consistency', () => {
  const inBounds = (bounds, gx, gz) =>
    gx >= bounds.x0 && gx <= bounds.x1 && gz >= bounds.z0 && gz <= bounds.z1

  const participantsInclude = (structure, chunk) => structure.participants.some(
    ({ cx, cz }) => cx === chunk.cx && cz === chunk.cz
  )

  const sharedStructure = (a, b, axis) => {
    const structure = a.multilevelStructure
    if (
      !structure ||
      structure.id !== b.multilevelStructure?.id ||
      structure.bridgeAxis !== axis ||
      a.cy !== b.cy ||
      a.cy < structure.baseCy ||
      a.cy > structure.topCy ||
      !participantsInclude(structure, a) ||
      !participantsInclude(structure, b)
    ) return null
    return structure
  }

  const ownsVSeamCell = (west, east, z) => {
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

  const ownsHSeamCell = (north, south, x) => {
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

  it('stores the canonical shared border outside exact tall-structure cuts', () => {
    for (const s of SEEDS) {
      for (const [cx, cy, cz] of COORDS) {
        const ls = layerSeed(s, cy)
        const layerCtx = { rootSeed: s, layerSeed: ls, cy }
        // East seam of (cx,cz): the chunk to the east stores it as its West line 0.
        const west = buildChunk(s, cx, cy, cz, CFG)
        const east = buildChunk(s, cx + 1, cy, cz, CFG)
        const vb = vBorderContract(cx, cz, ls, CFG, layerCtx)
        for (let z = 0; z < CHUNK; z++) {
          if (ownsVSeamCell(west, east, z)) continue
          expect(east.vAt(0, z)).toBe(vb.walls[z])
          expect(east.passageVAt(0, z)).toBe(vb.passages[z])
        }

        // South seam of (cx,cz): the chunk to the south stores it as its North line 0.
        const north = west
        const south = buildChunk(s, cx, cy, cz + 1, CFG)
        const hb = hBorderContract(cx, cz, ls, CFG, layerCtx)
        for (let x = 0; x < CHUNK; x++) {
          if (ownsHSeamCell(north, south, x)) continue
          expect(south.hAt(x, 0)).toBe(hb.walls[x])
          expect(south.passageHAt(x, 0)).toBe(hb.passages[x])
        }
      }
    }
  })

  it('opens every structure-owned shared seam cell as one protected wide cut', () => {
    let owned = 0
    let changedFromCanonical = 0
    for (const s of SEEDS) {
      for (const [districtX, districtZ] of [[-2, -1], [1, 2]]) {
        const structure = districtStructure(s, districtX, districtZ)
        const cy = structure.baseCy
        const ls = layerSeed(s, cy)
        const layerCtx = { rootSeed: s, layerSeed: ls, cy }
        const [first, second] = structure.participants.map(({ cx, cz }) =>
          buildChunk(s, cx, cy, cz, CFG)
        )
        if (structure.bridgeAxis === 'x') {
          const vb = vBorderContract(first.cx, first.cz, ls, CFG, layerCtx)
          for (let z = 0; z < CHUNK; z++) {
            if (!ownsVSeamCell(first, second, z)) continue
            owned++
            if (second.vAt(0, z) !== vb.walls[z]) changedFromCanonical++
            expect(second.vAt(0, z)).toBe(0)
            expect(second.passageVAt(0, z)).toBe(PASSAGE_WIDE)
            expect(second.wallFeatureVAt(0, z)).toBe(WALL_PLAIN)
          }
        } else {
          const hb = hBorderContract(first.cx, first.cz, ls, CFG, layerCtx)
          for (let x = 0; x < CHUNK; x++) {
            if (!ownsHSeamCell(first, second, x)) continue
            owned++
            if (second.hAt(x, 0) !== hb.walls[x]) changedFromCanonical++
            expect(second.hAt(x, 0)).toBe(0)
            expect(second.passageHAt(x, 0)).toBe(PASSAGE_WIDE)
            expect(second.wallFeatureHAt(x, 0)).toBe(WALL_PLAIN)
          }
        }
      }
    }
    expect(owned).toBeGreaterThan(0)
    expect(changedFromCanonical).toBeGreaterThan(0)
  })
})

describe('border contracts', () => {
  // Planned internal office cuts may be solid room walls; canonical transitions
  // and district boundaries must always retain a portal.
  it('every canonical border contract keeps at least one opening', () => {
    for (const s of SEEDS) {
      for (const [cx, , cz] of COORDS) {
        for (const c of [
          vBorderContract(cx, cz, s, CFG),
          hBorderContract(cx, cz, s, CFG),
        ]) {
          if (c.kind !== 'planned') expect(c.walls.some((v) => v === 0)).toBe(true)
        }
      }
    }
  })
})

describe('bounds & shape', () => {
  it('arrays are correctly sized and lamps in range', () => {
    for (const s of SEEDS) {
      for (const [cx, cy, cz] of COORDS) {
        const d = buildChunk(s, cx, cy, cz, CFG)
        expect(d.wallV.length).toBe(CHUNK * CHUNK)
        expect(d.wallH.length).toBe(CHUNK * CHUNK)
        expect(d.passageV.length).toBe(CHUNK * CHUNK)
        expect(d.passageH.length).toBe(CHUNK * CHUNK)
        expect(d.wallFeatureV.length).toBe(CHUNK * CHUNK)
        expect(d.wallFeatureH.length).toBe(CHUNK * CHUNK)
        expect(d.cols.length).toBe(CHUNK * CHUNK)
        expect(d.cellKind.length).toBe(CHUNK * CHUNK)
        expect(d.spaceId.length).toBe(CHUNK * CHUNK)
        expect(d.exit).toBe(null)
        for (const l of d.lamps) {
          expect(l.lx).toBeGreaterThanOrEqual(0)
          expect(l.lx).toBeLessThan(CHUNK)
          expect(l.lz).toBeGreaterThanOrEqual(0)
          expect(l.lz).toBeLessThan(CHUNK)
          expect(typeof l.lit).toBe('boolean')
        }
      }
    }
  })
})

describe('lamp regularity', () => {
  it('lamps follow room grids or circulation intervals and never occupy columns', () => {
    const step = CFG.lamps.step
    for (const s of SEEDS) {
      for (const [cx, cy, cz] of COORDS) {
        const d = buildChunk(s, cx, cy, cz, CFG)
        const ls = layerSeed(s, cy)
        const phase = CFG.lamps.phase[d.zone] ?? 0
        for (const l of d.lamps) {
          const gx = cx * CHUNK + l.lx
          const gz = cz * CHUNK + l.lz
          const kind = d.cellKind[l.lz * CHUNK + l.lx]
          if (kind === CELL_CORRIDOR || kind === CELL_LOBBY || kind === CELL_BRIDGE) {
            const corridorPhase =
              hash2i((ls ^ CFG.lamps.corridorSalt) | 0, 0x43, 0) % CFG.lamps.corridorStep
            expect(
              (((gx + gz - corridorPhase) % CFG.lamps.corridorStep) +
                CFG.lamps.corridorStep) %
                CFG.lamps.corridorStep
            ).toBe(0)
          } else {
            expect((((gx - phase) % step) + step) % step).toBe(0)
            expect((((gz - phase) % step) + step) % step).toBe(0)
          }
          expect(d.colAt(l.lx, l.lz)).toBe(0)
          expect(d.hasCeilHole(l.lx, l.lz)).toBe(false)
        }
      }
    }
  })

  // Regression: a pillar lattice sharing the phase-0 lamp grid rejects nearly
  // every fixture candidate. The per-zone offset must keep bounded hypostyle
  // halls deliberately lit rather than accidentally pitch-black.
  it('pillars chunks get real lamp coverage (>= 4 lamps/chunk on average)', () => {
    const cfg = structuredClone(CFG)
    cfg.zoneBands = [{ id: ZONE_PILLARS, max: 1.01 }]
    cfg.stairs.enabled = false
    cfg.multilevel.enabled = false
    for (const s of SEEDS) {
      let lamps = 0
      let chunks = 0
      for (let cz = -2; cz <= 2; cz++) {
        for (let cx = -2; cx <= 2; cx++) {
          const d = buildChunk(s, cx, 0, cz, cfg)
          expect(d.zone).toBe(ZONE_PILLARS)
          lamps += d.lamps.length
          chunks++
        }
      }
      expect(chunks).toBeGreaterThan(0)
      expect(lamps / chunks).toBeGreaterThanOrEqual(4)
    }
  })
})

describe('monumental pillar halls', () => {
  it('places true large-pier bytes on a seam-continuous global bay grid', () => {
    const cfg = structuredClone(CFG)
    cfg.zoneBands = [{ id: ZONE_PILLARS, max: 1.01 }]
    cfg.stairs.enabled = false
    cfg.multilevel.enabled = false
    cfg.pillars.monumentalChance = 1
    const { spacing, phase } = cfg.pillars
    let columns = 0
    for (const [cx, cz] of [[0, 0], [1, 0], [-1, -1]]) {
      const data = buildChunk(0x5049, cx, 0, cz, cfg)
      expect(data.zone).toBe(ZONE_PILLARS)
      for (let z = 0; z < CHUNK; z++) {
        for (let x = 0; x < CHUNK; x++) {
          const gx = cx * CHUNK + x
          const gz = cz * CHUNK + z
          const expected = fmod(gx, spacing) === phase && fmod(gz, spacing) === phase
          expect(data.colAt(x, z)).toBe(expected ? COLUMN_MONUMENTAL : 0)
          if (expected) columns++
        }
      }
    }
    expect(columns).toBeGreaterThan(0)
  })

  it('uses coherent processional, broken-bay, and court signatures', () => {
    const processional = {
      x0: 0,
      z0: 0,
      x1: 0,
      z1: 0,
      axis: 'x',
      pierPattern: 'processionalAisle',
    }
    expect(pillarColumnKindAt(1, 0, 4, processional, CFG)).toBe(COLUMN_MONUMENTAL)
    expect(pillarColumnKindAt(1, 0, 8, processional, CFG)).toBe(COLUMN_MONUMENTAL)
    expect(pillarColumnKindAt(1, 0, 0, processional, CFG)).toBe(COLUMN_STANDARD)
    expect(pillarColumnKindAt(1, 1, 4, processional, CFG)).toBe(COLUMN_NONE)

    const broken = {
      ...processional,
      x0: 0,
      z0: 0,
      x1: 2,
      z1: 2,
      pierPattern: 'brokenBay',
    }
    expect(pillarColumnKindAt(1, 20, 20, broken, CFG)).toBe(COLUMN_NONE)
    expect(pillarColumnKindAt(1, 16, 20, broken, CFG)).toBe(COLUMN_MONUMENTAL)

    const court = { ...processional, pierPattern: 'courtColonnade' }
    expect(pillarColumnKindAt(1, 0, 0, court, CFG)).toBe(COLUMN_MONUMENTAL)
  })

  it('recovers one processional signature across every real landmark slice', () => {
    const cfg = structuredClone(CFG)
    cfg.stairs.enabled = false
    cfg.multilevel.enabled = false

    for (const axis of ['x', 'z']) {
      let found = null
      for (let seed = 0; seed < 64 && !found; seed++) {
        for (let dz = -8; dz <= 8 && !found; dz++) {
          for (let dx = -8; dx <= 8; dx++) {
            const landmark = regionLandmark(seed, dx, dz, cfg)
            if (
              landmark.active &&
              landmark.kind === 'pillarHall' &&
              landmark.pierPattern === 'processionalAisle' &&
              landmark.axis === axis &&
              landmark.width >= 2 &&
              landmark.height >= 2
            ) {
              found = { seed, landmark }
              break
            }
          }
        }
      }
      expect(found).not.toBeNull()

      const { seed, landmark } = found
      const global = {
        x0: landmark.x0 * CHUNK,
        z0: landmark.z0 * CHUNK,
        x1: (landmark.x1 + 1) * CHUNK - 1,
        z1: (landmark.z1 + 1) * CHUNK - 1,
      }
      let monumental = 0
      let standard = 0
      for (let cz = landmark.z0; cz <= landmark.z1; cz++) {
        for (let cx = landmark.x0; cx <= landmark.x1; cx++) {
          if (!regionLandmarkContains(landmark, cx, cz)) continue
          expect(regionLandmarkAt(cx, cz, seed, cfg)).toEqual(landmark)
          const data = buildChunk(seed, cx, 0, cz, cfg)
          for (let z = 0; z < CHUNK; z++) {
            for (let x = 0; x < CHUNK; x++) {
              const gx = cx * CHUNK + x
              const gz = cz * CHUNK + z
              if (
                gx < global.x0 + 3 || gx > global.x1 - 3 ||
                gz < global.z0 + 3 || gz > global.z1 - 3
              ) continue
              const expected = pillarColumnKindAt(seed, gx, gz, landmark, cfg)
              if (!expected) continue
              expect(data.colAt(x, z)).toBe(expected)
              monumental += expected === COLUMN_MONUMENTAL ? 1 : 0
              standard += expected === COLUMN_STANDARD ? 1 : 0
            }
          }
        }
      }
      expect(monumental).toBeGreaterThan(0)
      expect(standard).toBeGreaterThan(0)
    }
  })

  it('realizes the elected missing pier of a broken-bay landmark', () => {
    const cfg = structuredClone(CFG)
    cfg.stairs.enabled = false
    cfg.multilevel.enabled = false
    let found = null
    for (let seed = 0; seed < 64 && !found; seed++) {
      for (let dz = -8; dz <= 8 && !found; dz++) {
        for (let dx = -8; dx <= 8; dx++) {
          const landmark = regionLandmark(seed, dx, dz, cfg)
          if (landmark.active && landmark.pierPattern === 'brokenBay') {
            found = { seed, landmark }
            break
          }
        }
      }
    }
    expect(found).not.toBeNull()
    const { seed, landmark } = found
    const { spacing, phase } = cfg.pillars
    const missing = []
    for (let gz = landmark.z0 * CHUNK; gz < (landmark.z1 + 1) * CHUNK; gz++) {
      for (let gx = landmark.x0 * CHUNK; gx < (landmark.x1 + 1) * CHUNK; gx++) {
        if (fmod(gx, spacing) !== phase || fmod(gz, spacing) !== phase) continue
        if (pillarColumnKindAt(seed, gx, gz, landmark, cfg) === COLUMN_NONE) {
          missing.push({ gx, gz })
        }
      }
    }
    expect(missing).toHaveLength(1)

    const [{ gx, gz }] = missing
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const data = buildChunk(seed, cx, 0, cz, cfg)
    expect(data.colAt(gx - cx * CHUNK, gz - cz * CHUNK)).toBe(COLUMN_NONE)
    const neighborX = gx + spacing
    const neighborCx = Math.floor(neighborX / CHUNK)
    const neighbor = buildChunk(seed, neighborCx, 0, cz, cfg)
    expect(pillarColumnKindAt(seed, neighborX, gz, landmark, cfg))
      .toBe(COLUMN_MONUMENTAL)
    expect(neighbor.colAt(neighborX - neighborCx * CHUNK, gz - cz * CHUNK))
      .toBe(COLUMN_MONUMENTAL)
  })
})

describe('config purity', () => {
  it('generators read config (lamp chance 0 -> no lamps)', () => {
    const cfg = structuredClone(CFG)
    for (const k of Object.keys(cfg.lamps.chance)) cfg.lamps.chance[k] = 0
    for (const [cx, cy, cz] of COORDS) {
      expect(buildChunk(7, cx, cy, cz, cfg).lamps.length).toBe(0)
    }
  })

  it('propagates the config generation version into ChunkData', () => {
    const cfg = structuredClone(CFG)
    cfg.version = 999
    expect(buildChunk(7, 0, 0, 0, cfg).version).toBe(999)
  })
})

describe('office invariant (I1)', () => {
  it('every compiled office slice is one connected component', () => {
    const cfg = structuredClone(CFG)
    cfg.zoneBands = [{ id: ZONE_OFFICE, max: 1.01 }]
    for (const s of SEEDS) {
      for (const [cx, cy, cz] of COORDS) {
        expect(countChunkComponents(buildChunk(s, cx, cy, cz, cfg))).toBe(1)
      }
    }
  })
})

describe('anomaly determinism', () => {
  it('pins exit and clearing inputs in regenerated output', () => {
    const a = buildChunk(77, 0, 0, 0, CFG, { lx: 3, lz: 4 }, [{ lx: 8, lz: 9, r: 2 }])
    const b = buildChunk(77, 0, 0, 0, CFG, { lx: 3, lz: 4 }, [{ lx: 8, lz: 9, r: 2 }])
    const ordinary = buildChunk(77, 0, 0, 0, CFG)
    expect(digest(a)).toBe(digest(b))
    expect(digest(a)).not.toBe(digest(ordinary))
    expect(a.exit).toEqual({ lx: 3, lz: 4 })
  })

  it('marks clearing cuts across semantic rooms as wide thresholds', () => {
    const ordinary = buildChunk(0, 1, 0, -3, CFG)
    const data = buildChunk(0, 1, 0, -3, CFG, null, [{ lx: 8, lz: 8, r: 2 }])
    expect(data.zone).toBe(ZONE_OFFICE)
    let changedCrossSpaceEdges = 0
    for (let z = 0; z < CHUNK; z++) {
      for (let x = 1; x < CHUNK; x++) {
        const west = data.spaceId[z * CHUNK + x - 1]
        const east = data.spaceId[z * CHUNK + x]
        const passage = data.passageVAt(x, z)
        if (west && east && west !== east) {
          expect(passage).not.toBe(PASSAGE_OPEN)
          if (passage !== ordinary.passageVAt(x, z)) {
            expect(passage).toBe(PASSAGE_WIDE)
            changedCrossSpaceEdges++
          }
        }
      }
    }
    for (let z = 1; z < CHUNK; z++) {
      for (let x = 0; x < CHUNK; x++) {
        const north = data.spaceId[(z - 1) * CHUNK + x]
        const south = data.spaceId[z * CHUNK + x]
        const passage = data.passageHAt(x, z)
        if (north && south && north !== south) {
          expect(passage).not.toBe(PASSAGE_OPEN)
          if (passage !== ordinary.passageHAt(x, z)) {
            expect(passage).toBe(PASSAGE_WIDE)
            changedCrossSpaceEdges++
          }
        }
      }
    }
    expect(changedCrossSpaceEdges).toBeGreaterThan(0)
  })

  it('normalizes a door frame after transition carving removes its supports', () => {
    const cfg = structuredClone(CFG)
    cfg.stairs.enabled = false
    // This fixture targets the transition/door-normalization integration, not
    // the default landmark election. Recover the broad-field coordinate that
    // originally exposed the unsupported frame.
    cfg.region.roomDominance.enabled = false
    const data = buildChunk(89, -10, 0, -6, cfg)
    expect(data.zone).toBe(ZONE_OFFICE)
    expect(data.hAt(5, 12)).toBe(0)
    expect(data.hAt(7, 12)).toBe(0)
    expect(data.passageHAt(6, 12)).toBe(PASSAGE_WIDE)
  })
})
