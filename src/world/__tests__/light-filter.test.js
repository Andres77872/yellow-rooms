import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { ChunkManager } from '../ChunkManager.js'
import { ChunkData } from '../ChunkData.js'
import { buildChunk } from '../pipeline.js'
import { buildStairCells } from '../structures/stairCells.js'
import { slabContract } from '../structures/slab.js'
import {
  multilevelBandBase,
  multilevelConfig,
  multilevelContract,
} from '../structures/multilevel.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import {
  LIGHT_RANGE,
  LIGHT_SPILL_R,
  STALKER_AMBIENT,
  LAYER_H,
  WALL_H,
  CELL,
  CHUNK,
  chunkKey3,
} from '../constants.js'
import { COLUMN_MONUMENTAL, COLUMN_STANDARD } from '../mapTypes.js'

// The cross-floor lamp policy, tested on the REAL ChunkManager (headless
// THREE scene, chunks injected directly — no WebGL, no generation): lamps are
// shadowless, so the slab is enforced by ASSIGNMENT, not shadowing. Same-floor
// lamps always qualify; cy±1 lamps spill near an aperture; farther floors can
// contribute only through one continuous tall structure and within true range.

const lampAt = (x, cy, z) => {
  const v = new THREE.Vector3(x, cy * LAYER_H + WALL_H - 0.5, z)
  v.cy = cy
  return v
}

function makeCM(lampsByFloor, apertures = []) {
  const cm = new ChunkManager(new THREE.Scene(), 1, null, null)
  for (const [cy, value] of Object.entries(lampsByFloor)) {
    const entry = Array.isArray(value) ? { lamps: value } : value
    const cx = entry.cx ?? 0
    const cz = entry.cz ?? 0
    const structure = entry.structure ?? null
    cm.chunks.set(chunkKey3(cx, Number(cy), cz), {
      cx,
      cy: Number(cy),
      cz,
      lamps: entry.lamps,
      apertures: [],
      structure: structure,
      data: { structure: structure },
    })
  }
  for (const a of apertures) {
    cm.apertures.set(`${a.cx ?? 0},${a.cz ?? 0},${a.lowerCy}`, { cx: a.cx ?? 0, cz: a.cz ?? 0, ...a })
  }
  return cm
}

function tallConfig(levels = 10) {
  const config = structuredClone(DEFAULT_WORLD_CONFIG)
  config.multilevel.minLevels = levels
  config.multilevel.maxLevels = levels
  return config
}

function findStructure(seed, config, levelCy = 0) {
  const K = multilevelConfig(config).districtChunks
  const baseCy = multilevelBandBase(seed, K, -K, levelCy, config)
  for (let dz = 0; dz < K; dz++) {
    for (let dx = 0; dx < K; dx++) {
      const structure = multilevelContract(seed, K + dx, -K + dz, baseCy, config)
      if (structure.hasRoom) return structure
    }
  }
  throw new Error('expected a deterministic multilevel structure')
}

function distanceToStructure(x, z, structure) {
  const bounds = structure.globalBounds
  const minX = bounds.x0 * CELL
  const maxX = (bounds.x1 + 1) * CELL
  const minZ = bounds.z0 * CELL
  const maxZ = (bounds.z1 + 1) * CELL
  const nearestX = Math.max(minX, Math.min(maxX, x))
  const nearestZ = Math.max(minZ, Math.min(maxZ, z))
  return Math.hypot(x - nearestX, z - nearestZ)
}

describe('cross-floor lamp filter', () => {
  const aperture = { centerX: 21, centerZ: 21, lowerCy: 0 }

  it('passes same-floor lamps, spills cy±1 near an aperture, and blocks unconnected cy±2', () => {
    const near1 = lampAt(21, 1, 24) // 3u from the aperture: spills down
    const far1 = lampAt(21 + LIGHT_SPILL_R + 5, 1, 21) // beyond spill radius
    const same = lampAt(30, 0, 30)
    const two = lampAt(21, 2, 21) // two floors up: never
    const cm = makeCM({ 0: [same], 1: [near1, far1], 2: [two] }, [aperture])

    const out = cm.collectLampsNear(21, 21, [], 0)
    expect(out).toContain(same)
    expect(out).toContain(near1)
    expect(out).not.toContain(far1)
    expect(out).not.toContain(two)
  })

  it('spills upward through the same aperture (player above, lamp below)', () => {
    const below = lampAt(22, 0, 22) // on floor 0, right by the hole
    const cm = makeCM({ 0: [below] }, [aperture])
    const out = cm.collectLampsNear(21, 21, [], 1)
    expect(out).toContain(below)
  })

  it('with no aperture, adjacent-floor lamps are fully blocked', () => {
    const above = lampAt(21, 1, 21)
    const cm = makeCM({ 1: [above] }, [])
    expect(cm.collectLampsNear(21, 21, [], 0)).toHaveLength(0)
  })

  it('uses the full multilevel void bounds instead of a stair-sized center point', () => {
    const room = {
      centerX: 21,
      centerZ: 21,
      lowerCy: 0,
      minX: 9,
      maxX: 33,
      minZ: 12,
      maxZ: 30,
      regions: [
        { minX: 9, maxX: 33, minZ: 12, maxZ: 19.5 },
        { minX: 9, maxX: 33, minZ: 22.5, maxZ: 30 },
      ],
    }
    const edgeLamp = lampAt(32, 1, 16)
    // More than LIGHT_SPILL_R from the center, but directly above the open
    // lobe of the atrium: its light must reach the lower room.
    expect(Math.hypot(edgeLamp.x - room.centerX, edgeLamp.z - room.centerZ)).toBeGreaterThan(LIGHT_SPILL_R)
    const cm = makeCM({ 1: [edgeLamp] }, [room])
    expect(cm.collectLampsNear(21, 21, [], 0)).toContain(edgeLamp)
  })

  it('legacy unfiltered form (pcy null) keeps every lamp in radius', () => {
    const a = lampAt(21, 0, 21)
    const b = lampAt(21, 2, 21)
    const cm = makeCM({ 0: [a], 2: [b] }, [])
    expect(cm.collectLampsNear(21, 21, [])).toHaveLength(2)
  })

  it('spills from distant floors only through the same continuous tall structure', () => {
    const seed = 0x1a17
    const structure = findStructure(seed, tallConfig(10))
    const participant = structure.participants[0]
    const x = (structure.globalBounds.x0 + 0.5) * CELL
    const z = (structure.globalBounds.z0 + 0.5) * CELL
    const near = lampAt(x, structure.baseCy + 2, z)
    const beyondVerticalRange = lampAt(x, structure.baseCy + 4, z)
    const cm = makeCM({
      [structure.baseCy + 2]: {
        cx: participant.cx,
        cz: participant.cz,
        lamps: [near],
        structure,
      },
      [structure.baseCy + 4]: {
        cx: participant.cx,
        cz: participant.cz,
        lamps: [beyondVerticalRange],
        structure,
      },
    })

    const out = cm.collectLampsNear(x, z, [], structure.baseCy)
    expect(out).toContain(near)
    expect(out).not.toContain(beyondVerticalRange)

    const disconnected = {
      ...structure,
      id: `${structure.id}:disconnected`,
      baseCy: structure.baseCy + 1,
    }
    const disconnectedCM = makeCM({
      [structure.baseCy + 2]: {
        cx: participant.cx,
        cz: participant.cz,
        lamps: [near],
        structure: disconnected,
      },
    })
    expect(disconnectedCM.collectLampsNear(x, z, [], structure.baseCy))
      .not.toContain(near)
  })

  it('rejects a distant-floor lamp in a participant chunk when it is far from the void', () => {
    const seed = 0x1a18
    const structure = findStructure(seed, tallConfig(10))
    const candidates = structure.participants.flatMap((participant) => {
      const minX = participant.cx * CHUNK * CELL
      const minZ = participant.cz * CHUNK * CELL
      const maxX = minX + CHUNK * CELL
      const maxZ = minZ + CHUNK * CELL
      return [
        { participant, x: minX + 0.5, z: minZ + 0.5 },
        { participant, x: maxX - 0.5, z: minZ + 0.5 },
        { participant, x: minX + 0.5, z: maxZ - 0.5 },
        { participant, x: maxX - 0.5, z: maxZ - 0.5 },
      ]
    })
    const farthest = candidates.sort((a, b) =>
      distanceToStructure(b.x, b.z, structure) -
      distanceToStructure(a.x, a.z, structure)
    )[0]
    expect(distanceToStructure(farthest.x, farthest.z, structure))
      .toBeGreaterThan(LIGHT_SPILL_R)
    const farLamp = lampAt(
      farthest.x,
      structure.baseCy + 2,
      farthest.z
    )
    const sampleX = (structure.globalBounds.x0 + 0.5) * CELL
    const sampleZ = (structure.globalBounds.z0 + 0.5) * CELL
    const cm = makeCM({
      [structure.baseCy + 2]: {
        cx: farthest.participant.cx,
        cz: farthest.participant.cz,
        lamps: [farLamp],
        structure,
      },
    })
    expect(cm.collectLampsNear(sampleX, sampleZ, [], structure.baseCy))
      .not.toContain(farLamp)
  })
})

describe('cross-floor visibility state', () => {
  it('reset() clears the visibility inputs (no stale gating after a restart)', () => {
    const cm = makeCM({}, [])
    // Player died on floor 2 -> visibility last gated for cy 2.
    cm.updateVisibility(2, null)
    cm.reset()
    // Fresh level: chunks stream in on floor 0 and must ALL be visible.
    const mk = (cy) => ({ cx: 0, cy, cz: 0, lamps: [], apertures: [], group: { visible: true } })
    for (const cy of [-1, 0, 1]) {
      const c = mk(cy)
      cm.chunks.set(`0,${cy},0`, c)
      cm._applyVisibility(c)
    }
    expect(cm.chunks.get('0,0,0').group.visible).toBe(true) // own floor
    expect(cm.chunks.get('0,1,0').group.visible).toBe(false) // no aperture: gated
    expect(cm.chunks.get('0,-1,0').group.visible).toBe(false)
  })
})

describe('isBlocked fails closed on stair geometry', () => {
  it('blocks ramp (run) and hole cells of a real stamped chunk', () => {
    const cfg = structuredClone(DEFAULT_WORLD_CONFIG)
    cfg.stairs.chance = 1
    cfg.multilevel.enabled = false
    const seed = 7
    const c = slabContract(seed, 1, 1, 0, cfg)
    expect(c.hasStair).toBe(true)
    const cm = new ChunkManager(new THREE.Scene(), seed, null, null)
    for (const cy of [0, 1]) {
      const data = buildChunk(seed, 1, cy, 1, cfg)
      cm.chunks.set(`1,${cy},1`, {
        cx: 1,
        cy,
        cz: 1,
        data,
        stairCells: buildStairCells(data, 1, cy, 1),
        lamps: [],
        apertures: [],
      })
    }
    const w = (cell) => [(14 + cell.lx + 0.5) * CELL, (14 + cell.lz + 0.5) * CELL]
    // Lower layer: run cells (the ramp) are unplaceable; the landing is fine.
    for (const cell of c.run) {
      const [x, z] = w(cell)
      expect(cm.isBlocked(x, z, 0)).toBe(true)
    }
    expect(cm.isBlocked(...w(c.landing), 0)).toBe(false)
    // Upper layer: holes are unplaceable; the exit cell is fine.
    for (const cell of c.run) {
      const [x, z] = w(cell)
      expect(cm.isBlocked(x, z, 1)).toBe(true)
    }
    expect(cm.isBlocked(...w(c.exit), 1)).toBe(false)
    // Unloaded chunks fail closed.
    expect(cm.isBlocked(9999, 9999, 0)).toBe(true)
  })

  it('uses monumental-pier body clearance across the owning cell boundary', () => {
    const data = new ChunkData(0, 0, 0, 0)
    const cm = new ChunkManager(new THREE.Scene(), 1, null, null)
    cm.chunks.set('0,0,0', {
      cx: 0,
      cy: 0,
      cz: 0,
      data,
      stairCells: new Map(),
      lamps: [],
      apertures: [],
    })
    const gx = 5
    const gz = 5
    const cornerX = (gx + 0.01) * CELL
    const cornerZ = (gz + 0.01) * CELL

    data.setCol(gx, gz, COLUMN_STANDARD)
    expect(cm.isBlocked(cornerX, cornerZ, 0)).toBe(false)
    data.setCol(gx, gz, COLUMN_MONUMENTAL)
    expect(cm.isBlocked((gx + 0.5) * CELL, (gz + 0.5) * CELL, 0)).toBe(true)
    expect(cm.isBlocked(cornerX, cornerZ, 0)).toBe(true)
    expect(cm.isBlocked((gx + 0.5) * CELL + 1.55, (gz + 0.5) * CELL, 0)).toBe(true)
  })
})

describe('isBlocked understands multilevel surfaces', () => {
  it('blocks atrium void cells but accepts the retained bridge deck', () => {
    const seed = 1337
    const config = tallConfig(10)
    config.multilevel.bridgeChance = 1
    const structure = findStructure(seed, config)
    const { cx, cz } = structure.participants[0]
    const cy = structure.bridgeLevels[0]
    const data = buildChunk(seed, cx, cy, cz, config)
    const room = data.structureDown
    expect(room).not.toBeNull()
    const cm = new ChunkManager(new THREE.Scene(), seed, null, null)
    cm.chunks.set(`${cx},${cy},${cz}`, {
      cx,
      cy,
      cz,
      data,
      stairCells: buildStairCells(data, cx, cy, cz),
      lamps: [],
      apertures: [],
    })
    const world = ({ lx, lz }) => [
      (cx * CHUNK + lx + 0.5) * CELL,
      (cz * CHUNK + lz + 0.5) * CELL,
    ]
    const [vx, vz] = world(room.voidCells[0])
    const [bx, bz] = world(room.bridgeCells[0])
    expect(cm.isBlocked(vx, vz, cy)).toBe(true)
    expect(cm.isBlocked(bx, bz, cy)).toBe(false)
  })
})

describe('lightAt curve identity', () => {
  it('same-floor light level matches the shader cubic window exactly (XZ distance)', () => {
    // The AI light sense must track the pools the player SEES: identical
    // falloff to lampAtt in render/shaders/common.js — cubic in XZ distance
    // for same-floor lamps. This is the CPU/shader mirror the stalker AI and
    // the audio hum rely on.
    const lamps = [lampAt(20, 0, 20), lampAt(26, 0, 23)]
    const cm = makeCM({ 0: lamps }, [])
    const px = 22
    const pz = 21
    let want = STALKER_AMBIENT
    for (const v of lamps) {
      const d = Math.hypot(v.x - px, v.z - pz)
      if (d < LIGHT_RANGE) {
        const f = 1 - d / LIGHT_RANGE
        want += f * f * f
      }
    }
    expect(cm.lightAt(px, pz, 0)).toBeCloseTo(Math.min(want, 1), 12)
  })

  it('spill lamps contribute with true 3D distance (dimmer through the hole)', () => {
    const above = lampAt(21, 1, 22) // 1u XZ from the sample, one floor up
    const cm = makeCM({ 1: [above] }, [{ centerX: 21, centerZ: 21, lowerCy: 0 }])
    const got = cm.lightAt(21, 21, 0)
    const d3 = Math.hypot(above.x - 21, above.y - 0, above.z - 21)
    const f = Math.max(0, 1 - d3 / LIGHT_RANGE)
    expect(got).toBeCloseTo(Math.min(STALKER_AMBIENT + f * f * f, 1), 12)
    // And strictly dimmer than a same-floor lamp at the same XZ offset.
    const sameFloor = makeCM({ 0: [lampAt(21, 0, 22)] }, [])
    expect(got).toBeLessThan(sameFloor.lightAt(21, 21, 0))
  })
})
