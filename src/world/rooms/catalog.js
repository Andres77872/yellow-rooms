import {
  MAP_FAMILY_HOTEL,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
  SEWER_MODULE_CHAMBER_LARGE,
  SEWER_MODULE_CHAMBER_SMALL,
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
  SPACE_ROLE_OFFICE,
  SPACE_ROLE_SERVER,
  SPACE_ROLE_STORAGE,
} from '../mapTypes.js'

// The room catalog (v23): one declarative source of truth for what a "named
// room" is. Three layers of vocabulary live here:
//
//   piece kinds   — the collision-real furniture vocabulary (FURN_*);
//   room types    — per SPACE_ROLE_*: the anchor piece that must land, the
//                   strict piece whitelist, and the furnishing grammar
//                   (an op program interpreted by rooms/furnish.js);
//   family catalogs — per MAP_FAMILY_*: which room types a district may
//                   elect, their per-district quotas, and the election bands
//                   (rooms/election.js walks these against each room's size
//                   and anchor-hosting metrics). Sewer has no districts, so
//                   its prescribed chambers roll SEWER_CHAMBER_CATALOG instead
//                   (zones/sewer.js assigns the role at stamp time).
//
// The same room type always furnishes the same way in every family — a
// library IS bookshelf rows and a reading table — while the family decides
// whether libraries exist there at all and how many. That split is what keeps
// "furniture consistent with the room type" and "room mix consistent with the
// map type" from ever fighting each other.

// --- Piece kinds -----------------------------------------------------------
// Canonical home of the furniture vocabulary (moved from furniture.js, which
// re-exports them for the existing import surface).
export const FURN_DESK = 1
export const FURN_CHAIR = 2
export const FURN_TABLE = 3
export const FURN_CABINET = 4
export const FURN_COPIER = 5
export const FURN_COOLER = 6
export const FURN_PLANT = 7
export const FURN_RACK = 8
export const FURN_SOFA = 9
export const FURN_BOOKSHELF = 10
export const FURN_WHITEBOARD = 11
// Residential vocabulary (hotel family).
export const FURN_BED = 12
export const FURN_NIGHTSTAND = 13
export const FURN_WARDROBE = 14
export const FURN_TOILET = 15
export const FURN_SINK = 16
export const FURN_TUB = 17
export const FURN_COUNTER = 18
export const FURN_STOVE = 19
export const FURN_FRIDGE = 20
export const FURN_TV = 21
export const FURN_ARMCHAIR = 22
export const FURN_WASHER = 23

// Role-marker kinds read as landmarks: they appear ONLY inside rooms whose
// role owns them, never in ordinary themed rooms. The residential fixtures
// (bed, bathroom porcelain, kitchen appliances, the TV wall, washers) carry
// the same landmark weight in the hotel family.
export const ROLE_MARKER_KINDS = Object.freeze([
  FURN_COPIER,
  FURN_RACK,
  FURN_BOOKSHELF,
  FURN_COOLER,
  FURN_BED,
  FURN_TOILET,
  FURN_SINK,
  FURN_TUB,
  FURN_COUNTER,
  FURN_STOVE,
  FURN_FRIDGE,
  FURN_TV,
  FURN_WASHER,
])

// --- Room types (shared across families) -----------------------------------
// grammar ops (interpreted in declared order by rooms/furnish.js):
//   {op:'row', kind, min, max, chance, salt}  wall-hugging run; the first
//                                             `min` placements are anchors
//                                             (unconditional).
//   {op:'conference', minArea?}               centred table + chairs; skipped
//                                             below minArea.
//   {op:'workstations', ensure?}              wall desk + chair pairs; with
//                                             `ensure`, a lone wall desk is
//                                             placed if no pairing fits, so
//                                             the anchor guarantee holds.
//   {op:'accent', kinds:[a,b], chance, salt}  ONE per-room elected accent.
export const ROOM_TYPES = Object.freeze({
  [SPACE_ROLE_MEETING]: deepFreeze({
    key: 'meeting',
    anchor: FURN_TABLE,
    whitelist: [FURN_TABLE, FURN_CHAIR, FURN_WHITEBOARD],
    grammar: [
      { op: 'conference' },
      { op: 'row', kind: FURN_WHITEBOARD, min: 1, max: 1, chance: 1, salt: 0x9b1d },
    ],
  }),
  [SPACE_ROLE_BREAK]: deepFreeze({
    key: 'break',
    anchor: FURN_COOLER,
    whitelist: [FURN_COOLER, FURN_SOFA, FURN_TABLE, FURN_CHAIR, FURN_CABINET, FURN_PLANT],
    grammar: [
      { op: 'row', kind: FURN_COOLER, min: 1, max: 1, chance: 1, salt: 0xb3e9 },
      { op: 'row', kind: FURN_SOFA, min: 1, max: 1, chance: 1, salt: 0x50fa },
      { op: 'conference', minArea: 8 },
      { op: 'accent', kinds: [FURN_CABINET, FURN_PLANT], chance: 0.55, salt: 0x5709 },
    ],
  }),
  [SPACE_ROLE_COPY]: deepFreeze({
    key: 'copy',
    anchor: FURN_COPIER,
    whitelist: [FURN_COPIER, FURN_CABINET],
    grammar: [
      { op: 'row', kind: FURN_COPIER, min: 1, max: 3, chance: 0.5, salt: 0xc09c },
      { op: 'row', kind: FURN_CABINET, min: 0, max: 1, chance: 0.4, salt: 0xc0b1 },
    ],
  }),
  [SPACE_ROLE_ARCHIVE]: deepFreeze({
    key: 'archive',
    anchor: FURN_BOOKSHELF,
    whitelist: [FURN_BOOKSHELF, FURN_CABINET],
    grammar: [
      { op: 'row', kind: FURN_BOOKSHELF, min: 2, max: 4, chance: 0.6, salt: 0xb00c },
      { op: 'row', kind: FURN_CABINET, min: 0, max: 1, chance: 0.5, salt: 0xa2c4 },
    ],
  }),
  [SPACE_ROLE_SERVER]: deepFreeze({
    key: 'server',
    anchor: FURN_RACK,
    whitelist: [FURN_RACK],
    grammar: [
      { op: 'row', kind: FURN_RACK, min: 2, max: 5, chance: 0.6, salt: 0x5e22 },
    ],
  }),
  [SPACE_ROLE_STORAGE]: deepFreeze({
    key: 'storage',
    anchor: FURN_CABINET,
    whitelist: [FURN_CABINET],
    grammar: [
      { op: 'row', kind: FURN_CABINET, min: 1, max: 3, chance: 0.5, salt: 0x570a },
    ],
  }),
  [SPACE_ROLE_LIBRARY]: deepFreeze({
    key: 'library',
    anchor: FURN_BOOKSHELF,
    whitelist: [FURN_BOOKSHELF, FURN_TABLE, FURN_CHAIR, FURN_PLANT],
    grammar: [
      // Shelf runs are the read; a reading island lands in genuinely big rooms.
      { op: 'row', kind: FURN_BOOKSHELF, min: 2, max: 5, chance: 0.65, salt: 0x11b5 },
      { op: 'conference', minArea: 12 },
      { op: 'row', kind: FURN_PLANT, min: 0, max: 1, chance: 0.35, salt: 0x11b6 },
    ],
  }),
  [SPACE_ROLE_OFFICE]: deepFreeze({
    key: 'office',
    anchor: FURN_DESK,
    whitelist: [FURN_DESK, FURN_CHAIR, FURN_CABINET, FURN_PLANT],
    grammar: [
      // A private office HAS its desk: pairing first, lone wall desk fallback.
      { op: 'workstations', ensure: { salt: 0x0ff1 } },
      { op: 'row', kind: FURN_CABINET, min: 0, max: 1, chance: 0.45, salt: 0x0ff2 },
      { op: 'row', kind: FURN_PLANT, min: 0, max: 1, chance: 0.3, salt: 0x0ff3 },
    ],
  }),
  [SPACE_ROLE_LOUNGE]: deepFreeze({
    key: 'lounge',
    anchor: FURN_SOFA,
    whitelist: [FURN_SOFA, FURN_PLANT],
    grammar: [
      { op: 'row', kind: FURN_SOFA, min: 1, max: 2, chance: 0.6, salt: 0x10fa },
      { op: 'row', kind: FURN_PLANT, min: 0, max: 2, chance: 0.5, salt: 0x10fb },
    ],
  }),
  // Residential room types (hotel family). Same declarative contract:
  // the anchor fixture always lands, everything else stays sparse — a made
  // bed in an empty room is the hotel read, not a fully staged showroom.
  [SPACE_ROLE_BEDROOM]: deepFreeze({
    key: 'bedroom',
    anchor: FURN_BED,
    whitelist: [FURN_BED, FURN_NIGHTSTAND, FURN_WARDROBE, FURN_ARMCHAIR, FURN_PLANT],
    grammar: [
      // A second bed reads as the twin guest room; nightstands trail the beds.
      { op: 'row', kind: FURN_BED, min: 1, max: 2, chance: 0.3, salt: 0xbe01 },
      { op: 'row', kind: FURN_NIGHTSTAND, min: 0, max: 2, chance: 0.6, salt: 0xbe02 },
      { op: 'row', kind: FURN_WARDROBE, min: 0, max: 1, chance: 0.5, salt: 0xbe03 },
      { op: 'accent', kinds: [FURN_ARMCHAIR, FURN_PLANT], chance: 0.35, salt: 0xbe04 },
    ],
  }),
  [SPACE_ROLE_BATHROOM]: deepFreeze({
    key: 'bathroom',
    anchor: FURN_TOILET,
    whitelist: [FURN_TOILET, FURN_SINK, FURN_TUB, FURN_CABINET],
    grammar: [
      { op: 'row', kind: FURN_TOILET, min: 1, max: 1, chance: 1, salt: 0xba01 },
      { op: 'row', kind: FURN_SINK, min: 1, max: 1, chance: 1, salt: 0xba02 },
      { op: 'row', kind: FURN_TUB, min: 0, max: 1, chance: 0.55, salt: 0xba03 },
      { op: 'row', kind: FURN_CABINET, min: 0, max: 1, chance: 0.25, salt: 0xba04 },
    ],
  }),
  [SPACE_ROLE_KITCHEN]: deepFreeze({
    key: 'kitchen',
    anchor: FURN_COUNTER,
    whitelist: [FURN_COUNTER, FURN_STOVE, FURN_FRIDGE, FURN_SINK, FURN_CABINET, FURN_TABLE, FURN_CHAIR],
    grammar: [
      // The counter run is the read; range and fridge complete the work line.
      { op: 'row', kind: FURN_COUNTER, min: 1, max: 3, chance: 0.6, salt: 0xc101 },
      { op: 'row', kind: FURN_STOVE, min: 1, max: 1, chance: 1, salt: 0xc102 },
      { op: 'row', kind: FURN_FRIDGE, min: 1, max: 1, chance: 1, salt: 0xc103 },
      { op: 'row', kind: FURN_SINK, min: 0, max: 1, chance: 0.4, salt: 0xc104 },
      { op: 'conference', minArea: 16 },
    ],
  }),
  [SPACE_ROLE_LIVING]: deepFreeze({
    key: 'living',
    anchor: FURN_SOFA,
    whitelist: [FURN_SOFA, FURN_ARMCHAIR, FURN_TV, FURN_TABLE, FURN_CHAIR, FURN_PLANT],
    grammar: [
      { op: 'row', kind: FURN_SOFA, min: 1, max: 2, chance: 0.4, salt: 0x1101 },
      { op: 'row', kind: FURN_TV, min: 1, max: 1, chance: 1, salt: 0x1102 },
      { op: 'row', kind: FURN_ARMCHAIR, min: 0, max: 2, chance: 0.45, salt: 0x1103 },
      { op: 'accent', kinds: [FURN_PLANT, FURN_ARMCHAIR], chance: 0.5, salt: 0x1104 },
    ],
  }),
  [SPACE_ROLE_DINING]: deepFreeze({
    key: 'dining',
    anchor: FURN_TABLE,
    whitelist: [FURN_TABLE, FURN_CHAIR, FURN_CABINET, FURN_PLANT],
    grammar: [
      { op: 'conference' },
      { op: 'row', kind: FURN_CABINET, min: 0, max: 1, chance: 0.5, salt: 0xd101 }, // sideboard
      { op: 'row', kind: FURN_PLANT, min: 0, max: 1, chance: 0.3, salt: 0xd102 },
    ],
  }),
  [SPACE_ROLE_LAUNDRY]: deepFreeze({
    key: 'laundry',
    anchor: FURN_WASHER,
    whitelist: [FURN_WASHER, FURN_CABINET],
    grammar: [
      { op: 'row', kind: FURN_WASHER, min: 1, max: 3, chance: 0.55, salt: 0x1a01 },
      { op: 'row', kind: FURN_CABINET, min: 0, max: 1, chance: 0.4, salt: 0x1a02 },
    ],
  }),
})

// --- Ordinary-room themes (unnamed rooms) -----------------------------------
// One theme per room, elected from the district-stable space id
// (rooms/furnish.js). `window` values are cumulative thresholds on one roll.
// Kinds stay disjoint from ROLE_MARKER_KINDS so named rooms keep their
// landmark value.
export const ORDINARY_BARE_CHANCE = 0.25
export const ORDINARY_THEMES = Object.freeze([
  deepFreeze({
    key: 'huddle',
    window: 0.2,
    grammar: [
      { op: 'conference' },
      { op: 'row', kind: FURN_WHITEBOARD, min: 0, max: 1, chance: 0.3, salt: 0x9b1e },
    ],
  }),
  deepFreeze({
    key: 'workroom',
    window: 0.6,
    grammar: [
      { op: 'workstations' },
      { op: 'row', kind: FURN_CABINET, min: 0, max: 1, chance: 0.35, salt: 0xf17e },
      { op: 'row', kind: FURN_PLANT, min: 0, max: 1, chance: 0.25, salt: 0x9147 },
    ],
  }),
  deepFreeze({
    key: 'lounge',
    window: 0.8,
    grammar: [
      { op: 'row', kind: FURN_SOFA, min: 1, max: 1, chance: 1, salt: 0x50fb },
      { op: 'row', kind: FURN_PLANT, min: 0, max: 1, chance: 0.6, salt: 0x9148 },
    ],
  }),
  deepFreeze({
    key: 'stash',
    window: 1.01,
    grammar: [
      { op: 'row', kind: FURN_CABINET, min: 1, max: 2, chance: 0.4, salt: 0x570b },
    ],
  }),
])

// Hotel ordinary rooms furnish from a residential theme set — no desks or
// whiteboards behind an unmarked hotel door. Same one-theme-per-room
// contract, same bare share (an empty guest room IS the genre).
export const HOTEL_ORDINARY_THEMES = Object.freeze([
  deepFreeze({
    key: 'sitting',
    window: 0.35,
    grammar: [
      { op: 'row', kind: FURN_ARMCHAIR, min: 1, max: 2, chance: 0.55, salt: 0x9150 },
    ],
  }),
  deepFreeze({
    key: 'guest',
    window: 0.65,
    grammar: [
      { op: 'row', kind: FURN_WARDROBE, min: 1, max: 1, chance: 1, salt: 0x9151 },
      { op: 'row', kind: FURN_NIGHTSTAND, min: 0, max: 1, chance: 0.5, salt: 0x9152 },
    ],
  }),
  deepFreeze({
    key: 'parlor',
    window: 0.85,
    grammar: [
      { op: 'row', kind: FURN_SOFA, min: 1, max: 1, chance: 1, salt: 0x9153 },
      { op: 'row', kind: FURN_PLANT, min: 0, max: 1, chance: 0.6, salt: 0x9154 },
    ],
  }),
  deepFreeze({
    key: 'stash',
    window: 1.01,
    grammar: [
      { op: 'row', kind: FURN_CABINET, min: 1, max: 2, chance: 0.4, salt: 0x9155 },
    ],
  }),
])

// Per-family ordinary theme sets. Families without an entry keep the office
// set — byte-identical for every pre-hotel family.
export const FAMILY_ORDINARY_THEMES = Object.freeze({
  [MAP_FAMILY_HOTEL]: HOTEL_ORDINARY_THEMES,
})

export function ordinaryThemesFor(family) {
  return FAMILY_ORDINARY_THEMES[family] ?? ORDINARY_THEMES
}

// --- Per-family catalogs -----------------------------------------------------
// Election bands (rooms/election.js). A room is banded by its geometry and
// anchor-hosting metrics, then the band's entries are walked in declared
// order against one deterministic roll r:
//   large — area>=20, both spans >=4, free>=5
//   mid   — area>=10, free>=3
//   small — free>=3, wallFree>=1
// An entry takes the room when r < window, its quota is open, and the slice
// can host the anchor (wallFree >= entry.wallFree).
export const FAMILY_ROOM_CATALOGS = Object.freeze({
  // The office floor: the full institutional mix. Meeting rooms and the
  // library live in the big bays; copy/archive/private offices in the mid
  // rooms; storage closets in the leftovers.
  [MAP_FAMILY_OFFICE]: deepFreeze({
    quotas: {
      [SPACE_ROLE_MEETING]: 2,
      [SPACE_ROLE_LIBRARY]: 1,
      [SPACE_ROLE_SERVER]: 1,
      [SPACE_ROLE_BREAK]: 1,
      [SPACE_ROLE_COPY]: 2,
      [SPACE_ROLE_ARCHIVE]: 2,
      [SPACE_ROLE_OFFICE]: 3,
      [SPACE_ROLE_STORAGE]: 3,
      [SPACE_ROLE_LOUNGE]: 1,
    },
    election: {
      large: [
        { role: SPACE_ROLE_MEETING, window: 0.3, wallFree: 0 },
        { role: SPACE_ROLE_LIBRARY, window: 0.42, wallFree: 2 },
        { role: SPACE_ROLE_SERVER, window: 0.52, wallFree: 2 },
        { role: SPACE_ROLE_BREAK, window: 0.64, wallFree: 2 },
        { role: SPACE_ROLE_LOUNGE, window: 0.74, wallFree: 1 },
      ],
      mid: [
        { role: SPACE_ROLE_COPY, window: 0.14, wallFree: 1 },
        { role: SPACE_ROLE_ARCHIVE, window: 0.26, wallFree: 2 },
        { role: SPACE_ROLE_OFFICE, window: 0.42, wallFree: 1 },
        { role: SPACE_ROLE_STORAGE, window: 0.52, wallFree: 1 },
        { role: SPACE_ROLE_BREAK, window: 0.58, wallFree: 2 },
        { role: SPACE_ROLE_LOUNGE, window: 0.64, wallFree: 1 },
      ],
      small: [
        { role: SPACE_ROLE_STORAGE, window: 0.1, wallFree: 1 },
        { role: SPACE_ROLE_COPY, window: 0.16, wallFree: 1 },
        { role: SPACE_ROLE_OFFICE, window: 0.26, wallFree: 1 },
      ],
    },
  }),
  // Tower floors read as infrastructure: server/utility floors, stores, the
  // occasional observation lounge. No break rooms, copy rooms, or libraries —
  // nobody LIVED here.
  [MAP_FAMILY_TOWER]: deepFreeze({
    quotas: {
      [SPACE_ROLE_SERVER]: 2,
      [SPACE_ROLE_MEETING]: 1,
      [SPACE_ROLE_LOUNGE]: 2,
      [SPACE_ROLE_ARCHIVE]: 1,
      [SPACE_ROLE_OFFICE]: 1,
      [SPACE_ROLE_STORAGE]: 3,
    },
    election: {
      large: [
        { role: SPACE_ROLE_SERVER, window: 0.34, wallFree: 2 },
        { role: SPACE_ROLE_LOUNGE, window: 0.5, wallFree: 1 },
        { role: SPACE_ROLE_MEETING, window: 0.62, wallFree: 0 },
      ],
      mid: [
        { role: SPACE_ROLE_STORAGE, window: 0.22, wallFree: 1 },
        { role: SPACE_ROLE_ARCHIVE, window: 0.34, wallFree: 2 },
        { role: SPACE_ROLE_OFFICE, window: 0.46, wallFree: 1 },
        { role: SPACE_ROLE_LOUNGE, window: 0.54, wallFree: 1 },
      ],
      small: [
        { role: SPACE_ROLE_STORAGE, window: 0.12, wallFree: 1 },
        { role: SPACE_ROLE_OFFICE, window: 0.22, wallFree: 1 },
      ],
    },
  }),
  // Sewer has no office-fabric rooms at all (its chambers are landmarks of
  // the module grammar, furnished from SEWER_CHAMBER_CATALOG below — never
  // through district election), so its election catalog stays explicitly
  // empty. Lattice decks are bare by design, but the office shell AROUND the
  // structure (every floor outside the structure's vertical band) is real
  // fabric: it elects a sparse maintenance mix — stores, a control room, an
  // archive — so off-band floors read as the building the lattice was cut
  // from, not as sterile leftovers.
  [MAP_FAMILY_SEWER]: deepFreeze({ quotas: {}, election: { large: [], mid: [], small: [] } }),
  // The hotel floor: a residence, not an institution. Bedrooms are the
  // dominant named room — most mid rooms behind most doors ARE guest rooms —
  // with bathrooms threaded between them and exactly one of each communal
  // room (kitchen, living room, dining room, laundry) per district, plus a
  // lobby lounge and linen closets. The office-only vocabulary (copy, server,
  // break, library...) never appears: nobody WORKED here, they stayed here.
  [MAP_FAMILY_HOTEL]: deepFreeze({
    quotas: {
      [SPACE_ROLE_BEDROOM]: 5,
      [SPACE_ROLE_BATHROOM]: 3,
      [SPACE_ROLE_LIVING]: 1,
      [SPACE_ROLE_DINING]: 1,
      [SPACE_ROLE_KITCHEN]: 1,
      [SPACE_ROLE_LAUNDRY]: 1,
      [SPACE_ROLE_LOUNGE]: 1,
      [SPACE_ROLE_STORAGE]: 2,
    },
    election: {
      large: [
        // wallFree mirrors the type's unconditional wall rows: a living room
        // must host sofa AND TV, a kitchen counter+stove+fridge, a bathroom
        // toilet+sink (break-room precedent: min:1 rows are unconditional).
        { role: SPACE_ROLE_LIVING, window: 0.3, wallFree: 2 },
        { role: SPACE_ROLE_DINING, window: 0.42, wallFree: 0 },
        { role: SPACE_ROLE_BEDROOM, window: 0.62, wallFree: 1 },
        { role: SPACE_ROLE_KITCHEN, window: 0.72, wallFree: 3 },
        { role: SPACE_ROLE_LOUNGE, window: 0.8, wallFree: 1 },
      ],
      mid: [
        { role: SPACE_ROLE_BEDROOM, window: 0.32, wallFree: 1 },
        { role: SPACE_ROLE_BATHROOM, window: 0.44, wallFree: 2 },
        { role: SPACE_ROLE_KITCHEN, window: 0.52, wallFree: 3 },
        { role: SPACE_ROLE_LAUNDRY, window: 0.58, wallFree: 1 },
        { role: SPACE_ROLE_STORAGE, window: 0.64, wallFree: 1 },
        { role: SPACE_ROLE_DINING, window: 0.7, wallFree: 0 },
      ],
      small: [
        { role: SPACE_ROLE_BATHROOM, window: 0.18, wallFree: 2 },
        { role: SPACE_ROLE_STORAGE, window: 0.28, wallFree: 1 },
        { role: SPACE_ROLE_BEDROOM, window: 0.38, wallFree: 1 },
      ],
    },
  }),
  [MAP_FAMILY_LATTICE]: deepFreeze({
    quotas: {
      [SPACE_ROLE_SERVER]: 1,
      [SPACE_ROLE_ARCHIVE]: 1,
      [SPACE_ROLE_STORAGE]: 2,
    },
    election: {
      large: [
        { role: SPACE_ROLE_SERVER, window: 0.2, wallFree: 2 },
        { role: SPACE_ROLE_ARCHIVE, window: 0.32, wallFree: 2 },
      ],
      mid: [
        { role: SPACE_ROLE_STORAGE, window: 0.16, wallFree: 1 },
        { role: SPACE_ROLE_ARCHIVE, window: 0.26, wallFree: 2 },
      ],
      small: [
        { role: SPACE_ROLE_STORAGE, window: 0.12, wallFree: 1 },
      ],
    },
  }),
})

// Sewer chamber furnishing (no district plan exists to elect over): each
// prescribed chamber module (zones/sewer.js) rolls ONE cumulative window list
// by its kind, deterministically from the winning candidate seed. A roll past
// every window leaves the chamber bare — the empty pump room is a valid read.
// The vocabulary stays infrastructural: racks read as valve/pump controls,
// cabinets as maintenance stores. Rooms keep their SPACE_ROLE_* byte so the
// debug map, lamp character and dressing read them like any named room.
export const SEWER_CHAMBER_CATALOG = deepFreeze({
  [SEWER_MODULE_CHAMBER_LARGE]: [
    { role: SPACE_ROLE_SERVER, window: 0.45, salt: 0x5e31 },
    { role: SPACE_ROLE_STORAGE, window: 0.8, salt: 0x5e32 },
  ],
  [SEWER_MODULE_CHAMBER_SMALL]: [
    { role: SPACE_ROLE_STORAGE, window: 0.5, salt: 0x5e33 },
    { role: SPACE_ROLE_SERVER, window: 0.65, salt: 0x5e34 },
  ],
})

// Family resolution for planner-side callers. The pipeline fail-closes on
// invalid selections before any planner runs (resolveMapFamily), so this
// lookup only needs the selected key; absent/unknown selections keep the
// office default the rest of the generation stack assumes.
export function roomCatalogFor(config) {
  const family = config?.mapFamily?.selected
  return FAMILY_ROOM_CATALOGS[family] ?? FAMILY_ROOM_CATALOGS[MAP_FAMILY_OFFICE]
}

export function roomTypeFor(role) {
  return ROOM_TYPES[role] ?? null
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}
