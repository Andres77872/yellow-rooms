import { describe, it, expect } from 'vitest'
import { buildChunk, layerSeed } from '../pipeline.js'
import { DEFAULT_WORLD_CONFIG as CFG } from '../config.js'
import {
  CHUNK,
  ZONE_OFFICE,
  ZONE_WAREHOUSE,
  chunkKey,
  fmod,
} from '../constants.js'
import { hash2i } from '../core/hash.js'
import {
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_STAIR,
  PASSAGE_DOOR,
  PASSAGE_OPEN,
  PASSAGE_WALL,
  PASSAGE_WIDE,
} from '../mapTypes.js'
import {
  buildOfficeDistrictEdgeContract,
  buildOfficeDistrictPlan,
  clearOfficePlanCache,
  officeDistrictCoords,
} from '../zones/officePlan.js'
import { warehouseWallH, warehouseWallV } from '../warehouseStructure.js'
import {
  multilevelBandBase,
  multilevelConfig,
  multilevelContract,
} from '../multilevel.js'

function forcedZone(zone) {
  const cfg = structuredClone(CFG)
  cfg.zoneBands = [{ id: zone, max: 1.01 }]
  return cfg
}

function isCirculation(kind) {
  return kind === CELL_CORRIDOR || kind === CELL_LOBBY
}

function planBytes(plan) {
  return [
    ...plan.active,
    ...plan.wallV,
    ...plan.wallH,
    ...plan.passageV,
    ...plan.passageH,
    ...plan.cellKind,
    ...plan.spaceId,
  ]
}

function hasUsableWidth(plan, spaceId, width) {
  if (width <= 1) return true
  const cells = new Set()
  for (let i = 0; i < plan.spaceId.length; i++) if (plan.spaceId[i] === spaceId) cells.add(i)
  for (const i of cells) {
    const x = i % plan.size
    const z = Math.floor(i / plan.size)
    for (let oz = 1 - width; oz <= 0; oz++) {
      for (let ox = 1 - width; ox <= 0; ox++) {
        const x0 = x + ox
        const z0 = z + oz
        if (x0 < 0 || z0 < 0 || x0 + width > plan.size || z0 + width > plan.size) continue
        let supported = true
        for (let dz = 0; dz < width && supported; dz++) {
          for (let dx = 0; dx < width; dx++) {
            if (!cells.has((z0 + dz) * plan.size + x0 + dx)) {
              supported = false
              break
            }
          }
        }
        if (supported) return true
      }
    }
  }
  return false
}

describe('multi-chunk office district plan', () => {
  const seed = 0x0ff1ce
  const cfg = forcedZone(ZONE_OFFICE)

  it('is deterministic across cache eviction and negative coordinates', () => {
    const first = buildOfficeDistrictPlan(seed, -2, 3, cfg)
    const bytes = planBytes(first)
    clearOfficePlanCache(cfg)
    const second = buildOfficeDistrictPlan(seed, -2, 3, cfg)
    expect(planBytes(second)).toEqual(bytes)
    expect(second.metrics).toEqual(first.metrics)
  })

  it('keys cached stair reservations by root seed and floor context', () => {
    const layer = 0xabc123
    const a = buildOfficeDistrictPlan(layer, 0, 0, cfg, {
      rootSeed: 7,
      layerSeed: layer,
      cy: 2,
    })
    const b = buildOfficeDistrictPlan(layer, 0, 0, cfg, {
      rootSeed: 99,
      layerSeed: layer,
      cy: -1,
    })
    const again = buildOfficeDistrictPlan(layer, 0, 0, cfg, {
      rootSeed: 7,
      layerSeed: layer,
      cy: 2,
    })
    expect(a.stairLobbies).not.toEqual(b.stairLobbies)
    expect(again.stairLobbies).toEqual(a.stairLobbies)
    expect(planBytes(again)).toEqual(planBytes(a))
  })

  it('keeps one connected circulation hierarchy with bounded coverage', () => {
    for (const s of [1, 42, seed, 0xc0ffee]) {
      const plan = buildOfficeDistrictPlan(s, 0, 0, cfg)
      const cells = []
      for (let i = 0; i < plan.cellKind.length; i++) {
        if (isCirculation(plan.cellKind[i])) cells.push(i)
      }
      expect(plan.metrics.corridorCoverage).toBeGreaterThanOrEqual(0.1)
      // A reserved tall structure may contribute its wide lower hall or
      // gallery ring to circulation before room allocation.
      expect(plan.metrics.corridorCoverage).toBeLessThanOrEqual(0.38)
      expect(plan.metrics.wallFraction).toBeGreaterThanOrEqual(0.15)
      expect(plan.metrics.wallFraction).toBeLessThanOrEqual(0.27)
      expect(plan.metrics.rooms).toBeGreaterThan(30)
      expect(plan.metrics.maxRoomDepth).toBeLessThanOrEqual(cfg.office.corridors.maxRoomDepth)
      expect(plan.metrics.portalMisses).toBe(0)
      expect(plan.metrics.unroutedStairs).toBe(0)
      expect(plan.metrics.unroutedMultilevel).toBe(0)
      expect(plan.metrics.unsupportedDoors).toBe(0)
      expect(plan.metrics.invalidRooms).toBe(0)
      expect(plan.metrics.seamRatio).toBeLessThanOrEqual(cfg.office.corridors.maxSeamRatio)

      for (const room of plan.spaces.filter((space) => space.type === 'room')) {
        const width = room.x1 - room.x0 + 1
        const height = room.z1 - room.z0 + 1
        expect(room.area).toBeGreaterThanOrEqual(cfg.office.minRoomArea)
        expect(Math.min(width, height)).toBeGreaterThanOrEqual(cfg.office.minRoomWidth)
        expect(Math.max(width / height, height / width)).toBeLessThanOrEqual(
          cfg.office.maxRoomAspect
        )
      }

      const seen = new Set([cells[0]])
      const queue = [cells[0]]
      while (queue.length) {
        const i = queue.shift()
        const x = i % plan.size
        const z = Math.floor(i / plan.size)
        for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = x + dx
          const nz = z + dz
          if (nx < 0 || nx >= plan.size || nz < 0 || nz >= plan.size) continue
          const ni = nz * plan.size + nx
          if (!seen.has(ni) && isCirculation(plan.cellKind[ni])) {
            seen.add(ni)
            queue.push(ni)
          }
        }
      }
      expect(seen.size).toBe(cells.length)
    }
  })

  it('uses explicit doors and stable semantic spaces', () => {
    const plan = buildOfficeDistrictPlan(seed, 0, 0, cfg)
    let passages = 0
    for (let i = 0; i < plan.passageV.length; i++) {
      if (plan.passageV[i] === PASSAGE_DOOR) {
        expect(plan.wallV[i]).toBe(0)
      }
      if (plan.passageH[i] === PASSAGE_DOOR) {
        expect(plan.wallH[i]).toBe(0)
      }
      if (plan.passageV[i] === PASSAGE_DOOR || plan.passageV[i] === PASSAGE_WIDE) passages++
      if (plan.passageH[i] === PASSAGE_DOOR || plan.passageH[i] === PASSAGE_WIDE) passages++
    }
    expect(passages).toBeGreaterThan(plan.metrics.rooms - 1)
    const publicIds = new Set(plan.spaces.map((space) => space.id))
    const cellIds = new Set([...plan.spaceId].filter(Boolean))
    expect(cellIds).toEqual(publicIds)
    expect(new Set(plan.spaces.map((space) => space.localId)).size).toBe(plan.spaces.length)
    for (const edge of plan.adjacency) {
      expect(publicIds.has(edge.a)).toBe(true)
      expect(publicIds.has(edge.b)).toBe(true)
    }
  })

  it('routes every canonical macro-edge portal directly into circulation', () => {
    const plan = buildOfficeDistrictPlan(seed, 0, 0, cfg)
    expect(plan.portals.length).toBe(4 * cfg.office.districtChunks)
    for (const portal of plan.portals) {
      expect(isCirculation(plan.cellKind[portal.z * plan.size + portal.x])).toBe(true)
    }
    for (const [axis, dx, dz] of [
      ['v', -1, 0],
      ['v', 0, 0],
      ['h', 0, -1],
      ['h', 0, 0],
    ]) {
      const edge = buildOfficeDistrictEdgeContract(seed, axis, dx, dz, cfg)
      expect(edge.portals.length).toBe(cfg.office.districtChunks)
    }
  })

  it('enforces room geometry, final graph depth, and seam density on regression plans', () => {
    const cases = [
      [cfg, 15, 3, 2],
      [cfg, 0, -50, -51],
      [cfg, 0, 2, -4],
      [CFG, 165, 28, 17],
      [CFG, 1319, -49, 50],
      [CFG, 3058196056, 41, -1],
      [CFG, 1726732321, -17, -56],
      [CFG, 2354233868, -48, -44],
      [CFG, 3896116424, 55, -31],
    ]
    let shapePromotions = 0
    for (const [planConfig, planSeed, dx, dz] of cases) {
      const plan = buildOfficeDistrictPlan(planSeed, dx, dz, planConfig)
      shapePromotions += plan.metrics.shapePromotions
      expect(plan.metrics.invalidRooms).toBe(0)
      expect(plan.metrics.maxRoomDepth).toBeLessThanOrEqual(
        planConfig.office.corridors.maxRoomDepth
      )
      expect(plan.metrics.seamRatio).toBeLessThanOrEqual(
        planConfig.office.corridors.maxSeamRatio
      )
      for (const room of plan.spaces.filter((space) => space.type === 'room')) {
        const width = room.x1 - room.x0 + 1
        const height = room.z1 - room.z0 + 1
        expect(room.area).toBeGreaterThanOrEqual(planConfig.office.minRoomArea)
        expect(Math.min(width, height)).toBeGreaterThanOrEqual(
          planConfig.office.minRoomWidth
        )
        expect(Math.max(width / height, height / width)).toBeLessThanOrEqual(
          planConfig.office.maxRoomAspect
        )
        expect(hasUsableWidth(plan, room.id, planConfig.office.minRoomWidth)).toBe(true)
      }
    }
    expect(shapePromotions).toBeGreaterThan(0)
  })

  it('returns defensive plan snapshots that cannot corrupt cached generation', () => {
    const dense = structuredClone(cfg)
    dense.stairs.chance = 1
    const first = buildOfficeDistrictPlan(seed, 0, 0, dense)
    const original = first.wallV[1]
    const originalMouth = { ...first.stairLobbies[0].mouth }
    first.wallV[1] = original ? 0 : 1
    first.stairLobbies[0].mouth.x = -999
    first.stairLobbies[0].cells.length = 0
    first.stairLobbies[0].contract.run[0].lx = -999
    const second = buildOfficeDistrictPlan(seed, 0, 0, dense)
    expect(second.wallV[1]).toBe(original)
    expect(second.stairLobbies[0].mouth).toEqual(originalMouth)
    expect(second.stairLobbies[0].cells.length).toBeGreaterThan(0)
    expect(second.stairLobbies[0].contract.run[0].lx).toBeGreaterThanOrEqual(0)
  })

  it('normalizes non-integer and non-finite structural tuning values', () => {
    const fractional = forcedZone(ZONE_OFFICE)
    fractional.office.districtChunks = 3.9
    fractional.office.planCandidates = 1.9
    fractional.office.roomMin = 4.8
    fractional.office.roomMax = 3.2
    expect(buildOfficeDistrictPlan(seed, 0, 0, fractional).size).toBe(3 * CHUNK)

    const nonFinite = forcedZone(ZONE_OFFICE)
    nonFinite.office.districtChunks = Number.NaN
    nonFinite.office.planCandidates = Number.POSITIVE_INFINITY
    expect(buildOfficeDistrictPlan(seed, 0, 0, nonFinite).size).toBe(3 * CHUNK)
  })

  // Byte-exactness needs physical vertical stamps off: plans reserve their
  // circulation, while guard walls/holes remain post-slice realizations.
  it('slices chunks from the district while preserving internal seam bytes', () => {
    const cfgNS = structuredClone(cfg)
    cfgNS.stairs.enabled = false
    cfgNS.multilevel.enabled = false
    const plan = buildOfficeDistrictPlan(seed, 0, 0, cfgNS)
    const chunks = new Map()
    for (let cz = 0; cz < cfgNS.office.districtChunks; cz++) {
      for (let cx = 0; cx < cfgNS.office.districtChunks; cx++) {
        chunks.set(chunkKey(cx, cz), buildChunk(seed, cx, 0, cz, cfgNS))
      }
    }

    for (let cz = 0; cz < cfgNS.office.districtChunks; cz++) {
      for (let cx = 0; cx < cfgNS.office.districtChunks; cx++) {
        const data = chunks.get(chunkKey(cx, cz))
        expect(data.repairs).toEqual({ connectivity: 0, navigation: 0, columns: 0 })
        const dc = officeDistrictCoords(cx, cz, cfg)
        const x0 = dc.localCx * CHUNK
        const z0 = dc.localCz * CHUNK
        for (let z = 0; z < CHUNK; z++) {
          for (let x = 0; x < CHUNK; x++) {
            const pi = (z0 + z) * plan.size + x0 + x
            const di = z * CHUNK + x
            expect(data.cellKind[di]).toBe(plan.cellKind[pi])
            expect(data.spaceId[di]).toBe(plan.spaceId[pi])
          }
          for (let lineX = 1; lineX < CHUNK; lineX++) {
            expect(data.vAt(lineX, z)).toBe(plan.vAt(x0 + lineX, z0 + z))
            expect(data.passageVAt(lineX, z)).toBe(
              plan.passageVAt(x0 + lineX, z0 + z)
            )
          }
        }
        for (let lineZ = 1; lineZ < CHUNK; lineZ++) {
          for (let x = 0; x < CHUNK; x++) {
            expect(data.hAt(x, lineZ)).toBe(plan.hAt(x0 + x, z0 + lineZ))
            expect(data.passageHAt(x, lineZ)).toBe(
              plan.passageHAt(x0 + x, z0 + lineZ)
            )
          }
        }
        if (cx > 0) {
          for (let z = 0; z < CHUNK; z++) {
            expect(data.vAt(0, z)).toBe(plan.vAt(x0, z0 + z))
            expect(data.passageVAt(0, z)).toBe(plan.passageVAt(x0, z0 + z))
          }
        }
        if (cz > 0) {
          for (let x = 0; x < CHUNK; x++) {
            expect(data.hAt(x, 0)).toBe(plan.hAt(x0 + x, z0))
            expect(data.passageHAt(x, 0)).toBe(plan.passageHAt(x0 + x, z0))
          }
        }
      }
    }
  })

  it('reserves every office stair halo as routed lobby before room allocation', () => {
    const cfgStairs = structuredClone(cfg)
    cfgStairs.stairs.chance = 1
    const plan = buildOfficeDistrictPlan(seed, 0, 0, cfgStairs, {
      rootSeed: seed,
      layerSeed: seed,
      cy: 0,
    })
    expect(plan.stairLobbies.length).toBeGreaterThan(0)
    expect(plan.metrics.stairLobbies).toBe(plan.stairLobbies.length)
    expect(plan.metrics.unroutedStairs).toBe(0)

    const chunks = new Map()
    const K = cfgStairs.office.districtChunks
    for (let cz = 0; cz < K; cz++) {
      for (let cx = 0; cx < K; cx++) {
        const stamped = buildChunk(seed, cx, 0, cz, cfgStairs)
        expect(stamped.repairs).toEqual({ connectivity: 0, navigation: 0, columns: 0 })
        chunks.set(`${cx},${cz}`, stamped)
      }
    }
    for (const lobby of plan.stairLobbies) {
      const stamped = chunks.get(`${lobby.cx},${lobby.cz}`)
      expect(stamped[lobby.kind === 'up' ? 'stairUp' : 'stairDown']).toEqual(lobby.contract)
      const mouthIdx = lobby.mouth.z * plan.size + lobby.mouth.x
      expect(isCirculation(plan.cellKind[mouthIdx])).toBe(true)
      for (const cell of lobby.cells) {
        expect(plan.cellKind[cell]).toBe(CELL_LOBBY)
        expect(plan.spaceId[cell]).not.toBe(0)
        const x = cell % plan.size
        const z = Math.floor(cell / plan.size)
        const local = (z % CHUNK) * CHUNK + (x % CHUNK)
        expect([CELL_LOBBY, CELL_STAIR]).toContain(stamped.cellKind[local])
      }
    }
  })

  it('reserves every floor/chunk of a tall atrium before rooms and routes its approaches', () => {
    const rootSeed = 1337
    const structureCfg = structuredClone(cfg)
    structureCfg.multilevel.bridgeChance = 1
    structureCfg.multilevel.minLevels = 4
    structureCfg.multilevel.maxLevels = 4
    const K = multilevelConfig(structureCfg).districtChunks
    const baseCy = multilevelBandBase(rootSeed, 0, 0, 0, structureCfg)
    let structure = null
    for (let dz = 0; dz < K && !structure; dz++) {
      for (let dx = 0; dx < K; dx++) {
        const candidate = multilevelContract(rootSeed, dx, dz, baseCy, structureCfg)
        if (candidate.hasRoom) structure = candidate
      }
    }
    expect(structure).not.toBeNull()

    for (let cy = structure.baseCy; cy <= structure.topCy; cy++) {
      for (const participant of structure.participants) {
        const district = officeDistrictCoords(participant.cx, participant.cz, structureCfg)
        const seedForLayer = layerSeed(rootSeed, cy)
        const plan = buildOfficeDistrictPlan(
          seedForLayer,
          district.dx,
          district.dz,
          structureCfg,
          { rootSeed, layerSeed: seedForLayer, cy }
        )
        const lobby = plan.multilevelLobbies.find(
          (candidate) => candidate.cx === participant.cx && candidate.cz === participant.cz
        )
        expect(lobby).toBeTruthy()
        const bridged = structure.bridgeLevels.includes(cy)
        expect(lobby.kind).toBe(cy === structure.baseCy ? 'bottom' : bridged ? 'bridge' : 'gallery')
        expect(plan.metrics.unroutedMultilevel).toBe(0)
        expect(plan.metrics.multilevelLobbies).toBe(plan.multilevelLobbies.length)
        for (const mouth of lobby.mouths) {
          expect(isCirculation(plan.cellKind[mouth.z * plan.size + mouth.x])).toBe(true)
        }
        for (const cell of lobby.cells) expect(plan.cellKind[cell]).toBe(CELL_LOBBY)

        const stamped = buildChunk(rootSeed, participant.cx, cy, participant.cz, structureCfg)
        const surface = cy === structure.baseCy
          ? stamped.multilevelUp
          : stamped.multilevelDown
        expect(surface).toEqual(lobby.room)
      }
    }
  })

  it('lets rooms and corridors cross streaming seams without a wall-density spike', () => {
    let seamWalls = 0
    let seamEdges = 0
    let ordinaryWalls = 0
    let ordinaryEdges = 0
    let circulationCrossings = 0
    for (const s of [1, 42, seed, 314159, 0xc0ffee]) {
      const plan = buildOfficeDistrictPlan(s, 0, 0, cfg)
      for (let z = 0; z < plan.size; z++) {
        for (let x = 1; x < plan.size; x++) {
          const seam = x % CHUNK === 0
          if (seam) {
            seamWalls += plan.vAt(x, z)
            seamEdges++
            const a = z * plan.size + x - 1
            const b = a + 1
            if (!plan.vAt(x, z) && isCirculation(plan.cellKind[a]) && isCirculation(plan.cellKind[b])) {
              circulationCrossings++
            }
          } else {
            ordinaryWalls += plan.vAt(x, z)
            ordinaryEdges++
          }
        }
      }
      for (let z = 1; z < plan.size; z++) {
        for (let x = 0; x < plan.size; x++) {
          const seam = z % CHUNK === 0
          if (seam) {
            seamWalls += plan.hAt(x, z)
            seamEdges++
            const a = (z - 1) * plan.size + x
            const b = z * plan.size + x
            if (!plan.hAt(x, z) && isCirculation(plan.cellKind[a]) && isCirculation(plan.cellKind[b])) {
              circulationCrossings++
            }
          } else {
            ordinaryWalls += plan.hAt(x, z)
            ordinaryEdges++
          }
        }
      }
    }
    const seamDensity = seamWalls / seamEdges
    const ordinaryDensity = ordinaryWalls / ordinaryEdges
    expect(seamDensity / ordinaryDensity).toBeLessThan(1.35)
    expect(circulationCrossings).toBeGreaterThan(0)
  })

  it('keeps wall bytes and passage semantics internally consistent', () => {
    for (const s of [1, 42, seed, 314159]) {
      const plan = buildOfficeDistrictPlan(s, 0, 0, cfg)
      for (let i = 0; i < plan.wallV.length; i++) {
        expect(plan.wallV[i] === 1).toBe(plan.passageV[i] === PASSAGE_WALL)
        expect(plan.wallH[i] === 1).toBe(plan.passageH[i] === PASSAGE_WALL)
      }
      for (const edge of plan.adjacency) {
        expect(edge.kind === PASSAGE_DOOR || edge.kind === PASSAGE_WIDE).toBe(true)
        const actual = edge.axis === 'v'
          ? plan.passageVAt(edge.line, edge.cell)
          : plan.passageHAt(edge.cell, edge.line)
        expect(actual).toBe(edge.kind)
        const cells = edge.axis === 'v'
          ? [
              edge.cell * plan.size + edge.line - 1,
              edge.cell * plan.size + edge.line,
            ]
          : [
              (edge.line - 1) * plan.size + edge.cell,
              edge.line * plan.size + edge.cell,
            ]
        expect(new Set([edge.a, edge.b])).toEqual(
          new Set(cells.map((i) => plan.spaceId[i]))
        )
      }
      for (let z = 0; z < plan.size; z++) {
        for (let x = 1; x < plan.size; x++) {
          const i = z * plan.size + x
          if (plan.passageV[i] !== PASSAGE_OPEN) continue
          expect(plan.spaceId[i]).toBe(plan.spaceId[i - 1])
        }
      }
      for (let z = 1; z < plan.size; z++) {
        for (let x = 0; x < plan.size; x++) {
          const i = z * plan.size + x
          if (plan.passageH[i] !== PASSAGE_OPEN) continue
          expect(plan.spaceId[i]).toBe(plan.spaceId[i - plan.size])
        }
      }
      for (let z = 0; z < plan.size; z++) {
        for (let x = 0; x < plan.size; x++) {
          if (plan.passageVAt(x, z) === PASSAGE_DOOR) {
            const support =
              (z > 0 && plan.vAt(x, z - 1) ? 1 : 0) +
              (z < plan.size - 1 && plan.vAt(x, z + 1) ? 1 : 0)
            expect(support).toBeGreaterThan(0)
            if (z < plan.size - 1) {
              expect(plan.passageVAt(x, z + 1)).not.toBe(PASSAGE_DOOR)
            }
          }
          if (plan.passageHAt(x, z) === PASSAGE_DOOR) {
            const support =
              (x > 0 && plan.hAt(x - 1, z) ? 1 : 0) +
              (x < plan.size - 1 && plan.hAt(x + 1, z) ? 1 : 0)
            expect(support).toBeGreaterThan(0)
            if (x < plan.size - 1) {
              expect(plan.passageHAt(x + 1, z)).not.toBe(PASSAGE_DOOR)
            }
          }
        }
      }
    }
  })

  it('does not reuse a semantic space id across disconnected mixed-zone islands', () => {
    const plans = [
      buildOfficeDistrictPlan(1, -1, -25, CFG),
      buildOfficeDistrictPlan(42, 0, 0, CFG),
      buildOfficeDistrictPlan(0xbeef, 3, -2, CFG),
    ]
    for (const plan of plans) {
      const bySpace = new Map()
      for (let i = 0; i < plan.spaceId.length; i++) {
        const id = plan.spaceId[i]
        if (id === 0) continue
        let cells = bySpace.get(id)
        if (!cells) bySpace.set(id, (cells = []))
        cells.push(i)
      }
      for (const cells of bySpace.values()) {
        const wanted = new Set(cells)
        const seen = new Set([cells[0]])
        const queue = [cells[0]]
        while (queue.length) {
          const i = queue.shift()
          const x = i % plan.size
          const z = Math.floor(i / plan.size)
          for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const nx = x + dx
            const nz = z + dz
            if (nx < 0 || nx >= plan.size || nz < 0 || nz >= plan.size) continue
            const ni = nz * plan.size + nx
            if (wanted.has(ni) && !seen.has(ni)) {
              seen.add(ni)
              queue.push(ni)
            }
          }
        }
        expect(seen.size).toBe(cells.length)
      }
    }
  })
})

describe('global warehouse structure', () => {
  it('evaluates wall fragments from global coordinates across chunk slices', () => {
    const cfg = forcedZone(ZONE_WAREHOUSE)
    cfg.warehouse.fragments.chance = 1
    cfg.warehouse.fragments.lineSpacing = 1
    cfg.warehouse.fragments.anchorStep = 10
    cfg.warehouse.fragments.runLen = [10, 10]
    const seed = 0x51a7
    expect(warehouseWallH(13, 5, seed, cfg)).toBe(true)
    expect(warehouseWallH(14, 5, seed, cfg)).toBe(true)
    expect(typeof warehouseWallV(5, 13, seed, cfg)).toBe('boolean')
  })

  it('compiles horizontal and vertical global wall runs across chunk edges', () => {
    const cfg = forcedZone(ZONE_WAREHOUSE)
    const seed = 6
    const west = buildChunk(seed, 0, 0, 0, cfg)
    const east = buildChunk(seed, 1, 0, 0, cfg)
    const north = buildChunk(seed, 0, 0, 0, cfg)
    const south = buildChunk(seed, 0, 0, 1, cfg)
    expect(west.hAt(13, 2)).toBe(1)
    expect(east.hAt(0, 2)).toBe(1)
    expect(north.vAt(3, 13)).toBe(1)
    expect(south.vAt(3, 0)).toBe(1)
  })

  it('places structural columns on one global bay grid, including chunk edge rows', () => {
    const cfg = forcedZone(ZONE_WAREHOUSE)
    cfg.border.stubChance = 0
    cfg.warehouse.fragments.chance = 0
    cfg.warehouse.columns.chance = 1
    cfg.stairs.enabled = false // stair halos delete columns; the bay grid is asserted exactly
    cfg.multilevel.enabled = false // atrium halls likewise clear structural columns
    const { spacing, phaseSalt } = cfg.warehouse.columns
    const seed = 0x51a7
    const px = hash2i((seed ^ phaseSalt) | 0, 0x58, 0) % spacing
    const pz = hash2i((seed ^ phaseSalt) | 0, 0x5a, 0) % spacing
    let edgeColumn = false
    for (let cz = -5; cz <= 5; cz++) {
      for (let cx = -5; cx <= 5; cx++) {
        const data = buildChunk(seed, cx, 0, cz, cfg)
        for (let z = 0; z < CHUNK; z++) {
          for (let x = 0; x < CHUNK; x++) {
            const gx = cx * CHUNK + x
            const gz = cz * CHUNK + z
            const expected = fmod(gx - px, spacing) === 0 && fmod(gz - pz, spacing) === 0
            expect(data.colAt(x, z) === 1).toBe(expected)
            if (expected && (x === 0 || z === 0 || x === CHUNK - 1 || z === CHUNK - 1)) {
              edgeColumn = true
            }
          }
        }
      }
    }
    expect(edgeColumn).toBe(true)
  })
})
