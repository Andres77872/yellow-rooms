import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'

// Spec §9.6: the gated mass fast path. (a) a whole-solid chunk of a
// massFastPath family skips meshing; (b) sealed mass cells get no column
// instance and no column trim. Legacy families never take either path.

// generateChunk is routed through an override so a solid liminal chunk can be
// streamed before the liminal pipeline branch (F-backend) exists; with no
// override the real generator runs (legacy rows).
const gen = vi.hoisted(() => ({ override: null }))
vi.mock('../generate.js', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    generateChunk: (...args) => (gen.override ? gen.override(...args) : real.generateChunk(...args)),
  }
})

const { Chunk } = await import('../Chunk.js')
const { ChunkManager } = await import('../ChunkManager.js')
const { ChunkData } = await import('../ChunkData.js')
const { buildChunkMeshes, emptyChunkMeshes } = await import('../mesh.js')
const { dressColumns } = await import('../objects/dressing/columns.js')
const { worldConfigForFamily } = await import('../mapFamily.js')
const { forcedFamilyConfig } = await import('../families/forced.js')
const { LIMINAL_FAMILY_IDS } = await import('../families/ids.js')
const { solidChunk, isSolidMassChunk } = await import('../tiles/solidChunk.js')
const { familyGenerator } = await import('../families/generators.js')
const { resolveMapFamily } = await import('../mapFamily.js')
const { tileKeyOf } = await import('../tiles/tileKey.js')
const { generateChunk } = await import('../generate.js')
const { sealedMassMask, fastPathMassMask, massFastPathOf, BORDER_DEPTH } = await import('../tiles/massMask.js')
const { cellWalkable } = await import('../tiles/holeMasks.js')
const { createGeometries } = await import('../../render/geometries.js')
const { CELL, CHUNK, COL_HALF, WALL_H, chunkKey3, cIdx, hIdx, vIdx } = await import('../constants.js')
const { COLUMN_STANDARD, COLUMN_NONE, WALL_PLAIN, WALL_RAIL, WALL_WINDOW } =
  await import('../mapTypes.js')
const { EditorMap } = await import('../../editor/EditorMap.js')
const { generatePrototype } = await import('../../editor/prototypes.js')

const geom = createGeometries()
const material = new THREE.MeshBasicMaterial()
const materials = new Proxy({}, { get: () => material })

const SEED = 12345
const PARTS = ['walls', 'stairs', 'frames', 'leaves', 'veneer', 'hardware', 'props', 'decals', 'signs',
  'glass', 'furniture', 'litPanels', 'deadPanels']

// Instance count of a render part (every instanced batch under it), -1 when
// the part is absent.
function instances(part) {
  if (!part) return -1
  let n = 0
  part.traverse((o) => { if (o.isInstancedMesh) n += o.count })
  return n
}

function totalInstances(group) {
  let n = 0
  group.traverse((o) => { if (o.isInstancedMesh) n += o.count })
  return n
}

// Cells (cIdx) holding a freestanding standard column instance in the wall
// batch: a 2*COL_HALF x WALL_H x 2*COL_HALF box at the cell centre.
function columnCells(mesh) {
  const out = new Set()
  const walls = mesh.parts.walls
  if (!walls) return out
  const m = new THREE.Matrix4()
  const p = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const s = new THREE.Vector3()
  const near = (a, b) => Math.abs(a - b) < 1e-4
  for (let i = 0; i < walls.count; i++) {
    walls.getMatrixAt(i, m)
    m.decompose(p, q, s)
    if (!near(s.x, COL_HALF * 2) || !near(s.z, COL_HALF * 2) || !near(s.y, WALL_H)) continue
    const x = p.x / CELL - 0.5
    const z = p.z / CELL - 0.5
    if (near(x, Math.round(x)) && near(z, Math.round(z))) out.add(cIdx(Math.round(x), Math.round(z)))
  }
  return out
}

// Captured from the pre-§9.6 mesher (seed 12345, storey 0): the instance
// count of every batch, in PARTS order, -1 = absent. The fast path must not
// move a single legacy instance. A byte-level check of the instance matrices
// over all 5 families x 18 chunks was run when this landed (SP probe).
const LEGACY_COUNTS = {
  'office:-1,-1': [32, -1, 184, -1, 76, 88, 229, 31, -1, 6, 236, 10, 1],
  'office:0,-1': [39, -1, 182, 46, 96, 142, 107, 30, 33, 10, 114, 18, 3],
  'office:1,-1': [40, -1, 204, -1, 74, 74, 88, 31, 24, 6, 136, 14, 3],
  'office:-1,0': [40, -1, 184, 26, 50, 94, 187, 38, 43, 6, 98, 18, 2],
  'office:0,0': [39, -1, 182, 52, 120, 180, 185, 43, 47, 14, 137, 12, 8],
  'office:1,0': [36, -1, 192, 32, 50, 160, 174, 27, 19, 6, 164, 17, 6],
  'office:-1,1': [26, -1, 162, 2, 144, 142, 198, 22, 30, 12, 170, 12, 4],
  'office:0,1': [51, -1, 226, 46, 50, 116, 226, 45, 63, 6, 89, 21, 5],
  'office:1,1': [57, -1, 252, -1, 98, 94, 290, 48, 54, 8, 80, 21, 4],
  'lattice:-1,-1': [24, -1, 40, 48, -1, 40, 14, 11, 4, 4, -1, 29, 13],
  'lattice:0,-1': [29, -1, 60, 72, -1, 60, 14, 7, -1, 6, 87, 26, 12],
  'lattice:1,-1': [25, 12, 40, 68, -1, 54, 26, 25, 4, 4, 120, 21, 9],
  'lattice:-1,0': [14, -1, 40, 64, -1, 48, 4, 5, -1, 2, 93, 22, 16],
  'lattice:0,0': [18, -1, 40, 24, -1, 20, 8, 4, -1, 2, 110, 31, 10],
  'lattice:1,0': [9, -1, 20, 44, -1, 34, 2, 2, -1, 2, 16, 34, 9],
  'lattice:-1,1': [7, -1, 10, 24, -1, 20, -1, -1, -1, 2, -1, 30, 15],
  'lattice:0,1': [15, -1, 30, 48, -1, 40, 2, 1, -1, 4, 57, 21, 15],
  'lattice:1,1': [21, -1, 30, 48, -1, 40, 10, 5, -1, 4, 16, 26, 13],
  'hotel:-1,-1': [38, -1, 288, -1, 84, 600, 144, 15, 25, -1, 151, 18, 1],
  'hotel:0,-1': [36, -1, 252, -1, 66, 394, 95, 5, 5, -1, 137, 16, 4],
  'hotel:1,-1': [38, -1, 270, 28, 86, 684, 99, 18, 15, -1, 141, 19, -1],
  'hotel:-1,0': [46, -1, 290, -1, 96, 742, 99, 12, 34, -1, 128, 23, 2],
  'hotel:0,0': [36, -1, 232, -1, 66, 432, 122, 11, -1, -1, 119, 16, 3],
  'hotel:1,0': [43, -1, 266, -1, 84, 746, 126, 13, 25, -1, 151, 25, 3],
  'hotel:-1,1': [45, -1, 256, 28, 80, 604, 109, 16, 9, -1, 160, 20, 4],
  'hotel:0,1': [34, -1, 228, 14, 48, 404, 134, 15, 5, -1, 121, 20, 1],
  'hotel:1,1': [36, -1, 234, -1, 96, 856, 148, 20, 20, -1, 95, 21, 2],
}

describe('mass fast path: legacy families are untouched', () => {
  it('legacy instance counts are identical (3 families x 9 chunks)', () => {
    gen.override = null
    const actual = {}
    for (const family of ['office', 'lattice', 'hotel']) {
      const config = worldConfigForFamily(family)
      for (let cz = -1; cz <= 1; cz++) {
        for (let cx = -1; cx <= 1; cx++) {
          const c = new Chunk(cx, 0, cz, SEED, materials, geom, null, config, null)
          expect(massFastPathOf(c.data)).toBe(false)
          expect(fastPathMassMask(c.data)).toBeNull()
          actual[`${family}:${cx},${cz}`] = PARTS.map((p) => instances(c.renderParts[p]))
          c.dispose()
        }
      }
    }
    expect(actual).toEqual(LEGACY_COUNTS)
  }, 60_000)

  it('a legacy solid chunk still meshes every column (no gate, no mask)', () => {
    const data = solidChunk(SEED, 0, 0, 0, worldConfigForFamily('office'), 'office')
    expect(isSolidMassChunk(data)).toBe(true)
    gen.override = () => data
    try {
      const c = new Chunk(0, 0, 0, SEED, materials, geom, null, worldConfigForFamily('office'), null)
      expect(c.zoneBytes).not.toBeNull()
      expect(columnCells(c._mesh).size).toBe(CHUNK * CHUNK)
      const trim = []
      dressColumns(data, trim)
      expect(trim.length).toBe(4 * CHUNK * CHUNK)
      c.dispose()
    } finally {
      gen.override = null
    }
  })
})

describe('mass fast path (a): whole-chunk solid mass of a liminal family', () => {
  it('emptyChunkMeshes has the buildChunkMeshes shape and nothing to draw', () => {
    const m = emptyChunkMeshes()
    expect(m.group).toBeInstanceOf(THREE.Group)
    expect(m.group.children).toEqual([])
    expect(m.lamps).toEqual([])
    expect(m.parts).toEqual({})
    expect(m.exitWorld).toBeNull()
    expect(m.zoneMap).toBeNull()
    const parent = new THREE.Group()
    parent.add(m.group)
    m.dispose()
    expect(m.group.parent).toBeNull()
  })

  // Sight through glass across a thin band of in-chunk mass may reach a
  // whole-solid chunk (the train's far windows, §12.10): it keeps the shared
  // full-chunk floor and ceiling planes, so the slab continues instead of the
  // black clear colour. No instances, no per-chunk geometry to free.
  it('emptyChunkMeshes with geometry keeps only the shared floor and ceiling planes', () => {
    const m = emptyChunkMeshes(geom, materials, 42, 7, -42)
    expect(m.group.position.toArray()).toEqual([42, 7, -42])
    expect(m.group.children.length).toBe(2)
    expect(totalInstances(m.group)).toBe(0)
    expect(Object.keys(m.parts).sort()).toEqual(['ceiling', 'floor'])
    expect(Object.isFrozen(m.parts)).toBe(true)
    expect(m.parts.floor.geometry).toBe(geom.floor)
    expect(m.parts.ceiling.geometry).toBe(geom.ceiling)
    expect(m.parts.floor.position.y).toBe(0)
    expect(m.parts.ceiling.position.y).toBe(WALL_H)
    expect(typeof m.parts.floor.onBeforeRender).toBe('function')
    expect(m.lamps).toEqual([])
    expect(m.zoneMap).toBeNull()
    const floorDispose = vi.spyOn(geom.floor, 'dispose')
    const ceilDispose = vi.spyOn(geom.ceiling, 'dispose')
    const parent = new THREE.Group()
    parent.add(m.group)
    m.dispose()
    expect(m.group.parent).toBeNull()
    expect(floorDispose).not.toHaveBeenCalled()
    expect(ceilDispose).not.toHaveBeenCalled()
    floorDispose.mockRestore()
    ceilDispose.mockRestore()
  })

  it('every liminal family: a solid chunk has 0 instances, no stair cells, no apertures', () => {
    for (const id of LIMINAL_FAMILY_IDS) {
      const config = forcedFamilyConfig(id)
      const data = solidChunk(SEED, 2, 0, -3, config, id)
      gen.override = () => data
      try {
        const c = new Chunk(2, 0, -3, SEED, materials, geom, null, config, null)
        expect(c.data).toBe(data)
        expect(totalInstances(c.group)).toBe(0)
        // Only the shared floor and ceiling planes, at the chunk origin.
        expect(c.group.children.length).toBe(2)
        expect(c.renderParts.floor.geometry).toBe(geom.floor)
        expect(c.renderParts.ceiling.geometry).toBe(geom.ceiling)
        expect(c.group.position.x).toBe(2 * CHUNK * CELL)
        expect(c.group.position.z).toBe(-3 * CHUNK * CELL)
        expect(c.stairCells).toBeInstanceOf(Map)
        expect(c.stairCells.size).toBe(0)
        expect(c.apertures).toEqual([])
        expect(c.lamps).toEqual([])
        expect(c.exitWorld).toBeNull()
        expect(c.zoneBytes).toBeNull()
        expect(c.surfaceSet).toBeNull()
        // Every reader of _mesh / zoneBytes / renderParts tolerates it.
        expect(() => c.refreshZoneHalo(() => null)).not.toThrow()
        expect(c.setRenderDetail('reduced')).toBe(true)
        expect(c.setRenderDetail('shell')).toBe(true)
        expect(c.setBevelDetail(false)).toBe(true)
        expect(() => c.refreshFurniture(null)).not.toThrow()
        const root = new THREE.Group()
        c.mount(root)
        expect(c.group.parent).toBe(root)
        c.dispose()
        expect(c.group.parent).toBeNull()
      } finally {
        gen.override = null
      }
    }
  })

  it('end to end: the real liminal pipeline (no override) sends footprint-solid chunks down the fast path', () => {
    // Per family, coordinates come from its own geometry (familyGenerator(id)
    // .tile / .footprint), not a fixed (3, ±1, −2): a real family's tiles sit
    // wherever its design puts them (stairwell: shaft chunks on every storey;
    // poolrooms: a 3-storey band). A chunk outside the tile range or with
    // footprint 'solid' must come out of generateChunk → buildChunk →
    // buildFamilyChunk as whole-solid mass and take the fast path; the first
    // baked tile chunk that is not whole mass must mesh normally.
    expect(gen.override).toBeNull()
    const XZ = [[3, -2], [0, 0], [1, 0], [0, 1], [-1, -1], [2, 2], [5, -3], [-4, 6], [7, 7], [-9, -2], [11, 4], [-6, -8]]
    const SOLID_CY = [1, -1, 2, -2, 3, -3, 6, -6, 20, -20, 64, -64]
    let familiesWithSolid = 0
    for (const id of LIMINAL_FAMILY_IDS) {
      const config = forcedFamilyConfig(id)
      const fam = familyGenerator(id)
      const profile = resolveMapFamily(config)
      const isSolid = (cx, cy, cz) =>
        tileKeyOf(fam.tile, cx, cy, cz) === null || fam.footprint(SEED, cx, cy, cz, profile) === 'solid'
      const solids = []
      for (const cy of SOLID_CY) {
        for (const [cx, cz] of XZ) if (solids.length < 2 && isSolid(cx, cy, cz)) solids.push([cx, cy, cz])
      }
      if (solids.length) familiesWithSolid++
      for (const [cx, cy, cz] of solids) {
        const at = `${id} ${cx},${cy},${cz}`
        const c = new Chunk(cx, cy, cz, SEED, materials, geom, null, config, null)
        expect(c.data.mapFamily, at).toBe(id)
        expect(isSolidMassChunk(c.data), `${at} solid`).toBe(true)
        expect(totalInstances(c.group), `${at} instances`).toBe(0)
        expect(c.group.children.length).toBe(2)
        expect(c.surfaceSet).toBeNull()
        expect(c.stairCells.size).toBe(0)
        c.dispose()
      }
      let tileAt = null
      for (const cy of [0, 1, -1]) {
        for (let cz = -3; cz <= 3 && !tileAt; cz++) {
          for (let cx = -3; cx <= 3 && !tileAt; cx++) {
            if (isSolid(cx, cy, cz)) continue
            if (!isSolidMassChunk(generateChunk(SEED, cx, cy, cz, config))) tileAt = [cx, cy, cz]
          }
        }
        if (tileAt) break
      }
      expect(tileAt, `${id}: a baked, non-mass tile chunk near the origin`).not.toBeNull()
      const tile = new Chunk(...tileAt, SEED, materials, geom, null, config, null)
      expect(isSolidMassChunk(tile.data), `${id} ${tileAt} is a baked tile`).toBe(false)
      expect(tile.surfaceSet).not.toBeNull()
      expect(totalInstances(tile.group), `${id} ${tileAt} meshes`).toBeGreaterThan(0)
      tile.dispose()
    }
    expect(familiesWithSolid).toBeGreaterThan(0)
  }, 120_000)

  it('cm.stairAt, stair-cell lookups and placement queries work over solid chunks', () => {
    const config = forcedFamilyConfig('stairwell')
    gen.override = (seed, cx, cy, cz, cfg) => solidChunk(seed, cx, cy, cz, cfg, 'stairwell')
    try {
      const cm = new ChunkManager(new THREE.Scene(), SEED, materials, geom)
      cm.config = config
      for (let cz = -1; cz <= 1; cz++) {
        for (let cx = -1; cx <= 1; cx++) {
          const key = chunkKey3(cx, 0, cz)
          cm.queue.push({ cx, cy: 0, cz, key })
          cm.queued.add(key)
          cm._buildNext()
        }
      }
      expect(cm.chunks.size).toBe(9)
      expect(cm.apertures.size).toBe(0)
      for (const c of cm.chunks.values()) {
        expect(c.stairCells.size).toBe(0)
        expect(c.stairCells.get(cIdx(3, 4))).toBeUndefined()
        expect(totalInstances(c.group)).toBe(0)
      }
      for (const [gx, gz] of [[0, 0], [-1, -1], [13, 13], [-14, 7], [20, -5]]) {
        expect(cm.stairAt(gx, gz, 0)).toBeNull()
        expect(cm.floorHoleAt(gx, gz, 0)).toBe(false)
        expect(cm.columnAt(gx, gz, 0)).toBe(true)
        expect(cm.isBlocked((gx + 0.5) * CELL, (gz + 0.5) * CELL, 0)).toBe(true)
      }
      expect(cm.collectLampsNear(0, 0, [], 0)).toEqual([])
      expect(cm.exitWorld()).toBeNull()
      cm.updateVisibility(0)
      cm.upgradeFurnitureModels(null)
      for (const c of cm.chunks.values()) c.refreshFurniture(null)
      expect(() => cm.reset()).not.toThrow()
      expect(cm.chunks.size).toBe(0)
    } finally {
      gen.override = null
    }
  })
})

// A train-like synthetic chunk: all mass, a corridor on rows 5..7, glass on
// the corridor's north line for x 2..11, plain walls elsewhere around it. The
// own west line carries plain walls on the south block's rows, so only the
// neighbours' (east/south) lines are border entries there.
function corridorChunk(family) {
  const d = new ChunkData(0, 0, 0, 0, undefined, family)
  d.cols.fill(COLUMN_STANDARD)
  for (let z = 5; z <= 7; z++) for (let x = 0; x < CHUNK; x++) d.setCol(x, z, COLUMN_NONE)
  for (let x = 0; x < CHUNK; x++) {
    d.setH(x, 5, 1, undefined, x >= 2 && x <= 11 ? WALL_WINDOW : WALL_PLAIN)
    d.setH(x, 8, 1)
  }
  for (let z = 8; z < CHUNK; z++) d.setV(0, z, 1)
  return d
}

const isMassCell = (d, x, z) => d.cols[cIdx(x, z)] === COLUMN_STANDARD
const plainV = (d, line, z) => d.wallV[vIdx(line, z)] !== 0 && d.wallFeatureV[vIdx(line, z)] === WALL_PLAIN
const plainH = (d, x, line) => d.wallH[hIdx(x, line)] !== 0 && d.wallFeatureH[hIdx(x, line)] === WALL_PLAIN

// Global sight depth through mass: breadth-first from every walkable cell of
// the map, across chunk borders, through every edge that is not an opaque
// plain wall (open, window, rail), into mass cells only. Returns
// Map<'gx,cy,gz', depth> (1 = the mass cell right behind the edge).
function sightDepths(chunks, maxDepth) {
  const at = new Map()
  for (const d of chunks) at.set(`${d.cx},${d.cy},${d.cz}`, d)
  const fd = (a) => Math.floor(a / CHUNK)
  const md = (a) => ((a % CHUNK) + CHUNK) % CHUNK
  const cellAt = (gx, cy, gz) => {
    const d = at.get(`${fd(gx)},${cy},${fd(gz)}`)
    return d ? { d, x: md(gx), z: md(gz) } : null
  }
  // Edge between (gx, gz) and (gx + dx, gz + dz): the owner of the line holds it.
  const opaque = (gx, cy, gz, dx, dz) => {
    const c = dx ? cellAt(dx > 0 ? gx + 1 : gx, cy, gz) : cellAt(gx, cy, dz > 0 ? gz + 1 : gz)
    if (!c) return true
    return dx ? plainV(c.d, c.x, c.z) : plainH(c.d, c.x, c.z)
  }
  const depth = new Map()
  let frontier = []
  for (const d of chunks) {
    for (let z = 0; z < CHUNK; z++) {
      for (let x = 0; x < CHUNK; x++) if (cellWalkable(d, x, z)) frontier.push([d.cx * CHUNK + x, d.cy, d.cz * CHUNK + z])
    }
  }
  for (let k = 1; k <= maxDepth && frontier.length; k++) {
    const next = []
    for (const [gx, cy, gz] of frontier) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const c = cellAt(gx + dx, cy, gz + dz)
        if (!c || !isMassCell(c.d, c.x, c.z)) continue
        const key = `${gx + dx},${cy},${gz + dz}`
        if (depth.has(key) || opaque(gx, cy, gz, dx, dz)) continue
        depth.set(key, k)
        next.push([gx + dx, cy, gz + dz])
      }
    }
    frontier = next
  }
  return { depth, cellAt }
}

// In-chunk sight: every mass cell connected through mass (across non-plain
// edges) to a mass cell that faces a non-mass in-chunk cell across a
// non-plain edge. Independent of massMask's budget bookkeeping.
function inChunkSight(d) {
  const seen = new Uint8Array(CHUNK * CHUNK)
  const stack = []
  const push = (x, z) => {
    const i = cIdx(x, z)
    if (!seen[i]) { seen[i] = 1; stack.push([x, z]) }
  }
  const steps = (x, z) => [
    [x - 1, z, x > 0 && !plainV(d, x, z)],
    [x + 1, z, x < CHUNK - 1 && !plainV(d, x + 1, z)],
    [x, z - 1, z > 0 && !plainH(d, x, z)],
    [x, z + 1, z < CHUNK - 1 && !plainH(d, x, z + 1)],
  ]
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      if (!isMassCell(d, x, z)) continue
      if (steps(x, z).some(([nx, nz, open]) => open && !isMassCell(d, nx, nz))) push(x, z)
    }
  }
  while (stack.length) {
    const [x, z] = stack.pop()
    for (const [nx, nz, open] of steps(x, z)) if (open && isMassCell(d, nx, nz)) push(nx, nz)
  }
  return seen
}

describe('mass fast path (b): sealed mass mask', () => {
  it('mass behind in-chunk glass keeps its columns all the way back; sealed mass is masked', () => {
    const d = corridorChunk('train')
    const mask = sealedMassMask(d)
    // North block: sight enters through the glass on line 5 and every row
    // behind it stays visible between the posts, including cells that sit
    // behind the plain part of the wall and the deepest row on the border.
    for (let z = 0; z <= 4; z++) for (let x = 0; x < CHUNK; x++) expect(mask[cIdx(x, z)], `${x},${z}`).toBe(0)
    for (let z = 5; z <= 7; z++) for (let x = 0; x < CHUNK; x++) expect(mask[cIdx(x, z)]).toBe(0)
    // South block: plain walls on line 8 and on the own west line, so the
    // only entries are the neighbours' east and south lines, each keeping
    // BORDER_DEPTH rows of posts.
    for (let z = 8; z < CHUNK; z++) {
      for (let x = 0; x < CHUNK; x++) {
        const fromBorder = Math.min(CHUNK - x, CHUNK - z)
        expect(mask[cIdx(x, z)], `${x},${z}`).toBe(fromBorder > BORDER_DEPTH ? 1 : 0)
      }
    }
    expect(mask.reduce((a, b) => a + b, 0)).toBe((CHUNK - BORDER_DEPTH) * (CHUNK - BORDER_DEPTH - 8))

    const mesh = buildChunkMeshes(d, geom, materials, 0, 0, 0)
    const cols = columnCells(mesh)
    for (let i = 0; i < CHUNK * CHUNK; i++) {
      const isCol = d.cols[i] === COLUMN_STANDARD
      expect(cols.has(i)).toBe(isCol && !mask[i])
    }
    for (let x = 2; x <= 11; x++) for (let z = 0; z <= 4; z++) expect(cols.has(cIdx(x, z))).toBe(true)
    const trim = []
    dressColumns(d, trim)
    expect(trim.length).toBe(4 * cols.size)
    mesh.dispose()
  })

  it('the same raster under a legacy family keeps every column', () => {
    const d = corridorChunk('office')
    expect(fastPathMassMask(d)).toBeNull()
    const mesh = buildChunkMeshes(d, geom, materials, 0, 0, 0)
    expect(columnCells(mesh).size).toBe(CHUNK * CHUNK - 3 * CHUNK)
    mesh.dispose()
  })

  it('see-through walls on the own border line and slab holes are sight entries', () => {
    // All mass, plain walls on the whole own west and north lines: only the
    // neighbours' lines (east/south) enter, plus what each case opens.
    const sealed = () => {
      const d = new ChunkData(0, 0, 0, 0, undefined, 'train')
      d.cols.fill(COLUMN_STANDARD)
      for (let k = 0; k < CHUNK; k++) { d.setV(0, k, 1); d.setH(k, 0, 1) }
      return d
    }
    const base = sealedMassMask(sealed())
    expect(base[cIdx(0, 3)]).toBe(1)
    expect(base[cIdx(6, 0)]).toBe(1)

    const d = sealed()
    d.setV(0, 3, 1, undefined, WALL_RAIL)
    d.setH(6, 0, 1, undefined, WALL_WINDOW)
    const mask = sealedMassMask(d)
    // A border entry keeps BORDER_DEPTH rows (Manhattan steps) of posts.
    for (let x = 0; x < BORDER_DEPTH; x++) expect(mask[cIdx(x, 3)], `rail row ${x}`).toBe(0)
    expect(mask[cIdx(BORDER_DEPTH, 3)]).toBe(1)
    for (let z = 0; z < BORDER_DEPTH; z++) expect(mask[cIdx(6, z)], `window row ${z}`).toBe(0)
    expect(mask[cIdx(6, BORDER_DEPTH)]).toBe(1)
    expect(mask[cIdx(1, 9)]).toBe(1)

    // A holed slab is an in-chunk entry: sight floods the connected mass.
    const h = sealed()
    h.hasCeilHole = (lx, lz) => lx === 4 && lz === 4
    for (let x = 7; x <= 8; x++) { h.setH(x, 2, 1); h.setH(x, 4, 1) }
    for (let z = 2; z <= 3; z++) { h.setV(7, z, 1); h.setV(9, z, 1) }
    const hm = sealedMassMask(h)
    expect(hm[cIdx(4, 4)]).toBe(0)
    expect(hm[cIdx(1, 1)]).toBe(0) // reached through mass from the hole
    for (const [x, z] of [[7, 2], [8, 2], [7, 3], [8, 3]]) expect(hm[cIdx(x, z)], `pocket ${x},${z}`).toBe(1)
  })

  it('the mask follows in-place edits of the same ChunkData (no stale cache)', () => {
    const d = corridorChunk('train')
    const before = sealedMassMask(d)
    expect(before[cIdx(5, 9)]).toBe(1)
    expect(before[cIdx(4, 9)]).toBe(1)
    // Carve a glazed bay into the sealed south block, in place (the editor
    // preview re-meshes the same object after every edit).
    d.setH(5, 8, 1, undefined, WALL_WINDOW)
    d.setCol(5, 9, COLUMN_NONE)
    const after = sealedMassMask(d)
    expect(after).not.toBe(before)
    const fresh = new ChunkData(0, 0, 0, 0, undefined, 'train')
    for (const k of ['cols', 'wallV', 'wallH', 'wallFeatureV', 'wallFeatureH']) fresh[k].set(d[k])
    expect(Array.from(after)).toEqual(Array.from(sealedMassMask(fresh)))
    expect(after[cIdx(4, 9)]).toBe(0)
    expect(after.reduce((a, b) => a + b, 0)).toBe(0)
    const mesh = buildChunkMeshes(d, geom, materials, 0, 0, 0)
    const freshMesh = buildChunkMeshes(fresh, geom, materials, 0, 0, 0)
    expect(columnCells(mesh)).toEqual(columnCells(freshMesh))
    mesh.dispose()
    freshMesh.dispose()
  })

  it('a solid liminal raster meshed directly keeps BORDER_DEPTH rings of columns', () => {
    const d = solidChunk(SEED, 0, 0, 0, forcedFamilyConfig('train'), 'train')
    const mesh = buildChunkMeshes(d, geom, materials, 0, 0, 0)
    const inner = CHUNK - 2 * BORDER_DEPTH
    expect(columnCells(mesh).size).toBe(CHUNK * CHUNK - inner * inner)
    mesh.dispose()
  })

  // The 12 liminal editor kinds, re-labelled with their own family so the
  // gate is on. (1) No masked cell is reachable through mass from an in-chunk
  // see-through or open edge. (2) Across chunk borders, no masked cell lies
  // within BORDER_DEPTH mass steps of a walkable cell through non-plain
  // edges. (3) The train keeps column instances at depth >= 2 behind its
  // windows (§12.10's far windows: mass z 1 and z 0). (4) The mask still
  // saves something. Sanity: no masked cell is walkable.
  it('the 12 liminal kinds: no masked cell is visible through mass', () => {
    let masked = 0
    let trainDeep = 0
    for (const id of LIMINAL_FAMILY_IDS) {
      const map = new EditorMap()
      expect(generatePrototype(map, id, { seed: 'proto' }).ok).toBe(true)
      const chunks = [...map.chunks.values()]
      for (const d of chunks) d.mapFamily = id
      const { depth } = sightDepths(chunks, BORDER_DEPTH)
      for (const d of chunks) {
        const mask = fastPathMassMask(d)
        expect(mask).not.toBeNull()
        const sight = inChunkSight(d)
        const deepBehindGlass = []
        for (let z = 0; z < CHUNK; z++) {
          for (let x = 0; x < CHUNK; x++) {
            const i = cIdx(x, z)
            const where = `${id} ${d.cx},${d.cy},${d.cz} ${x},${z}`
            const k = depth.get(`${d.cx * CHUNK + x},${d.cy},${d.cz * CHUNK + z}`)
            if (id === 'train' && k >= 2) deepBehindGlass.push(i)
            if (!mask[i]) continue
            masked++
            expect(cellWalkable(d, x, z), where).toBe(false)
            expect(sight[i], `${where} reachable through in-chunk mass`).toBe(0)
            expect(k, `${where} at sight depth ${k}`).toBeUndefined()
          }
        }
        if (deepBehindGlass.length) {
          const mesh = buildChunkMeshes(d, geom, materials, 0, 0, 0)
          const cols = columnCells(mesh)
          for (const i of deepBehindGlass) expect(cols.has(i)).toBe(true)
          mesh.dispose()
          trainDeep += deepBehindGlass.length
        }
      }
    }
    expect(trainDeep).toBeGreaterThan(0)
    expect(masked).toBeGreaterThan(0)
  }, 120_000)
})
