import { describe, expect, it } from 'vitest'
import {
  CELL_ATRIUM,
  CELL_ROOM,
  CELL_VOID,
  PASSAGE_DOOR,
  SPACE_ROLE_LIVING,
  WALL_RAIL,
  WALL_WINDOW,
} from '../../world/mapTypes.js'
import { PROP_HALL_CLOCK, PROP_RADIO } from '../../world/props/index.js'
import { EditorMap } from '../EditorMap.js'
import { HOUSE_LAYOUT as H } from '../kinds/house.js'
import { generatePrototype } from '../prototypes.js'
import { isovist, walkGraph } from '../simulate.js'
import { KIND_SEEDS, expectKindClean } from './kindJudge.js'

// House larger inside (docs/liminal_maps/05-house-larger-inside.md): the
// kind-lab contract over the default seeds, then the doc's signature claims
// that a Euclidean prototype can carry.

const build = (seed) => {
  const map = new EditorMap()
  const res = generatePrototype(map, 'house', { seed })
  return { map, res }
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const inRect = (r, gx, gz) => gx >= r.x0 && gx <= r.x1 && gz >= r.z0 && gz <= r.z1

describe('house kind', () => {
  it('builds clean, connected, deterministic storeys for every seed', () => {
    expectKindClean(expect, 'house')
  }, 180_000)

  it('is larger inside than the shell you can see from the yard', () => {
    for (const seed of ['proto', 'liminal-3']) {
      const { map, res } = build(seed)
      expect(inRect(H.yard, res.spawn.gx, res.spawn.gz)).toBe(true)
      // The yard meets the house only through its façade: one door, one
      // window per front room and a sidelight; every other yard edge is hedge.
      const facade = []
      for (let gx = H.yard.x0; gx <= H.yard.x1; gx++) {
        const e = map.wallHAt(gx, 0, H.yard.z0)
        if (gx < H.shell.x0 || gx > H.shell.x1) expect(e.wall, `yard north ${gx}`).toBe(1)
        else facade.push(e.wall ? (e.feature === WALL_WINDOW ? 'window' : 'wall') : e.passage === PASSAGE_DOOR ? 'door' : 'open')
        expect(map.wallHAt(gx, 0, H.yard.z1 + 1).wall).toBe(1)
      }
      for (let gz = H.yard.z0; gz <= H.yard.z1; gz++) {
        expect(map.wallVAt(H.yard.x0, 0, gz).wall).toBe(1)
        expect(map.wallVAt(H.yard.x1 + 1, 0, gz).wall).toBe(1)
      }
      expect(facade.filter((f) => f === 'door')).toHaveLength(1)
      expect(facade.filter((f) => f === 'window')).toHaveLength(3)
      expect(facade.filter((f) => f === 'open')).toHaveLength(0)
      // Nothing stands above the shell: the upper storeys lie elsewhere.
      for (let cy = 1; cy < H.floors; cy++) {
        expect(map.chunkAt(map.cellChunk(H.shell.x0), cy, map.cellChunk(H.shell.z0))).toBeNull()
      }
      // Interior/exterior area: doc §12 asks ≥ 3 by depth 8; the whole
      // interior measures ~12× the shell footprint.
      const b = map.bounds()
      let inside = 0
      for (let cy = 0; cy < H.floors; cy++) {
        for (const n of walkGraph(map, { ...b, y0: cy, y1: cy }, { vertical: false }).nodes.values()) {
          if (cy > 0 || (!inRect(H.yard, n.gx, n.gz) && !inRect(H.shell, n.gx, n.gz))) inside++
        }
      }
      const shellArea = (H.shell.x1 - H.shell.x0 + 1) * (H.shell.z1 - H.shell.z0 + 1)
      expect(inside / shellArea, seed).toBeGreaterThan(8)
    }
  }, 60_000)

  it('keeps the rooms close and opens the Great Hall wide (isovist bands)', () => {
    const { map } = build('proto')
    const rooms = []
    for (const rm of map.rooms) {
      for (let gz = rm.z0; gz <= rm.z1; gz++) {
        for (let gx = rm.x0; gx <= rm.x1; gx++) {
          if (!map.cellAt(gx, rm.cy, gz).col) rooms.push(isovist(map, rm.cy, gx, gz, { rays: 48 }).area)
        }
      }
    }
    const hall = []
    for (let gz = H.hall.z0; gz <= H.hall.z1; gz += 3) {
      for (let gx = H.hall.x0; gx <= H.hall.x1; gx += 3) hall.push(isovist(map, 0, gx, gz, { rays: 48 }).area)
    }
    // Doc §12: 3–6 cells in rooms, ≥ 30 in the Great Hall. The rooms here
    // are 3×2 / 3×3 (the furnishing grammar needs three free cells) and see
    // out through their doorway: ~11 cells. The hall's ~145 is its whole floor.
    expect(median(rooms)).toBeGreaterThan(6)
    expect(median(rooms)).toBeLessThan(16)
    expect(median(hall)).toBeGreaterThan(100)
  }, 60_000)

  it('repeats one L-hallway four times round the loop, one copy mutated', () => {
    const { x: LX, z: LZ } = H.loopLine
    const cell = (q, gx, gz) => ({ gx: q & 1 ? 2 * LX - 1 - gx : gx, gz: q & 2 ? 2 * LZ - 1 - gz : gz })
    const lineV = (q, gx) => (q & 1 ? 2 * LX - gx : gx)
    // Facing back into the NW frame: S/N swap across z, E/W across x.
    const unflip = (q, f) => {
      let out = f
      if (q & 2) out = [1, 0, 2, 3][out]
      if (q & 1) out = [0, 1, 3, 2][out]
      return out
    }
    const anomalies = new Set()
    for (const seed of KIND_SEEDS) {
      const { map, res } = build(seed)
      const signature = (q) => {
        const elbow = cell(q, 16, 15)
        const alcove = cell(q, 18, 14)
        const closet = cell(q, 15, 18)
        const inner = cell(q, 17, 17)
        const lamp = map.lampAt(elbow.gx, 0, elbow.gz)?.rec
        const clock = map.furnitureAt(alcove.gx, 0, alcove.gz)?.rec
        const door = map.wallVAt(lineV(q, 16), 0, closet.gz)
        return JSON.stringify({
          lamp: lamp ? [lamp.lit, lamp.tint ?? null] : null,
          clock: clock ? [clock.kind, unflip(q, clock.facing)] : null,
          closet: [map.cellAt(closet.gx, 0, closet.gz).kind, door.wall, door.passage],
          inner: map.cellAt(inner.gx, 0, inner.gz).kind === CELL_ROOM,
        })
      }
      const sigs = [0, 1, 2, 3].map(signature)
      expect(JSON.parse(sigs[0]).clock[0], seed).toBe(PROP_HALL_CLOCK)
      const odd = [1, 2, 3].filter((q) => sigs[q] !== sigs[0])
      expect(odd, `${seed}: ${sigs.join(' ')}`).toHaveLength(1)
      const note = res.notes.find((n) => n.startsWith('loop:'))
      const [, name, anomaly] = note.match(/the (\w+) copy is mutated \((\w+)\)/)
      expect(H.loopQuadrants[odd[0]], seed).toBe(name)
      anomalies.add(anomaly)
    }
    expect(anomalies.size).toBeGreaterThanOrEqual(3)
  }, 60_000)

  it('stacks a dark 3-storey Great Hall with a door onto its rail, and furnishes the house', () => {
    for (const seed of ['proto', 'liminal-6']) {
      const { map } = build(seed)
      for (let cy = 0; cy < H.floors; cy++) {
        for (let gz = H.ring.z0; gz <= H.ring.z1; gz++) {
          for (let gx = H.ring.x0; gx <= H.ring.x1; gx++) {
            expect(map.lampAt(gx, cy, gz), `lamp ${cy}:${gx},${gz}`).toBeNull()
            expect(map.furnitureAt(gx, cy, gz)).toBeNull()
            if (inRect(H.hall, gx, gz)) expect(map.cellAt(gx, cy, gz).kind).toBe(cy === 0 ? CELL_ATRIUM : CELL_VOID)
          }
        }
      }
      // Winchester: the top-floor anteroom door opens one step from the rail.
      const top = H.floors - 1
      const door = map.wallVAt(H.ring.x0, top, H.overlook)
      expect([door.wall, door.passage]).toEqual([0, PASSAGE_DOOR])
      expect(map.wallVAt(H.hall.x0, top, H.overlook).feature).toBe(WALL_RAIL)
      expect(inRect(H.anteroom, H.ring.x0 - 1, H.overlook)).toBe(true)
      // The upstairs landing corridor ends at a window into the void.
      expect(map.wallVAt(H.hall.x0, 1, 5).feature).toBe(WALL_WINDOW)

      // Props: the clock in the shell hall (and every L), the radio in the
      // living room; the guest room's copy carries its furniture exactly.
      const hallClock = map.furnitureAt(6, 0, H.shell.z0)?.rec
      expect(hallClock?.kind).toBe(PROP_HALL_CLOCK)
      const living = map.rooms.find((rm) => rm.role === SPACE_ROLE_LIVING)
      const radios = []
      for (let gz = living.z0; gz <= living.z1; gz++) {
        for (let gx = living.x0; gx <= living.x1; gx++) if (map.furnitureAt(gx, 0, gz)?.rec.kind === PROP_RADIO) radios.push(gx)
      }
      expect(radios, seed).toHaveLength(1)
      const twin = map.rooms.at(-1)
      const src = map.rooms.find((rm) => rm.cy === twin.cy && rm.x0 === twin.x0 - H.copyDx && rm.z0 === twin.z0)
      const piecesOf = (rm, dx) => {
        const out = []
        for (let gz = rm.z0; gz <= rm.z1; gz++) {
          for (let gx = rm.x0; gx <= rm.x1; gx++) {
            const f = map.furnitureAt(gx, rm.cy, gz)?.rec
            if (f) out.push([gx - dx, gz, f.kind, f.facing, f.w, f.d])
          }
        }
        return out
      }
      expect(piecesOf(src, 0).length).toBeGreaterThanOrEqual(3)
      expect(piecesOf(twin, H.copyDx)).toEqual(piecesOf(src, 0))
    }
  }, 60_000)
})
