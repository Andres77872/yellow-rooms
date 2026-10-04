import { DOOR_EGRESS, DOOR_GUEST, DOOR_INTERNAL, DOOR_ROOM, DOOR_SERVICE, DOOR_WET } from '../../doorFunction.js'
import {
  MAP_FAMILY_HOTEL,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
  SPACE_ROLE_DINING,
  SPACE_ROLE_LAUNDRY,
  SPACE_ROLE_LIBRARY,
  SPACE_ROLE_LOUNGE,
  SPACE_ROLE_MEETING,
} from '../../mapTypes.js'
import { baseFamilyOf, byFamily } from '../../families/registry.js'

// Family door kits: WHICH door a doorway shows, before doors.js builds it.
//
// One building type hangs a handful of door types, and the mix is what makes
// a corridor read as an office floor rather than a hotel or a plant room:
// flush veneer doors with a vision slot and a closer in offices, panelled
// mahogany with a brass number and a spy-hole in hotels, hollow-metal doors
// with wired glass in towers, rusting service doors in sewers.
//
// The type is chosen the way an architect's door schedule chooses it: by
// what the door is FOR (doorFunction.js) and by the department's standard
// (doorSchedule.js), never by per-door dice. Ordinary room doors take the
// district's standard type, species and ironmongery, so one corridor hangs
// one kind of door; bathrooms get a flush leaf without glass, plant and
// store rooms a painted leaf with a kick plate, the escape route its fire
// doors. A kit is a pure function of (family, door.fn, door.schedule,
// door.role, whether door.number is set), so a doorway looks identical on
// every chunk reload.
//
//   type    the family type name (veneer, panel, fire, guest...)
//   leaf    LEAF_PANEL (raised panels; door.style picks two/three)
//           | LEAF_FLUSH (plain slab)
//   finish  'paint' (family leaf colour) | 'wood' (veneer, `wood` tint)
//   lite    LITE_NONE | LITE_NARROW (vision slot) | LITE_SQUARE; `wired`
//           marks safety glass
//   handle  HANDLE_KNOB | HANDLE_LEVER | HANDLE_PULL | HANDLE_BAR (panic bar)
//   closer  overhead closer on the top rail
//   kick    kick plate at the foot
//   plate   PLATE_NONE | PLATE_NUMBER (hotel brass + spy-hole) | PLATE_SIGN
//   grille  low transfer grille (plant-room ventilation)
//   metal   linear F0 tint of the hardware

export const LEAF_PANEL = 0
export const LEAF_FLUSH = 1

export const LITE_NONE = 0
export const LITE_NARROW = 1
export const LITE_SQUARE = 2

export const HANDLE_KNOB = 0
export const HANDLE_LEVER = 1
export const HANDLE_PULL = 2
export const HANDLE_BAR = 3

export const PLATE_NONE = 0
export const PLATE_NUMBER = 1
export const PLATE_SIGN = 2

// Linear F0 tints for the metal hardware batch.
export const METAL_SATIN = Object.freeze([0.6, 0.6, 0.58])
export const METAL_STAINLESS = Object.freeze([0.52, 0.53, 0.53])
export const METAL_BRASS = Object.freeze([0.78, 0.56, 0.26])
export const METAL_BRONZE = Object.freeze([0.24, 0.17, 0.11])
export const METAL_BLACK = Object.freeze([0.05, 0.05, 0.05])
export const METAL_GALVANISED = Object.freeze([0.42, 0.43, 0.42])

// Linear veneer tints (light oak, cherry, walnut, mahogany).
const SPECIES = Object.freeze({
  oak: Object.freeze([0.46, 0.3, 0.15]),
  cherry: Object.freeze([0.34, 0.16, 0.08]),
  walnut: Object.freeze([0.17, 0.08, 0.04]),
  mahogany: Object.freeze([0.22, 0.07, 0.035]),
})
const METALS = Object.freeze({
  satin: METAL_SATIN,
  stainless: METAL_STAINLESS,
  brass: METAL_BRASS,
  bronze: METAL_BRONZE,
  black: METAL_BLACK,
  galvanised: METAL_GALVANISED,
})

// What a department may specify, per family, as weighted [name, weight]
// lists: the standard ROOM door, the veneer species, the ironmongery finish
// and the panel count of panelled leaves. doorSchedule.js draws one of each
// per district; the names resolve to kits below.
export const DOOR_VOCAB = Object.freeze({
  [MAP_FAMILY_OFFICE]: {
    standard: [['veneer', 6], ['panel', 4]],
    species: [['oak', 5], ['cherry', 3], ['walnut', 2]],
    metal: [['satin', 5], ['stainless', 3], ['black', 2]],
    panels: [[2, 6], [3, 4]],
  },
  [MAP_FAMILY_HOTEL]: {
    standard: [['guest', 1]],
    species: [['mahogany', 5], ['walnut', 3], ['cherry', 2]],
    metal: [['brass', 6], ['bronze', 4]],
    panels: [[2, 5], [3, 5]],
  },
  [MAP_FAMILY_TOWER]: {
    standard: [['metal', 6], ['sign', 4]],
    species: [['oak', 6], ['walnut', 4]],
    metal: [['stainless', 7], ['satin', 3]],
    panels: [[2, 1]],
  },
  [MAP_FAMILY_LATTICE]: {
    standard: [['vision', 55], ['plant', 45]],
    species: [['oak', 1]],
    metal: [['galvanised', 6], ['black', 4]],
    panels: [[2, 1]],
  },
  [MAP_FAMILY_SEWER]: {
    standard: [['grille', 1], ['vision', 1]],
    species: [['oak', 1]],
    metal: [['galvanised', 1]],
    panels: [[2, 1]],
  },
})

// Fallback schedule for door descriptors without one (tests, tools): the
// first entry of every list.
function firstSchedule(family) {
  const v = byFamily(DOOR_VOCAB, family)
  return { standard: v.standard[0][0], species: v.species[0][0], metal: v.metal[0][0], panels: v.panels[0][0] }
}

function kit(overrides) {
  return {
    type: '',
    leaf: LEAF_FLUSH,
    finish: 'paint',
    wood: null,
    lite: LITE_NONE,
    wired: false,
    handle: HANDLE_LEVER,
    closer: false,
    kick: false,
    plate: PLATE_NONE,
    grille: false,
    metal: METAL_SATIN,
    ...overrides,
  }
}

// Public hotel rooms carry a name plaque, not a room number; a guest leaf
// carries the schedule's number, and a leaf the schedule did not number (no
// room seen behind it) carries no plate at all rather than an invented one.
const PUBLIC_ROLES = new Set([SPACE_ROLE_LOUNGE, SPACE_ROLE_LIBRARY, SPACE_ROLE_DINING, SPACE_ROLE_MEETING])

// Each family's door types: name -> kit, given the district schedule `s` and
// the door. District-finished types take the schedule's species and metal;
// service and fire doors keep the family's utility ironmongery.
const TYPES = {
  [MAP_FAMILY_OFFICE]: {
    // Flush veneer with a vision slot and a closer: the commercial standard.
    veneer: (s) => kit({ finish: 'wood', wood: SPECIES[s.species], lite: LITE_NARROW, closer: true, kick: true, metal: METALS[s.metal] }),
    // Painted panel door with a knob: the older fit-out.
    panel: (s) => kit({ leaf: LEAF_PANEL, handle: HANDLE_KNOB, metal: METALS[s.metal] }),
    // Store, copy, server rooms: painted flush leaf, kick plate, name plaque.
    service: () => kit({ plate: PLATE_SIGN, kick: true }),
    // Washrooms: no glass, a transfer grille for the extract air.
    wet: (s) => kit({ plate: PLATE_SIGN, kick: true, grille: true, metal: METALS[s.metal] }),
    // Escape route: painted hollow-metal leaf, wired lite, closer, panic bar.
    fire: () => kit({ lite: LITE_NARROW, wired: true, handle: HANDLE_BAR, closer: true, kick: true, metal: METAL_STAINLESS }),
    // Room to room: a plain veneer leaf in the department's species.
    internal: (s) => kit({ finish: 'wood', wood: SPECIES[s.species], metal: METALS[s.metal] }),
  },
  [MAP_FAMILY_HOTEL]: {
    guest: (s, door) =>
      kit({
        leaf: LEAF_PANEL,
        finish: 'wood',
        wood: SPECIES[s.species],
        handle: HANDLE_LEVER,
        plate: PUBLIC_ROLES.has(door.role) ? PLATE_SIGN : door.number ? PLATE_NUMBER : PLATE_NONE,
        metal: METALS[s.metal],
      }),
    // Housekeeping / linen closet: painted, louvered, plain knob.
    closet: () => kit({ leaf: LEAF_PANEL, handle: HANDLE_KNOB, kick: true, metal: METAL_BRONZE, louvered: true }),
    // En-suite and staff kitchen: flush veneer, no glass, no plate.
    ensuite: (s) => kit({ finish: 'wood', wood: SPECIES[s.species], metal: METALS[s.metal] }),
    // Suite connecting door: the guest leaf without number or spy-hole.
    connecting: (s) => kit({ leaf: LEAF_PANEL, finish: 'wood', wood: SPECIES[s.species], metal: METALS[s.metal] }),
    // Stair and cross-corridor smoke doors.
    fire: () => kit({ lite: LITE_SQUARE, wired: true, handle: HANDLE_BAR, closer: true, kick: true, metal: METAL_SATIN }),
  },
  [MAP_FAMILY_TOWER]: {
    metal: (s) => kit({ lite: LITE_SQUARE, wired: true, closer: true, kick: true, metal: METALS[s.metal] }),
    sign: (s) => kit({ closer: true, kick: true, plate: PLATE_SIGN, metal: METALS[s.metal] }),
    service: () => kit({ kick: true, plate: PLATE_SIGN, metal: METAL_STAINLESS }),
    wet: () => kit({ closer: true, kick: true, grille: true, plate: PLATE_SIGN, metal: METAL_STAINLESS }),
    fire: () => kit({ lite: LITE_SQUARE, wired: true, handle: HANDLE_BAR, closer: true, kick: true, metal: METAL_STAINLESS }),
    internal: (s) => kit({ finish: 'wood', wood: SPECIES[s.species], metal: METALS[s.metal] }),
  },
  [MAP_FAMILY_LATTICE]: {
    vision: (s) => kit({ lite: LITE_NARROW, wired: true, closer: true, kick: true, metal: METALS[s.metal] }),
    plant: () => kit({ handle: HANDLE_PULL, grille: true, kick: true, metal: METAL_BLACK }),
    fire: () => kit({ lite: LITE_NARROW, wired: true, handle: HANDLE_BAR, closer: true, kick: true, metal: METAL_GALVANISED }),
    plain: (s) => kit({ handle: HANDLE_PULL, metal: METALS[s.metal] }),
  },
  [MAP_FAMILY_SEWER]: {
    grille: () => kit({ handle: HANDLE_PULL, grille: true, metal: METAL_GALVANISED }),
    vision: () => kit({ lite: LITE_SQUARE, wired: true, handle: HANDLE_LEVER, kick: true, metal: METAL_GALVANISED }),
    service: () => kit({ handle: HANDLE_PULL, grille: true, kick: true, metal: METAL_GALVANISED }),
    // Bulkhead escape door: no glass, panic bar and closer.
    bulkhead: () => kit({ handle: HANDLE_BAR, closer: true, metal: METAL_GALVANISED }),
  },
}

// Function class -> type name. DOOR_ROOM (and anything a family does not
// list) takes the district standard.
const ROUTES = {
  [MAP_FAMILY_OFFICE]: { [DOOR_EGRESS]: 'fire', [DOOR_SERVICE]: 'service', [DOOR_WET]: 'wet', [DOOR_INTERNAL]: 'internal' },
  [MAP_FAMILY_HOTEL]: { [DOOR_EGRESS]: 'fire', [DOOR_SERVICE]: 'closet', [DOOR_WET]: 'ensuite', [DOOR_INTERNAL]: 'connecting', [DOOR_GUEST]: 'guest' },
  [MAP_FAMILY_TOWER]: { [DOOR_EGRESS]: 'fire', [DOOR_SERVICE]: 'service', [DOOR_WET]: 'wet', [DOOR_INTERNAL]: 'internal' },
  [MAP_FAMILY_LATTICE]: { [DOOR_EGRESS]: 'fire', [DOOR_SERVICE]: 'plant', [DOOR_WET]: 'plant', [DOOR_INTERNAL]: 'plain' },
  [MAP_FAMILY_SEWER]: { [DOOR_EGRESS]: 'bulkhead', [DOOR_SERVICE]: 'service', [DOOR_WET]: 'grille', [DOOR_INTERNAL]: 'grille' },
}

// A liminal family hangs its base family's kit (§5.1: T[f] ?? T[base] ?? office).
const familyOf = (family) =>
  TYPES[family] ? family : TYPES[baseFamilyOf(family)] ? baseFamilyOf(family) : MAP_FAMILY_OFFICE

// The type name a door gets: its function class first, the district
// standard for ordinary rooms. A hotel laundry is serviced by housekeeping,
// so it hangs the louvered closet door rather than an en-suite leaf.
export function doorType(family, door) {
  const f = familyOf(family)
  const fn = door.fn ?? DOOR_ROOM
  if (baseFamilyOf(f) === MAP_FAMILY_HOTEL && fn === DOOR_WET && door.role === SPACE_ROLE_LAUNDRY) return 'closet'
  const s = door.schedule ?? firstSchedule(f)
  return ROUTES[f][fn] ?? s.standard
}

// Every type name a family can hang (tests, tools).
export function doorTypes(family) {
  return Object.keys(TYPES[familyOf(family)])
}

export function doorKit(family, door) {
  const f = familyOf(family)
  const type = doorType(f, door)
  const make = TYPES[f][type] ?? TYPES[f][firstSchedule(f).standard]
  return { ...make(door.schedule ?? firstSchedule(f), door), type }
}
