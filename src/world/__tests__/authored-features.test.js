import { describe, expect, it } from 'vitest'
import { auditLayeredPatch } from '../audit.js'
import { ChunkData } from '../ChunkData.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { CHUNK } from '../constants.js'
import { generateChunk } from '../generate.js'
import { PASSAGE_WALL, WALL_PLAIN, WALL_RAIL, WALL_WINDOW } from '../mapTypes.js'
import { multilevelBandBase, multilevelConfig, multilevelContract } from '../structures/multilevel.js'

// Authored-document chunk extras (ChunkData.levelLabel / authoredFeatures):
// render and audit hints an editor kind sets; the generator never does.

const key3 = (cx, cy, cz) => `${cx},${cy},${cz}`

// One generated chunk with no slab descriptor that would excuse a feature:
// a plain storey, where any window or rail is stray.
function plainChunk() {
  for (let cx = 0; cx < 8; cx++) {
    const d = generateChunk(7, cx, 0, 0, DEFAULT_WORLD_CONFIG)
    if (!d.structure && !d.structureUp && !d.structureDown) return d
  }
  throw new Error('expected a plain chunk')
}

// The first edge of a chunk that is still plain, closed off with a window.
function addWindow(d, feature = WALL_WINDOW) {
  for (let z = 1; z < CHUNK - 1; z++) {
    for (let line = 1; line < CHUNK - 1; line++) {
      if (d.wallFeatureVAt(line, z) !== WALL_PLAIN) continue
      d.setV(line, z, 1, PASSAGE_WALL, feature)
      return
    }
  }
  throw new Error('no plain edge')
}

const auditOne = (d) => auditLayeredPatch((cx, cy, cz) => (cx === d.cx && cy === d.cy && cz === d.cz ? d : null), d.cx, d.cy, d.cz, 1, 1, 1)

describe('authored chunk extras', () => {
  it('default to null / false and are never set by the generator', () => {
    const fresh = new ChunkData(0, 0, 0, 0)
    expect(fresh.levelLabel).toBe(null)
    expect(fresh.authoredFeatures).toBe(false)
    const d = generateChunk(7, 1, 0, 1, DEFAULT_WORLD_CONFIG)
    expect(d.levelLabel).toBe(null)
    expect(d.authoredFeatures).toBe(false)
  })

  it('lets a chunk opt its authored windows out of the stray-feature audit', () => {
    const d = plainChunk()
    expect(auditOne(d).strayWallFeatures).toBe(0)
    addWindow(d)
    addWindow(d, WALL_RAIL)
    const flagged = auditOne(d)
    expect(flagged.strayWallFeatures).toBe(2)
    expect(flagged.details.strayWallFeatures).toEqual([{ cx: d.cx, cy: d.cy, cz: d.cz, count: 2 }])
    // Only `true` opts out: a truthy stand-in is not the flag.
    d.authoredFeatures = 1
    expect(auditOne(d).strayWallFeatures).toBe(2)
    d.authoredFeatures = true
    const authored = auditOne(d)
    expect(authored.strayWallFeatures).toBe(0)
    expect(authored.details.strayWallFeatures).toEqual([])
  })

  it('still fails an atrium base floor that carries a feature', () => {
    const config = structuredClone(DEFAULT_WORLD_CONFIG)
    config.multilevel.bridgeChance = 1
    config.multilevel.minLevels = 3
    config.multilevel.maxLevels = 3
    config.catalog.enabled = false
    const seed = 404
    const K = multilevelConfig(config).districtChunks
    const baseCy = multilevelBandBase(seed, K, 2 * K, 0, config)
    let room = null
    for (let i = 0; i < K * K && !room; i++) {
      const candidate = multilevelContract(seed, K + (i % K), 2 * K + Math.floor(i / K), baseCy, config)
      if (candidate.hasRoom) room = candidate
    }
    expect(room).not.toBe(null)
    const xs = room.participants.map((p) => p.cx)
    const zs = room.participants.map((p) => p.cz)
    const patch = () => {
      const chunks = new Map()
      for (let cy = room.baseCy; cy <= room.topCy; cy++) {
        for (const { cx, cz } of room.participants) chunks.set(key3(cx, cy, cz), generateChunk(seed, cx, cy, cz, config))
      }
      return chunks
    }
    const audit = (chunks) => auditLayeredPatch(
      (cx, cy, cz) => chunks.get(key3(cx, cy, cz)) ?? null,
      Math.min(...xs),
      room.baseCy,
      Math.min(...zs),
      Math.max(...xs) - Math.min(...xs) + 1,
      room.levelCount,
      Math.max(...zs) - Math.min(...zs) + 1
    )
    const reasonsOf = (result) => result.details.invalidMultilevelRooms.flatMap((item) => item.reasons)

    const clean = patch()
    expect(reasonsOf(audit(clean))).not.toContain('bottom floor has a window or rail feature')

    const chunks = patch()
    for (const d of chunks.values()) d.authoredFeatures = true
    const base = chunks.get(key3(room.participants[0].cx, room.baseCy, room.participants[0].cz))
    expect(base.structureUp).toBeTruthy()
    addWindow(base)
    const result = audit(chunks)
    // The flag silences the generic stray count, never the atrium rule.
    expect(result.strayWallFeatures).toBe(0)
    expect(result.invalidMultilevelRooms).toBeGreaterThan(0)
    expect(reasonsOf(result)).toContain('bottom floor has a window or rail feature')
    expect(result.ok).toBe(false)
  })
})
