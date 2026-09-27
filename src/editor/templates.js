import { CELL, CHUNK } from '../world/constants.js'
import {
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_OPEN,
  COLUMN_STANDARD,
  PASSAGE_DOOR,
  PASSAGE_OPEN,
  PASSAGE_WALL,
  SPACE_ROLE_NONE,
} from '../world/mapTypes.js'
import { hash3i } from '../world/core/hash.js'
import {
  STAIR_E,
  STAIR_S,
  atriumConflicts,
  atriumDescriptor,
  clearRectToOpen,
  stairwellConflicts,
  stairwellPlan,
  stampAtrium,
  stampStairwell,
} from '../world/structures/authored.js'
import { createRoom, removeRoom, stampRoomShell } from './roomBuilder.js'
import { protectedRectReason } from './protect.js'

// Structure templates the editor can author into a document. Each template
// PLANS first (pure: parts, footprint, a verdict the drag preview shows) and
// then APPLIES as one undoable operation that records the structure in
// `map.authored`. Multilevel parts reuse the canonical contracts
// (world/structures/authored.js); room parts reuse the room builder and the
// game's furnishing grammar.
//
// The composites realize the structure roadmap in liminal-horror-design.md:
//   splitLevel   sunken two-storey hall with a stair visible from its floor
//                up to the gallery (exposure plus deferred access)
//   twinVoid     two shafts separated by an occupied spine (layered
//                observation and route choice)
//   anomalyWing  a corridor of identical rooms where exactly one differs in
//                a high-salience property (recognition, doubt, memory)
//   compression  low rooms in series releasing into a tall hall (scale change
//                as a beat)

export const TEMPLATE_DEFS = Object.freeze([
  { id: 'atrium', label: 'light well (open shaft)', input: 'rect', multilevel: true },
  { id: 'bridgedAtrium', label: 'bridged atrium', input: 'rect', multilevel: true },
  { id: 'stairwell', label: 'endless stairwell (switchback)', input: 'point', multilevel: true },
  { id: 'splitLevel', label: 'split-level overlook', input: 'rect', multilevel: true },
  { id: 'twinVoid', label: 'twin-void atrium', input: 'rect', multilevel: true },
  { id: 'anomalyWing', label: 'repetition-anomaly wing', input: 'rect', multilevel: false },
  { id: 'compression', label: 'compression-release suite', input: 'rect', multilevel: true },
])

export const ANOMALIES = Object.freeze(['random', 'dark', 'empty', 'pillar', 'extraDoor'])

export const DEFAULT_TEMPLATE_PARAMS = Object.freeze({
  levels: 3,
  bridgeEvery: 2,
  dir: STAIR_E,
  enclosed: true,
  role: SPACE_ROLE_NONE,
  anomaly: 'random',
  salt: 0,
})

const normRect = ({ x0, z0, x1, z1 }) => ({
  x0: Math.min(x0, x1), z0: Math.min(z0, z1), x1: Math.max(x0, x1), z1: Math.max(z0, z1),
})

function planAtrium(map, rect, cy, params, kind, bridgeAxis = null) {
  const { descriptor, error } = atriumDescriptor({
    ...rect, baseCy: cy, levels: params.levels, kind, bridgeAxis, bridgeEvery: params.bridgeEvery,
  })
  if (error) return { error }
  const conflicts = atriumConflicts((cx, y, cz) => map.chunkAt(cx, y, cz), descriptor)
  if (conflicts.length) return { error: conflicts[0] }
  return { part: { type: 'atrium', descriptor } }
}

function planStairwell(map, gx, gz, cy, levels, dir, enclosed) {
  const plan = stairwellPlan({ gx, gz, baseCy: cy, topCy: cy + levels - 1, dir })
  if (plan.error) return { error: plan.error }
  const conflicts = stairwellConflicts((cx, y, cz) => map.chunkAt(cx, y, cz), plan)
  if (conflicts.length) return { error: conflicts[0] }
  return { part: { type: 'stairwell', plan, enclosed } }
}

const rectOverlaps = (a, b) => a.x0 <= b.x1 && a.x1 >= b.x0 && a.z0 <= b.z1 && a.z1 >= b.z0

// --- planning -----------------------------------------------------------------------

export function planTemplate(map, templateId, input, cy, params = {}) {
  const p = { ...DEFAULT_TEMPLATE_PARAMS, ...params }
  const fail = (error) => ({ ok: false, error, templateId })
  const done = (parts, bounds, label) => ({
    ok: true,
    templateId,
    label,
    parts,
    bounds,
    baseCy: cy,
    topCy: Math.max(cy, ...parts.map((part) =>
      part.type === 'atrium' ? part.descriptor.topCy : part.type === 'stairwell' ? part.plan.topCy : cy)),
  })

  if (templateId === 'stairwell') {
    const r = planStairwell(map, input.gx, input.gz, cy, Math.max(2, p.levels), p.dir, p.enclosed)
    if (r.error) return fail(r.error)
    return done([r.part], r.part.plan.globalCore, `stairwell ${p.levels} floors`)
  }

  const rect = normRect(input)
  if (templateId === 'atrium' || templateId === 'bridgedAtrium') {
    const r = planAtrium(map, rect, cy, p, templateId === 'atrium' ? 'openVoid' : 'bridged')
    if (r.error) return fail(r.error)
    return done([r.part], rect, `${templateId === 'atrium' ? 'light well' : 'bridged atrium'} ${p.levels} storeys`)
  }

  if (templateId === 'splitLevel') {
    const hall = planAtrium(map, rect, cy, { ...p, levels: 2 }, 'openVoid')
    if (hall.error) return fail(hall.error)
    // A single flight beside the hall, from its floor to the gallery: try
    // below, above, then the sides. The core (flight + halo) must not touch
    // the lobby ring: its carve would open the hall's windowed perimeter.
    const ring = { x0: rect.x0 - 1, z0: rect.z0 - 1, x1: rect.x1 + 1, z1: rect.z1 + 1 }
    const tries = [
      { gx: rect.x0, gz: rect.z1 + 3, dir: STAIR_E },
      { gx: rect.x0, gz: rect.z0 - 4, dir: STAIR_E },
      { gx: rect.x1 + 3, gz: rect.z0, dir: STAIR_S },
      { gx: rect.x0 - 4, gz: rect.z0, dir: STAIR_S },
    ]
    let stair = null
    let lastError = 'no room for the stair beside the hall'
    for (const t of tries) {
      const r = planStairwell(map, t.gx, t.gz, cy, 2, t.dir, false)
      if (r.error) { lastError = r.error; continue }
      if (rectOverlaps(r.part.plan.globalCore, ring)) continue
      stair = r.part
      break
    }
    if (!stair) return fail(`split level: ${lastError}`)
    const g = stair.plan.globalCore
    return done([hall.part, stair], {
      x0: Math.min(rect.x0, g.x0), z0: Math.min(rect.z0, g.z0), x1: Math.max(rect.x1, g.x1), z1: Math.max(rect.z1, g.z1),
    }, 'split-level overlook')
  }

  if (templateId === 'twinVoid') {
    // A chunk holds one slab slice per direction, so the two shafts live in
    // different chunks: the rectangle straddles a chunk seam and the 2-cell
    // occupied spine is the two lobby rings meeting across it.
    const alongX = rect.x1 - rect.x0 >= rect.z1 - rect.z0
    const lo = alongX ? rect.x0 : rect.z0
    const hi = alongX ? rect.x1 : rect.z1
    const mid = (lo + hi) / 2
    let seam = null
    for (let s = Math.ceil((lo + 4) / CHUNK) * CHUNK; s <= hi - 3; s += CHUNK) {
      if (seam === null || Math.abs(s - mid) < Math.abs(seam - mid)) seam = s
    }
    if (seam === null) return fail('twin void: the rectangle must straddle a chunk seam with 4+ cells on one side and 3+ on the other')
    const a = alongX ? { ...rect, x1: seam - 2 } : { ...rect, z1: seam - 2 }
    const b = alongX ? { ...rect, x0: seam + 1 } : { ...rect, z0: seam + 1 }
    const va = planAtrium(map, a, cy, p, 'openVoid', alongX ? 'x' : 'z')
    if (va.error) return fail(`twin void A: ${va.error}`)
    const vb = planAtrium(map, b, cy, p, 'openVoid', alongX ? 'x' : 'z')
    if (vb.error) return fail(`twin void B: ${vb.error}`)
    if (va.part.descriptor.id === vb.part.descriptor.id) return fail('twin void: identity collision')
    return done([va.part, vb.part], rect, `twin-void atrium ${p.levels} storeys`)
  }

  if (templateId === 'anomalyWing') return planAnomalyWing(map, rect, cy, p)
  if (templateId === 'compression') return planCompression(map, rect, cy, p)
  return fail(`unknown template ${templateId}`)
}

// Rooms 3 cells deep and 3 wide along a 2-cell corridor; both sides when the
// rectangle is 8+ cells across. One room — never the first or last — carries
// the anomaly.
function planAnomalyWing(map, rect, cy, p) {
  const fail = (error) => ({ ok: false, error, templateId: 'anomalyWing' })
  const hit = protectedRectReason(map, rect, cy)
  if (hit) return fail(`wing overlaps a ${hit.reason} at ${hit.gx},${hit.gz}`)
  const alongX = rect.x1 - rect.x0 >= rect.z1 - rect.z0
  const len = (alongX ? rect.x1 - rect.x0 : rect.z1 - rect.z0) + 1
  const across = (alongX ? rect.z1 - rect.z0 : rect.x1 - rect.x0) + 1
  if (across < 5) return fail('anomaly wing: needs 5+ cells across (3 room + 2 corridor)')
  const perSide = Math.floor(len / 3)
  if (perSide < 3) return fail('anomaly wing: needs 9+ cells along (three rooms)')
  const twoSided = across >= 8
  const a0 = alongX ? rect.x0 : rect.z0
  const c0 = alongX ? rect.z0 : rect.x0
  const c1 = alongX ? rect.z1 : rect.x1
  const corridor = twoSided ? [c0 + 3, c0 + 4] : [c1 - 1, c1]
  const toRect = (along0, along1, acr0, acr1) => (alongX
    ? { x0: along0, x1: along1, z0: acr0, z1: acr1 }
    : { x0: acr0, x1: acr1, z0: along0, z1: along1 })
  const rooms = []
  for (const side of twoSided ? [0, 1] : [0]) {
    const acr = side === 0 ? [c0, c0 + 2] : [c0 + 5, c0 + 7]
    for (let i = 0; i < perSide; i++) {
      const r = toRect(a0 + i * 3, a0 + i * 3 + 2, acr[0], acr[1])
      const doorAcross = side === 0 ? acr[1] + 1 : acr[0]
      const doorAlong = a0 + i * 3 + 1
      const door = alongX
        ? { axis: 'h', gx: doorAlong, gz: doorAcross }
        : { axis: 'v', gx: doorAcross, gz: doorAlong }
      rooms.push({ rect: r, door, side, index: i })
    }
  }
  const salt = hash3i(0x3a0e, rect.x0 ^ (p.salt | 0), cy, rect.z0) >>> 0
  const pick = (n) => 1 + (salt % Math.max(1, n - 2))
  const anomalyIndex = pick(perSide)
  const kinds = ANOMALIES.filter((k) => k !== 'random')
  const anomaly = p.anomaly === 'random' ? kinds[(salt >>> 8) % kinds.length] : p.anomaly
  return {
    ok: true,
    templateId: 'anomalyWing',
    label: `anomaly wing ×${rooms.length} (${anomaly} @ ${anomalyIndex + 1})`,
    parts: [{
      type: 'wing',
      rect,
      alongX,
      corridor: toRect(rect.x0 === rect.x0 ? a0 : a0, a0 + len - 1, corridor[0], corridor[1]),
      rooms,
      role: p.role,
      anomaly,
      anomalyIndex,
      salt,
    }],
    bounds: rect,
    baseCy: cy,
    topCy: cy,
  }
}

// Two low 3×3 rooms in series, then a tall open hall filling the rest.
function planCompression(map, rect, cy, p) {
  const fail = (error) => ({ ok: false, error, templateId: 'compression' })
  const alongX = rect.x1 - rect.x0 >= rect.z1 - rect.z0
  const a0 = alongX ? rect.x0 : rect.z0
  const a1 = alongX ? rect.x1 : rect.z1
  const c0 = alongX ? rect.z0 : rect.x0
  const c1 = alongX ? rect.z1 : rect.x1
  if (c1 - c0 + 1 < 5) return fail('compression suite: needs 5+ cells across')
  if (a1 - a0 + 1 < 13) return fail('compression suite: needs 13+ cells along (2 rooms + hall)')
  const cc = Math.floor((c0 + c1) / 2)
  const toRect = (along0, along1, acr0, acr1) => (alongX
    ? { x0: along0, x1: along1, z0: acr0, z1: acr1 }
    : { x0: acr0, x1: acr1, z0: along0, z1: along1 })
  const hallRect = toRect(a0 + 7, a1 - 1, c0 + 1, c1 - 1)
  const hall = planAtrium(map, hallRect, cy, { ...p, levels: Math.max(2, p.levels) }, 'openVoid', alongX ? 'x' : 'z')
  if (hall.error) return fail(`compression hall: ${hall.error}`)
  const roomRects = [toRect(a0, a0 + 2, cc - 1, cc + 1), toRect(a0 + 3, a0 + 5, cc - 1, cc + 1)]
  for (const r of roomRects) {
    const hit = protectedRectReason(map, r, cy)
    if (hit) return fail(`compression room overlaps a ${hit.reason}`)
  }
  const doorAt = (line) => (alongX ? { axis: 'v', gx: line, gz: cc } : { axis: 'h', gx: cc, gz: line })
  return {
    ok: true,
    templateId: 'compression',
    label: `compression-release (${Math.max(2, p.levels)}-storey hall)`,
    parts: [
      { type: 'rooms', cy, role: p.role, rooms: [
        { rect: roomRects[0], door: doorAt(a0), extraDoors: [doorAt(a0 + 3)] },
        { rect: roomRects[1], door: doorAt(a0 + 6), extraDoors: [] },
      ] },
      hall.part,
    ],
    bounds: rect,
    baseCy: cy,
    topCy: hall.part.descriptor.topCy,
  }
}

// --- applying -------------------------------------------------------------------------

const ensureOf = (map) => (cx, cy, cz) => map._touch(cx, cy, cz)

// Drop room records a volume overwrites (their cells were relabelled).
export function dropRoomsIn(map, rect, y0, y1) {
  map.rooms = map.rooms.filter((r) => r.cy < y0 || r.cy > y1 || !rectOverlaps(r, rect))
}

function clearRect(map, rect, cy) {
  for (let gz = rect.z0; gz <= rect.z1; gz++) {
    for (let gx = rect.x0; gx <= rect.x1; gx++) {
      map.removeFurniture(gx, cy, gz)
      if (map.lampAt(gx, cy, gz)) map.setLamp(gx, cy, gz, null)
      map.setCell(gx, cy, gz, { kind: CELL_OPEN, spaceId: 0, role: SPACE_ROLE_NONE, col: 0 })
    }
  }
  for (let gz = rect.z0; gz <= rect.z1; gz++) {
    for (let gx = rect.x0 + 1; gx <= rect.x1; gx++) map.setWallV(gx, cy, gz, 0, PASSAGE_OPEN)
  }
  for (let gz = rect.z0 + 1; gz <= rect.z1; gz++) {
    for (let gx = rect.x0; gx <= rect.x1; gx++) map.setWallH(gx, cy, gz, 0, PASSAGE_OPEN)
  }
}

function applyWing(map, part, cy) {
  clearRect(map, part.rect, cy)
  dropRoomsIn(map, part.rect, cy, cy)
  const c = part.corridor
  for (let gz = c.z0; gz <= c.z1; gz++) {
    for (let gx = c.x0; gx <= c.x1; gx++) map.setCell(gx, cy, gz, { kind: CELL_CORRIDOR })
  }
  // Single-sided wings face a blank wall across the corridor.
  if (!part.rooms.some((r) => r.side === 1)) {
    if (part.alongX) for (let gx = c.x0; gx <= c.x1; gx++) map.setWallH(gx, cy, c.z1 + 1, 1, PASSAGE_WALL)
    else for (let gz = c.z0; gz <= c.z1; gz++) map.setWallV(c.x1 + 1, cy, gz, 1, PASSAGE_WALL)
  }
  // Corridor lamps on an even cadence along its centre line.
  const len = part.alongX ? c.x1 - c.x0 + 1 : c.z1 - c.z0 + 1
  for (let i = 1; i < len; i += 3) {
    const gx = part.alongX ? c.x0 + i : c.x0
    const gz = part.alongX ? c.z0 : c.z0 + i
    map.setLamp(gx, cy, gz, true)
  }

  // The first room of each side is furnished by the grammar; its siblings
  // are exact copies (same pieces at the same offsets): repetition.
  const templates = new Map()
  const records = []
  for (const r of part.rooms) {
    const source = templates.get(r.side)
    if (!source) {
      const room = createRoom(map, { cy, ...r.rect, role: part.role, salt: part.salt, door: r.door, lamp: true })
      records.push(room)
      const pieces = []
      for (let gz = r.rect.z0; gz <= r.rect.z1; gz++) {
        for (let gx = r.rect.x0; gx <= r.rect.x1; gx++) {
          const found = map.furnitureAt(gx, cy, gz)
          if (found) pieces.push({ dx: gx - r.rect.x0, dz: gz - r.rect.z0, rec: { ...found.rec } })
        }
      }
      templates.set(r.side, { rect: r.rect, pieces })
      continue
    }
    const room = {
      id: map.nextRoomId++, cy, ...r.rect, role: part.role, salt: part.salt, door: r.door, baked: false,
    }
    stampRoomShell(map, room)
    map.rooms.push(room)
    records.push(room)
    const lx = Math.floor((r.rect.x0 + r.rect.x1) / 2)
    const lz = Math.floor((r.rect.z0 + r.rect.z1) / 2)
    map.setLamp(lx, cy, lz, true)
    for (const { dx, dz, rec } of source.pieces) {
      const gx = r.rect.x0 + dx
      const gz = r.rect.z0 + dz
      const offX = rec.x - (rec.lx + 0.5) * CELL
      const offZ = rec.z - (rec.lz + 0.5) * CELL
      map.addFurniture(gx, cy, gz, {
        ...rec,
        x: (map.cellLocal(gx) + 0.5) * CELL + offX,
        z: (map.cellLocal(gz) + 0.5) * CELL + offZ,
      })
    }
  }

  // The anomaly, on the chosen room of the first side.
  const target = part.rooms.findIndex((r) => r.side === 0 && r.index === part.anomalyIndex)
  const room = records[target]
  const r = part.rooms[target]
  if (room && r) {
    const cx = Math.floor((r.rect.x0 + r.rect.x1) / 2)
    const cz = Math.floor((r.rect.z0 + r.rect.z1) / 2)
    if (part.anomaly === 'dark') {
      map.setLamp(cx, cy, cz, false)
    } else if (part.anomaly === 'empty') {
      for (let gz = r.rect.z0; gz <= r.rect.z1; gz++) for (let gx = r.rect.x0; gx <= r.rect.x1; gx++) map.removeFurniture(gx, cy, gz)
    } else if (part.anomaly === 'pillar') {
      // The room is emptied and a single column stands where the lamp hung:
      // the ring of cells around it stays one walkable loop.
      for (let gz = r.rect.z0; gz <= r.rect.z1; gz++) for (let gx = r.rect.x0; gx <= r.rect.x1; gx++) map.removeFurniture(gx, cy, gz)
      if (map.lampAt(cx, cy, cz)) map.setLamp(cx, cy, cz, null)
      map.setCell(cx, cy, cz, { col: COLUMN_STANDARD })
    } else if (part.anomaly === 'extraDoor') {
      // A door into the next room through the shared side wall.
      const line = part.alongX ? r.rect.x1 + 1 : r.rect.z1 + 1
      for (const g of part.alongX ? [cz] : [cx]) {
        if (part.alongX) {
          map.removeFurniture(r.rect.x1, cy, g)
          map.removeFurniture(r.rect.x1 + 1, cy, g)
          map.setWallV(line, cy, g, 0, PASSAGE_DOOR)
        } else {
          map.removeFurniture(g, cy, r.rect.z1)
          map.removeFurniture(g, cy, r.rect.z1 + 1)
          map.setWallH(g, cy, line, 0, PASSAGE_DOOR)
        }
      }
    }
  }
  return records.map((rm) => rm.id)
}

function applyRooms(map, part) {
  const ids = []
  for (const r of part.rooms) {
    clearRect(map, r.rect, part.cy)
    dropRoomsIn(map, r.rect, part.cy, part.cy)
    const room = createRoom(map, { cy: part.cy, ...r.rect, role: part.role, door: r.door, lamp: true })
    for (const d of r.extraDoors) {
      if (d.axis === 'v') map.setWallV(d.gx, part.cy, d.gz, 0, PASSAGE_DOOR)
      else map.setWallH(d.gx, part.cy, d.gz, 0, PASSAGE_DOOR)
    }
    ids.push(room.id)
  }
  return ids
}

// Apply a successful plan as one undoable operation; returns the record.
export function applyTemplate(map, plan) {
  if (!plan?.ok) return null
  let record = null
  map.mutate(() => {
    const parts = []
    for (const part of plan.parts) {
      if (part.type === 'atrium') {
        const d = part.descriptor
        const b = d.globalBounds
        dropRoomsIn(map, { x0: b.x0 - 1, z0: b.z0 - 1, x1: b.x1 + 1, z1: b.z1 + 1 }, d.baseCy, d.topCy)
        stampAtrium(ensureOf(map), d)
        parts.push({ type: 'atrium', descriptor: d })
      } else if (part.type === 'stairwell') {
        const { plan: sp, enclosed } = part
        dropRoomsIn(map, sp.globalCore, sp.baseCy, sp.topCy)
        stampStairwell(ensureOf(map), sp, { enclosed })
        parts.push({ type: 'stairwell', plan: sp, enclosed })
      } else if (part.type === 'wing') {
        parts.push({ type: 'wing', rect: part.rect, cy: plan.baseCy, rooms: applyWing(map, part, plan.baseCy), anomaly: part.anomaly, anomalyIndex: part.anomalyIndex })
      } else if (part.type === 'rooms') {
        parts.push({ type: 'rooms', cy: part.cy, rooms: applyRooms(map, part) })
      }
    }
    record = {
      id: authoredRecordId(plan),
      template: plan.templateId,
      label: plan.label,
      baseCy: plan.baseCy,
      topCy: plan.topCy,
      bounds: plan.bounds,
      parts,
    }
    map.authored = map.authored.filter((r) => r.id !== record.id)
    map.authored.push(record)
  })
  return record
}

// A structure-shaped view of an authored record so the structures list,
// focus, section, 3D outline and audit treat it like any other volume.
export function authoredView(rec) {
  const participants = new Map()
  const add = (cx, cz) => participants.set(`${cx},${cz}`, { cx, cz })
  let bridgeAxis = 'x'
  for (const part of rec.parts) {
    if (part.type === 'atrium') {
      for (const p of part.descriptor.participants) add(p.cx, p.cz)
      bridgeAxis = part.descriptor.bridgeAxis
    } else if (part.type === 'stairwell') {
      add(part.plan.cx, part.plan.cz)
    }
  }
  const b = rec.bounds
  if (!participants.size) {
    for (let cz = Math.floor(b.z0 / CHUNK); cz <= Math.floor(b.z1 / CHUNK); cz++) {
      for (let cx = Math.floor(b.x0 / CHUNK); cx <= Math.floor(b.x1 / CHUNK); cx++) add(cx, cz)
    }
  }
  return {
    id: rec.id,
    hasRoom: true,
    authored: true,
    template: rec.template,
    label: rec.label,
    kind: rec.template,
    family: 'authored',
    baseCy: rec.baseCy,
    topCy: rec.topCy,
    globalBounds: b,
    bridgeAxis,
    participants: [...participants.values()].sort((a, c) => a.cz - c.cz || a.cx - c.cx),
    parts: rec.parts,
  }
}

function authoredRecordId(plan) {
  return (hash3i(0x7e3a1 ^ plan.templateId.length, plan.bounds.x0, plan.baseCy, plan.bounds.z0) >>> 0) || 1
}

// Remove an authored structure: its slabs and stairs are withdrawn and the
// cells return to plain open floor (the fabric underneath is not recoverable;
// undo restores it).
export function removeAuthored(map, record) {
  map.mutate(() => {
    for (const part of record.parts) {
      if (part.type === 'atrium') {
        const d = part.descriptor
        const b = d.globalBounds
        for (let cy = d.baseCy; cy <= d.topCy; cy++) {
          for (const { cx, cz } of d.participants) {
            const data = map._touch(cx, cy, cz, false)
            if (!data) continue
            if (data.structureUp?.id === d.id) data.structureUp = null
            if (data.structureDown?.id === d.id) data.structureDown = null
            clearRectToOpen(data, b.x0 - 1 - cx * CHUNK, b.z0 - 1 - cz * CHUNK, b.x1 + 1 - cx * CHUNK, b.z1 + 1 - cz * CHUNK)
          }
        }
      } else if (part.type === 'stairwell') {
        const sp = part.plan
        for (let cy = sp.baseCy; cy <= sp.topCy; cy++) {
          const data = map._touch(sp.cx, cy, sp.cz, false)
          if (!data) continue
          data.stairUp = null
          data.stairDown = null
          clearRectToOpen(data, sp.core.x0, sp.core.z0, sp.core.x1, sp.core.z1)
          for (let z = sp.core.z0; z <= sp.core.z1; z++) {
            for (let x = sp.core.x0; x <= sp.core.x1; x++) data.cellKind[z * CHUNK + x] = CELL_LOBBY
          }
        }
      } else if (part.type === 'wing' || part.type === 'rooms') {
        for (const id of part.rooms) {
          const room = map.roomById(id)
          if (room) removeRoom(map, room)
        }
      }
    }
    map.authored = map.authored.filter((r) => r.id !== record.id)
  })
}
