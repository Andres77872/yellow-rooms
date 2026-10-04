import stairwell from './packs/stairwell.js'
import street from './packs/street.js'
import showroom from './packs/showroom.js'
import pool from './packs/pool.js'
import babel from './packs/babel.js'
import suburb from './packs/suburb.js'
import terminal from './packs/terminal.js'
import theater from './packs/theater.js'
import playplace from './packs/playplace.js'
import train from './packs/train.js'
import house from './packs/house.js'
import funhouse from './packs/funhouse.js'

export * from './packs/stairwell.js'
export * from './packs/street.js'
export * from './packs/showroom.js'
export * from './packs/pool.js'
export * from './packs/babel.js'
export * from './packs/suburb.js'
export * from './packs/terminal.js'
export * from './packs/theater.js'
export * from './packs/playplace.js'
export * from './packs/train.js'
export * from './packs/house.js'
export * from './packs/funhouse.js'

// Prop registry: the liminal maps' Blender prop packs (class B), kept apart
// from the 23 furniture kinds (world/furniture.js) so the furniture tables,
// tests and budgets stay exact. Ids share the furniture record's u8 `kind`
// space (24..255, disjoint from every FURN_*). No furnishing grammar names
// them: props are only ever placed explicitly (editor kinds, ObjectTool).
//
// Each pack module (packs/<pack>.js) is plain data with no imports, so this
// file, objects/furniture/proxies.js and render/surfaces.js can all read it
// without a cycle. One kind:
//   { id, key: 'PROP_X', kind: '<GLB file stem>', name, cls: 'B',
//     dims: [w, d] collision footprint (m, unrotated, front toward +v),
//     height: model height budget (m),
//     boxes: [[u, yCentre, v, sizeU, sizeY, sizeV, tint], ...] the box
//       fallback drawn until (or instead of) the GLB, in the frame.js local
//       frame; tint is a FURN_TINT key or an [r, g, b] array,
//     proxies: [[u0, u1, v0, v1, y0, y1, t?], ...] 1-2 lamp-shadow boxes under
//       the objects/furniture/proxies.js contract (largest opacity first) }
// A pack may also carry `surfaces: { yr_<key>: [roughness, metalness] }` for
// the Blender material names it introduces (merged by render/surfaces.js).
// The GLBs live in public/models/<pack>/<kind>.glb.
export const PROP_PACKS = Object.freeze([
  stairwell,
  street,
  showroom,
  pool,
  babel,
  suburb,
  terminal,
  theater,
  playplace,
  train,
  house,
  funhouse,
])

export const PROP_KINDS = Object.freeze(
  PROP_PACKS.flatMap((p) => p.kinds.map((k) => Object.freeze({ ...k, pack: p.pack })))
)

const byId = (value) => Object.freeze(Object.fromEntries(PROP_KINDS.map((k) => [k.id, value(k)])))

export const PROP_BY_ID = byId((k) => k)
export const PROP_DIMS = byId((k) => k.dims)
export const PROP_HEIGHTS = byId((k) => k.height)
export const PROP_NAMES = byId((k) => k.name)

// Same frozen record shape as proxies.js box(); built here so proxies.js can
// import the table without the registry importing proxies.js back.
const proxyBox = ([u0, u1, v0, v1, y0, y1, t = 0]) => Object.freeze({ u0, u1, v0, v1, y0, y1, t })
export const PROP_PROXIES = byId((k) => Object.freeze(k.proxies.map(proxyBox)))

export const PROP_MODEL_FILES = Object.freeze(Object.fromEntries(
  PROP_PACKS.map((p) => [p.pack, Object.freeze(Object.fromEntries(p.kinds.map((k) => [k.id, k.kind])))])
))
