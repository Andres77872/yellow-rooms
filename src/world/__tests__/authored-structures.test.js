import { describe, expect, it } from 'vitest'
import { CHUNK, ZONE_OFFICE, chunkKey3 } from '../constants.js'
import { ChunkData } from '../ChunkData.js'
import { auditLayeredPatch } from '../audit.js'
import { generateChunk } from '../generate.js'
import { worldConfigForFamilyOrOffice } from '../mapFamily.js'
import { hashStr } from '../core/hash.js'
import { CELL_ATRIUM, CELL_BRIDGE, CELL_VOID, PASSAGE_DOOR } from '../mapTypes.js'
import {
  atriumConflicts,
  atriumDescriptor,
  stairwellConflicts,
  stairwellDoor,
  stairwellPlan,
  stampAtrium,
  stampStairwell,
  STAIR_E,
  STAIR_S,
} from '../structures/authored.js'
import { structureAt } from '../structures/contract.js'

// A tiny chunk store: missing chunks materialize as open office fabric.
function store(prefill = null) {
  const chunks = new Map(prefill ?? [])
  const getChunk = (cx, cy, cz) => chunks.get(chunkKey3(cx, cy, cz)) ?? null
  const ensureChunk = (cx, cy, cz) => {
    const key = chunkKey3(cx, cy, cz)
    if (!chunks.has(key)) chunks.set(key, new ChunkData(cx, cy, cz, ZONE_OFFICE))
    return chunks.get(key)
  }
  const audit = (x0, x1, z0, z1, y0, y1) => {
    for (let cy = y0; cy <= y1; cy++) for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) ensureChunk(cx, cy, cz)
    return auditLayeredPatch(getChunk, x0, y0, z0, x1 - x0 + 1, y1 - y0 + 1, z1 - z0 + 1)
  }
  return { chunks, getChunk, ensureChunk, audit }
}

const failures = (a) => Object.entries(a.details)
  .filter(([, v]) => v.length)
  .map(([k, v]) => `${k}: ${JSON.stringify(v.slice(0, 3))}`)

describe('authored atrium', () => {
  it('rejects footprints whose ring would cross a chunk border', () => {
    expect(atriumDescriptor({ x0: 0, z0: 3, x1: 5, z1: 8, baseCy: 0 }).error).toMatch(/chunk border/)
    expect(atriumDescriptor({ x0: 3, z0: 3, x1: 13, z1: 8, baseCy: 0 }).error).toMatch(/chunk border/)
    expect(atriumDescriptor({ x0: 3, z0: 3, x1: 4, z1: 8, baseCy: 0 }).error).toMatch(/at least/)
    expect(atriumDescriptor({ x0: 3, z0: 3, x1: 9, z1: 5, baseCy: 0, kind: 'bridged', bridgeAxis: 'x' }).error).toMatch(/short side/)
  })

  for (const kind of ['openVoid', 'bridged']) {
    it(`stamps a ${kind} atrium across a chunk seam that passes the layered audit`, () => {
      const s = store()
      const { descriptor, error } = atriumDescriptor({ x0: 9, z0: 3, x1: 19, z1: 9, baseCy: 0, levels: 4, kind, bridgeAxis: 'x' })
      expect(error).toBeUndefined()
      expect(descriptor.participants).toEqual([{ cx: 0, cz: 0 }, { cx: 1, cz: 0 }])
      expect(atriumConflicts(s.getChunk, descriptor)).toEqual([])
      stampAtrium(s.ensureChunk, descriptor)
      const audit = s.audit(-1, 2, -1, 1, 0, 3)
      expect(failures(audit)).toEqual([])
      expect(audit.multilevelPairs).toBe(6)
      // Atria own no stairs: every storey is one planar component of its own.
      expect(audit.components).toBe(4)
      const base = s.getChunk(0, 0, 0)
      expect(base.cellKind[5 * CHUNK + 10]).toBe(CELL_ATRIUM)
      expect(base.hasCeilHole(10, 5)).toBe(true)
      const upper = s.getChunk(0, 1, 0)
      const kinds = new Set()
      for (let x = 9; x < CHUNK; x++) for (let z = 3; z <= 9; z++) kinds.add(upper.cellKind[z * CHUNK + x])
      expect(kinds.has(CELL_VOID)).toBe(true)
      expect(kinds.has(CELL_BRIDGE)).toBe(kind === 'bridged')
      // Not a canonical structure: slices only.
      expect(upper.structure).toBeNull()
      expect(upper.structureDown.id).toBe(descriptor.id)
    })
  }

  it('fits into a generated office district and still audits clean', () => {
    const { config } = worldConfigForFamilyOrOffice('office')
    const seed = hashStr('authored')
    // Pick a chunk column with no canonical structure or stairs near the rect.
    const pre = []
    for (let cy = 0; cy <= 2; cy++) for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) {
      pre.push([chunkKey3(cx, cy, cz), generateChunk(seed, cx, cy, cz, config)])
    }
    const s = store(pre)
    let placed = null
    for (let gz = -12; gz <= 6 && !placed; gz += 2) {
      for (let gx = -12; gx <= 6 && !placed; gx += 2) {
        const { descriptor } = atriumDescriptor({ x0: gx, z0: gz, x1: gx + 4, z1: gz + 4, baseCy: 0, levels: 3 })
        if (descriptor && !atriumConflicts(s.getChunk, descriptor).length &&
          descriptor.participants.every(({ cx, cz }) => !structureAt(seed, cx, cz, 0, config).hasRoom)) placed = descriptor
      }
    }
    expect(placed).toBeTruthy()
    stampAtrium(s.ensureChunk, placed)
    const audit = auditLayeredPatch(s.getChunk, -1, 0, -1, 3, 3, 3)
    expect(failures(audit)).toEqual([])
  })

  it('reports conflicts with a canonical structure', () => {
    const { config } = worldConfigForFamilyOrOffice('tower')
    const seed = hashStr('lobby')
    let st = null
    for (let cy = -2; cy <= 20 && !st; cy++) for (let cz = -6; cz <= 6 && !st; cz++) for (let cx = -6; cx <= 6; cx++) {
      const c = structureAt(seed, cx, cz, cy, config)
      if (c.hasRoom) { st = c; break }
    }
    const p = st.participants[0]
    const s = store([[chunkKey3(p.cx, st.baseCy, p.cz), generateChunk(seed, p.cx, st.baseCy, p.cz, config)]])
    const { descriptor } = atriumDescriptor({ x0: p.cx * CHUNK + 3, z0: p.cz * CHUNK + 3, x1: p.cx * CHUNK + 8, z1: p.cz * CHUNK + 8, baseCy: st.baseCy, levels: 2 })
    expect(atriumConflicts(s.getChunk, descriptor).join(' ')).toMatch(/already holds a multilevel structure/)
  })
})

describe('authored stairwell', () => {
  it('rejects cores that leave the chunk', () => {
    expect(stairwellPlan({ gx: 1, gz: 5, baseCy: 0, topCy: 3 }).error).toMatch(/inside one chunk/)
    expect(stairwellPlan({ gx: 9, gz: 5, baseCy: 0, topCy: 3 }).error).toMatch(/inside one chunk/)
    expect(stairwellPlan({ gx: 3, gz: 5, baseCy: 0, topCy: 0 }).error).toMatch(/at least 2/)
  })

  for (const dir of [STAIR_E, STAIR_S]) {
    for (const enclosed of [false, true]) {
      it(`switchback (dir ${dir}, enclosed ${enclosed}) links every floor through canonical stairs`, () => {
        const s = store()
        const plan = stairwellPlan({ gx: 3, gz: 4, baseCy: 0, topCy: 5, dir })
        expect(plan.error).toBeUndefined()
        expect(plan.flights).toHaveLength(5)
        expect(stairwellConflicts(s.getChunk, plan)).toEqual([])
        stampStairwell(s.ensureChunk, plan, { enclosed })
        const audit = s.audit(0, 0, 0, 0, 0, 5)
        expect(failures(audit)).toEqual([])
        expect(audit.canonicalLinks).toBe(5)
        expect(audit.stairPairs).toBe(5)
        expect(audit.connected).toBe(true)
        expect(audit.ok).toBe(true)
        if (enclosed) {
          const door = stairwellDoor(plan)
          for (let cy = 0; cy <= 5; cy++) {
            const d = s.getChunk(0, cy, 0)
            const passage = door.axis === 'h' ? d.passageHAt(door.lx, door.line) : d.passageVAt(door.line, door.lz)
            expect(passage).toBe(PASSAGE_DOOR)
          }
        }
      })
    }
  }

  it('refuses a chunk that already has stairs', () => {
    const s = store()
    const plan = stairwellPlan({ gx: 3, gz: 4, baseCy: 0, topCy: 2 })
    stampStairwell(s.ensureChunk, plan)
    expect(stairwellConflicts(s.getChunk, stairwellPlan({ gx: 3, gz: 4, baseCy: 1, topCy: 3 })).length).toBeGreaterThan(0)
  })
})
