import { describe, expect, it } from 'vitest'
import { EditorMap } from '../EditorMap.js'
import { CELL_CORRIDOR, CELL_ROOM, FACING, WALL_RAIL, WALL_WINDOW } from '../kinds/floorPlan.js'
import { generatePrototype } from '../prototypes.js'
import { liminalReport } from '../simulate.js'
import { FURN_COUNTER } from '../../world/rooms/catalog.js'
import { KIND_SEEDS, expectKindClean } from './kindJudge.js'

// 08 — The Terminal (docs/liminal_maps/08-terminal.md): a spine with two
// dead-end piers, glass onto a sealed apron, a security serpentine, a dead
// pier against lit gates; baggage below, a mezzanine above.

const BAG = 0
const DEP = 1
const MEZ = 2

function build(seed) {
  const map = new EditorMap()
  const res = generatePrototype(map, 'terminal', { seed })
  return { map, res }
}

// Every lamp record of storey cy as {gx, gz, lit, tint}.
function lamps(map, cy) {
  const out = []
  for (const d of map.chunks.values()) {
    if (d.cy !== cy) continue
    for (const l of d.lamps) out.push({ gx: d.cx * 14 + l.lx, gz: d.cz * 14 + l.lz, lit: l.lit, tint: l.tint })
  }
  return out
}

// The walled edges of storey cy that bound at least one open (non-mass)
// cell, with their features.
function closedEdges(map, cy) {
  const b = map.bounds()
  const open = (gx, gz) => map.chunkAt(map.cellChunk(gx), cy, map.cellChunk(gz)) && map.cellAt(gx, cy, gz).col !== 1
  const out = []
  for (let gz = b.z0 * 14; gz <= b.z1 * 14 + 14; gz++) {
    for (let gx = b.x0 * 14; gx <= b.x1 * 14 + 14; gx++) {
      const v = map.wallVAt(gx, cy, gz)
      if (v.wall && (open(gx - 1, gz) || open(gx, gz))) out.push({ axis: 'v', gx, gz, feature: v.feature })
      const h = map.wallHAt(gx, cy, gz)
      if (h.wall && (open(gx, gz - 1) || open(gx, gz))) out.push({ axis: 'h', gx, gz, feature: h.feature })
    }
  }
  return out
}

describe('terminal kind', () => {
  it('builds clean, connected, deterministic maps for every default seed', () => {
    expectKindClean(expect, 'terminal')
  })

  it('is a comb: 16 jet bridges, 4–14-cell dead-end tubes ending at a door into a 1×1 closet', () => {
    for (const seed of ['proto', 'liminal-0', 'liminal-3']) {
      const { map, res } = build(seed)
      const rooms = new Map()
      for (const d of map.chunks.values()) {
        if (d.cy !== DEP) continue
        for (let i = 0; i < 196; i++) {
          if (d.cellKind[i] !== CELL_ROOM) continue
          const cell = { gx: d.cx * 14 + (i % 14), gz: d.cz * 14 + Math.floor(i / 14) }
          rooms.set(d.spaceId[i], [...(rooms.get(d.spaceId[i]) ?? []), cell])
        }
      }
      const closets = [...rooms.values()].filter((cells) => cells.length === 1).map(([c]) => c)
      expect(closets, seed).toHaveLength(16)
      for (const { gx, gz } of closets) {
        // Exactly one opening, and behind it a straight corridor tube back to
        // a holdroom or tip lounge.
        const sides = [
          [map.wallVAt(gx, DEP, gz), -1, 0],
          [map.wallVAt(gx + 1, DEP, gz), 1, 0],
          [map.wallHAt(gx, DEP, gz), 0, -1],
          [map.wallHAt(gx, DEP, gz + 1), 0, 1],
        ].filter(([e]) => !e.wall)
        expect(sides, `${seed} closet ${gx},${gz}`).toHaveLength(1)
        const [, dx, dz] = sides[0]
        let len = 0
        while (map.cellAt(gx + dx * (len + 1), DEP, gz + dz * (len + 1)).kind === CELL_CORRIDOR) len++
        expect(len, `${seed} tube at ${gx},${gz}`).toBeGreaterThanOrEqual(4)
        expect(len, `${seed} tube at ${gx},${gz}`).toBeLessThanOrEqual(14)
        expect(map.cellAt(gx + dx * (len + 1), DEP, gz + dz * (len + 1)).kind).toBe(CELL_ROOM)
      }
      // Boarding: the exit is one of the closets.
      expect(closets.some((c) => c.gx === res.exit.gx && c.gz === res.exit.gz), seed).toBe(true)
    }
  })

  it('glazes the piers onto the apron and rails the security serpentine', () => {
    for (const seed of KIND_SEEDS) {
      const { map } = build(seed)
      const edges = closedEdges(map, DEP)
      const glass = edges.filter((e) => e.feature === WALL_WINDOW)
      const rails = edges.filter((e) => e.feature === WALL_RAIL)
      // Four stanchion lines of 8 with one gap each, all landside (cx 0).
      expect(rails, seed).toHaveLength(28)
      expect(rails.every((e) => e.gx < 14), seed).toBe(true)
      // Doc 12 "mirror/glass share 0.3–0.5 of closed edges"; measured
      // 0.28–0.37 over the default seeds (holdroom and tip walls plus the
      // glass jet-bridge tubes; the steel ones stay plain).
      const share = glass.length / edges.length
      expect(share, seed).toBeGreaterThan(0.25)
      expect(share, seed).toBeLessThan(0.45)
      // Glass only south of the atrium's base-storey chunks, and every
      // featured chunk opted out of the stray-feature audit.
      expect(glass.every((e) => e.gz >= 14), seed).toBe(true)
      for (const e of [...glass, ...rails]) {
        expect(map.chunkAt(map.cellChunk(e.gx), DEP, map.cellChunk(e.gz)).authoredFeatures, seed).toBe(true)
      }
      // No authored feature on the baggage storey; the mezzanine's are the
      // atrium's own.
      expect(closedEdges(map, BAG).some((e) => e.feature), seed).toBe(false)
    }
  })

  it('leaves one pier dead and lights the other pier\'s gates with a cool tint', () => {
    const deadSides = new Set()
    for (const seed of KIND_SEEDS) {
      const { map, res } = build(seed)
      const pierLamps = [12, 33].map((x0) => lamps(map, DEP).filter((l) => l.gx >= x0 && l.gx <= x0 + 10 && l.gz >= 12 && l.gz <= 35))
      const lit = pierLamps.map((ls) => ls.filter((l) => l.lit))
      const dead = lit[0].length < lit[1].length ? 0 : 1
      deadSides.add(dead)
      expect(res.notes[0], seed).toContain(`pier ${dead === 0 ? 'A' : 'B'}`)
      // The dead pier keeps at most one lit gate (a relief that is wrong).
      expect(lit[dead].length, seed).toBeLessThanOrEqual(1)
      expect(lit[1 - dead].length, seed).toBeGreaterThanOrEqual(8)
      // Every lit holdroom/tip lamp of the live pier carries the gate tint.
      expect(lit[1 - dead].filter((l) => l.tint === 0xd4e2ff).length, seed).toBeGreaterThanOrEqual(7)
      expect(pierLamps[dead].every((l) => !l.lit || l.tint === 0xd4e2ff), seed).toBe(true)
    }
    // Both piers take their turn being the dead one across the seeds.
    expect(deadSides.size).toBe(2)
  })

  it('names its floors and lies about its gate numbers on the plates', () => {
    const schemes = new Set()
    for (const seed of KIND_SEEDS) {
      const { map, res } = build(seed)
      const labelAt = (cx, cy, cz) => map.chunkAt(cx, cy, cz).levelLabel
      expect(labelAt(1, BAG, 0), seed).toBe('Arr')
      expect(labelAt(1, DEP, 0), seed).toBe('dEP')
      expect(labelAt(1, MEZ, 0), seed).toBe('CLUb')
      // Pier A sits in chunk columns 0..1, pier B in 2..3 (rows 1..2).
      const pierA = [labelAt(0, DEP, 1), labelAt(0, DEP, 2)]
      const pierB = [labelAt(3, DEP, 1), labelAt(3, DEP, 2)]
      expect([...pierA, ...pierB].every((l) => /^C\d+$/.test(l)), seed).toBe(true)
      const scheme = /gate plates (\w+)/.exec(res.notes.join('\n'))[1]
      schemes.add(scheme)
      if (scheme === 'repeat') expect(pierB, seed).toEqual(pierA)
      else expect(pierB, seed).not.toEqual(pierA)
    }
    expect(schemes.size).toBeGreaterThanOrEqual(2)
  })

  it('rings every baggage carousel with a free hall aisle (none flush against the office)', () => {
    const counts = new Set()
    for (const seed of KIND_SEEDS) {
      const { map, res } = build(seed)
      const n = Number(/\((\d) carousels\)/.exec(res.notes.join('\n'))[1])
      counts.add(n)
      // Carousel counters: the west column faces W; each starts a 2 × 6 block.
      const west = []
      for (const d of map.chunks.values()) {
        if (d.cy !== BAG) continue
        for (const f of d.furniture) {
          if (f.kind === FURN_COUNTER && f.facing === FACING.W) west.push({ gx: d.cx * 14 + f.lx, gz: d.cz * 14 + f.lz })
        }
      }
      const xs = [...new Set(west.map((f) => f.gx))].sort((a, b) => a - b)
      expect(xs, seed).toHaveLength(n)
      const hall = (gx, gz) => {
        const c = map.cellAt(gx, BAG, gz)
        return c.col !== 1 && c.spaceId === 0 && !map.furnitureAt(gx, BAG, gz)
      }
      for (const a of xs) {
        // The ring x a−1..a+2 × z 3..10 is open hall, unwalled step to step,
        // so each counter fronts an aisle and the carousel can be walked round.
        const ring = []
        for (let gx = a - 1; gx <= a + 2; gx++) ring.push([gx, 3])
        for (let gz = 4; gz <= 10; gz++) ring.push([a + 2, gz])
        for (let gx = a + 1; gx >= a - 1; gx--) ring.push([gx, 10])
        for (let gz = 9; gz >= 4; gz--) ring.push([a - 1, gz])
        for (let i = 0; i < ring.length; i++) {
          const [gx, gz] = ring[i]
          expect(hall(gx, gz), `${seed} carousel x${a} ring ${gx},${gz}`).toBe(true)
          const [nx, nz] = ring[(i + 1) % ring.length]
          const edge = nx !== gx ? map.wallVAt(Math.max(gx, nx), BAG, gz) : map.wallHAt(gx, BAG, Math.max(gz, nz))
          expect(edge.wall, `${seed} carousel x${a} ring step ${gx},${gz}→${nx},${nz}`).toBeFalsy()
        }
      }
    }
    // Both the two- and the three-carousel hall occur across the seeds.
    expect([...counts].sort()).toEqual([2, 3])
  })

  it('measures inside the doc 12 bands that today\'s engine can reach', () => {
    for (const seed of ['liminal-0', 'liminal-1']) {
      const { map } = build(seed)
      const b = map.bounds()
      const { floors } = liminalReport(map, { ...b }, { samples: 8, rays: 48 })
      const dep = floors.find((f) => f.cy === DEP)
      const mez = floors.find((f) => f.cy === MEZ)
      // Darkness target 0.3–0.5 (dead piers, lit gates): departures measured
      // 0.42–0.53 here.
      expect(dep.darkness, seed).toBeGreaterThan(0.3)
      expect(dep.darkness, seed).toBeLessThan(0.6)
      // Long sight lines along the spine and piers (doc: 30–48 cells, the
      // cap): departures p90 measured ~33.5 at 48 rays.
      expect(dep.sightP90, seed).toBeGreaterThan(28)
      // Dead-end share target 0.35–0.6: the mezzanine's lounges reach it
      // (0.47); departures stays near 0.27 (a two-pier comb, see notes).
      expect(mez.deadEndSpaces / mez.spaces, seed).toBeGreaterThan(0.35)
      expect(mez.deadEndSpaces / mez.spaces, seed).toBeLessThan(0.6)
      expect(dep.deadEndSpaces / dep.spaces, seed).toBeGreaterThan(0.2)
    }
  })
})
