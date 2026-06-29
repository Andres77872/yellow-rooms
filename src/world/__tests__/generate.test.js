import { describe, it, expect } from 'vitest'
import { buildChunk } from '../pipeline.js'
import { vBorder, hBorder } from '../border.js'
import { DEFAULT_WORLD_CONFIG as CFG } from '../config.js'
import { CHUNK, ZONE_OFFICE, WORLD_GEN_VERSION } from '../constants.js'
import { ChunkData } from '../ChunkData.js'
import { RNG } from '../core/rng.js'
import { fmix32 } from '../core/hash.js'
import * as office from '../zones/office.js'
import { floodReachable } from '../connectivity.js'

// Stable fold over a chunk's full state — pins the generator output so any
// accidental algorithm drift fails CI (intentional changes bump WORLD_GEN_VERSION
// and re-pin these). Computed from the committed implementation.
function digest(d) {
  let h = 0x9e3779b1 | 0
  const fold = (v) => {
    h = fmix32((h ^ v) | 0) | 0
  }
  for (const arr of [d.wallV, d.wallH, d.cols]) for (const v of arr) fold(v)
  for (const l of d.lamps) {
    fold(l.lx)
    fold(l.lz)
    fold(l.lit ? 1 : 0)
  }
  fold(d.zone)
  return (h >>> 0).toString(16).padStart(8, '0')
}

const GOLDEN = {
  '0,0': '2716be0c',
  '3,-2': 'ed2f26d0',
  '12,12': '6af233e0',
}

const SEEDS = [1, 42, 0xbeef, 1234567, 0x5a5a5a]
const COORDS = [
  [0, 0],
  [1, 0],
  [3, -2],
  [-4, 5],
  [12, 12],
  [-7, -9],
]

describe('determinism', () => {
  it('regenerates byte-identical chunks', () => {
    for (const s of SEEDS) {
      for (const [cx, cz] of COORDS) {
        const a = buildChunk(s, cx, cz, CFG)
        const b = buildChunk(s, cx, cz, CFG)
        expect(a.version).toBe(WORLD_GEN_VERSION)
        expect(a.zone).toBe(b.zone)
        expect(Array.from(a.wallV)).toEqual(Array.from(b.wallV))
        expect(Array.from(a.wallH)).toEqual(Array.from(b.wallH))
        expect(Array.from(a.cols)).toEqual(Array.from(b.cols))
        expect(a.lamps).toEqual(b.lamps)
      }
    }
  })

  it('matches pinned golden digests', () => {
    for (const [key, want] of Object.entries(GOLDEN)) {
      const [cx, cz] = key.split(',').map(Number)
      expect(digest(buildChunk(12345, cx, cz, CFG))).toBe(want)
    }
  })
})

describe('seam consistency', () => {
  it('a neighbour stores the identical shared border (vertical + horizontal)', () => {
    for (const s of SEEDS) {
      for (const [cx, cz] of COORDS) {
        // East seam of (cx,cz): the chunk to the east stores it as its West line 0.
        const east = buildChunk(s, cx + 1, cz, CFG)
        const vb = vBorder(cx, cz, s, CFG)
        for (let z = 0; z < CHUNK; z++) expect(east.vAt(0, z)).toBe(vb[z])

        // South seam of (cx,cz): the chunk to the south stores it as its North line 0.
        const south = buildChunk(s, cx, cz + 1, CFG)
        const hb = hBorder(cx, cz, s, CFG)
        for (let x = 0; x < CHUNK; x++) expect(south.hAt(x, 0)).toBe(hb[x])
      }
    }
  })
})

describe('border doorways', () => {
  // Core invariant under the zone-aware seam model: no shared border is ever
  // fully sealed, so the infinite graph stays traversable. (The zone-specific
  // shape rules — office corners walled, transition mouths, open halls merging,
  // cross-seam doorway alignment — are validated in continuity.test.js.)
  it('every shared border keeps at least one opening', () => {
    for (const s of SEEDS) {
      for (const [cx, cz] of COORDS) {
        for (const b of [vBorder(cx, cz, s, CFG), hBorder(cx, cz, s, CFG)]) {
          expect(b.some((v) => v === 0)).toBe(true)
        }
      }
    }
  })
})

describe('bounds & shape', () => {
  it('arrays are correctly sized and lamps in range', () => {
    for (const s of SEEDS) {
      for (const [cx, cz] of COORDS) {
        const d = buildChunk(s, cx, cz, CFG)
        expect(d.wallV.length).toBe(CHUNK * CHUNK)
        expect(d.wallH.length).toBe(CHUNK * CHUNK)
        expect(d.cols.length).toBe(CHUNK * CHUNK)
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
  it('lamps sit on the global module grid and never inside a column', () => {
    const step = CFG.lamps.step
    for (const s of SEEDS) {
      for (const [cx, cz] of COORDS) {
        const d = buildChunk(s, cx, cz, CFG)
        for (const l of d.lamps) {
          const gx = cx * CHUNK + l.lx
          const gz = cz * CHUNK + l.lz
          expect(((gx % step) + step) % step).toBe(0)
          expect(((gz % step) + step) % step).toBe(0)
          expect(d.colAt(l.lx, l.lz)).toBe(0)
        }
      }
    }
  })
})

describe('config purity', () => {
  it('generators read config (lamp chance 0 -> no lamps)', () => {
    const cfg = structuredClone(CFG)
    for (const k of Object.keys(cfg.lamps.chance)) cfg.lamps.chance[k] = 0
    for (const [cx, cz] of COORDS) {
      expect(buildChunk(7, cx, cz, cfg).lamps.length).toBe(0)
    }
  })
})

describe('office invariant (I1)', () => {
  it('a single office chunk is one connected component of all cells', () => {
    for (const s of SEEDS) {
      const data = new ChunkData(0, 0, ZONE_OFFICE)
      office.generate(data, {
        seed: s,
        cx: 0,
        cz: 0,
        zone: ZONE_OFFICE,
        rng: RNG.fromHash(s, 0, 0),
        config: CFG,
        borders: {},
      })
      const canPass = (ax, az, bx, bz) => {
        if (bx === ax + 1) return data.vAt(ax + 1, az) === 0
        if (bx === ax - 1) return data.vAt(ax, az) === 0
        if (bz === az + 1) return data.hAt(ax, az + 1) === 0
        return data.hAt(ax, az) === 0
      }
      const hub = (CHUNK / 2) | 0
      const seen = floodReachable(hub, hub, CHUNK, CHUNK, canPass)
      let reached = 0
      for (const v of seen) reached += v
      expect(reached).toBe(CHUNK * CHUNK)
    }
  })
})
