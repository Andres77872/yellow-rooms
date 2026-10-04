import {
  MAP_FAMILY_HOTEL,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
  SPACE_ROLE_ARCHIVE,
  SPACE_ROLE_BATHROOM,
  SPACE_ROLE_BEDROOM,
  SPACE_ROLE_BREAK,
  SPACE_ROLE_COPY,
  SPACE_ROLE_DINING,
  SPACE_ROLE_KITCHEN,
  SPACE_ROLE_LAUNDRY,
  SPACE_ROLE_LIBRARY,
  SPACE_ROLE_LIVING,
  SPACE_ROLE_LOUNGE,
  SPACE_ROLE_MEETING,
  SPACE_ROLE_NONE,
  SPACE_ROLE_OFFICE,
  SPACE_ROLE_SERVER,
  SPACE_ROLE_STORAGE,
} from './mapTypes.js'
import { baseFamilyOf, byFamily } from './families/registry.js'
import { MAP_FAMILY_TERMINAL, MAP_FAMILY_TRAIN } from './families/ids.js'

// Wall decal vocabulary shared by the dressing builders (objects/dressing)
// and the per-world decal atlas painter (render/decalAtlas.js). THREE-free.
//
// The atlas is a DECAL_GRID x DECAL_GRID sheet of cells; every kind owns a
// fixed run of cells, so a chunk's dressing can name a cell without knowing
// the world seed. Two sorts of kind share the sheet:
//   * printed matter (posters, memos, calendars, prints, clocks, photos,
//     charts, plans, notes): the painter repaints each cell's CONTENT per
//     world, and the dressing picks cells by room persona or department;
//   * signage (safety notices, wayfinding arrows, room signs): every cell
//     carries a FIXED meaning, the same in every world, so a server room can
//     ask for HIGH VOLTAGE and an arrow for STAIRS on the left. Only the
//     typography, colours and plate style change per world.
// A cell is painted at its kind's aspect and stretched to the square cell,
// so it maps undistorted onto a plate of that aspect.
export const DECAL_GRID = 8
export const DECAL_CELLS = DECAL_GRID * DECAL_GRID

// kind: [first cell, count, width / height]
export const DECAL_KINDS = Object.freeze({
  poster: [0, 6, 3 / 4], // framed motivational poster
  safety: [6, 8, 3 / 4], // SAFETY_NOTICES, one fixed notice per cell
  evac: [14, 2, 4 / 3], // evacuation plan, YOU ARE HERE (one per storey)
  calendar: [16, 3, 3 / 4], // wall calendar, days struck through
  memo: [19, 6, 0.707], // typed A4 memo / timetable / phone list
  art: [25, 6, 4 / 3], // hotel and lobby prints
  clock: [31, 4, 1], // clock dial with its own stopped time
  sign: [35, 16, 3], // SIGN_PLATES: room / level / plant identification
  liminal: [51, 4, 3 / 4], // notes that should not be there
  photo: [55, 3, 4 / 3], // framed photograph of a place like this one
  wayfinding: [58, 4, 3], // WAYFINDING: exit / stairs arrow plates
  chart: [62, 2, 4 / 3], // pinned bar chart / org chart
})

export function decalAspect(kind) {
  return DECAL_KINDS[kind]?.[2] ?? 1
}

// Pick a cell of `kind` from a 0..1 roll (printed matter).
export function decalCell(kind, roll) {
  const [first, count] = DECAL_KINDS[kind] ?? DECAL_KINDS.memo
  return first + Math.min(count - 1, Math.floor(Math.max(0, roll) * count))
}

// The `slot`-th cell of `kind` (wraps, so any integer key works).
export function decalCellAt(kind, slot) {
  const [first, count] = DECAL_KINDS[kind] ?? DECAL_KINDS.memo
  return first + ((((slot | 0) % count) + count) % count)
}

export function decalKindOf(cell) {
  for (const [kind, [first, count]] of Object.entries(DECAL_KINDS)) {
    if (cell >= first && cell < first + count) return kind
  }
  return null
}

// --- Safety notices -----------------------------------------------------------
// One fixed notice per safety cell, chosen by the space it is posted in:
// wet rooms wash hands / wet floor, server rooms high voltage / authorised
// personnel, egress corridors fire door / do not block, sewers confined
// space, open decks fall hazard.
export const SAFETY_NOTICES = Object.freeze([
  'wetFloor',
  'washHands',
  'highVoltage',
  'authorized',
  'fireDoor',
  'doNotBlock',
  'confinedSpace',
  'fallHazard',
])

export function safetyCell(id) {
  const i = SAFETY_NOTICES.indexOf(id)
  if (i < 0) throw new Error(`unknown safety notice ${id}`)
  return DECAL_KINDS.safety[0] + i
}

// --- Wayfinding ---------------------------------------------------------------
// Arrow plates with a fixed label and direction, as the viewer reads them:
// dir -1 points to the viewer's left, +1 to the right.
export const WAYFINDING = Object.freeze([
  Object.freeze({ label: 'EXIT', dir: -1 }),
  Object.freeze({ label: 'EXIT', dir: 1 }),
  Object.freeze({ label: 'STAIRS', dir: -1 }),
  Object.freeze({ label: 'STAIRS', dir: 1 }),
])

export function wayfindingCell(label, dir) {
  const i = WAYFINDING.findIndex((w) => w.label === label && w.dir === (dir < 0 ? -1 : 1))
  if (i < 0) throw new Error(`unknown wayfinding plate ${label}`)
  return DECAL_KINDS.wayfinding[0] + i
}

// --- Sign plates --------------------------------------------------------------
// The 16 sign cells of each family's atlas, in cell order: { id, text,
// numbered }. A numbered plate leaves a blank field to the right of its
// text; the dressing sets the number in raised numerals over it
// (objects/dressing/notices.js), so one ROOM cell serves every room of the
// building with its own number, and one LEVEL cell every storey.
const plate = (id, text, numbered = false) => Object.freeze({ id, text, numbered })

const OFFICE_PLATES = [
  plate('room', 'ROOM', true),
  plate('level', 'LEVEL', true),
  plate('conference', 'CONFERENCE'),
  plate('break', 'BREAK ROOM'),
  plate('copy', 'COPY ROOM'),
  plate('archive', 'ARCHIVE'),
  plate('electrical', 'ELECTRICAL'),
  plate('storage', 'STORAGE'),
  plate('library', 'LIBRARY'),
  plate('lounge', 'LOUNGE'),
  plate('restroom', 'RESTROOM'),
  plate('kitchen', 'KITCHEN'),
  plate('laundry', 'LAUNDRY'),
  plate('dining', 'CAFETERIA'),
  plate('staff', 'STAFF ONLY'),
  plate('plant', 'PLANT ROOM'),
]

// Same meanings, the family's own wording.
const reword = (plates, words) =>
  Object.freeze(plates.map((p) => (words[p.id] ? plate(p.id, words[p.id], p.numbered) : p)))

const TOWER_PLATES = reword(OFFICE_PLATES, { level: 'FLOOR', conference: 'MEETING', archive: 'RECORDS', electrical: 'COMMS', plant: 'RISER' })

export const SIGN_PLATES = Object.freeze({
  [MAP_FAMILY_OFFICE]: Object.freeze(OFFICE_PLATES),
  [MAP_FAMILY_TOWER]: TOWER_PLATES,
  // The train (tower-based) numbers its cars and names its stations
  // (families/train/plates.js): a car panel is the numbered ROOM plate, a
  // station board the numbered LEVEL plate, in the train's own words; the
  // rest keep the tower's.
  [MAP_FAMILY_TRAIN]: reword(TOWER_PLATES, { room: 'CAR', level: 'STATION' }),
  // The terminal (tower-based) names its storeys by gate: the numbered
  // LEVEL plate carries a pier's gate number (C12, the board's Err) and the
  // halls' display words (Arr, dEP, CLUb; families/plates.js labelPlates,
  // the stair ends), so it reads GATE, not the tower's FLOOR.
  [MAP_FAMILY_TERMINAL]: reword(TOWER_PLATES, { level: 'GATE' }),
  [MAP_FAMILY_HOTEL]: reword(OFFICE_PLATES, {
    level: 'FLOOR',
    conference: 'BALLROOM',
    archive: 'RECORDS',
    electrical: 'SERVICE',
    storage: 'HOUSEKEEPING',
    library: 'READING ROOM',
    dining: 'DINING ROOM',
    restroom: 'WC',
  }),
  // The lattice keeps its rooms unsigned (exposed steel, no fit-out); its
  // plates name storeys and plant.
  [MAP_FAMILY_LATTICE]: Object.freeze([
    plate('level', 'LEVEL', true),
    plate('deck', 'DECK', true),
    plate('plant', 'PLANT'),
    plate('hoist', 'HOIST'),
    plate('gantry', 'GANTRY'),
    plate('control', 'CONTROL'),
    plate('room', 'BAY', true),
    plate('storage', 'STORAGE'),
    plate('electrical', 'ELECTRICAL'),
    plate('staff', 'NO ACCESS'),
    plate('conference', 'MEETING'),
    plate('break', 'MESS ROOM'),
    plate('copy', 'PRINT ROOM'),
    plate('archive', 'RECORDS'),
    plate('restroom', 'WC'),
    plate('lounge', 'LOUNGE'),
  ]),
  // Sewer chambers are plant: the valve stations and access shafts name
  // themselves (objects/dressing/sewer.js keys the plate by the chamber).
  [MAP_FAMILY_SEWER]: Object.freeze([
    plate('valve', 'VALVE', true),
    plate('level', 'LEVEL', true),
    plate('pump', 'PUMP ROOM'),
    plate('control', 'CONTROL'),
    plate('sluice', 'SLUICE GATE'),
    plate('gauge', 'GAUGE ROOM'),
    plate('overflow', 'OVERFLOW'),
    plate('weir', 'WEIR'),
    plate('bypass', 'BYPASS'),
    plate('access', 'ACCESS', true),
    plate('shaft', 'SHAFT'),
    plate('sump', 'SUMP'),
    plate('inspection', 'INSPECTION'),
    plate('silt', 'SILT TRAP'),
    plate('outfall', 'OUTFALL'),
    plate('noEntry', 'NO ENTRY'),
  ]),
})

// Sewer chamber plates by chamber type (sewer.js).
export const SEWER_LARGE_PLATES = Object.freeze(['valve', 'pump', 'control', 'sluice', 'gauge', 'overflow', 'weir', 'bypass'])
export const SEWER_SMALL_PLATES = Object.freeze(['access', 'shaft', 'sump', 'inspection', 'silt', 'outfall'])

export function signPlates(family) {
  return byFamily(SIGN_PLATES, family)
}

// Cell of the plate `id` in `family`'s atlas, or -1 when it has none.
export function signCell(id, family) {
  const i = signPlates(family).findIndex((p) => p.id === id)
  return i < 0 ? -1 : DECAL_KINDS.sign[0] + i
}

// Plate painted in `cell` of `family`'s atlas (null outside the sign run).
export function signPlateAt(cell, family) {
  const [first, count] = DECAL_KINDS.sign
  return cell >= first && cell < first + count ? signPlates(family)[cell - first] : null
}

// The plate that names a room of `role`: what the door of that room says.
// null means the room is not signed — a hotel's guest rooms carry their
// number on the door itself.
const ROLE_PLATE = {
  [SPACE_ROLE_NONE]: 'room',
  [SPACE_ROLE_OFFICE]: 'room',
  [SPACE_ROLE_MEETING]: 'conference',
  [SPACE_ROLE_BREAK]: 'break',
  [SPACE_ROLE_COPY]: 'copy',
  [SPACE_ROLE_ARCHIVE]: 'archive',
  [SPACE_ROLE_SERVER]: 'electrical',
  [SPACE_ROLE_STORAGE]: 'storage',
  [SPACE_ROLE_LIBRARY]: 'library',
  [SPACE_ROLE_LOUNGE]: 'lounge',
  [SPACE_ROLE_BEDROOM]: 'room',
  [SPACE_ROLE_BATHROOM]: 'restroom',
  [SPACE_ROLE_KITCHEN]: 'kitchen',
  [SPACE_ROLE_LIVING]: 'lounge',
  [SPACE_ROLE_DINING]: 'dining',
  [SPACE_ROLE_LAUNDRY]: 'laundry',
}
const HOTEL_ROLE_PLATE = {
  ...ROLE_PLATE,
  [SPACE_ROLE_NONE]: null,
  [SPACE_ROLE_BEDROOM]: null,
  [SPACE_ROLE_LIVING]: null,
  [SPACE_ROLE_OFFICE]: 'staff',
  [SPACE_ROLE_COPY]: 'staff',
  [SPACE_ROLE_SERVER]: 'staff',
}

export function signIdFor(role, family) {
  const table = baseFamilyOf(family) === MAP_FAMILY_HOTEL ? HOTEL_ROLE_PLATE : ROLE_PLATE
  return table[role] ?? null
}

// THREE-free lookup: the sign cell over the door of a room of `role`, or -1.
export function signCellFor(role, family) {
  const id = signIdFor(role, family)
  return id ? signCell(id, family) : -1
}
