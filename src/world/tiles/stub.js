import { CHUNK } from '../constants.js'
import { CELL_CORRIDOR, PASSAGE_OPEN } from '../mapTypes.js'
import { FloorPlan } from './floorPlan.js'
import { markExit, markSpawn } from './kit.js'
import { STUB_EXIT_ANCHOR, STUB_PORT_A0, STUB_PORT_A1, stubGeometry } from './stubPlanner.js'

// The stub world's generator and hooks (spec §12.0). Every liminal family
// starts on these until its agent ports the kind body (Phase P/B), so the
// registration lists import real files from day one and the framework
// (bake, cache, seams, spawn/exit hooks, reachability) runs end to end.
//
// IMPORT RULE (§3.1, §7.5): this module imports the floor-plan compiler and
// the kit, so it must NEVER be imported from any <id>/structures.js or
// <id>/geometry.js (the planner chain contract.js reaches). generator.js and
// hooks.js may import it. The pure geometry lives in stubPlanner.js.

// One room per tile over local cells 1..12 × 1..12, ports at 6..7 on all
// four sides, one lit lamp at (7,7).
export const STUB_ROOM = Object.freeze({ x0: 1, z0: 1, x1: CHUNK - 2, z1: CHUNK - 2 })
export const STUB_LAMP = Object.freeze({ gx: 7, gz: 7 })
// Spawn of the stub world: chunk (0,0) on storey 0, cell (6,6) (§8.1 shape).
export const STUB_SPAWN = Object.freeze({ cx: 0, cz: 0, lx: 6, lz: 6, yaw: null })
// Exit bounds of the stub world (§8.2): the exit chunk is 5..7 chunks from
// spawn, on storey 0.
export const STUB_EXIT_BOUNDS = Object.freeze({ minChunks: 5, maxChunks: 7, cy: Object.freeze([0, 0]) })

// Local space ids of the stub tile (all ≤ LOCAL_SPACE_MASK; the bake remaps
// them with spaceIdOf, §6.2/§6.6): the room, then the four port stubs.
const ROOM_ID = 1
const PORT_ID = Object.freeze({ west: 2, north: 3, east: 4, south: 5 })

// The stub tile program: build<Id>Tile(canvas, seed, ctx) for the stub world.
// Draws storey 0 of the tile (local chunk 0,0) when it lies in [ctx.cy0,
// ctx.cy1], records the spawn/exit cells through the kit markers (tile mode:
// ctx.spawns / ctx.exits, GLOBAL cells) and returns {} (no error).
export function buildStubTile(canvas, seed, ctx = {}) {
  const o = canvas.origin ?? { cx: 0, cy: 0, cz: 0 }
  const cy0 = ctx.cy0 ?? o.cy
  const cy1 = ctx.cy1 ?? o.cy
  if (cy0 > 0 || cy1 < 0) return {}
  const cy = 0 - o.cy // storey 0, kind-local
  const last = CHUNK - 1

  const plan = new FloorPlan({ x0: 0, z0: 0, x1: last, z1: last })
  const doors = []
  for (let a = STUB_PORT_A0; a <= STUB_PORT_A1; a++) {
    // Port stubs from the room wall to the tile edge, on all four sides.
    plan.open(0, a, CELL_CORRIDOR, PORT_ID.west)
    plan.open(a, 0, CELL_CORRIDOR, PORT_ID.north)
    plan.open(last, a, CELL_CORRIDOR, PORT_ID.east)
    plan.open(a, last, CELL_CORRIDOR, PORT_ID.south)
    doors.push(
      { axis: 'v', gx: STUB_ROOM.x0, gz: a },
      { axis: 'h', gx: a, gz: STUB_ROOM.z0 },
      { axis: 'v', gx: STUB_ROOM.x1 + 1, gz: a },
      { axis: 'h', gx: a, gz: STUB_ROOM.z1 + 1 },
    )
  }
  plan.room(STUB_ROOM, { spaceId: ROOM_ID, doors }) // door edges default to PASSAGE_DOOR
  // The owned West (lx = 0) and North (lz = 0) lines stay open at the ports
  // (§6.8 rule 3); the east/south lines belong to the neighbour tile.
  for (let a = STUB_PORT_A0; a <= STUB_PORT_A1; a++) {
    plan.edge('v', 0, a, 0, PASSAGE_OPEN)
    plan.edge('h', a, 0, 0, PASSAGE_OPEN)
  }
  plan.lamp(STUB_LAMP.gx, STUB_LAMP.gz, true, ctx.record?.lampTint ?? null)
  plan.compile(canvas, cy)

  const key = ctx.key ?? { tx: o.cx, tz: o.cz }
  if (key.tx === STUB_SPAWN.cx && key.tz === STUB_SPAWN.cz) {
    markSpawn(canvas, ctx, { gx: STUB_SPAWN.lx, gz: STUB_SPAWN.lz, cy })
  }
  const anchor = ctx.anchor
  if (anchor && anchor.cy === 0 && anchor.cx === o.cx && anchor.cz === o.cz) {
    markExit(canvas, ctx, { gx: anchor.lx, gz: anchor.lz, cy })
  }
  return {}
}

// Generator object of a stub family (§6.5 shape, stub: true).
//   stubGenerator(id, geometry = stubGeometry()) → frozen
//   { family, ready, stub, tile, footprint, ports, exitAnchor, paramsFor(ctx), bake(canvas, ctx) }
// `geometry` is the family's own geometry.js exports ({TILE, footprint,
// ports, exitAnchor}) so the generator re-exports exactly what the planner
// chain sees.
export function stubGenerator(id, geometry = stubGeometry()) {
  return Object.freeze({
    family: id,
    ready: true,
    stub: true,
    tile: geometry.TILE,
    footprint: geometry.footprint,
    ports: geometry.ports,
    exitAnchor: geometry.exitAnchor,
    paramsFor() {
      return {}
    },
    bake(canvas, ctx) {
      return buildStubTile(canvas, ctx.tileSeed, ctx)
    },
  })
}

// Hooks of a stub family (§8.1/§8.2 shapes).
//   stubHooks(id, { exitAnchor } = stubGeometry()) → frozen
//   { family, stub, spawn(args), exit(args), exitBounds, proofBox(anchor, spawn), exitAnchor }
// spawn → {cx, cz, lx, lz, yaw} on storey 0 (never a storey, I7);
// exit  → {cx, cy, cz, lx, lz}, the pure anchor (the stub never throws).
export function stubHooks(id, { exitAnchor = stubGeometry().exitAnchor } = {}) {
  return Object.freeze({
    family: id,
    stub: true,
    exitAnchor,
    spawn() {
      return { ...STUB_SPAWN }
    },
    exit({ worldSeed = 0, profile = null } = {}) {
      const a = exitAnchor(worldSeed >>> 0, profile) ?? STUB_EXIT_ANCHOR
      return { cx: a.cx, cy: a.cy, cz: a.cz, lx: a.lx, lz: a.lz }
    },
    exitBounds: STUB_EXIT_BOUNDS,
    proofBox(anchor = STUB_EXIT_ANCHOR, spawn = STUB_SPAWN) {
      return {
        chunks: {
          x0: Math.min(anchor.cx, spawn.cx) - 1,
          z0: Math.min(anchor.cz, spawn.cz) - 1,
          x1: Math.max(anchor.cx, spawn.cx) + 1,
          z1: Math.max(anchor.cz, spawn.cz) + 1,
        },
        cy: [0, 0],
      }
    },
  })
}
