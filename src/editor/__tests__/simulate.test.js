import { describe, expect, it } from 'vitest'
import { CHUNK } from '../../world/constants.js'
import { hashStr } from '../../world/core/hash.js'
import { worldConfigForFamilyOrOffice } from '../../world/mapFamily.js'
import { CELL_ROOM, PASSAGE_DOOR, PASSAGE_WALL, WALL_WINDOW } from '../../world/mapTypes.js'
import { auditLayeredPatch } from '../../world/audit.js'
import { EditorMap } from '../EditorMap.js'
import { WorldSource } from '../worldSource.js'
import {
  distanceField,
  isovist,
  lightField,
  liminalReport,
  shortestPath,
  spaceGraph,
  walkGraph,
  graphComponents,
} from '../simulate.js'
import { discoverStructures, structureChunkBox, structureChunkCoords } from '../structureReview.js'

const BOX0 = { x0: 0, x1: 0, z0: 0, z1: 0, y0: 0, y1: 0 }

// Wall every edge of the rectangle [x0..x1]×[z0..z1] on floor 0.
function wallRect(map, x0, z0, x1, z1, { door = null, feature = 0 } = {}) {
  for (let gz = z0; gz <= z1; gz++) {
    map.setWallV(x0, 0, gz, 1, PASSAGE_WALL, feature)
    map.setWallV(x1 + 1, 0, gz, 1, PASSAGE_WALL, feature)
  }
  for (let gx = x0; gx <= x1; gx++) {
    map.setWallH(gx, 0, z0, 1, PASSAGE_WALL, feature)
    map.setWallH(gx, 0, z1 + 1, 1, PASSAGE_WALL, feature)
  }
  if (door) map.setWallH(door.gx, 0, door.gz, 0, PASSAGE_DOOR)
}

// A 1-wide corridor from (2,5) to (10,5) inside chunk (0,0,0).
function corridorMap() {
  const map = new EditorMap()
  map.mutate(() => {
    for (let gz = 0; gz < CHUNK; gz++) for (let gx = 0; gx < CHUNK; gx++) map.setCell(gx, 0, gz, { col: 1 })
    for (let gx = 2; gx <= 10; gx++) map.setCell(gx, 0, 5, { col: 0 })
  })
  return map
}

describe('distance field and paths', () => {
  it('measures walk distance, the farthest cell and dead ends', () => {
    const map = corridorMap()
    const f = distanceField(map, BOX0, { gx: 2, gz: 5, cy: 0 })
    expect(f.ok).toBe(true)
    expect(f.reachable).toBe(9)
    expect(f.max).toBe(8)
    expect(f.farthest).toMatchObject({ gx: 10, gz: 5 })
    expect(f.deadEnds.map((n) => n.gx).sort((a, b) => a - b)).toEqual([2, 10])
    expect(f.dist.get('6,5,0')).toBe(4)
  })

  it('reports an unwalkable start instead of throwing', () => {
    const f = distanceField(corridorMap(), BOX0, { gx: 0, gz: 0, cy: 0 })
    expect(f.ok).toBe(false)
  })

  it('routes across floors through a tower volume', () => {
    const { config } = worldConfigForFamilyOrOffice('tower')
    const seed = hashStr('lobby')
    const s = discoverStructures(seed, config, { x0: -6, x1: 6, z0: -6, z1: 6, y0: -2, y1: 20 })
      .find((d) => d.kind === 'towerSkybridge')
    const map = new EditorMap()
    map.bakeChunks({ seed, family: 'tower', coords: structureChunkCoords(s, 0) })
    const box = structureChunkBox(s, 0)
    const graph = walkGraph(map, box)
    const [main] = graphComponents(graph)
    const onFloor = (cy) => [...graph.nodes.values()].find((n) => n.cy === cy)
    const a = onFloor(s.baseCy)
    const b = onFloor(s.topCy)
    expect(main.floors).toEqual([s.baseCy, s.baseCy + 1, s.topCy])
    const route = shortestPath(map, box, a, b)
    expect(route.ok).toBe(true)
    expect(route.flights).toBe(2)
    expect(route.path[0]).toMatchObject(a)
    expect(route.path.at(-1)).toMatchObject(b)
    // Every step is a planar neighbour or one stair flight.
    for (let i = 1; i < route.path.length; i++) {
      const p = route.path[i - 1]
      const q = route.path[i]
      if (p.cy === q.cy) expect(Math.abs(p.gx - q.gx) + Math.abs(p.gz - q.gz)).toBe(1)
      else expect(Math.abs(p.cy - q.cy)).toBe(1)
    }
  })

  it('agrees with the layered audit on walkable cells and components', () => {
    const { config } = worldConfigForFamilyOrOffice('office')
    const seed = hashStr('a')
    const map = new EditorMap()
    map.bakeProcedural({ seedText: 'a', family: 'office', radius: 1, floors: [0, 1] })
    const box = { x0: -1, x1: 1, z0: -1, z1: 1, y0: 0, y1: 1 }
    const audit = auditLayeredPatch((cx, cy, cz) => map.chunkAt(cx, cy, cz), -1, 0, -1, 3, 2, 3)
    const comps = graphComponents(walkGraph(map, box))
    expect(comps.map((c) => c.size)).toEqual(audit.componentSizes)
    expect(config).toBeTruthy()
    expect(seed).toBeGreaterThan(0)
  })
})

describe('isovist', () => {
  it('is bounded by opaque walls and sees through windows', () => {
    const map = new EditorMap()
    map.mutate(() => wallRect(map, 2, 2, 6, 6))
    const closed = isovist(map, 0, 4, 4, { rays: 90 })
    // Farthest visible point: a corner, sqrt(2.5² + 2.5²) cells away.
    expect(closed.maxDepth).toBeGreaterThan(3.3)
    expect(closed.maxDepth).toBeLessThan(3.6)
    expect(closed.area).toBeGreaterThan(20)
    expect(closed.area).toBeLessThan(26)
    expect(closed.cells.has('9,4,0')).toBe(false)

    const glass = new EditorMap()
    glass.mutate(() => wallRect(glass, 2, 2, 6, 6, { feature: WALL_WINDOW }))
    const seeThrough = isovist(glass, 0, 4, 4, { rays: 90, range: 12 })
    expect(seeThrough.maxDepth).toBeGreaterThan(10)
    expect(seeThrough.cells.has('9,4,0')).toBe(true)
  })
})

describe('light field', () => {
  it('lights a room from its lamp and counts darkness', () => {
    const map = new EditorMap()
    map.mutate(() => {
      wallRect(map, 1, 1, 5, 5)
      map.setLamp(3, 0, 3, true)
    })
    const lit = lightField(map, BOX0, 0, { radius: 4 })
    expect(lit.litLamps).toBe(1)
    expect(lit.level.get('3,3,0')).toBeCloseTo(1, 5)
    // Nothing outside the walls is lit.
    expect(lit.level.has('8,3,0')).toBe(false)
    expect(lit.darkness).toBeGreaterThan(0.5)

    map.mutate(() => map.setLamp(3, 0, 3, false))
    const dead = lightField(map, BOX0, 0, { radius: 4 })
    expect(dead.deadLamps).toBe(1)
    expect(dead.darkness).toBe(1)
  })
})

describe('space graph', () => {
  // Three rooms (spaceIds 1..3) in a row, joined through one-cell unnamed
  // gaps: A—p—B—p—C. Everything else is blocked. `ring` adds a south corridor
  // from A to C, closing exactly one loop.
  function roomsRow({ ring = false } = {}) {
    const map = new EditorMap()
    map.mutate(() => {
      for (let gz = 0; gz < CHUNK; gz++) for (let gx = 0; gx < CHUNK; gx++) map.setCell(gx, 0, gz, { col: 1 })
      const rooms = [[1, 1, 3, 3], [5, 1, 7, 3], [9, 1, 11, 3]]
      rooms.forEach(([x0, z0, x1, z1], i) => {
        for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) {
          map.setCell(gx, 0, gz, { kind: CELL_ROOM, spaceId: i + 1, col: 0 })
        }
      })
      map.setCell(4, 0, 2, { col: 0 })
      map.setCell(8, 0, 2, { col: 0 })
      if (ring) {
        map.setCell(2, 0, 4, { col: 0 })
        map.setCell(10, 0, 4, { col: 0 })
        for (let gx = 2; gx <= 10; gx++) map.setCell(gx, 0, 5, { col: 0 })
      }
    })
    return map
  }

  it('counts dead ends, loops and articulation spaces', () => {
    const tree = spaceGraph(roomsRow(), BOX0, 0)
    expect(tree).toMatchObject({ spaces: 5, edges: 4, loops: 0, deadEnds: 2, decisions: 0, articulation: 3 })
    // The south corridor decomposes into three convex rectangles.
    const loop = spaceGraph(roomsRow({ ring: true }), BOX0, 0)
    expect(loop).toMatchObject({ spaces: 8, edges: 8, loops: 1, deadEnds: 0, articulation: 0 })
  })
})

describe('liminal report and world source', () => {
  it('reports finite per-floor metrics over the live world', () => {
    const world = new WorldSource({ seedText: 'lobby', family: 'office' })
    const box = { x0: -1, x1: 1, z0: -1, z1: 1, y0: 0, y1: 0 }
    expect(world.chunkAt(0, 0, 0)).toBeNull() // queued, not generated
    expect(world.pending).toBe(1)
    world.prepare(box)
    expect(world.chunkAt(0, 0, 0)).toBeTruthy()
    const report = liminalReport(world, box, { samples: 8, rays: 48 })
    expect(report.floors).toHaveLength(1)
    const f = report.floors[0]
    expect(f.chunks).toBe(9)
    expect(f.walkable).toBeGreaterThan(500)
    for (const k of ['openShare', 'darkness', 'repetition']) {
      expect(f[k]).toBeGreaterThanOrEqual(0)
      expect(f[k]).toBeLessThanOrEqual(1)
    }
    expect(f.sightMedian).toBeGreaterThan(0)
    expect(f.spaces).toBeGreaterThan(5)
    expect(f.articulationSpaces).toBeLessThanOrEqual(f.spaces)
    // The world source reads like a document.
    expect(world.cellAt(3, 0, 3).chunk).toBe(world.chunkAt(0, 0, 0))
  })
})

describe('convex decomposition', () => {
  it('reads a corridor ring round a core as a ring', () => {
    const map = new EditorMap()
    map.mutate(() => {
      for (let gz = 0; gz < CHUNK; gz++) for (let gx = 0; gx < CHUNK; gx++) map.setCell(gx, 0, gz, { col: 1 })
      for (let gx = 2; gx <= 10; gx++) { map.setCell(gx, 0, 2, { col: 0 }); map.setCell(gx, 0, 8, { col: 0 }) }
      for (let gz = 2; gz <= 8; gz++) { map.setCell(2, 0, gz, { col: 0 }); map.setCell(10, 0, gz, { col: 0 }) }
    })
    const g = spaceGraph(map, BOX0, 0)
    expect(g.loops).toBe(1)
    expect(g.deadEnds).toBe(0)
    expect(g.types.shares.c).toBe(1)
  })
})

describe('room repetition', () => {
  it('counts rooms whose layout repeats', async () => {
    const { roomRepetition } = await import('../simulate.js')
    const map = new EditorMap()
    map.mutate(() => {
      for (const [x0, id] of [[1, 1], [5, 2], [9, 3]]) {
        for (let gz = 1; gz <= 3; gz++) for (let gx = x0; gx <= x0 + 2; gx++) map.setCell(gx, 0, gz, { kind: CELL_ROOM, spaceId: id })
        map.setLamp(x0 + 1, 0, 2, id !== 3)
      }
    })
    expect(roomRepetition(map, BOX0, 0)).toEqual({ rooms: 3, repeated: 2, share: 2 / 3 })
  })
})

describe('space syntax metrics', () => {
  const graph = (edges) => {
    const adj = new Map()
    for (const [a, b] of edges) {
      if (!adj.has(a)) adj.set(a, new Set())
      if (!adj.has(b)) adj.set(b, new Set())
      adj.get(a).add(b)
      adj.get(b).add(a)
    }
    return adj
  }

  it('classifies Hillier a/b/c/d spaces', async () => {
    const { hillierTypes } = await import('../simulate.js')
    expect(hillierTypes(graph([['A', 'B'], ['B', 'C']]))).toMatchObject({ a: 2, b: 1, c: 0, d: 0 })
    expect(hillierTypes(graph([['A', 'B'], ['B', 'C'], ['C', 'A'], ['C', 'D']]))).toMatchObject({ a: 1, b: 0, c: 3, d: 0 })
    // Bowtie: C sits on two rings.
    expect(hillierTypes(graph([['A', 'B'], ['B', 'C'], ['C', 'A'], ['C', 'D'], ['D', 'E'], ['E', 'C']])))
      .toMatchObject({ c: 4, d: 1 })
    // K4: one block with three independent rings.
    const k4 = graph([['A', 'B'], ['A', 'C'], ['A', 'D'], ['B', 'C'], ['B', 'D'], ['C', 'D']])
    expect(hillierTypes(k4)).toMatchObject({ d: 4 })
  })

  it('integrates hubs and reports intelligibility', async () => {
    const { integration } = await import('../simulate.js')
    const star = graph([['H', 'a'], ['H', 'b'], ['H', 'c'], ['H', 'd'], ['H', 'e']])
    const r = integration(star)
    expect(r.intelligibility).toBeCloseTo(1, 6)
    expect(r.meanIntegration).toBeGreaterThan(0)
  })

  it("measures darkness clustering with Moran's I", async () => {
    const { darknessClustering, walkGraph } = await import('../simulate.js')
    const map = corridorMap()
    const g = walkGraph(map, BOX0, { vertical: false })
    const keys = [...g.nodes.keys()].sort((a, b) => Number(a.split(',')[0]) - Number(b.split(',')[0]))
    const clustered = new Map(keys.map((k, i) => [k, i < 4 ? 0 : 1]))
    const alternating = new Map(keys.map((k, i) => [k, i % 2 ? 0 : 1]))
    expect(darknessClustering(g, clustered)).toBeGreaterThan(0.5)
    expect(darknessClustering(g, alternating)).toBeLessThan(-0.5)
  })
})
