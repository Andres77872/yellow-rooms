import { describe, it, expect } from 'vitest'
import { buildChunk } from '../pipeline.js'
import { vBorderContract, hBorderContract } from '../border.js'
import { DEFAULT_WORLD_CONFIG as CFG } from '../config.js'
import { CHUNK, ZONE_OFFICE, ZONE_PILLARS, WORLD_GEN_VERSION } from '../constants.js'
import { fmix32, hash2i } from '../core/hash.js'
import {
  CELL_BRIDGE,
  CELL_CORRIDOR,
  CELL_LOBBY,
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
  ]) {
    for (const v of arr) fold(v)
  }
  for (const l of d.lamps) {
    fold(l.lx)
    fold(l.lz)
    fold(l.lit ? 1 : 0)
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
// repair metadata, plan-aware stairs, and representative v13 structures. The
// final twelve entries pin bottom/middle/top in both chunks of deterministic
// maximum-height bridged and open-void structures.
const GOLDEN = {
  '0,0,0': '3f7e50cb',
  '3,0,-2': '026a98a0',
  '12,0,12': 'a0b8fa75',
  '-10,0,10': '0c86dffc',
  '0,1,0': 'af590c30',
  '3,-1,-2': '519c131a',
  '12,2,12': 'e521877c',
  '3,-2,-12': 'c4c3ae3a',
  '3,-1,-12': '4eda62a9',
  '1,0,-2': '755fcc9f',
  '2,1,-2': 'a8c8485c',
  '1,7,-2': '57a89ebb',
  '-1,0,2': 'ba63055c',
  '-1,3,3': 'e708ed4e',
  '-7,9,-8': '85e14710',
  '-3,-15,-1': '99905d6a',
  '-2,-15,-1': '5657370e',
  '-3,-8,-1': '85ac2e20',
  '-2,-8,-1': '2b35b3ac',
  '-3,-1,-1': '47046d4e',
  '-2,-1,-1': 'd77b093f',
  '-10,0,8': '3588f414',
  '-10,0,9': 'fe209aa8',
  '-10,7,8': 'dc813e47',
  '-10,7,9': '3a970027',
  '-10,14,8': '3e0e5691',
  '-10,14,9': '8e7e4bea',
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

  // Regression: the pillars column lattice (spacing 2, phase 0) used to cover
  // the whole phase-0 lamp grid, rejecting nearly every candidate — pillar
  // halls averaged ~0.3 lamps/chunk vs office ~8.5 and were pitch-black. The
  // per-zone phase offset must keep pillars lamp coverage comparable to office.
  it('pillars chunks get real lamp coverage (>= 4 lamps/chunk on average)', () => {
    for (const s of SEEDS) {
      let lamps = 0
      let chunks = 0
      for (let cz = -8; cz <= 8 && chunks < 20; cz++) {
        for (let cx = -8; cx <= 8 && chunks < 20; cx++) {
          const d = buildChunk(s, cx, 0, cz, CFG)
          if (d.zone !== ZONE_PILLARS) continue
          lamps += d.lamps.length
          chunks++
        }
      }
      expect(chunks).toBeGreaterThan(0)
      expect(lamps / chunks).toBeGreaterThanOrEqual(4)
    }
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
    const data = buildChunk(89, -10, 0, -6, cfg)
    expect(data.zone).toBe(ZONE_OFFICE)
    expect(data.hAt(5, 12)).toBe(0)
    expect(data.hAt(7, 12)).toBe(0)
    expect(data.passageHAt(6, 12)).toBe(PASSAGE_WIDE)
  })
})
