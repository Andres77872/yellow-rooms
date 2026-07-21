import { describe, expect, it } from 'vitest'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { CHUNK, cIdx } from '../constants.js'
import { worldConfigForFamily } from '../mapFamily.js'
import { CELL_VOID, MAP_FAMILY_LATTICE } from '../mapTypes.js'
import { buildChunk } from '../pipeline.js'
import { structureAt } from '../structures/contract.js'

// Physical accessibility contract for the multilayer lattice district: every
// rasterized district must be ONE walkable component. The planner's spanning
// tree proves the plan is connected; this test walks the stamped bytes the
// player actually traverses — cells, thin walls, and stair links — so a
// regression that strands a chamber, catwalk, stair pocket, or whole floor
// fails here even if every descriptor-level invariant still holds.

const FIXED_SEEDS = Object.freeze([0x1a771ce, 0x5a17, 0xc0ffee])

function forcedLatticeConfig() {
  const base = structuredClone(DEFAULT_WORLD_CONFIG)
  base.mapFamily.profiles[MAP_FAMILY_LATTICE].enabled = true
  return worldConfigForFamily(MAP_FAMILY_LATTICE, base)
}

function findLatticeStructure(seed, config) {
  for (let cy = -24; cy <= 24; cy++) {
    for (let cz = -4; cz <= 4; cz++) {
      for (let cx = -4; cx <= 4; cx++) {
        const candidate = structureAt(seed, cx, cz, cy, config)
        if (candidate?.hasRoom === true) return candidate
      }
    }
  }
  return null
}

// Walk graph over the rasterized district, mirroring pathfind.js: stair
// run/hole cells are traversed by the stair edge (landing <-> upper exit),
// planar steps use the thin-wall owner at the shared grid line.
function districtWalkAudit(seed, structure, config) {
  const chunks = new Map()
  for (let cy = structure.baseCy; cy <= structure.topCy; cy++) {
    for (const { cx, cz } of structure.participants) {
      chunks.set(`${cx},${cz},${cy}`, buildChunk(seed, cx, cy, cz, config))
    }
  }
  const chunkOf = (gx, gz, cy) =>
    chunks.get(`${Math.floor(gx / CHUNK)},${Math.floor(gz / CHUNK)},${cy}`)
  const local = (g) => ((g % CHUNK) + CHUNK) % CHUNK

  const rampCells = new Set()
  const stairEdges = []
  for (const [key, data] of chunks) {
    const [cx, cz, cy] = key.split(',').map(Number)
    if (data.stairUp) {
      for (const cell of data.stairUp.run) {
        rampCells.add(`${cx * CHUNK + cell.lx},${cz * CHUNK + cell.lz},${cy}`)
      }
      stairEdges.push([
        `${cx * CHUNK + data.stairUp.landing.lx},${cz * CHUNK + data.stairUp.landing.lz},${cy}`,
        `${cx * CHUNK + data.stairUp.exit.lx},${cz * CHUNK + data.stairUp.exit.lz},${cy + 1}`,
      ])
    }
    if (data.stairDown) {
      for (const cell of data.stairDown.run) {
        rampCells.add(`${cx * CHUNK + cell.lx},${cz * CHUNK + cell.lz},${cy}`)
      }
    }
  }

  const nodes = new Set()
  for (const [key, data] of chunks) {
    const [cx, cz, cy] = key.split(',').map(Number)
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        if (data.cellKind[cIdx(lx, lz)] === CELL_VOID) continue
        const node = `${cx * CHUNK + lx},${cz * CHUNK + lz},${cy}`
        if (!rampCells.has(node)) nodes.add(node)
      }
    }
  }

  const wallBetween = (axis, gx, gz, cy) => {
    const data = chunkOf(gx, gz, cy)
    if (!data) return true
    return (axis === 'v'
      ? data.vAt(local(gx), local(gz))
      : data.hAt(local(gx), local(gz))) !== 0
  }

  const seen = new Set()
  const componentSizes = []
  const stairByNode = new Map()
  for (const [lower, upper] of stairEdges) {
    if (nodes.has(lower) && nodes.has(upper)) {
      stairByNode.set(lower, upper)
      stairByNode.set(upper, lower)
    }
  }
  for (const start of nodes) {
    if (seen.has(start)) continue
    let size = 0
    const queue = [start]
    seen.add(start)
    while (queue.length > 0) {
      const node = queue.pop()
      size++
      const [gx, gz, cy] = node.split(',').map(Number)
      for (const step of [
        { key: `${gx + 1},${gz},${cy}`, axis: 'v', wx: gx + 1, wz: gz },
        { key: `${gx - 1},${gz},${cy}`, axis: 'v', wx: gx, wz: gz },
        { key: `${gx},${gz + 1},${cy}`, axis: 'h', wx: gx, wz: gz + 1 },
        { key: `${gx},${gz - 1},${cy}`, axis: 'h', wx: gx, wz: gz },
      ]) {
        if (seen.has(step.key) || !nodes.has(step.key)) continue
        if (wallBetween(step.axis, step.wx, step.wz, cy)) continue
        seen.add(step.key)
        queue.push(step.key)
      }
      const across = stairByNode.get(node)
      if (across && !seen.has(across)) {
        seen.add(across)
        queue.push(across)
      }
    }
    componentSizes.push(size)
  }

  const floorTotals = new Map()
  for (const node of nodes) {
    const cy = Number(node.slice(node.lastIndexOf(',') + 1))
    floorTotals.set(cy, (floorTotals.get(cy) ?? 0) + 1)
  }
  return { nodes, componentSizes, floorTotals, stairEdges }
}

describe('lattice district physical reachability', () => {
  it.each(FIXED_SEEDS.map((seed) => ({ seed })))(
    'walks every floor, chamber, and stair of seed $seed as one component',
    ({ seed }) => {
      const config = forcedLatticeConfig()
      const structure = findLatticeStructure(seed, config)
      expect(structure).not.toBeNull()

      const audit = districtWalkAudit(seed, structure, config)

      // One component: no stranded island anywhere in the five-floor volume.
      expect(audit.componentSizes).toHaveLength(1)

      // Every floor of the band hosts walkable cells — "always accessible for
      // some layer" means each layer both exists and joins the single walk.
      for (let cy = structure.baseCy; cy <= structure.topCy; cy++) {
        expect(audit.floorTotals.get(cy) ?? 0).toBeGreaterThan(0)
      }

      // Every adjacent floor pair is bridged by at least one physical stair
      // whose both endpoints are walkable nodes.
      const bridgedBoundaries = new Set(audit.stairEdges
        .filter(([lower, upper]) =>
          audit.nodes.has(lower) && audit.nodes.has(upper)
        )
        .map(([lower]) => Number(lower.slice(lower.lastIndexOf(',') + 1))))
      for (let cy = structure.baseCy; cy < structure.topCy; cy++) {
        expect(bridgedBoundaries.has(cy)).toBe(true)
      }

      // Every chamber anchor stands on a walkable cell.
      for (const anchor of structure.anchors) {
        expect(
          audit.nodes.has(`${anchor.gx},${anchor.gz},${anchor.levelCy}`)
        ).toBe(true)
      }
    }
  )
})
