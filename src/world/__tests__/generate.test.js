import { describe, it, expect } from 'vitest'
import { buildChunk } from '../pipeline.js'
import { vBorder, hBorder, vBorderContract, hBorderContract } from '../border.js'
import { DEFAULT_WORLD_CONFIG as CFG } from '../config.js'
import { CHUNK, ZONE_OFFICE, ZONE_PILLARS, WORLD_GEN_VERSION } from '../constants.js'
import { fmix32, hash2i } from '../core/hash.js'
import { CELL_CORRIDOR, CELL_LOBBY, PASSAGE_OPEN, PASSAGE_WIDE } from '../mapTypes.js'
import { countChunkComponents } from '../topology.js'
import { layerSeed } from '../pipeline.js'

// Stable fold over a chunk's full state — pins the generator output so any
// accidental algorithm drift fails CI (intentional changes bump WORLD_GEN_VERSION
// and re-pin these). Computed from the committed implementation.
function digest(d) {
  let h = 0x9e3779b1 | 0
  const fold = (v) => {
    h = fmix32((h ^ v) | 0) | 0
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
  return (h >>> 0).toString(16).padStart(8, '0')
}

// Re-pinned whenever WORLD_GEN_VERSION changes. Coordinates cover all three
// zones AND multiple layers; the digest includes semantic passages, spaces,
// repair metadata and the v8 stair descriptors.
const GOLDEN = {
  '0,0,0': '1474b067',
  '3,0,-2': '3e21b9d6',
  '12,0,12': '539ea588',
  '-10,0,10': 'b93903c6',
  '0,1,0': '8e1117b7',
  '3,-1,-2': 'c86d22ca',
  '12,2,12': '52a34797',
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
        expect(Array.from(a.cols)).toEqual(Array.from(b.cols))
        expect(Array.from(a.cellKind)).toEqual(Array.from(b.cellKind))
        expect(Array.from(a.spaceId)).toEqual(Array.from(b.spaceId))
        expect(a.lamps).toEqual(b.lamps)
        expect(a.repairs).toEqual(b.repairs)
        expect(a.stairUp).toEqual(b.stairUp)
        expect(a.stairDown).toEqual(b.stairDown)
      }
    }
  })

  it('matches pinned golden digests', () => {
    for (const [key, want] of Object.entries(GOLDEN)) {
      const [cx, cy, cz] = key.split(',').map(Number)
      expect(digest(buildChunk(12345, cx, cy, cz, CFG))).toBe(want)
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
})

describe('seam consistency', () => {
  it('a neighbour stores the identical shared border (vertical + horizontal)', () => {
    for (const s of SEEDS) {
      for (const [cx, cy, cz] of COORDS) {
        const ls = layerSeed(s, cy)
        // East seam of (cx,cz): the chunk to the east stores it as its West line 0.
        const east = buildChunk(s, cx + 1, cy, cz, CFG)
        const vb = vBorder(cx, cz, ls, CFG)
        for (let z = 0; z < CHUNK; z++) expect(east.vAt(0, z)).toBe(vb[z])

        // South seam of (cx,cz): the chunk to the south stores it as its North line 0.
        const south = buildChunk(s, cx, cy, cz + 1, CFG)
        const hb = hBorder(cx, cz, ls, CFG)
        for (let x = 0; x < CHUNK; x++) expect(south.hAt(x, 0)).toBe(hb[x])
      }
    }
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
          if (kind === CELL_CORRIDOR || kind === CELL_LOBBY) {
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
    const data = buildChunk(89, -10, 0, -6, CFG)
    expect(data.zone).toBe(ZONE_OFFICE)
    expect(data.hAt(5, 12)).toBe(0)
    expect(data.hAt(7, 12)).toBe(0)
    expect(data.passageHAt(6, 12)).toBe(PASSAGE_WIDE)
  })
})
