// The rooms layer (v23): everything that makes a carved space read as a NAMED
// room lives under this folder.
//
//   catalog.js  — piece kinds, room types (anchor/whitelist/grammar), the
//                 per-map-family catalogs (which rooms exist there, quotas,
//                 election bands), and the sewer chamber roll table. The
//                 single tuning surface for room mixes.
//   election.js — plan-time role election over a finished office district
//                 plan, budgeted by the selected family's catalog and topped
//                 up by the deterministic quota backstop.
//   furnish.js  — the grammar interpreter that turns a room type into
//                 collision-real furniture at chunk-build time.
//   shapes.js   — the leaf-field corner-exchange pass that makes room shapes
//                 (not just sizes) procedural.
//
// officePlan.js consumes election + shapes while planning; furniture.js
// consumes furnish at stamp time for every family (sewer chambers roll their
// roles at stamp time instead); both stay byte-deterministic per
// (seed, district/chunk, config).
export {
  FURN_DESK,
  FURN_CHAIR,
  FURN_TABLE,
  FURN_CABINET,
  FURN_COPIER,
  FURN_COOLER,
  FURN_PLANT,
  FURN_RACK,
  FURN_SOFA,
  FURN_BOOKSHELF,
  FURN_WHITEBOARD,
  FURN_BED,
  FURN_NIGHTSTAND,
  FURN_WARDROBE,
  FURN_TOILET,
  FURN_SINK,
  FURN_TUB,
  FURN_COUNTER,
  FURN_STOVE,
  FURN_FRIDGE,
  FURN_TV,
  FURN_ARMCHAIR,
  FURN_WASHER,
  ROLE_MARKER_KINDS,
  ROOM_TYPES,
  ORDINARY_THEMES,
  HOTEL_ORDINARY_THEMES,
  FAMILY_ORDINARY_THEMES,
  ORDINARY_BARE_CHANCE,
  FAMILY_ROOM_CATALOGS,
  SEWER_CHAMBER_CATALOG,
  ordinaryThemesFor,
  roomCatalogFor,
  roomTypeFor,
} from './catalog.js'
export { assignSpaceRoles, roomFurnishMetrics } from './election.js'
export { furnishRoleRoom, furnishOrdinaryRoom, cellEdges } from './furnish.js'
export { carveLeafShapes } from './shapes.js'
