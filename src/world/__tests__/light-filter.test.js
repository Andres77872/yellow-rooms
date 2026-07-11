import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { ChunkManager } from '../ChunkManager.js'
import { buildChunk } from '../pipeline.js'
import { buildStairCells } from '../stairCells.js'
import { slabContract } from '../slab.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import {
  LIGHT_RANGE,
  LIGHT_SPILL_R,
  STALKER_AMBIENT,
  LAYER_H,
  WALL_H,
  CELL,
} from '../constants.js'

// The v8 cross-floor lamp policy, tested on the REAL ChunkManager (headless
// THREE scene, chunks injected directly — no WebGL, no generation): lamps are
// shadowless, so the slab is enforced by ASSIGNMENT, not shadowing. Same-floor
// lamps always qualify; cy±1 lamps only within LIGHT_SPILL_R of a stair
// aperture between the two floors; cy±2 never.

const lampAt = (x, cy, z) => {
  const v = new THREE.Vector3(x, cy * LAYER_H + WALL_H - 0.5, z)
  v.cy = cy
  return v
}

function makeCM(lampsByFloor, apertures = []) {
  const cm = new ChunkManager(new THREE.Scene(), 1, null, null)
  for (const [cy, lamps] of Object.entries(lampsByFloor)) {
    cm.chunks.set(`0,${cy},0`, { cx: 0, cy: Number(cy), cz: 0, lamps, apertures: [] })
  }
  for (const a of apertures) {
    cm.apertures.set(`${a.cx ?? 0},${a.cz ?? 0},${a.lowerCy}`, { cx: a.cx ?? 0, cz: a.cz ?? 0, ...a })
  }
  return cm
}

describe('cross-floor lamp filter', () => {
  const aperture = { centerX: 21, centerZ: 21, lowerCy: 0 }

  it('passes same-floor lamps, spills cy±1 only near an aperture, never cy±2', () => {
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

  it('legacy unfiltered form (pcy null) keeps every lamp in radius', () => {
    const a = lampAt(21, 0, 21)
    const b = lampAt(21, 2, 21)
    const cm = makeCM({ 0: [a], 2: [b] }, [])
    expect(cm.collectLampsNear(21, 21, [])).toHaveLength(2)
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
    const cfg = { ...DEFAULT_WORLD_CONFIG, stairs: { ...DEFAULT_WORLD_CONFIG.stairs, chance: 1 } }
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
