import { CHUNK, ZONE_OFFICE, ZONE_PILLARS, ZONE_SEWER, ZONE_WAREHOUSE, cIdx } from '../world/constants.js'
import {
  PASSAGE_DOOR,
  PASSAGE_OPEN,
  PASSAGE_WALL,
  PASSAGE_WIDE,
  WALL_PLAIN,
  WALL_RAIL,
  WALL_WINDOW,
} from '../world/mapTypes.js'
import { describeCell, roomRoleLabel } from '../debug/mapInspect.js'
import { structureAdapterFor, structureKind, validateLethalVoidHalf } from '../world/structures/contract.js'
import { STAIR_DOWN_EXIT, STAIR_DOWN_RUN, STAIR_UP_LANDING, STAIR_UP_RUN, holeMasks } from './holeMasks.js'

// The editor's debugger view of one cell: everything the generator wrote
// there and everything that reads it — rasters, the four edges, derived slab
// openings and why, stairs, structure slices, lethal halves, lamps and
// furniture — plus the chunk it lives in. Pure; the panel renders `lines`.

export const ZONE_NAMES = {
  [ZONE_OFFICE]: 'office',
  [ZONE_PILLARS]: 'pillar hall',
  [ZONE_WAREHOUSE]: 'warehouse',
  [ZONE_SEWER]: 'sewer',
}

const PASSAGE_NAMES = {
  [PASSAGE_WALL]: 'wall',
  [PASSAGE_OPEN]: 'open',
  [PASSAGE_DOOR]: 'door',
  [PASSAGE_WIDE]: 'wide',
}
const FEATURE_NAMES = { [WALL_PLAIN]: '', [WALL_WINDOW]: ' window', [WALL_RAIL]: ' rail' }
const DIR_NAMES = ['N', 'E', 'S', 'W']

function edgeText(e) {
  if (e.wall) return `wall${FEATURE_NAMES[e.feature] ?? ''}`
  return PASSAGE_NAMES[e.passage] ?? `passage ${e.passage}`
}

const cellText = (c) => (c ? `${c.lx},${c.lz}` : '—')

function stairText(s) {
  if (!s) return null
  return `dir ${DIR_NAMES[s.dir] ?? s.dir} · landing ${cellText(s.landing)} · run ${s.run?.map(cellText).join(' ')} · exit ${cellText(s.exit)}`
}

function sliceText(slice) {
  if (!slice) return null
  const b = slice.localBounds ?? slice.bounds
  const bridge = slice.globalBridgeLine === null || slice.globalBridgeLine === undefined
    ? 'no deck'
    : `deck ${slice.bridgeAxis === 'x' ? 'gz' : 'gx'}=${slice.globalBridgeLine}`
  return `#${slice.id} ${slice.kind ?? '?'} slab ${slice.lowerCy}→${slice.levelCy} · local ${b ? `${b.x0},${b.z0}..${b.x1},${b.z1}` : '—'} · void ${slice.voidCells?.length ?? 0} · ${bridge}`
}

export function inspectCell(source, gx, cy, gz) {
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  const d = source.chunkAt(cx, cy, cz)
  if (!d) return { gx, gz, cy, chunk: null, lines: [`cell ${gx},${gz} · cy ${cy}`, `chunk ${cx},${cy},${cz} not ${source.isWorld ? 'generated yet' : 'in the document'}`] }
  const lx = gx - cx * CHUNK
  const lz = gz - cz * CHUNK
  const i = cIdx(lx, lz)
  const m = holeMasks(d)
  const lines = []
  lines.push(`cell ${gx},${gz} · cy ${cy} · chunk ${cx},${cy},${cz} local ${lx},${lz}`)
  const gen = source.genMs?.get(`${cx},${cy},${cz}`)
  lines.push(`zone ${ZONE_NAMES[d.zone] ?? d.zone} · family ${d.mapFamily} · v${d.version}${gen !== undefined ? ` · gen ${gen.toFixed(1)} ms` : ''}`)
  const repairs = Object.entries(d.repairs ?? {}).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`)
  if (repairs.length) lines.push(`repairs ${repairs.join(' · ')}`)
  lines.push(describeCell(d, lx, lz))
  const role = roomRoleLabel(d.spaceRole[i])
  lines.push(`spaceId ${d.spaceId[i]}${role ? ` · role ${role}` : ''} · column ${d.cols[i]}`)
  lines.push(`edges N ${edgeText(source.wallHAt(gx, cy, gz))} · S ${edgeText(source.wallHAt(gx, cy, gz + 1))} · W ${edgeText(source.wallVAt(gx, cy, gz))} · E ${edgeText(source.wallVAt(gx + 1, cy, gz))}`)

  // Slab state and its cause.
  const floorWhy = []
  if (m.stair[i] & STAIR_DOWN_RUN) floorWhy.push('stair from below')
  if (d.structureDown?.voidCells?.some((c) => c.lx === lx && c.lz === lz)) floorWhy.push(`slice #${d.structureDown.id}`)
  if (m.lethal[i]) floorWhy.push(m.lethal[i] === 1 ? `lethal (death y ${(m.deathYmm[i] / 1000).toFixed(1)} m)` : 'INVALID lethal half')
  const ceilWhy = []
  if (m.stair[i] & STAIR_UP_RUN) ceilWhy.push('stair run')
  if (d.structureUp?.voidCells?.some((c) => c.lx === lx && c.lz === lz)) ceilWhy.push(`slice #${d.structureUp.id}`)
  if (d.lethalVoidUp?.cells?.some((c) => c.lx === lx && c.lz === lz)) ceilWhy.push('lethal shaft')
  lines.push(`floor ${m.floor[i] ? `OPEN (${floorWhy.join(', ') || '?'})` : 'solid'} · ceiling ${m.ceil[i] ? `OPEN (${ceilWhy.join(', ') || '?'})` : 'solid'}`)
  const stairBits = []
  if (m.stair[i] & STAIR_UP_LANDING) stairBits.push('↑ landing')
  if (m.stair[i] & STAIR_UP_RUN) stairBits.push('↑ run')
  if (m.stair[i] & STAIR_DOWN_RUN) stairBits.push('↓ run (hole)')
  if (m.stair[i] & STAIR_DOWN_EXIT) stairBits.push('↓ exit')
  if (stairBits.length) lines.push(`stair cell: ${stairBits.join(', ')}`)

  const lamp = d.lamps.find((l) => l.lx === lx && l.lz === lz)
  if (lamp) lines.push(`lamp ${lamp.lit ? 'lit' : 'dead'}`)
  const furn = d.furniture.find((f) => f.lx === lx && f.lz === lz)
  if (furn) lines.push(`furniture kind ${furn.kind} · ${furn.w.toFixed(2)}×${furn.d.toFixed(2)} · facing ${furn.facing}`)
  if (d.exit && d.exit.lx === lx && d.exit.lz === lz) lines.push('EXIT')

  // Chunk-level descriptors.
  lines.push('— chunk —')
  lines.push(`lamps ${d.lamps.filter((l) => l.lit).length}/${d.lamps.length} lit · furniture ${d.furniture.length}${d.exit ? ` · exit ${cellText(d.exit)}` : ''}`)
  if (d.stairUp) lines.push(`stairUp ${stairText(d.stairUp)}`)
  if (d.stairDown) lines.push(`stairDown ${stairText(d.stairDown)}`)
  if (d.structure?.hasRoom) {
    const s = d.structure
    const participant = s.participants?.some((p) => p.cx === cx && p.cz === cz)
    lines.push(`structure #${s.id} ${structureKind(s)} cy ${s.baseCy}…${s.topCy} · ${participant ? 'participant' : 'NOT a participant'} · adapter ${structureAdapterFor(s)?.family ?? 'none'}`)
  }
  if (d.structureUp) lines.push(`structureUp ${sliceText(d.structureUp)}`)
  if (d.structureDown) lines.push(`structureDown ${sliceText(d.structureDown)}`)
  for (const [name, half, dir] of [['lethalVoidUp', d.lethalVoidUp, 'up'], ['lethalVoidDown', d.lethalVoidDown, 'down']]) {
    if (!half) continue
    const v = validateLethalVoidHalf(d, half, dir)
    lines.push(`${name} #${half.id} ${half.cells?.length ?? 0} cells · ${v.ok ? 'valid' : `INVALID ${v.reasons.join(', ')}`}`)
  }
  if (d.sewerDescriptor) {
    const sd = d.sewerDescriptor
    lines.push(`sewer modules ${sd.modules?.length ?? 0} · tree ${sd.treeEdges?.length ?? 0} · loops ${sd.loopEdges?.length ?? 0}`)
  }
  return { gx, gz, cy, lx, lz, chunk: d, lines }
}

// The chunk's descriptors as plain JSON (for the console / copy).
export function chunkDescriptors(d) {
  if (!d) return null
  const pick = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)))
  return {
    key: `${d.cx},${d.cy},${d.cz}`,
    zone: d.zone,
    family: d.mapFamily,
    stairUp: pick(d.stairUp),
    stairDown: pick(d.stairDown),
    structure: pick(d.structure),
    structureUp: pick(d.structureUp),
    structureDown: pick(d.structureDown),
    lethalVoidUp: pick(d.lethalVoidUp),
    lethalVoidDown: pick(d.lethalVoidDown),
    sewerDescriptor: pick(d.sewerDescriptor),
  }
}
