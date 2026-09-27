import { isCatalogStructure } from '../../world/structures/catalog/engine.js'
import { describe, expect, it } from 'vitest'
import { CHUNK } from '../../world/constants.js'
import { CELL_BRIDGE, CELL_OPEN, CELL_ROOM, PASSAGE_WALL } from '../../world/mapTypes.js'
import { hashStr } from '../../world/core/hash.js'
import { worldConfigForFamilyOrOffice } from '../../world/mapFamily.js'
import { auditLayeredPatch } from '../../world/audit.js'
import { EditorMap } from '../EditorMap.js'
import { decodeMapFile, encodeMapFile } from '../format/yrmap.js'
import {
  auditDocument,
  auditStructure,
  clippedStructures,
  connectivityPolicy,
  diffAgainstGenerated,
  discoverStructures,
  documentStructures,
  measureStructureLevel,
  structureChunkBox,
  structureChunkCoords,
  structureCoverage,
  structureKey,
  structureLevels,
  summarizeStructure,
  walkComponents,
} from '../structureReview.js'
import { holeMasks } from '../holeMasks.js'

const SEARCH = { x0: -6, x1: 6, z0: -6, z1: 6, y0: -2, y1: 20 }
// The family landmark planners (office atria, tower forms, lattice
// districts); v26 catalog volumes are covered by their own suite below.
const LANDMARK = (s) => !isCatalogStructure(s)

function firstStructure(family, seedText, predicate = () => true) {
  const { config } = worldConfigForFamilyOrOffice(family)
  const seed = hashStr(seedText)
  const found = discoverStructures(seed, config, SEARCH).filter(predicate)
  expect(found.length).toBeGreaterThan(0)
  // Prefer the shortest volume: cheapest to bake in a unit test.
  found.sort((a, b) => (a.topCy - a.baseCy) - (b.topCy - b.baseCy))
  return { seed, config, structure: found[0] }
}

function loadVolume(family, seed, structure, ring = 0) {
  const map = new EditorMap()
  map.bakeChunks({ seed, family, coords: structureChunkCoords(structure, ring) })
  return map
}

describe('structure discovery and volume', () => {
  it('discovers canonical descriptors from the planners, deduped per band', () => {
    const { structure } = firstStructure('office', 'a', LANDMARK)
    expect(structure.hasRoom).toBe(true)
    expect(structure.participants).toHaveLength(2)
    const coords = structureChunkCoords(structure, 0)
    expect(coords).toHaveLength(2 * (structure.topCy - structure.baseCy + 1))
    const ring = structureChunkCoords(structure, 1)
    const box = structureChunkBox(structure, 1)
    expect(ring).toHaveLength(
      (box.x1 - box.x0 + 1) * (box.z1 - box.z0 + 1) * (box.y1 - box.y0 + 1)
    )
  })

  it('summarizes anatomy per storey for every family', () => {
    for (const family of ['office', 'tower', 'lattice']) {
      const { structure } = firstStructure(family, 'lobby')
      const summary = summarizeStructure(structure)
      expect(summary.key).toBe(structureKey(structure))
      expect(summary.levels).toBe(structure.topCy - structure.baseCy + 1)
      const levels = structureLevels(structure)
      expect(levels.map((l) => l.cy)).toEqual(
        Array.from({ length: summary.levels }, (_, i) => structure.baseCy + i)
      )
      expect(levels.every((l) => l.role.length > 0)).toBe(true)
    }
  })
})

describe('structure audit over a complete volume', () => {
  it('passes for a generated office atrium, judged floor by floor', () => {
    const { seed, structure } = firstStructure('office', 'a', LANDMARK)
    const map = loadVolume('office', seed, structure)
    expect(structureCoverage(map, structure).complete).toBe(true)
    expect(documentStructures(map).map(structureKey)).toEqual([structureKey(structure)])
    const review = auditStructure(map, structure)
    expect(connectivityPolicy(structure)).toBe('perFloor')
    expect(review.issues).toEqual([])
    expect(review.ok).toBe(true)
    expect(review.floors.every((f) => f.components === 1)).toBe(true)
  })

  it('passes for tower and lattice volumes, judged as one walk', () => {
    for (const family of ['tower', 'lattice']) {
      const { seed, structure } = firstStructure(family, 'lobby', LANDMARK)
      const map = loadVolume(family, seed, structure)
      const review = auditStructure(map, structure)
      expect(connectivityPolicy(structure)).toBe('volume')
      expect(review.issues).toEqual([])
      expect(review.volume.components).toBe(1)
      expect(review.ok).toBe(true)
      if (family === 'lattice') expect(review.lattice?.anchorCount).toBe(structure.anchors.length)
    }
  })

  it('walks the same component graph as the layered audit', () => {
    const { seed, structure } = firstStructure('tower', 'a', LANDMARK)
    const map = loadVolume('tower', seed, structure, 1)
    const box = structureChunkBox(structure, 1)
    const audit = auditLayeredPatch(
      (cx, cy, cz) => map.chunkAt(cx, cy, cz),
      box.x0, box.y0, box.z0,
      box.x1 - box.x0 + 1, box.y1 - box.y0 + 1, box.z1 - box.z0 + 1
    )
    const walk = walkComponents(map, box)
    expect(walk.walkable).toBe(audit.walkableCells)
    expect(walk.components.map((c) => c.size)).toEqual(audit.componentSizes)
  })

  it('survives a .yrmap round trip (loaded descriptors are plain JSON)', async () => {
    for (const family of ['tower', 'lattice']) {
      const { seed, structure } = firstStructure(family, 'lobby', LANDMARK)
      const map = loadVolume(family, seed, structure)
      const loaded = await decodeMapFile(await encodeMapFile(map, { compress: false }))
      const [reloaded] = documentStructures(loaded)
      expect(structureKey(reloaded)).toBe(structureKey(structure))
      const review = auditStructure(loaded, reloaded)
      expect(review.issues).toEqual([])
      expect(review.ok).toBe(true)
    }
  })

  it('reports measured storey contents from the document', () => {
    const { seed, structure } = firstStructure('office', 'a', (s) => s.kind === 'bridged')
    const map = loadVolume('office', seed, structure)
    const bottom = measureStructureLevel(map, structure, structure.baseCy)
    expect(bottom.chunks).toBe(2)
    expect(bottom.hasUp).toBe(true)
    expect(bottom.hasDown).toBe(false)
    expect(bottom.atrium).toBeGreaterThan(0)
    expect(bottom.ceilHoles).toBeGreaterThan(0)
    const deck = structure.decks[0]
    const bridgeLevel = measureStructureLevel(map, structure, deck.levelCy)
    expect(bridgeLevel.bridge).toBe(deck.globalCells.length)
    expect(bridgeLevel.floorHoles).toBeGreaterThan(0)
    expect(bridgeLevel.rails).toBeGreaterThan(0)
  })
})

describe('structure audit catches edits that break the volume', () => {
  it('flags a bridge deck walled off at its chunk seam', () => {
    const { seed, structure } = firstStructure('office', 'a', (s) => s.kind === 'bridged')
    const map = loadVolume('office', seed, structure)
    const deck = structure.decks[0]
    const b = structure.globalBounds
    map.mutate(() => {
      if (structure.bridgeAxis === 'x') {
        const lineGX = (Math.floor(b.x0 / CHUNK) + 1) * CHUNK
        map.setWallV(lineGX, deck.levelCy, deck.globalBridgeLine, 1, PASSAGE_WALL)
      } else {
        const lineGZ = (Math.floor(b.z0 / CHUNK) + 1) * CHUNK
        map.setWallH(deck.globalBridgeLine, deck.levelCy, lineGZ, 1, PASSAGE_WALL)
      }
    })
    const review = auditStructure(map, structure)
    expect(review.ok).toBe(false)
    // Exactly one located finding: the group roll-up is not repeated.
    expect(review.issues.map((i) => i.code)).toEqual(['bridge-seam'])
    expect(review.issues[0].cy).toBe(deck.levelCy)
  })

  it('locates a stranded pocket cut into a storey', () => {
    const { seed, structure } = firstStructure('office', 'a', LANDMARK)
    const map = loadVolume('office', seed, structure)
    const cy = structure.baseCy
    // Box in one atrium corner cell with four walls.
    const gx = structure.globalBounds.x0
    const gz = structure.globalBounds.z0
    map.mutate(() => {
      map.setWallV(gx, cy, gz, 1)
      map.setWallV(gx + 1, cy, gz, 1)
      map.setWallH(gx, cy, gz, 1)
      map.setWallH(gx, cy, gz + 1, 1)
    })
    const review = auditStructure(map, structure)
    const stranded = review.issues.find((i) => i.code === 'stranded')
    expect(stranded).toMatchObject({ cy, gx, gz })
  })

  it('reports a clipped bake instead of a broken world', () => {
    const { seed, structure } = firstStructure('office', 'a')
    const p = structure.participants[0]
    const map = new EditorMap()
    map.bakeChunks({ seed, family: 'office', coords: [{ cx: p.cx, cy: structure.baseCy, cz: p.cz }] })
    const clipped = clippedStructures(map)
    expect(clipped).toHaveLength(1)
    expect(clipped[0].coverage.present).toBe(1)
    const review = auditDocument(map)
    expect(review.issues[0]).toMatchObject({ code: 'structure-clipped', severity: 'warn' })
    expect(auditStructure(map, structure).complete).toBe(false)
  })
})

describe('drift against the generator', () => {
  it('is empty for a fresh bake and flags structure-owned edits', () => {
    const { seed, structure } = firstStructure('office', 'a', (s) => s.kind === 'bridged')
    const map = loadVolume('office', seed, structure)
    const coords = structureChunkCoords(structure, 0)
    expect(diffAgainstGenerated(map, coords).cells).toEqual([])

    const deck = structure.decks[0]
    const cell = deck.globalCells[3]
    expect(map.cellAt(cell.gx, deck.levelCy, cell.gz).kind).toBe(CELL_BRIDGE)
    map.mutate(() => map.setCell(cell.gx, deck.levelCy, cell.gz, { kind: CELL_OPEN }))
    const diff = diffAgainstGenerated(map, coords)
    expect(diff.changedChunks).toBe(1)
    expect(diff.cells).toHaveLength(1)
    expect(diff.cells[0]).toMatchObject({ gx: cell.gx, gz: cell.gz, cy: deck.levelCy, structural: true })
    expect(diff.descriptorDrift).toEqual([])
  })

  it('does not read a reloaded document as drifted (float32 furniture)', async () => {
    const { seed, structure } = firstStructure('office', 'a', (s) => s.kind === 'bridged')
    const map = loadVolume('office', seed, structure)
    const loaded = await decodeMapFile(await encodeMapFile(map, { compress: false }))
    const coords = structureChunkCoords(structure, 0)
    expect(loaded.chunks.size).toBe(coords.length)
    const diff = diffAgainstGenerated(loaded, coords)
    expect(diff.cells).toEqual([])
    expect(diff.descriptorDrift).toEqual([])
  })
})

describe('hole masks', () => {
  it('match the ChunkData slab queries and follow descriptor identity', () => {
    const { seed, structure } = firstStructure('lattice', 'lobby')
    const map = loadVolume('lattice', seed, structure)
    for (const d of map.chunks.values()) {
      const m = holeMasks(d)
      for (let lz = 0; lz < CHUNK; lz++) {
        for (let lx = 0; lx < CHUNK; lx++) {
          expect(m.floor[lz * CHUNK + lx]).toBe(d.hasFloorHole(lx, lz) ? 1 : 0)
          expect(m.ceil[lz * CHUNK + lx]).toBe(d.hasCeilHole(lx, lz) ? 1 : 0)
        }
      }
    }
    const d = [...map.chunks.values()].find((c) => c.structureDown)
    const before = holeMasks(d)
    expect(holeMasks(d)).toBe(before)
    d.structureDown = null
    d.lethalVoidDown = null
    const after = holeMasks(d)
    expect(after).not.toBe(before)
    expect(after.floorCount).toBeLessThan(before.floorCount)
  })
})

describe('baked room records', () => {
  it('re-baking does not duplicate records or re-lift authored rooms', () => {
    const map = new EditorMap()
    map.bakeProcedural({ seedText: 'lobby', family: 'office', radius: 1, floors: [0] })
    const baked = map.rooms.length
    expect(baked).toBeGreaterThan(0)
    map.bakeProcedural({ seedText: 'lobby', family: 'office', radius: 1, floors: [0] })
    expect(map.rooms.length).toBe(baked)
    const keys = map.rooms.map((r) => `${r.cy}:${r.id}`)
    expect(new Set(keys).size).toBe(keys.length)

    // An authored room outside the re-baked box survives a re-bake and is
    // never lifted a second time as a baked record.
    map.mutate(() => {
      map.rooms.push({ id: 7, cy: 0, x0: 60, z0: 60, x1: 62, z1: 62, role: 0, salt: 0, door: null, baked: false })
      for (let gz = 60; gz <= 62; gz++) {
        for (let gx = 60; gx <= 62; gx++) map.setCell(gx, 0, gz, { kind: CELL_ROOM, spaceId: 7 })
      }
    })
    map.bakeProcedural({ seedText: 'lobby', family: 'office', radius: 1, floors: [0] })
    expect(map.rooms.filter((r) => r.id === 7)).toEqual([
      expect.objectContaining({ baked: false }),
    ])
    expect(map.rooms.length).toBe(baked + 1)
  })
})
