import { CHUNK, cIdx } from '../world/constants.js'
import { CELL_ROOM } from '../world/mapTypes.js'
import { hash3i } from '../world/core/hash.js'
import { darknessClustering, lightField, walkGraph } from './simulate.js'

// Lighting lab: re-assign lamp failures by CIRCUIT instead of per fixture,
// keeping the floor's dead-lamp budget, so darkness forms zones (a dark
// wing, a failed bank of a corridor) instead of speckle. Research basis:
// lighting was the one significant predictor of uncanniness in built
// environments, and people follow light (docs/liminal-horror-design.md,
// 2026-09 update). This operates on an editor document as a measurable
// proposal for lamps.js — the generator is unchanged.
//
// Circuits, by grain:
//   'circuit'  every named room's fixtures form one circuit; circulation
//              fixtures chain along rows (same gz, gaps of at most `gap`
//              cells), remaining singles chain along columns;
//   'zone'     a breaker panel feeds every fixture of a 7×7-cell zone, so a
//              failure darkens a whole block of rooms and corridor.

export const RELIGHT_GRAINS = Object.freeze(['circuit', 'zone'])
const ZONE_CELLS = 7

export function lampCircuits(map, cy, { gap = 5, grain = 'circuit' } = {}) {
  const lamps = []
  for (const d of map.chunks.values()) {
    if (d.cy !== cy) continue
    for (const l of d.lamps) {
      const i = cIdx(l.lx, l.lz)
      lamps.push({
        gx: d.cx * CHUNK + l.lx,
        gz: d.cz * CHUNK + l.lz,
        room: d.cellKind[i] === CELL_ROOM ? d.spaceId[i] : 0,
        lit: l.lit,
      })
    }
  }
  const circuits = new Map()
  const add = (key, lamp) => {
    let c = circuits.get(key)
    if (!c) circuits.set(key, (c = []))
    c.push(lamp)
  }
  if (grain === 'zone') {
    for (const l of lamps) add(`zone:${Math.floor(l.gx / ZONE_CELLS)},${Math.floor(l.gz / ZONE_CELLS)}`, l)
    return { lamps, circuits: [...circuits.entries()].map(([key, members]) => ({ key, members })) }
  }
  const loose = []
  for (const l of lamps) {
    if (l.room) add(`room:${l.room}`, l)
    else loose.push(l)
  }
  const chain = (list, axis) => {
    const along = axis === 'row' ? 'gx' : 'gz'
    const across = axis === 'row' ? 'gz' : 'gx'
    const groups = new Map()
    for (const l of list) {
      let g = groups.get(l[across])
      if (!g) groups.set(l[across], (g = []))
      g.push(l)
    }
    const singles = []
    for (const [line, g] of groups) {
      g.sort((a, b) => a[along] - b[along])
      let run = [g[0]]
      const flush = () => {
        if (run.length > 1) run.forEach((l) => add(`${axis}:${line}:${run[0][along]}`, l))
        else singles.push(run[0])
      }
      for (let i = 1; i < g.length; i++) {
        if (g[i][along] - g[i - 1][along] <= gap) run.push(g[i])
        else {
          flush()
          run = [g[i]]
        }
      }
      flush()
    }
    return singles
  }
  const leftover = chain(chain(loose, 'row'), 'col')
  for (const l of leftover) add(`single:${l.gx},${l.gz}`, l)
  return { lamps, circuits: [...circuits.entries()].map(([key, members]) => ({ key, members })) }
}

function measure(map, box, cy) {
  const light = lightField(map, box, cy)
  const planar = walkGraph(map, { ...box, y0: cy, y1: cy }, { vertical: false })
  return {
    darkness: light.darkness,
    clustering: darknessClustering(planar, light.level),
    lit: light.litLamps,
    dead: light.deadLamps,
  }
}

// Apply circuit failures to one floor of the document (undoable). The dead
// budget is the floor's current number of dead fixtures; `residue` of it
// stays as independent single failures (a lone bad tube still happens).
export function relightByCircuits(map, cy, { seed = 1, residue = 0.1, grain = 'circuit' } = {}) {
  const b = map.bounds()
  if (!b) return null
  const box = { x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, y0: cy, y1: cy }
  const before = measure(map, box, cy)
  const { lamps, circuits } = lampCircuits(map, cy, { grain })
  const budget = lamps.filter((l) => !l.lit).length
  if (!lamps.length) return { before, after: before, circuits: 0, failed: 0 }
  const order = circuits
    .map((c, i) => ({ ...c, rank: hash3i(seed | 0, i, c.members.length, cy) >>> 0 }))
    .sort((a, b) => a.rank - b.rank)
  const dead = new Set()
  const circuitBudget = Math.round(budget * (1 - residue))
  let failed = 0
  for (const c of order) {
    if (dead.size >= circuitBudget) break
    // Skip a bank that would overshoot the budget by more than its half.
    if (dead.size + c.members.length > circuitBudget + c.members.length / 2 && c.members.length > 2) continue
    c.members.forEach((l) => dead.add(`${l.gx},${l.gz}`))
    failed++
  }
  const singles = lamps
    .filter((l) => !dead.has(`${l.gx},${l.gz}`))
    .map((l) => ({ l, rank: hash3i((seed ^ 0x51d) | 0, l.gx, l.gz, cy) >>> 0 }))
    .sort((a, b) => a.rank - b.rank)
  for (const { l } of singles) {
    if (dead.size >= budget) break
    dead.add(`${l.gx},${l.gz}`)
  }
  map.mutate(() => {
    for (const l of lamps) map.setLamp(l.gx, cy, l.gz, !dead.has(`${l.gx},${l.gz}`))
  })
  const after = measure(map, box, cy)
  return { before, after, circuits: circuits.length, failed, budget }
}
