import { describe, expect, it } from 'vitest'
import { auditLayeredPatch } from '../audit.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { CHUNK, ZONE_WAREHOUSE, cIdx } from '../constants.js'
import { generateChunk } from '../generate.js'
import {
  CELL_ATRIUM,
  CELL_BRIDGE,
  CELL_VOID,
  PASSAGE_WALL,
  PASSAGE_WIDE,
  WALL_PLAIN,
  WALL_RAIL,
  WALL_WINDOW,
} from '../mapTypes.js'
import { multilevelContract } from '../multilevel.js'
import { slabContract } from '../slab.js'
import { countChunkComponents } from '../topology.js'

const FEATURE_HOST = Object.freeze({ seed: 1337, cx: 2, baseCy: 0, cz: -7 })
const PATCH = Object.freeze({ seed: 1337, x0: 0, y0: 0, z0: -9, nx: 5, ny: 2, nz: 5 })
const CORPUS_SEEDS = Array.from(
  { length: 24 },
  (_, i) => (Math.imul(0x9e3779b1, i + 1) + 0x539) >>> 0
)

const cellKey = ({ lx, lz }) => `${lx},${lz}`
const edgeKey = ({ axis, line, cell }) => `${axis}:${line},${cell}`
const chunkKey = (cx, cy, cz) => `${cx},${cy},${cz}`
const lookup = (chunks) => (cx, cy, cz) => chunks.get(chunkKey(cx, cy, cz)) || null

function expectedEdges(room) {
  const windows = []
  const mouths = []
  const rails = []
  const { x0, z0, x1, z1 } = room.bounds

  for (let z = z0; z <= z1; z++) {
    const target = room.bridgeAxis === 'x' && z === room.bridgeLine ? mouths : windows
    target.push({ axis: 'v', line: x0, cell: z })
    target.push({ axis: 'v', line: x1 + 1, cell: z })
  }
  for (let x = x0; x <= x1; x++) {
    const target = room.bridgeAxis === 'z' && x === room.bridgeLine ? mouths : windows
    target.push({ axis: 'h', line: z0, cell: x })
    target.push({ axis: 'h', line: z1 + 1, cell: x })
  }

  if (room.bridgeAxis === 'x') {
    for (let x = x0; x <= x1; x++) {
      rails.push({ axis: 'h', line: room.bridgeLine, cell: x })
      rails.push({ axis: 'h', line: room.bridgeLine + 1, cell: x })
    }
  } else {
    for (let z = z0; z <= z1; z++) {
      rails.push({ axis: 'v', line: room.bridgeLine, cell: z })
      rails.push({ axis: 'v', line: room.bridgeLine + 1, cell: z })
    }
  }
  return { windows, mouths, rails }
}

function edgeState(data, edge) {
  if (edge.axis === 'v') {
    return {
      wall: data.vAt(edge.line, edge.cell),
      passage: data.passageVAt(edge.line, edge.cell),
      feature: data.wallFeatureVAt(edge.line, edge.cell),
    }
  }
  return {
    wall: data.hAt(edge.cell, edge.line),
    passage: data.passageHAt(edge.cell, edge.line),
    feature: data.wallFeatureHAt(edge.cell, edge.line),
  }
}

function setEdge(data, edge, wall, passage, feature) {
  if (edge.axis === 'v') data.setV(edge.line, edge.cell, wall, passage, feature)
  else data.setH(edge.cell, edge.line, wall, passage, feature)
}

function featuredEdges(data) {
  const found = []
  for (let cell = 0; cell < CHUNK; cell++) {
    for (let line = 0; line < CHUNK; line++) {
      const v = data.wallFeatureVAt(line, cell)
      if (v !== WALL_PLAIN) found.push({ key: edgeKey({ axis: 'v', line, cell }), feature: v })
      const h = data.wallFeatureHAt(cell, line)
      if (h !== WALL_PLAIN) found.push({ key: edgeKey({ axis: 'h', line, cell }), feature: h })
    }
  }
  return found.sort((a, b) => a.key.localeCompare(b.key))
}

function chunkState(data) {
  return {
    version: data.version,
    cx: data.cx,
    cy: data.cy,
    cz: data.cz,
    zone: data.zone,
    wallV: [...data.wallV],
    wallH: [...data.wallH],
    passageV: [...data.passageV],
    passageH: [...data.passageH],
    wallFeatureV: [...data.wallFeatureV],
    wallFeatureH: [...data.wallFeatureH],
    cols: [...data.cols],
    cellKind: [...data.cellKind],
    spaceId: [...data.spaceId],
    lamps: data.lamps,
    repairs: data.repairs,
    exit: data.exit,
    stairUp: data.stairUp,
    stairDown: data.stairDown,
    multilevelUp: data.multilevelUp,
    multilevelDown: data.multilevelDown,
  }
}

function forcedFeatureConfig() {
  const config = structuredClone(DEFAULT_WORLD_CONFIG)
  config.zoneBands = [{ id: ZONE_WAREHOUSE, max: 1.01 }]
  config.multilevel.chance = 1
  return config
}

function findNegativeRoom(seed, config, baseCy = 0) {
  for (let cz = -24; cz < 0; cz++) {
    for (let cx = -24; cx < 0; cx++) {
      const room = multilevelContract(seed, cx, cz, baseCy, config)
      if (room.hasRoom) return { cx, cz, room }
    }
  }
  return null
}

function generatedPatch() {
  const chunks = new Map()
  for (let cy = PATCH.y0; cy < PATCH.y0 + PATCH.ny; cy++) {
    for (let cz = PATCH.z0; cz < PATCH.z0 + PATCH.nz; cz++) {
      for (let cx = PATCH.x0; cx < PATCH.x0 + PATCH.nx; cx++) {
        chunks.set(chunkKey(cx, cy, cz), generateChunk(PATCH.seed, cx, cy, cz))
      }
    }
  }
  return chunks
}

function auditGeneratedPatch(chunks) {
  return auditLayeredPatch(
    lookup(chunks),
    PATCH.x0,
    PATCH.y0,
    PATCH.z0,
    PATCH.nx,
    PATCH.ny,
    PATCH.nz
  )
}

function hostPair(chunks) {
  return {
    lower: chunks.get(chunkKey(FEATURE_HOST.cx, FEATURE_HOST.baseCy, FEATURE_HOST.cz)),
    upper: chunks.get(chunkKey(FEATURE_HOST.cx, FEATURE_HOST.baseCy + 1, FEATURE_HOST.cz)),
  }
}

function firstOrdinaryClosedEdge(data, room) {
  const expected = expectedEdges(room)
  const reserved = new Set(
    [...expected.windows, ...expected.mouths, ...expected.rails].map(edgeKey)
  )
  for (let cell = 0; cell < CHUNK; cell++) {
    for (let line = 0; line < CHUNK; line++) {
      for (const axis of ['v', 'h']) {
        const edge = { axis, line, cell }
        const state = edgeState(data, edge)
        if (!reserved.has(edgeKey(edge)) && state.wall === 1 && state.feature === WALL_PLAIN) {
          return edge
        }
      }
    }
  }
  return null
}

describe('production multilevel-room generation', () => {
  it('stamps one independently-derived room pair with exact void, bridge and edge semantics', () => {
    // Deliberately generate the consumer (upper floor) first: neither half may
    // depend on generation order or on sharing a mutable descriptor object.
    const upper = generateChunk(
      FEATURE_HOST.seed,
      FEATURE_HOST.cx,
      FEATURE_HOST.baseCy + 1,
      FEATURE_HOST.cz
    )
    const lower = generateChunk(
      FEATURE_HOST.seed,
      FEATURE_HOST.cx,
      FEATURE_HOST.baseCy,
      FEATURE_HOST.cz
    )
    const contract = multilevelContract(
      FEATURE_HOST.seed,
      FEATURE_HOST.cx,
      FEATURE_HOST.cz,
      FEATURE_HOST.baseCy
    )

    expect(contract.hasRoom).toBe(true)
    expect(lower.multilevelUp).toEqual(contract)
    expect(upper.multilevelDown).toEqual(contract)
    expect(lower.multilevelUp).not.toBe(upper.multilevelDown)
    expect(lower.multilevelDown).toBeNull()
    expect(upper.multilevelUp).toBeNull()

    const voidKeys = contract.voidCells.map(cellKey)
    const lowerHoles = []
    const upperHoles = []
    for (let z = 0; z < CHUNK; z++) {
      for (let x = 0; x < CHUNK; x++) {
        if (lower.hasCeilHole(x, z)) lowerHoles.push(`${x},${z}`)
        if (upper.hasFloorHole(x, z)) upperHoles.push(`${x},${z}`)
      }
    }
    expect(lowerHoles).toEqual(voidKeys)
    expect(upperHoles).toEqual(voidKeys)
    expect(upperHoles).toEqual(lowerHoles)

    const bridge = new Set(contract.bridgeCells.map(cellKey))
    const openVoid = new Set(voidKeys)
    const lampCells = new Set(lower.lamps.map(cellKey))
    const { x0, z0, x1, z1 } = contract.bounds
    const lowerAtriumCells = []
    const upperVoidCells = []
    const upperBridgeCells = []
    for (let z = 0; z < CHUNK; z++) {
      for (let x = 0; x < CHUNK; x++) {
        const key = `${x},${z}`
        const inside = x >= x0 && x <= x1 && z >= z0 && z <= z1
        const index = cIdx(x, z)
        if (lower.cellKind[index] === CELL_ATRIUM) lowerAtriumCells.push(key)
        if (upper.cellKind[index] === CELL_VOID) upperVoidCells.push(key)
        if (upper.cellKind[index] === CELL_BRIDGE) upperBridgeCells.push(key)
        if (!inside) continue

        expect(lower.cellKind[index]).toBe(CELL_ATRIUM)
        expect(lower.spaceId[index]).toBe(contract.id)
        expect(upper.spaceId[index]).toBe(contract.id)
        expect(lower.colAt(x, z)).toBe(0)
        expect(upper.colAt(x, z)).toBe(0)

        if (openVoid.has(key)) {
          expect(upper.cellKind[index]).toBe(CELL_VOID)
          expect(lower.hasCeilHole(x, z)).toBe(true)
          expect(upper.hasFloorHole(x, z)).toBe(true)
          expect(lampCells.has(key)).toBe(false)
        } else {
          expect(bridge.has(key)).toBe(true)
          expect(upper.cellKind[index]).toBe(CELL_BRIDGE)
          expect(lower.hasCeilHole(x, z)).toBe(false)
          expect(upper.hasFloorHole(x, z)).toBe(false)
        }
      }
    }
    expect(lowerAtriumCells).toEqual([...openVoid, ...bridge].sort((a, b) => {
      const [ax, az] = a.split(',').map(Number)
      const [bx, bz] = b.split(',').map(Number)
      return az * CHUNK + ax - (bz * CHUNK + bx)
    }))
    expect(upperVoidCells).toEqual(voidKeys)
    expect(upperBridgeCells).toEqual(contract.bridgeCells.map(cellKey))

    const edges = expectedEdges(contract)
    const width = x1 - x0 + 1
    const depth = z1 - z0 + 1
    const longSpan = Math.max(width, depth)
    expect(edges.mouths).toHaveLength(2)
    expect(edges.windows).toHaveLength(2 * (width + depth) - 2)
    expect(edges.rails).toHaveLength(longSpan * 2)
    for (const edge of edges.windows) {
      expect(edgeState(upper, edge)).toEqual({
        wall: 1,
        passage: PASSAGE_WALL,
        feature: WALL_WINDOW,
      })
    }
    for (const edge of edges.mouths) {
      expect(edgeState(upper, edge)).toEqual({
        wall: 0,
        passage: PASSAGE_WIDE,
        feature: WALL_PLAIN,
      })
    }
    for (const edge of edges.rails) {
      expect(edgeState(upper, edge)).toEqual({
        wall: 1,
        passage: PASSAGE_WALL,
        feature: WALL_RAIL,
      })
    }
    // The bridge is a real continuous corridor, not a collection of retained
    // but disconnected slab islands. Every longitudinal edge is open and both
    // opposite banks are solid, column-free gallery cells.
    for (let i = 1; i < contract.bridgeCells.length; i++) {
      const a = contract.bridgeCells[i - 1]
      const b = contract.bridgeCells[i]
      const edge = contract.bridgeAxis === 'x'
        ? { axis: 'v', line: Math.max(a.lx, b.lx), cell: a.lz }
        : { axis: 'h', line: Math.max(a.lz, b.lz), cell: a.lx }
      expect(edgeState(upper, edge).wall).toBe(0)
    }
    const banks = contract.bridgeAxis === 'x'
      ? [
          { lx: x0 - 1, lz: contract.bridgeLine },
          { lx: x1 + 1, lz: contract.bridgeLine },
        ]
      : [
          { lx: contract.bridgeLine, lz: z0 - 1 },
          { lx: contract.bridgeLine, lz: z1 + 1 },
        ]
    for (const bank of banks) {
      expect(upper.hasFloorHole(bank.lx, bank.lz)).toBe(false)
      expect(upper.colAt(bank.lx, bank.lz)).toBe(0)
    }

    const expectedFeatures = [
      ...edges.windows.map((edge) => ({ key: edgeKey(edge), feature: WALL_WINDOW })),
      ...edges.rails.map((edge) => ({ key: edgeKey(edge), feature: WALL_RAIL })),
    ].sort((a, b) => a.key.localeCompare(b.key))
    expect(featuredEdges(lower)).toEqual([])
    expect(featuredEdges(upper)).toEqual(expectedFeatures)
    expect(countChunkComponents(upper)).toBe(1)
    expect(countChunkComponents(upper, true)).toBe(1)
  })

  it.each([
    ['forced feature', forcedFeatureConfig],
    ['default feature density', () => DEFAULT_WORLD_CONFIG],
  ])('keeps a deterministic, stair-free room corpus at negative coordinates (%s)', (_, configOf) => {
    const config = configOf()
    let generatedRooms = 0

    for (const seed of CORPUS_SEEDS) {
      const host = findNegativeRoom(seed, config)
      expect(host, `negative multilevel host for seed ${seed}`).not.toBeNull()
      const { cx, cz, room } = host
      expect(cx).toBeLessThan(0)
      expect(cz).toBeLessThan(0)
      expect(multilevelContract(seed, cx, cz, 0, config)).toEqual(room)

      const width = room.bounds.x1 - room.bounds.x0 + 1
      const depth = room.bounds.z1 - room.bounds.z0 + 1
      expect([width, depth].sort((a, b) => b - a)).toEqual([
        config.multilevel.longSpan,
        config.multilevel.shortSpan,
      ])
      expect(room.bridgeCells).toHaveLength(config.multilevel.longSpan)
      expect(room.voidCells).toHaveLength(
        config.multilevel.longSpan * (config.multilevel.shortSpan - 1)
      )

      for (let slabCy = -1; slabCy <= 1; slabCy++) {
        expect(slabContract(seed, cx, cz, slabCy, config).hasStair).toBe(false)
      }

      const lower = generateChunk(seed, cx, 0, cz, config)
      const upper = generateChunk(seed, cx, 1, cz, config)
      expect(lower.multilevelUp).toEqual(room)
      expect(upper.multilevelDown).toEqual(room)
      expect([lower.stairDown, lower.stairUp, upper.stairDown, upper.stairUp]).toEqual([
        null,
        null,
        null,
        null,
      ])
      expect(chunkState(generateChunk(seed, cx, 0, cz, config))).toEqual(chunkState(lower))
      expect(chunkState(generateChunk(seed, cx, 1, cz, config))).toEqual(chunkState(upper))
      generatedRooms++
    }

    expect(generatedRooms).toBe(CORPUS_SEEDS.length)
  })
})

describe('layered multilevel-room audit integration', () => {
  it('accepts a generated 5x2x5 patch containing real rooms and stairs as one graph', () => {
    const audit = auditGeneratedPatch(generatedPatch())

    expect(audit.chunks).toBe(PATCH.nx * PATCH.ny * PATCH.nz)
    expect(audit.slabs).toBe(PATCH.nx * PATCH.nz)
    expect(audit.stairPairs).toBeGreaterThan(0)
    expect(audit.canonicalLinks).toBe(audit.stairPairs)
    expect(audit.multilevelPairs).toBeGreaterThan(0)
    expect(audit.multilevelRooms).toBe(audit.multilevelPairs)
    expect(audit.mismatchedDescriptors).toBe(0)
    expect(audit.holeMismatches).toBe(0)
    expect(audit.orphanedHalves).toBe(0)
    expect(audit.invalidCanonicalLinks).toBe(0)
    expect(audit.mismatchedMultilevelDescriptors).toBe(0)
    expect(audit.orphanedMultilevelHalves).toBe(0)
    expect(audit.invalidMultilevelRooms).toBe(0)
    expect(audit.strayWallFeatures).toBe(0)
    expect(audit.components).toBe(1)
    expect(audit.disconnectedCells).toBe(0)
    expect(audit.connected).toBe(true)
    expect(audit.ok).toBe(true)
  })

  it('reports an orphaned generated room half and its exact lost hole mask', () => {
    const chunks = generatedPatch()
    const { lower, upper } = hostPair(chunks)
    const room = lower.multilevelUp
    upper.multilevelDown = null

    const audit = auditGeneratedPatch(chunks)
    expect(audit.orphanedMultilevelHalves).toBe(1)
    expect(audit.details.orphanedMultilevelHalves).toContainEqual({
      cx: FEATURE_HOST.cx,
      cy: FEATURE_HOST.baseCy,
      cz: FEATURE_HOST.cz,
      half: 'lower.multilevelUp',
    })
    expect(audit.multilevelPairs).toBe(audit.multilevelRooms - 1)
    expect(audit.mismatchedMultilevelDescriptors).toBe(0)
    expect(audit.invalidMultilevelRooms).toBe(0)
    expect(audit.strayWallFeatures).toBeGreaterThan(0)
    expect(audit.holeMismatchSlabs).toBe(1)
    expect(audit.holeMismatches).toBe(room.voidCells.length)
    expect(audit.ok).toBe(false)
  })

  it('separates a shifted room descriptor from the resulting slab-hole mismatch', () => {
    const chunks = generatedPatch()
    const { lower, upper } = hostPair(chunks)
    const room = lower.multilevelUp
    const shortMax = room.bridgeAxis === 'x' ? room.bounds.z1 : room.bounds.x1
    const shiftedLine = room.bridgeLine === shortMax ? room.bridgeLine - 1 : room.bridgeLine + 1
    upper.multilevelDown = { ...upper.multilevelDown, bridgeLine: shiftedLine }

    const audit = auditGeneratedPatch(chunks)
    expect(audit.multilevelPairs).toBe(audit.multilevelRooms)
    expect(audit.mismatchedMultilevelDescriptors).toBe(1)
    expect(audit.orphanedMultilevelHalves).toBe(0)
    expect(audit.invalidMultilevelRooms).toBe(0)
    expect(audit.holeMismatchSlabs).toBe(1)
    expect(audit.holeMismatches).toBe(room.bridgeCells.length * 2)
    expect(audit.ok).toBe(false)
  })

  it('rejects a window feature assigned to an ordinary non-room edge', () => {
    const chunks = generatedPatch()
    const { lower, upper } = hostPair(chunks)
    const ordinary = firstOrdinaryClosedEdge(upper, lower.multilevelUp)
    expect(ordinary).not.toBeNull()
    setEdge(upper, ordinary, 1, PASSAGE_WALL, WALL_WINDOW)

    const audit = auditGeneratedPatch(chunks)
    expect(audit.invalidMultilevelRooms).toBe(1)
    expect(audit.mismatchedMultilevelDescriptors).toBe(0)
    expect(audit.holeMismatches).toBe(0)
    expect(audit.details.invalidMultilevelRooms[0].reasons).toContain(
      'window or rail outside its multilevel room'
    )
    expect(audit.connected).toBe(true)
    expect(audit.ok).toBe(false)
  })

  it('rejects a missing guard anywhere along either side of the bridge', () => {
    const chunks = generatedPatch()
    const { lower, upper } = hostPair(chunks)
    const rail = expectedEdges(lower.multilevelUp).rails[0]
    setEdge(upper, rail, 1, PASSAGE_WALL, WALL_PLAIN)

    const audit = auditGeneratedPatch(chunks)
    expect(audit.invalidMultilevelRooms).toBe(1)
    expect(audit.mismatchedMultilevelDescriptors).toBe(0)
    expect(audit.holeMismatches).toBe(0)
    expect(audit.details.invalidMultilevelRooms[0].reasons).toContain('invalid bridge guard')
    expect(audit.connected).toBe(true)
    expect(audit.ok).toBe(false)
  })

  it('validates window and rail structure when a bounded patch starts on the upper floor', () => {
    const upperCy = FEATURE_HOST.baseCy + 1
    const upper = generateChunk(
      FEATURE_HOST.seed,
      FEATURE_HOST.cx,
      upperCy,
      FEATURE_HOST.cz
    )
    const rail = expectedEdges(upper.multilevelDown).rails[0]
    setEdge(upper, rail, 1, PASSAGE_WALL, WALL_PLAIN)
    const audit = auditLayeredPatch(
      (cx, cy, cz) =>
        cx === FEATURE_HOST.cx && cy === upperCy && cz === FEATURE_HOST.cz ? upper : null,
      FEATURE_HOST.cx,
      upperCy,
      FEATURE_HOST.cz,
      1,
      1,
      1
    )
    expect(audit.slabs).toBe(0)
    expect(audit.invalidMultilevelRooms).toBe(1)
    expect(audit.details.invalidMultilevelRooms[0].boundaryHalf).toBe(
      'upper.multilevelDown'
    )
    expect(audit.details.invalidMultilevelRooms[0].reasons).toContain(
      'invalid bridge guard'
    )
    expect(audit.ok).toBe(false)
  })
})
