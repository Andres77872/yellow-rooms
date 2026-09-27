import { describe, expect, it } from 'vitest'
import { CHUNK, ZONE_OFFICE } from '../constants.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { worldConfigForFamily } from '../mapFamily.js'
import {
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_ROOM,
  PASSAGE_DOOR,
  PASSAGE_WALL,
} from '../mapTypes.js'
import { buildChunk, layerSeed } from '../pipeline.js'
import { auditLayeredPatch } from '../audit.js'
import {
  buildOfficeDistrictPlan,
  clearOfficePlanCache,
} from '../zones/officePlan.js'

function hotelConfig({ reservations = true, mixed = false } = {}) {
  const config = worldConfigForFamily('hotel', DEFAULT_WORLD_CONFIG)
  if (!mixed) config.zoneBands = [{ id: ZONE_OFFICE, max: 1.01 }]
  if (!reservations) {
    config.stairs.chance = 0
    config.multilevel.enabled = false
  }
  config.furniture.enabled = false
  return config
}

const circulation = (kind) => kind === CELL_CORRIDOR || kind === CELL_LOBBY

function reachable(plan, start, onlyCirculation = false, ignoreWalls = false) {
  const seen = new Set([start])
  const queue = [start]
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]
    const x = i % plan.size
    const z = Math.floor(i / plan.size)
    const neighbours = [
      [x - 1, z, plan.vAt(x, z)],
      [x + 1, z, x + 1 < plan.size ? plan.vAt(x + 1, z) : 1],
      [x, z - 1, plan.hAt(x, z)],
      [x, z + 1, z + 1 < plan.size ? plan.hAt(x, z + 1) : 1],
    ]
    for (const [nx, nz, wall] of neighbours) {
      if (nx < 0 || nz < 0 || nx >= plan.size || nz >= plan.size || (wall && !ignoreWalls)) continue
      const next = nz * plan.size + nx
      if (seen.has(next) || !plan.active[next]) continue
      if (onlyCirculation && !circulation(plan.cellKind[next])) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return seen
}

describe('hotel architectural grammar', () => {
  it('creates guest wings, direct suite entrances, and an empty public hall in the collision plan', () => {
    const config = hotelConfig({ reservations: false })
    const plan = buildOfficeDistrictPlan(777, 0, 0, config)
    const wings = plan.architecture.filter((item) => item.kind === 'hotel-guest-wing')
    expect(wings.length).toBeGreaterThanOrEqual(3)
    for (const wing of wings) {
      expect(wing.cells.length).toBe(plan.size)
      for (const i of wing.cells) expect(circulation(plan.cellKind[i])).toBe(true)
      // There are rooms on both sides along most of the run, with real
      // closed partitions interrupted by repeated suite entrance doors.
      let doubleLoaded = 0
      let doors = 0
      for (const i of wing.cells) {
        const x = i % plan.size
        const z = Math.floor(i / plan.size)
        const step = wing.axis === 'x' ? plan.size : 1
        if (plan.cellKind[i - step] === CELL_ROOM && plan.cellKind[i + step] === CELL_ROOM) doubleLoaded++
        if (wing.axis === 'x') {
          doors += Number(plan.passageHAt(x, z) === PASSAGE_DOOR)
          doors += Number(plan.passageHAt(x, z + 1) === PASSAGE_DOOR)
        } else {
          doors += Number(plan.passageVAt(x, z) === PASSAGE_DOOR)
          doors += Number(plan.passageVAt(x + 1, z) === PASSAGE_DOOR)
        }
      }
      expect(doubleLoaded).toBeGreaterThan(plan.size * 0.5)
      expect(doors).toBeGreaterThanOrEqual(5)
    }
    const hall = plan.architecture.find((item) => item.kind === 'hotel-reception-hall')
    expect(hall.cells.length).toBe(35)
    for (const i of hall.cells) {
      expect(plan.cellKind[i]).toBe(CELL_LOBBY)
      expect(plan.roleGrid[i]).toBe(0)
      const x = i % plan.size
      const z = Math.floor(i / plan.size)
      if (x > hall.bounds.x0) expect(plan.passageVAt(x, z)).not.toBe(PASSAGE_WALL)
      if (z > hall.bounds.z0) expect(plan.passageHAt(x, z)).not.toBe(PASSAGE_WALL)
    }
    expect(plan.metrics.maxRoomDepth).toBe(1)
    expect(plan.metrics.rooms).toBeGreaterThan(40)
    expect(reachable(plan, 0).size).toBe(plan.active.length)
    const first = plan.cellKind.findIndex(circulation)
    expect(reachable(plan, first, true).size).toBe(plan.cellKind.filter(circulation).length)
  })

  it('changes floor topology from office even with every object and vertical structure disabled', () => {
    const hotel = hotelConfig({ reservations: false })
    const office = worldConfigForFamily('office', hotel)
    const hp = buildOfficeDistrictPlan(42, -1, 2, hotel)
    const op = buildOfficeDistrictPlan(42, -1, 2, office)
    expect(hp.cellKind).not.toEqual(op.cellKind)
    expect(hp.wallV).not.toEqual(op.wallV)
    expect(hp.wallH).not.toEqual(op.wallH)
    const h = buildChunk(42, -2, 0, 6, hotel)
    const o = buildChunk(42, -2, 0, 6, office)
    expect(h.wallV).not.toEqual(o.wallV)
    expect(h.wallH).not.toEqual(o.wallH)
    expect(h.furniture).toHaveLength(0)
    expect(o.furniture).toHaveLength(0)
  })

  it('varies the wing axis, circulation pattern, and bay sizes deterministically across districts', () => {
    const config = hotelConfig({ reservations: false })
    const variants = new Set()
    const axes = new Set()
    const roomShapes = new Set()
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 42, 777, 4242, 0xc0ffee]) {
      const plan = buildOfficeDistrictPlan(seed, -2, 1, config)
      for (const item of plan.architecture) {
        axes.add(item.axis)
        variants.add(item.variant)
      }
      for (const room of plan.spaces.filter((space) => space.type === 'room')) {
        roomShapes.add(`${room.x1 - room.x0 + 1},${room.z1 - room.z0 + 1}`)
      }
    }
    expect(axes.size).toBe(2)
    expect(variants.size).toBe(3)
    expect(roomShapes.size).toBeGreaterThan(8)
    const first = buildOfficeDistrictPlan(4242, -2, 1, config)
    clearOfficePlanCache(config)
    expect(buildOfficeDistrictPlan(4242, -2, 1, config)).toEqual(first)
    first.architecture[0].cells[0] = -999
    first.architecture[0].bounds.x0 = -999
    const again = buildOfficeDistrictPlan(4242, -2, 1, config)
    expect(again.architecture[0].cells[0]).not.toBe(-999)
    expect(again.architecture[0].bounds.x0).not.toBe(-999)
  })

  it('keeps canonical stairs, galleries, bridges, and portals routed across mixed-zone and negative districts', () => {
    const config = hotelConfig({ mixed: true })
    let stairs = 0
    let galleries = 0
    let portals = 0
    for (const seed of [1, 42, 777, 0xc0ffee]) {
      for (const cy of [-1, 0, 2]) {
        for (const [dx, dz] of [[0, 0], [-1, -1], [1, -2]]) {
          const lseed = layerSeed(seed, cy)
          const plan = buildOfficeDistrictPlan(lseed, dx, dz, config, { rootSeed: seed, cy })
          expect(plan.metrics.invalidRooms).toBe(0)
          expect(plan.metrics.unsupportedDoors).toBe(0)
          expect(plan.metrics.unroutedStairs).toBe(0)
          expect(plan.metrics.unroutedMultilevel).toBe(0)
          expect(plan.metrics.portalMisses).toBe(0)
          for (const lobby of [...plan.stairLobbies, ...plan.multilevelLobbies]) {
            for (const i of lobby.cells) expect(circulation(plan.cellKind[i])).toBe(true)
          }
          // A mixed district may have multiple physically separate active
          // islands. Each must be fully connected through actual passages,
          // including a connected circulation subgraph on that island.
          const checked = new Set()
          for (let i = 0; i < plan.active.length; i++) {
            if (!plan.active[i] || checked.has(i)) continue
            const island = reachable(plan, i, false, true)
            expect(reachable(plan, i).size).toBe(island.size)
            const hall = [...island].filter((cell) => circulation(plan.cellKind[cell]))
            expect(hall.length).toBeGreaterThan(0)
            expect(reachable(plan, hall[0], true).size).toBe(hall.length)
            for (const cell of island) checked.add(cell)
          }
          stairs += plan.stairLobbies.length
          galleries += plan.multilevelLobbies.length
          portals += plan.portals.length
        }
      }
    }
    expect(stairs).toBeGreaterThan(20)
    expect(galleries).toBeGreaterThan(5)
    expect(portals).toBeGreaterThan(20)
  })

  it('uses the same hotel district across chunk streaming order and signed coordinates', () => {
    const config = hotelConfig()
    const coords = [[-3, -3], [-2, -3], [-3, -2], [-2, -2]]
    const first = coords.map(([cx, cz]) => buildChunk(777, cx, 0, cz, config))
    clearOfficePlanCache(config)
    const second = coords.slice().reverse().map(([cx, cz]) => buildChunk(777, cx, 0, cz, config)).reverse()
    for (let n = 0; n < first.length; n++) {
      expect(second[n].wallV).toEqual(first[n].wallV)
      expect(second[n].wallH).toEqual(first[n].wallH)
      expect(second[n].spaceId).toEqual(first[n].spaceId)
      expect(second[n].cellKind.length).toBe(CHUNK * CHUNK)
    }
  })

  it('keeps furnished hotel floors physically connected after all stair and atrium stamps', () => {
    const config = worldConfigForFamily('hotel', DEFAULT_WORLD_CONFIG)
    for (const seed of [42, 777]) {
      const chunks = new Map()
      for (let cy = -1; cy < 3; cy++) {
        for (let cz = -2; cz < 3; cz++) {
          for (let cx = -2; cx < 3; cx++) {
            chunks.set(`${cx},${cy},${cz}`, buildChunk(seed, cx, cy, cz, config))
          }
        }
      }
      const audit = auditLayeredPatch(
        (cx, cy, cz) => chunks.get(`${cx},${cy},${cz}`), -2, -1, -2, 5, 4, 5
      )
      expect(audit.stairs).toBeGreaterThan(0)
      expect(audit.multilevelRooms).toBeGreaterThan(0)
      expect(audit.components).toBe(1)
      expect(audit.disconnectedCells).toBe(0)
      expect(audit.ok, JSON.stringify(audit.details)).toBe(true)
    }
  })
})
