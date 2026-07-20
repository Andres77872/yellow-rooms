import { describe, it, expect, vi } from 'vitest'
import { groundHeightAt } from '../ground.js'
import { moveAndCollide } from '../collision.js'
import { buildChunk } from '../../world/pipeline.js'
import { ChunkData } from '../../world/ChunkData.js'
import { ChunkManager } from '../../world/ChunkManager.js'
import { buildStairCells } from '../../world/structures/stairCells.js'
import { slabContract, STAIR_DX, STAIR_DZ } from '../../world/structures/slab.js'
import { DEFAULT_WORLD_CONFIG } from '../../world/config.js'
import {
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
} from '../../world/mapTypes.js'
import { structureAdapterFor } from '../../world/structures/contract.js'
import {
  STRUCTURE_KIND_LATTICE,
  STRUCTURE_KIND_TOWER,
} from '../../world/structures/contract.js'
import {
  CELL,
  CHUNK,
  LAYER_H,
  FLOOR_SWITCH_Y,
  GROUND_SNAP,
  PLAYER_R,
  WALL_COL_HALF,
  SPRINT_SPEED,
  cIdx,
  chunkKey3,
  layerY,
} from '../../world/constants.js'

// A real two-layer world slice around one stair: chunk (cx,cz) on layers cy and
// cy+1 from the actual generator, wrapped in a minimal layer-aware CM. This is
// the executable form of the dual-raster contract — the player collider runs
// against ACTUAL generator output, so stamp drift breaks these tests, not the
// player.
function worldSlice(seed, cx, cz, cy, cfg) {
  const lower = buildChunk(seed, cx, cy, cz, cfg)
  const upper = buildChunk(seed, cx, cy + 1, cz, cfg)
  const layers = new Map([
    [cy, { data: lower, cells: buildStairCells(lower, cx, cy, cz) }],
    [cy + 1, { data: upper, cells: buildStairCells(upper, cx, cy + 1, cz) }],
  ])
  const local = (g, base) => g - base * CHUNK
  const inChunk = (gx, gz) =>
    Math.floor(gx / CHUNK) === cx && Math.floor(gz / CHUNK) === cz
  return {
    wallVAt: (gx, gz, l) =>
      inChunk(gx, gz) && !!layers.get(l) && layers.get(l).data.vAt(local(gx, cx), local(gz, cz)) === 1,
    wallHAt: (gx, gz, l) =>
      inChunk(gx, gz) && !!layers.get(l) && layers.get(l).data.hAt(local(gx, cx), local(gz, cz)) === 1,
    columnAt: (gx, gz, l) =>
      inChunk(gx, gz) && !!layers.get(l) && layers.get(l).data.colAt(local(gx, cx), local(gz, cz)) > 0,
    stairAt: (gx, gz, l) => {
      if (!inChunk(gx, gz) || !layers.get(l)) return null
      return layers.get(l).cells.get(cIdx(local(gx, cx), local(gz, cz))) || null
    },
  }
}

const CFG = {
  ...DEFAULT_WORLD_CONFIG,
  stairs: { ...DEFAULT_WORLD_CONFIG.stairs, chance: 1 },
  multilevel: { ...DEFAULT_WORLD_CONFIG.multilevel, enabled: false },
}

function loadedHardVoidFixture(family, { loaded = true, owned = true } = {}) {
  const id = family === MAP_FAMILY_TOWER ? 0x7100 : 0x1a771ce
  const participants = family === MAP_FAMILY_TOWER
    ? [{ cx: 0, cz: 0 }, { cx: 1, cz: 0 }]
    : Array.from({ length: 9 }, (_, index) => ({
        cx: index % 3,
        cz: Math.floor(index / 3),
      }))
  const structure = {
    id,
    family,
    kind: family === MAP_FAMILY_TOWER
      ? STRUCTURE_KIND_TOWER
      : STRUCTURE_KIND_LATTICE,
    baseCy: 0,
    topCy: 2,
    ...(family === MAP_FAMILY_LATTICE
      ? { levelCount: 3, district: { x: 0, z: 0, size: 3 } }
      : {}),
    participants,
    anchor: participants[0],
  }
  const data = new ChunkData(
    0,
    1,
    0,
    0,
    DEFAULT_WORLD_CONFIG.version,
    family
  )
  data.structure = structure
  data.lethalVoidDown = {
    id,
    family,
    lowerCy: 0,
    cells: [{ lx: 0, lz: 0, deathYmm: -750 }],
  }

  const cm = Object.create(ChunkManager.prototype)
  cm.chunks = new Map()
  if (loaded) {
    cm.chunks.set(chunkKey3(0, 1, 0), {
      cx: 0,
      cy: 1,
      cz: 0,
      data,
      structure: structure,
    })
  }
  const adapter = structureAdapterFor(structure)
  cm._validatedStructure = vi.fn(() =>
    owned ? { adapter, participants } : null
  )
  return { cm, data, structure }
}

// A simplified copy of the Controller's per-substep vertical resolve + handoff.
function verticalStep(cm, st, dt = 0.01 / 5) {
  const g = groundHeightAt(cm, st.pos.x, st.pos.z, st.floor)
  if (st.pos.y <= g + GROUND_SNAP && st.vy <= 0) {
    st.pos.y = g
    st.vy = 0
  } else {
    st.vy -= 22 * dt
    st.pos.y += st.vy * dt
    if (st.pos.y <= g) {
      st.pos.y = g
      st.vy = 0
    }
  }
  const yRel = st.pos.y - layerY(st.floor)
  if (yRel >= FLOOR_SWITCH_Y) st.floor++
  else if (yRel <= -FLOOR_SWITCH_Y) st.floor--
}

describe('groundHeightAt', () => {
  const cy = 0
  const cm = worldSlice(7, 1, 1, cy, CFG)
  const c = slabContract(7, 1, 1, cy, CFG)

  const cellMid = (cell, base) => ({
    x: ((base === 'x' ? 1 * CHUNK : 1 * CHUNK) + cell.lx + 0.5) * CELL,
    z: (1 * CHUNK + cell.lz + 0.5) * CELL,
  })

  it('is flat off-stair and on the landing, upper floor on the exit', () => {
    expect(c.hasStair).toBe(true)
    // A far corner cell (guaranteed off the strip: strips live in [3..10]²).
    expect(groundHeightAt(cm, (CHUNK + 0.5) * CELL, (CHUNK + 0.5) * CELL, cy)).toBe(layerY(cy))
    const l = cellMid(c.landing)
    expect(groundHeightAt(cm, l.x, l.z, cy)).toBe(layerY(cy))
    const e = cellMid(c.exit)
    expect(groundHeightAt(cm, e.x, e.z, cy + 1)).toBe(layerY(cy + 1))
  })

  it('ramps linearly over the run and agrees when queried from either layer', () => {
    const horiz = STAIR_DX[c.dir] !== 0
    const desc = cm.stairAt(CHUNK + c.run[0].lx, CHUNK + c.run[0].lz, cy)
    expect(desc.part).toBe('run')
    // Sample strictly inside the run cells: the exact t=0/t=1 boundary points
    // belong to the landing/exit cells (flat by definition, and the far-end
    // wall makes the t=1 boundary unreachable from the lower raster anyway).
    for (const t of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      const along = desc.rampStart + desc.sign * t * 2 * CELL
      const cross = horiz
        ? (CHUNK + c.run[0].lz + 0.5) * CELL
        : (CHUNK + c.run[0].lx + 0.5) * CELL
      const x = horiz ? along : cross
      const z = horiz ? cross : along
      const gLower = groundHeightAt(cm, x, z, cy)
      expect(gLower).toBeCloseTo(layerY(cy) + t * LAYER_H, 10)
      // Same world point queried from the UPPER layer (hole cells) must give
      // the identical surface — the ramp is one object seen from both floors.
      if (t > 0.05 && t < 0.95) {
        expect(groundHeightAt(cm, x, z, cy + 1)).toBeCloseTo(gLower, 10)
      }
    }
  })

  it('falls through all 14 apertures of a 15-storey shaft to its bottom support', () => {
    const shaft = {
      stairAt: () => null,
      floorHoleAt: (_gx, _gz, floor) => floor >= 1 && floor <= 14,
    }
    expect(groundHeightAt(shaft, CELL / 2, CELL / 2, 14)).toBe(layerY(0))
    expect(groundHeightAt(shaft, CELL / 2, CELL / 2, 7)).toBe(layerY(0))
    expect(groundHeightAt(shaft, CELL / 2, CELL / 2, 0)).toBe(layerY(0))
  })

  it('keeps explicit lethal-plane lookup out of the shared numeric ground fallback', () => {
    const hardVoidAt = vi.fn(() => ({ id: 17, family: 'tower', deathYmm: 10_300 }))
    const shaft = {
      stairAt: () => null,
      floorHoleAt: (_gx, _gz, floor) => floor >= 1 && floor <= 14,
      hardVoidAt,
    }

    expect(groundHeightAt(shaft, CELL / 2, CELL / 2, 14)).toBe(layerY(0))
    expect(hardVoidAt).not.toHaveBeenCalled()
  })
})

describe('ChunkManager hardVoidAt', () => {
  it.each([MAP_FAMILY_TOWER, MAP_FAMILY_LATTICE])(
    'dispatches a loaded canonically owned %s plane through its structure adapter',
    (family) => {
      const { cm, structure } = loadedHardVoidFixture(family)

      expect(cm.hardVoidAt(0, 0, 1)).toEqual({
        id: structure.id,
        family,
        deathYmm: -750,
      })
      expect(cm._validatedStructure).toHaveBeenCalledTimes(1)
      expect(cm._validatedStructure).toHaveBeenCalledWith(structure, 1)
    }
  )

  it('fails closed for unloaded, canonically unowned, and malformed lethal data', () => {
    const unloaded = loadedHardVoidFixture(MAP_FAMILY_TOWER, { loaded: false })
    expect(unloaded.cm.hardVoidAt(0, 0, 1)).toBeNull()
    expect(unloaded.cm._validatedStructure).not.toHaveBeenCalled()

    const unowned = loadedHardVoidFixture(MAP_FAMILY_TOWER, { owned: false })
    expect(unowned.cm.hardVoidAt(0, 0, 1)).toBeNull()

    const malformed = loadedHardVoidFixture(MAP_FAMILY_LATTICE)
    malformed.data.lethalVoidDown.cells.push(
      { ...malformed.data.lethalVoidDown.cells[0] }
    )
    expect(malformed.cm.hardVoidAt(0, 0, 1)).toBeNull()
  })

  it.each([MAP_FAMILY_OFFICE, MAP_FAMILY_SEWER])(
    'does not infer a lethal plane from loaded %s cells',
    (family) => {
      const data = new ChunkData(
        0,
        1,
        0,
        0,
        DEFAULT_WORLD_CONFIG.version,
        family
      )
      const cm = Object.create(ChunkManager.prototype)
      cm.chunks = new Map([[chunkKey3(0, 1, 0), {
        cx: 0,
        cy: 1,
        cz: 0,
        data,
      }]])
      cm._validatedStructure = vi.fn(() => null)

      expect(cm.hardVoidAt(0, 0, 1)).toBeNull()
    }
  )
})

describe('stair transit (real generator bytes + real collider)', () => {
  // Walk the player up and down the full stair with the production collision
  // + vertical resolve, across several seeds/coords/orientations. Asserts: the
  // transit completes, exactly one handoff each way, y is continuous (no pops
  // beyond a substep's ground delta), and the collider never ejects the player
  // sideways out of the shaft (the dual-raster guarantee in action).
  const cases = [
    [7, 1, 1, 0],
    [7, 3, -2, 1], // odd layer -> N/S stair
    [12345, -4, 6, 0],
    [99, 2, 2, -1],
    [0, -2, -2, -1], // transformed family completes all four ascent directions
  ]

  for (const [seed, cx, cz, cy] of cases) {
    it(`ascends and descends seed=${seed} chunk=(${cx},${cz}) slab=${cy}`, () => {
      const cfg = CFG
      const cm = worldSlice(seed, cx, cz, cy, cfg)
      const c = slabContract(seed, cx, cz, cy, cfg)
      expect(c.hasStair).toBe(true)
      const dx = STAIR_DX[c.dir]
      const dz = STAIR_DZ[c.dir]
      const startX = (cx * CHUNK + c.landing.lx + 0.5) * CELL
      const startZ = (cz * CHUNK + c.landing.lz + 0.5) * CELL

      const st = { pos: { x: startX, y: layerY(cy), z: startZ }, vy: 0, floor: cy }
      const dt = 1 / 60 / 5
      const speed = SPRINT_SPEED // worst case for tunneling/margins
      let flips = 0
      let lastFloor = st.floor
      let prevY = st.pos.y
      // Ascend: push along the stair direction for up to 4s of game time.
      for (let i = 0; i < 4 * 60 * 5 && st.floor === cy; i++) {
        moveAndCollide(cm, st.pos, dx * speed * dt, dz * speed * dt, st.floor)
        verticalStep(cm, st, dt)
        expect(Math.abs(st.pos.y - prevY)).toBeLessThanOrEqual(GROUND_SNAP + 1e-9)
        prevY = st.pos.y
        if (st.floor !== lastFloor) {
          flips++
          lastFloor = st.floor
        }
      }
      expect(st.floor).toBe(cy + 1)
      expect(flips).toBe(1)
      // Keep walking to the exit cell and settle on the upper floor.
      for (let i = 0; i < 2 * 60 * 5; i++) {
        moveAndCollide(cm, st.pos, dx * speed * dt, dz * speed * dt, st.floor)
        verticalStep(cm, st, dt)
      }
      expect(st.pos.y).toBeCloseTo(layerY(cy + 1), 6)
      // The collider must have kept the player inside the 1-cell-wide shaft
      // laterally (guard walls on both rasters).
      const crossNow = c.dir % 2 === 1 ? st.pos.z : st.pos.x
      const crossCell = c.dir % 2 === 1 ? (cz * CHUNK + c.landing.lz + 0.5) * CELL : (cx * CHUNK + c.landing.lx + 0.5) * CELL
      expect(Math.abs(crossNow - crossCell)).toBeLessThanOrEqual(CELL / 2 + PLAYER_R)

      // Descend: walk back the other way.
      flips = 0
      lastFloor = st.floor
      for (let i = 0; i < 6 * 60 * 5 && st.floor === cy + 1; i++) {
        moveAndCollide(cm, st.pos, -dx * speed * dt, -dz * speed * dt, st.floor)
        verticalStep(cm, st, dt)
        if (st.floor !== lastFloor) {
          flips++
          lastFloor = st.floor
        }
      }
      expect(st.floor).toBe(cy)
      expect(flips).toBe(1)
      for (let i = 0; i < 2 * 60 * 5; i++) {
        moveAndCollide(cm, st.pos, -dx * speed * dt, -dz * speed * dt, st.floor)
        verticalStep(cm, st, dt)
      }
      expect(st.pos.y).toBeCloseTo(layerY(cy), 6)
    })
  }

  it('holds the static handoff margin invariant', () => {
    // The handoff fires (LAYER_H - FLOOR_SWITCH_Y) of rise before the ramp
    // top, i.e. (LAYER_H - FLOOR_SWITCH_Y) / (LAYER_H / (2*CELL)) world units
    // along the axis from the disagreeing edge. The player's box reach is
    // PLAYER_R + WALL_COL_HALF; at least 0.5u of margin must remain.
    const alongMargin = ((LAYER_H - FLOOR_SWITCH_Y) * 2 * CELL) / LAYER_H
    expect(alongMargin - (PLAYER_R + WALL_COL_HALF)).toBeGreaterThanOrEqual(0.5)
    expect(FLOOR_SWITCH_Y).toBeLessThan(LAYER_H)
    expect(FLOOR_SWITCH_Y).toBeGreaterThan(LAYER_H / 2) // flip strictly past mid-ramp going up
  })
})
