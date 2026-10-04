import { CHUNK, DOOR_DARK_CHANCE, DOOR_DARK_TINT, DOOR_TINT_VAR, cIdx } from './constants.js'
import { hash2i, hash3i } from './core/hash.js'
import { DOOR_EGRESS, DOOR_GUEST, DOOR_INTERNAL, DOOR_ROOM, DOOR_SERVICE, DOOR_WET, edgeContext } from './doorFunction.js'
import { GLASS_CLEAR, GLASS_CRACKED, GLASS_DIRTY, GLASS_FROSTED, GLASS_TAPED, GLASS_WIRED } from './glassKinds.js'
import { FAMILY_SKELETONS, MAP_FAMILY_CODES } from './mapFamily.js'
import { MAP_FAMILY_HOTEL, SPACE_CLASS_ROOM, SPACE_ROLE_BEDROOM } from './mapTypes.js'
import { DOOR_VOCAB } from './objects/joinery/doorKit.js'
import { baseFamilyOf, byFamily } from './families/registry.js'
import { SPACE_ROOM, ZONE_WET, districtKeyOf, worldSurfaceSet } from './surfaceSet.js'

// The door schedule: what every doorway of a building hangs, chosen top down
// like the finish schedule (surfaceSet.js) instead of rolled per door.
//
//   world      family door vocabulary (objects/joinery/doorKit.js)
//   district   the department's standard: ROOM door type, veneer species,
//              ironmongery finish and panel count — hash(seed, family, key)
//   function   what the door is FOR (doorFunction.js) picks the type: the
//              district standard for ordinary rooms, flush leaves without
//              glass for washrooms, kick-plated leaves for plant and store
//              rooms, fire doors on the escape route
//   storey     one paint batch per department and storey: a +-3% brightness
//              drift shared by every door of the department's floor, so a
//              corridor (which never leaves its district) is one batch even
//              where a seam hides it from the chunk that hangs the door
//   door       only what really is per door: the hotel room number along
//              its corridor, the glass condition from the wear field, and a
//              rare dark-stained "wrong door", likelier in derelict wings
//
// Every choice is a pure function of the chunk's own ChunkData plus the
// world seed and family, keyed on stable keys (district, space key, global
// edge coordinate), so a doorway resolves the same however the world
// streamed in.

const SALT_SCHEDULE = 0xd5c4ed
const SALT_BATCH = 0xba7c4
const SALT_WRONG = 0x3e0d
const SALT_GLASS = 0x6a55d

const unit = (h) => h / 4294967296
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function pick(list, r) {
  let total = 0
  for (const [, w] of list) total += w
  let acc = 0
  for (const [name, w] of list) {
    acc += w / total
    if (r < acc) return name
  }
  return list[list.length - 1][0]
}

const scheduleMemo = new Map()

// A department's door standard. Pure in (worldSeed, family, key) and
// memoised: every doorway of a district asks for the same frozen record.
//   { key, standard, species, metal, panels, style }
// `style` is the leaf-style seed objects/joinery reads (two-panel below
// 0.5, three-panel above).
export function doorSchedule(worldSeed, family, key) {
  const id = `${family}:${worldSeed | 0}:${key >>> 0}`
  let s = scheduleMemo.get(id)
  if (s) return s
  const vocab = byFamily(DOOR_VOCAB, family)
  const f = MAP_FAMILY_CODES[family] ?? 0
  const roll = (k) => unit(hash3i((worldSeed ^ SALT_SCHEDULE) | 0, f, key | 0, k))
  const panels = pick(vocab.panels, roll(4))
  s = Object.freeze({
    key: key >>> 0,
    standard: pick(vocab.standard, roll(1)),
    species: pick(vocab.species, roll(2)),
    metal: pick(vocab.metal, roll(3)),
    panels,
    style: panels === 3 ? 0.65 : 0.25,
  })
  if (scheduleMemo.size > 4096) scheduleMemo.clear()
  scheduleMemo.set(id, s)
  return s
}

// Hotel room numbers, as a large hotel numbers them: the storey, the wing,
// then a two-digit index that climbs along the corridor — odd on the right
// hand walking toward +z (v doors) or +x (h doors), even on the left. The
// number names the ROOM, not the doorway: every door of one room onto one
// corridor wall reads the same number.
//   storey  as the LEVEL plates number storeys (dressing/notices.js
//           storeyNumber): 1 for the ground floor, b1, b2... below it, so
//           one basement never repeats another's numbers.
//   index   the room's first cell along the door's wall line: its run of
//           cells on the room side of the line, walked back to the low end —
//           this chunk's own cells, then past the chunk edge the district's
//           cells as the seam source gives them (data.seam.plannedId: the
//           plan in the game, the document's cells in the editor), since a
//           room never leaves its district; a chunk without a source stops
//           at its edge. A district line of 56 cells has 49 slots, two
//           digits with both parities: a chunk's cells 8 and 9 share one,
//           and so do the two cells either side of an inner chunk edge. The
//           rooms of one wall are disjoint runs, so their first cells climb
//           strictly; two of them meet on a shared slot only when a one-cell
//           room fills the pair's first cell and the next room starts on its
//           second. That room owns the cell after it, so it takes that
//           cell's slot instead, which nobody else can claim (two one-cell
//           rooms side by side on a pair would still meet; never measured).
//           Only a room holds a slot: a corridor cell before the pair never
//           bumps — the plan and the stamped chunk name corridor segments by
//           different ids, so a corridor read would bump the game and the
//           editor apart (seam.plannedClass).
//   wing    the corridor's GLOBAL row across the line (the cell on the far
//           side from the room), counted on from the district's first cell
//           along the line, modulo 10. A wall keeps its row and never leaves
//           its district, so the digit is constant down every corridor wall,
//           and the walls of that axis within ten rows — parallel wings 8-9
//           cells apart, stair lobbies, return halls, the next district's
//           corridors — read others. Both walls of a one-cell corridor share
//           its row; where the corridor widens into a lobby stretch, the far
//           wall of that stretch stands on another row and reads that row's
//           digit. Columns count five digits on from rows, and counting from
//           the same first cell as the index keeps that true in every
//           district: a row wall and a column wall that share digit and
//           index have their rooms' first cells about five cells apart.
// A room with doors onto two different corridor walls (a corner room, or
// one facing a lobby stretch) shows one number per wall. A number repeats
// ten rows away on its axis, or round a corner: about five cells off, nearer
// only where a door stands well along a long room (three cells, 3 times in
// 160 000 doors).
const WINGS = 10
const COLUMN_WING_OFFSET = 5
const SHARED_CELL = 9 // with cell 8, one slot inside every chunk

// Storey prefix, the LEVEL plates' rule (dressing/notices.js storeyNumber).
const storeyPrefix = (cy) => (cy >= 0 ? String(cy + 1) : `b${-cy}`)

// Slot of a district-local cell along a line: one per cell, less the shared
// pairs (13|0 at each inner chunk edge, 8|9 inside each chunk) before it.
const slotOf = (u) => u - Math.floor(u / CHUNK) - Math.floor((u + CHUNK - SHARED_CELL) / CHUNK)

// The space ids of the room-side cells of a wall line, by global cell along
// it. Inside the chunk they are read from its own data, past its edge from
// the seam source, which every chunk of the district shares — so each door
// of a room, whichever chunk hangs it, reads the same run.
// With rooms set, a cell that is not a room's reads 0.
function wallIds(data, axis, line, roomSide, rooms = false) {
  const v = axis === 'v'
  const x0 = data.cx * CHUNK
  const z0 = data.cz * CHUNK
  // The room's column (v) or row (h) beside the line.
  const across = (v ? x0 : z0) + line - (roomSide < 0 ? 1 : 0)
  return (t) => {
    const gx = v ? across : t
    const gz = v ? t : across
    const lx = gx - x0
    const lz = gz - z0
    if (lx >= 0 && lx < CHUNK && lz >= 0 && lz < CHUNK) {
      const i = cIdx(lx, lz)
      return rooms && data.spaceClass[i] !== SPACE_CLASS_ROOM ? 0 : data.spaceId[i]
    }
    const seam = data.seam
    if (!seam?.plannedId) return 0
    return rooms && seam.plannedClass?.(gx, gz) !== SPACE_CLASS_ROOM ? 0 : seam.plannedId(gx, gz)
  }
}

// The global cell along a wall line where the room behind a door begins.
function roomStart(idAt, t) {
  const id = idAt(t)
  if (id) while (idAt(t - 1) === id) t--
  return t
}

// A shared slot's second cell (9 inside a chunk, 0 past an inner chunk edge).
const sharesSlot = (u) => u % CHUNK === SHARED_CELL || (u > 0 && u % CHUNK === 0)

export function roomNumber(data, axis, line, cell, roomSide) {
  const skeleton = FAMILY_SKELETONS[data.mapFamily]
  const k = skeleton?.districtChunks ?? 4
  const off = skeleton?.districtOffset ?? 0
  const v = axis === 'v'
  const span = k * CHUNK
  const inDistrict = (g) => (((g + off * CHUNK) % span) + span) % span
  const idAt = wallIds(data, axis, line, roomSide)
  const start = roomStart(idAt, (v ? data.cz : data.cx) * CHUNK + cell)
  const u = inDistrict(start)
  // A one-cell room on the pair's first cell holds the shared slot.
  const before = wallIds(data, axis, line, roomSide, true)(start - 1)
  const bumped = sharesSlot(u) && before !== 0 && idAt(start - 2) !== before && idAt(start + 1) === idAt(start)
  const slot = slotOf(u) + (bumped ? 1 : 0)
  const odd = v ? roomSide < 0 : roomSide > 0
  const index = (2 * slot + (odd ? 1 : 2)) % 100
  // The corridor row: the cell on the far side of the line from the room,
  // counted on from the district's first cell along the line.
  const row = (v ? data.cx : data.cz) * CHUNK + line - (roomSide > 0 ? 1 : 0)
  const origin = (v ? data.cz : data.cx) * CHUNK
  const first = origin - inDistrict(origin)
  const wing = (((row + first) % WINGS) + WINGS + (v ? 0 : COLUMN_WING_OFFSET)) % WINGS
  return `${storeyPrefix(data.cy | 0)}${wing}${String(index).padStart(2, '0')}`
}

// The paint batch as the tone seed mesh.js reads (leafTint): brightness
// 1 - VAR + 2 VAR t, with t the tone above the dark-stain band.
const BATCH_DRIFT = 0.03
const toneOfDrift = (drift) => DOOR_DARK_CHANCE + (1 - DOOR_DARK_CHANCE) * (0.5 + drift / (2 * DOOR_TINT_VAR))
const WRONG_TONE = DOOR_DARK_CHANCE / 2

// Brightness factor of a leaf from its tone seed — the same mapping mesh.js
// applies to painted parts, for the veneer the joinery tints itself.
export function leafShade(tone) {
  if (tone < DOOR_DARK_CHANCE) return DOOR_DARK_TINT
  return 1 - DOOR_TINT_VAR + 2 * DOOR_TINT_VAR * ((tone - DOOR_DARK_CHANCE) / (1 - DOOR_DARK_CHANCE))
}

// The "wrong door": a rare dark-stained leaf. Lived-in floors keep it rare;
// worn and derelict wings (decay >= 0.6) hang it about twice as often.
const WRONG_LIVED = 0.028
const WRONG_DERELICT = 0.055

// How strongly a function keeps its leaf hung, as the exponent on the
// show-the-door gate (doors.js): P(leaf) = fraction^(1 / k). Fire, wash,
// store and guest-room doors are always there in a real building (k = 24
// hangs ~97% at the default half share — a guest room's number is on its
// leaf); suite connecting doors are often missing, and the plain room doors
// of derelict wings have been taken off.
const MUST_HANG = 24
const LEAF_KEEP = Object.freeze({
  [DOOR_GUEST]: MUST_HANG,
  [DOOR_WET]: MUST_HANG,
  [DOOR_SERVICE]: MUST_HANG,
  [DOOR_EGRESS]: MUST_HANG,
  [DOOR_ROOM]: 1,
  [DOOR_INTERNAL]: 0.6,
})

// Everything a doorway's dressing needs to agree with its building:
//   { fn, role, roomSide, decay, schedule, batch, tone, wrong, number,
//     privacy, keep }
//   fn        DOOR_* class (doorFunction.js)
//   role      SPACE_ROLE_* of the room it serves (0 when none / unknown)
//   roomSide  -1 / +1 face sign into that room (0 for egress doors)
//   decay     wear 0..1 of the room it serves, else its circulation
//   schedule  the department's door standard (doorSchedule)
//   batch     paint batch id: the department's order for the storey
//   tone      mesh.js leaf-tint seed: batch drift, or the dark stain
//   number    hotel room number string, or null
//   privacy   frosted glass if the leaf has a lite (bedrooms, washrooms)
//   keep      leaf-gate exponent (LEAF_KEEP, eased off in derelict wings)
export function scheduleDoor(data, axis, line, cell, set = worldSurfaceSet(data.mapFamily, data.worldSeed)) {
  const e = edgeContext(data, axis, line, cell, set)
  const family = data.mapFamily
  const seed = data.worldSeed | 0
  const v = axis === 'v'
  const ga = data.cx * CHUNK + (v ? line : cell)
  const gb = data.cz * CHUNK + (v ? cell : line)
  const cy = data.cy | 0

  // The circulation side of a room door, when it lies in this chunk.
  const corridor = e.roomSide ? (e.roomSide > 0 ? e.lo : e.hi) : (e.lo ?? e.hi)
  const corridorCtx = corridor && corridor.cls !== SPACE_ROOM ? corridor : null
  // A lone circulation side on a seam: the room (if any) is the far side.
  let roomSide = e.roomSide
  if (!roomSide && e.partial && e.fn === DOOR_ROOM) roomSide = e.lo ? 1 : -1

  // Department key: the planner district, else surfaceSet's 3x3-chunk block
  // (sewer chambers) — the same departments the room finishes follow, so a
  // sewer region hangs one door standard and the next may hang another.
  const schedule = doorSchedule(seed, family, districtKeyOf(data))

  const room = e.room
  const decay = room?.decay ?? corridorCtx?.decay ?? (e.lo ?? e.hi)?.decay ?? 0
  // The paint batch: the department's order for this storey. A seam door
  // cannot see the corridor it opens off, but every chunk knows its
  // district, and a corridor never leaves its district — so every door off
  // one corridor, seam doors included, takes the same drift.
  const batch = hash3i((seed ^ SALT_BATCH) | 0, schedule.key | 0, cy, MAP_FAMILY_CODES[family] ?? 0)
  const drift = (unit(batch) * 2 - 1) * BATCH_DRIFT
  const wrongChance = WRONG_LIVED + (WRONG_DERELICT - WRONG_LIVED) * smoothstep(0.5, 0.7, decay)
  // Seam doors sit on grid-aligned coordinates: hash twice so the rare roll
  // stays uniform over them.
  const wrong = unit(hash2i(hash3i((seed ^ SALT_WRONG) | 0, ga, gb, cy), v ? 1 : 2, 0x5eed)) < wrongChance

  // A hotel's corridor door into a room is a guest door, numbered and hung
  // like one, whatever the room's use. A line-0 door sees its far side
  // through the seam ring (doorFunction.js), and a district line opens only
  // corridor portals, so a suite door is never taken for a corridor door.
  // Only a room the schedule actually sees is numbered: a lone circulation
  // side at a document edge (or an unplanned neighbour) may open onto
  // anything, so it hangs an ordinary unnumbered leaf.
  const guest = baseFamilyOf(family) === MAP_FAMILY_HOTEL && (e.fn === DOOR_GUEST || e.fn === DOOR_ROOM) && !!room
  const keepBase = LEAF_KEEP[guest ? DOOR_GUEST : e.fn] ?? 1
  const derelict = !guest && (e.fn === DOOR_ROOM || e.fn === DOOR_INTERNAL) ? 1 - 0.4 * smoothstep(0.6, 0.95, decay) : 1
  return {
    fn: e.fn,
    role: room?.role ?? 0,
    roomSide,
    decay,
    schedule,
    batch: batch >>> 0,
    tone: wrong ? WRONG_TONE : toneOfDrift(drift),
    wrong,
    number: guest ? roomNumber(data, axis, line, cell, roomSide) : null,
    privacy: room ? room.role === SPACE_ROLE_BEDROOM || room.category === ZONE_WET : false,
    keep: keepBase * derelict,
  }
}

// Vision-lite glass from the wear field: clear on lived-in floors, dirty in
// worn wings, and in derelict ones now and then cracked or taped over.
// Wired safety glass stays wired (only its grime follows the wear); frosted
// privacy glass only where the room asks for it. `door.variant` is the
// doorway's own hash, so the rare broken pane is a fixed property of it.
export function liteGlass(door, wired) {
  const decay = door.decay ?? 0
  const r = unit(hash2i(SALT_GLASS, Math.floor((door.variant ?? 0.5) * 4294967296) | 0, 1))
  const roll = (r * 7.31) % 1
  if (wired) return { kind: GLASS_WIRED, dirt: 0.12 + 0.6 * decay }
  if (door.privacy) return { kind: GLASS_FROSTED, dirt: 0.1 + 0.4 * decay }
  if (decay >= 0.8 && r < 0.22) return { kind: r < 0.11 ? GLASS_CRACKED : GLASS_TAPED, dirt: 0.55 + 0.35 * roll }
  if (decay >= 0.45) return { kind: GLASS_DIRTY, dirt: 0.55 + 0.4 * smoothstep(0.45, 1, decay) }
  return { kind: GLASS_CLEAR, dirt: 0.1 + 0.4 * decay + 0.08 * roll }
}
