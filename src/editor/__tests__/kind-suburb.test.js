import { describe, expect, it } from 'vitest'
import { CELL, CHUNK } from '../../world/constants.js'
import {
  CELL_OPEN,
  CELL_ROOM,
  COLUMN_FURNITURE,
  COLUMN_NONE,
  SPACE_ROLE_BATHROOM,
  SPACE_ROLE_BEDROOM,
  SPACE_ROLE_DINING,
  SPACE_ROLE_KITCHEN,
  SPACE_ROLE_LAUNDRY,
  SPACE_ROLE_LIVING,
  WALL_RAIL,
  WALL_WINDOW,
} from '../../world/mapTypes.js'
import { PROP_DOGHOUSE, PROP_GNOME, PROP_MAILBOX, PROP_WHEELIE_BIN } from '../../world/props/index.js'
import { EditorMap, seedFromText } from '../EditorMap.js'
import { houseCell, suburbLayout, suburbModelSharing, suburbStreetGraph } from '../kinds/suburb.js'
import { generatePrototype } from '../prototypes.js'
import { DARK_LEVEL, lightField, walkGraph } from '../simulate.js'
import { KIND_SEEDS, expectKindClean, judgeMap } from './kindJudge.js'

// 03 Sleeping Suburb (docs/liminal_maps/03-sleeping-suburb.md): a loop
// collector with cul-de-sacs, lots of mirrored model houses built from
// createRoom rooms, fenced yards, light from the houses.

function build(seed) {
  const map = new EditorMap()
  const res = generatePrototype(map, 'suburb', { seed })
  const layout = suburbLayout(seedFromText(seed))
  return { map, res, layout }
}

const allFurniture = (map) => [...map.chunks.values()].flatMap((d) => d.furniture.map((f) => ({
  ...f, gx: d.cx * CHUNK + f.lx, gz: d.cz * CHUNK + f.lz,
})))

// Seeds where a defect once showed: sweep-3 and sweep-18 (furniture hugging
// an open chunk seam), sweep-10/18/42 (doghouses across a fence gap),
// sweep-0/3/4 (mailboxes behind a picket rail).
const EXTRA_SEEDS = ['sweep-0', 'sweep-3', 'sweep-4', 'sweep-10', 'sweep-18', 'sweep-42']

// Doc 12's street graph, measured on the document: the centrelines of the
// street rows and connector columns wherever their 5-cell cross-section is
// open ground. A stem counts only when it ends in an open cul-de-sac bulb
// (a vacant field has houses across its end). Nodes are the centreline
// cells of degree ≠ 2.
const BULB_X = { W: 1, E: 60 }
function measuredStreetGraph(map, layout) {
  // Unopened plan cells compile to solid columns; props on the ground
  // (wheelie bins at the kerb) leave it street.
  const open = (gx, gz) => {
    const c = map.cellAt(gx, 0, gz)
    return c.kind === CELL_OPEN && (c.col === COLUMN_NONE || c.col === COLUMN_FURNITURE)
  }
  const across = [-2, -1, 0, 1, 2]
  const rows = [...new Set(layout.junctions.map((j) => j.gz))].sort((a, b) => a - b)
  const cols = [...new Set(layout.junctions.map((j) => j.gx))].sort((a, b) => a - b)
  const cells = new Set()
  for (const zc of rows) {
    // The bulb plate's disc (a vacant field's end is not open).
    const bulb = (e) => {
      for (let j = 0; j < 9; j++) {
        for (let i = 0; i < 9; i++) {
          const gz = zc - 4 + j
          if ((i - 4) ** 2 + (j - 4) ** 2 <= 20.25 && gz <= 35 && !open(BULB_X[e] + i, gz)) return false
        }
      }
      return true
    }
    const [west, east] = [bulb('W'), bulb('E')]
    for (let gx = 1; gx <= 68; gx++) {
      if ((gx < cols[0] && !west) || (gx > cols.at(-1) && !east)) continue
      if (across.every((d) => open(gx, zc + d))) cells.add(`${gx},${zc}`)
    }
  }
  for (const xc of cols) {
    for (let gz = rows[0]; gz <= rows[1]; gz++) if (across.every((d) => open(xc + d, gz))) cells.add(`${xc},${gz}`)
  }
  const nodes = []
  for (const k of cells) {
    const [gx, gz] = k.split(',').map(Number)
    const degree = [[0, -1], [-1, 0], [1, 0], [0, 1]].filter(([dx, dz]) => cells.has(`${gx + dx},${gz + dz}`)).length
    if (degree !== 2) nodes.push({ gx, gz, degree })
  }
  const deadEnds = nodes.filter((n) => n.degree <= 1)
  const fourWay = nodes.filter((n) => n.degree >= 4).length
  return { nodes, deadEnds, deadEndShare: deadEnds.length / nodes.length, fourWayShare: fourWay / nodes.length }
}

describe('suburb kind', () => {
  it('builds clean, connected, deterministic maps for every seed', () => {
    expectKindClean(expect, 'suburb')
  })

  it('streets form a dendritic tree: 9×9 cul-de-sac bulbs, dead ends 0.3–0.5, no crossroads', () => {
    for (const seed of KIND_SEEDS) {
      const { map, res, layout } = build(seed)
      // Doc 12: street-graph dead-end share 0.3–0.5, 4-way share ≤ 0.15,
      // measured on the built map; it is the layout's intended graph.
      const g = measuredStreetGraph(map, layout)
      expect(g.deadEndShare, seed).toBeGreaterThanOrEqual(0.3)
      expect(g.deadEndShare, seed).toBeLessThanOrEqual(0.5)
      expect(g.fourWayShare, seed).toBeLessThanOrEqual(0.15)
      const intended = suburbStreetGraph(layout)
      expect(g.nodes.length, seed).toBe(intended.nodes)
      expect(g.deadEnds.length, seed).toBe(intended.deadEnds)
      const junctions = (list) => list.filter((n) => n.degree >= 3).map((n) => `${n.gx},${n.gz}/${n.degree}`).sort()
      expect(junctions(g.nodes), seed).toEqual(junctions(layout.junctions))
      for (const d of g.deadEnds) {
        expect(layout.bulbs.some((b) => d.gz === b.gz && d.gx >= b.x0 && d.gx < b.x0 + 9), `${seed} dead end ${d.gx},${d.gz}`).toBe(true)
      }
      expect(layout.bulbs.length, seed).toBeGreaterThanOrEqual(3)
      // Each bulb's 9-cell street-centre row and 9-cell column are open
      // ground in the document (band D's houses clip the S2 bulbs' last row).
      for (const b of layout.bulbs) {
        for (let i = 0; i < 9; i++) {
          expect(map.cellAt(b.x0 + i, 0, b.gz), `${seed} bulb ${b.end}`).toMatchObject({ kind: CELL_OPEN, col: 0 })
          if (b.z0 + i <= 35) expect(map.cellAt(b.gx, 0, b.z0 + i).kind, `${seed} bulb ${b.end}`).toBe(CELL_OPEN)
        }
      }
      // The spawn stands on a bulb's open ground.
      expect(map.cellAt(res.spawn.gx, 0, res.spawn.gz)).toMatchObject({ kind: CELL_OPEN, col: 0 })
    }
  })

  it('houses repeat 4–6 models, mostly next to their twin, with mirrored identical interiors', () => {
    const roles = new Set()
    for (const seed of KIND_SEEDS) {
      const { map, layout } = build(seed)
      const models = new Set(layout.houses.map((h) => h.model))
      expect(models.size, seed).toBeGreaterThanOrEqual(4)
      expect(models.size, seed).toBeLessThanOrEqual(6)
      // Doc 12: ≥ 0.6 of houses share a model with a neighbour (measured
      // 0.79–0.86 over the default seeds).
      expect(suburbModelSharing(layout), seed).toBeGreaterThanOrEqual(0.6)
      // Every house of a model holds the same furniture in the model's own
      // frame: the twins are reflections of the first one.
      const furniture = new Map(allFurniture(map).map((f) => [`${f.gx},${f.gz}`, f.kind]))
      const sig = new Map()
      for (const h of layout.houses) {
        const cells = []
        for (let v = 0; v < h.model.D; v++) {
          for (let u = 0; u < h.model.W; u++) {
            const c = houseCell(h, u, v)
            cells.push(furniture.get(`${c.gx},${c.gz}`) ?? 0)
          }
        }
        expect(cells.some(Boolean), `${seed} house ${h.index}`).toBe(true)
        const s = cells.join(',')
        if (!sig.has(h.model)) sig.set(h.model, s)
        expect(s, `${seed} house ${h.index} (${h.model.name})`).toBe(sig.get(h.model))
      }
      // Rooms are createRoom records; mirrored houses are mirrored in plan.
      expect(map.rooms.length, seed).toBe(layout.houses.reduce((n, h) => n + h.model.rooms.length, 0))
      for (const room of map.rooms) roles.add(room.role)
      expect(layout.houses.some((h) => h.flipX) && layout.houses.some((h) => !h.flipX), seed).toBe(true)
    }
    for (const role of [SPACE_ROLE_BEDROOM, SPACE_ROLE_BATHROOM, SPACE_ROLE_KITCHEN, SPACE_ROLE_LIVING, SPACE_ROLE_DINING, SPACE_ROLE_LAUNDRY]) {
      expect(roles.has(role), `role ${role}`).toBe(true)
    }
  })

  it('furniture hugs real walls: house pieces, doghouses and mailboxes', () => {
    for (const seed of [...KIND_SEEDS, ...EXTRA_SEEDS]) {
      const { map, layout } = build(seed)
      const inHouse = (gx, gz) => layout.houses.some((h) => gx >= h.hx0 && gx < h.hx0 + h.model.W && gz >= h.hz0 && gz < h.hz0 + h.model.D)
      // An edge a piece leans on is walled, or the cell beyond is taken.
      const shut = (edge, gx, gz) => edge.wall === 1 || map.cellAt(gx, 0, gz).col !== 0
      for (const f of allFurniture(map)) {
        const dx = f.x - (f.lx + 0.5) * CELL
        const dz = f.z - (f.lz + 0.5) * CELL
        const at = `${seed} ${f.kind} @${f.gx},${f.gz}`
        if (f.kind === PROP_MAILBOX) {
          // The picket fence opens in front of the mailbox (facing S 0 / N 1).
          const line = (f.facing & 3) === 0 ? f.gz + 1 : f.gz
          expect(map.wallHAt(f.gx, 0, line).wall, at).toBe(0)
          continue
        }
        if (f.kind !== PROP_DOGHOUSE && !inHouse(f.gx, f.gz)) continue
        // Interiors: a piece pushed off its cell centre leans on a wall,
        // never on open floor (a chunk seam inside a room is not a wall).
        if (f.kind === PROP_DOGHOUSE) expect(Math.abs(dz), at).toBeGreaterThan(0.3)
        if (dx > 0.3) expect(shut(map.wallVAt(f.gx + 1, 0, f.gz), f.gx + 1, f.gz), `${at} E`).toBe(true)
        if (dx < -0.3) expect(shut(map.wallVAt(f.gx, 0, f.gz), f.gx - 1, f.gz), `${at} W`).toBe(true)
        if (dz > 0.3) expect(shut(map.wallHAt(f.gx, 0, f.gz + 1), f.gx, f.gz + 1), `${at} S`).toBe(true)
        if (dz < -0.3) expect(shut(map.wallHAt(f.gx, 0, f.gz), f.gx, f.gz - 1), `${at} N`).toBe(true)
      }
    }
  })

  it('light comes from the houses: dead streetlights, dark exterior, street-facing windows', () => {
    for (const seed of KIND_SEEDS) {
      const { map, layout } = build(seed)
      const { box } = judgeMap(map)
      // Streetlights stand only at junctions and bulbs; 60–80% are dead.
      const poles = [...layout.junctions.filter((j) => j.degree !== 2), ...layout.bulbs]
      const dead = poles.filter((p) => !map.lampAt(p.gx, 0, p.gz).rec.lit).length / poles.length
      expect(dead, seed).toBeGreaterThanOrEqual(0.6)
      expect(dead, seed).toBeLessThanOrEqual(0.8)
      // Doc 12: exterior darkness 0.7–0.9 (lightField's radius-6 estimate,
      // windows and rails let house light out; measured 0.76–0.87).
      const light = lightField(map, box, 0)
      const planar = walkGraph(map, { ...box, y0: 0, y1: 0 }, { vertical: false })
      let outside = 0
      let dark = 0
      for (const [k, n] of planar.nodes) {
        if (map.cellAt(n.gx, 0, n.gz).kind !== CELL_OPEN) continue
        outside++
        if ((light.level.get(k) ?? 0) < DARK_LEVEL) dark++
      }
      expect(dark / outside, seed).toBeGreaterThanOrEqual(0.7)
      expect(dark / outside, seed).toBeLessThanOrEqual(0.9)
      // Some rooms burn behind the windows; every house front has glass.
      const litRooms = [...map.chunks.values()].flatMap((d) => d.lamps.filter((l) => l.lit && d.cellKind[l.lz * CHUNK + l.lx] === CELL_ROOM))
      expect(litRooms.length, seed).toBeGreaterThanOrEqual(8)
      for (const h of layout.houses) {
        const front = []
        for (let u = 0; u < h.model.W; u++) {
          const a = houseCell(h, u, 0)
          const line = h.flipZ ? a.gz + 1 : a.gz
          front.push(map.wallHAt(a.gx, 0, line).feature)
        }
        expect(front.filter((f) => f === WALL_WINDOW).length, `${seed} house ${h.index}`).toBeGreaterThanOrEqual(2)
      }
      // Picket fences are rails; chunks carrying features opt out of the
      // stray-feature audit.
      let rails = 0
      for (const d of map.chunks.values()) {
        const n = d.wallFeatureH.filter((f) => f === WALL_RAIL).length + d.wallFeatureV.filter((f) => f === WALL_RAIL).length
        rails += n
        if (n || d.wallFeatureH.includes(WALL_WINDOW)) expect(d.authoredFeatures).toBe(true)
      }
      expect(rails, seed).toBeGreaterThan(0)
    }
  })

  it('the exit is in the farthest house, every gnome faces it, one house has no front door', () => {
    for (const seed of KIND_SEEDS) {
      const { map, res, layout } = build(seed)
      const exit = map.cellAt(res.exit.gx, 0, res.exit.gz)
      expect(exit, seed).toMatchObject({ kind: CELL_ROOM, col: 0 })
      expect(exit.chunk.exit, seed).toEqual({ lx: map.cellLocal(res.exit.gx), lz: map.cellLocal(res.exit.gz) })
      const porch = layout.exitHouse.outside
      expect(map.lampAt(porch.gx, 0, porch.gz).rec.lit, seed).toBe(true)
      const furniture = allFurniture(map)
      const gnomes = furniture.filter((f) => f.kind === PROP_GNOME)
      expect(gnomes.length, seed).toBeGreaterThan(0)
      for (const g of gnomes) {
        const dx = porch.gx - g.gx
        const dz = porch.gz - g.gz
        // FACING S 0 (+z), N 1, E 2 (+x), W 3: the gnome's dominant axis.
        const want = Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 2 : 3) : dz > 0 ? 0 : 1
        expect(g.facing, `${seed} gnome ${g.gx},${g.gz}`).toBe(want)
      }
      expect(furniture.filter((f) => f.kind === PROP_MAILBOX).length, seed).toBeGreaterThanOrEqual(layout.houses.length / 2)
      expect(furniture.some((f) => f.kind === PROP_WHEELIE_BIN), seed).toBe(true)
      // Doc 10.7: the doorless house's front wall is solid where its path ends.
      const nd = layout.noFrontDoor
      const line = nd.flipZ ? nd.frontDoor.gz + 1 : nd.frontDoor.gz
      expect(map.wallHAt(nd.frontDoor.gx, 0, line).wall, seed).toBe(1)
    }
  })
})
