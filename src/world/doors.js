import { CHUNK, DOOR_SALT, vIdx, hIdx } from './constants.js'
import { hash2i } from './core/hash.js'
import { scheduleDoor } from './doorSchedule.js'
import { PASSAGE_DOOR, PASSAGE_WIDE } from './mapTypes.js'
import { worldSurfaceSet } from './surfaceSet.js'

// Decorative-door detection (THREE-free, so it runs headless under Vitest).
//
// Doorways are explicit generation metadata. Earlier versions inferred them
// from one-cell raster gaps, which produced fake frames on warehouse chunk
// boundaries because the detector could not inspect the neighbouring chunk.
//
// Returns descriptors in GRID space — mesh.js turns them into instance
// transforms. `leaf` (show the door?), `leaves[].hinge` (which side the panel
// lies against) and `leaves[].face` (which wall face) are derived
// deterministically from the doorway's GLOBAL edge coordinate, so a given
// doorway always looks identical across chunk reloads; it varies between seeds
// only because the wall layout does. What the door IS — its type, finish,
// paint batch, number and glass — comes from the building's door schedule
// (doorSchedule.js), keyed by the spaces it joins, never by per-door dice.
//
//   { axis: 'v'|'h', line, cell, leaf, leaves: [{ hinge: -1|1, face: -1|1 }], tone: 0..1, style: 0..1, variant: 0..1,
//     fn, role, roomSide, decay, schedule, batch, wrong, number, privacy }
//     v: line = lx (vertical grid line), cell = z (row along the line)
//     h: line = lz (horizontal grid line), cell = x (column along the line)
//     tone: leaf-colour seed — mesh.js maps it onto the painted-cream band
//           or the dark-stained "wrong door". The schedule sets it: one
//           +-3% batch drift per department storey (so per corridor), the
//           dark band for `wrong` doors.
//     style: leaf-style seed (two-panel / three-panel), the district's
//           panel count from the schedule.
//     variant: the doorway's own hash, for what really varies per door
//           (sign-plate text length, the rare broken vision lite).
//     fn ... privacy: the schedule (doorSchedule.js scheduleDoor); the kit
//           (objects/joinery/doorKit.js) reads fn, schedule and role.

const SALT_V = DOOR_SALT
const SALT_H = (DOOR_SALT ^ 0x68f1) | 0

// Late anomaly and transition carving can remove the last wall beside a door.
// Preserve the opening, but reclassify it as a wide threshold so rendering
// never places an unsupported frame into open floor.
export function normalizeDoorPassages(data) {
  let normalized = 0
  for (let lx = 0; lx < CHUNK; lx++) {
    for (let z = 0; z < CHUNK; z++) {
      if (data.passageV[vIdx(lx, z)] !== PASSAGE_DOOR) continue
      const lo = z > 0 && data.wallV[vIdx(lx, z - 1)] === 1
      const hi = z < CHUNK - 1 && data.wallV[vIdx(lx, z + 1)] === 1
      if (lo || hi) continue
      data.setPassageV(lx, z, PASSAGE_WIDE)
      normalized++
    }
  }
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let x = 0; x < CHUNK; x++) {
      if (data.passageH[hIdx(x, lz)] !== PASSAGE_DOOR) continue
      const lo = x > 0 && data.wallH[hIdx(x - 1, lz)] === 1
      const hi = x < CHUNK - 1 && data.wallH[hIdx(x + 1, lz)] === 1
      if (lo || hi) continue
      data.setPassageH(x, lz, PASSAGE_WIDE)
      normalized++
    }
  }
  return normalized
}

// Resolve the per-door cosmetic flags. `lo`/`hi` mark whether a REAL in-range
// wall exists on the low / high side, so open leaves always lie against an
// actual wall (never float off the chunk edge). A doorway that shows its door
// gets a PAIR of leaves — each half the framed opening, so the closed pair
// would fill it exactly — with one leaf on EACH face of the wall, so the door
// reads from both rooms instead of existing on a single side. Wall on both
// sides: one leaf per neighbour cell, mirrored through the opening. Wall on
// one side only (a corner doorway): both leaves fold into the same neighbour
// cell, one per face.
//
// Whether the door is hung follows its function: `fraction` is the base
// share, and the schedule's `keep` exponent bends it — u^keep < fraction —
// so fire, wash and guest-room doors nearly always show while suite doors
// often stand empty. Fraction 0 and 1 still mean never and always.
function decorate(axis, line, cell, lo, hi, ga, gb, salt, fraction, sched) {
  const h = hash2i(salt, ga, gb)
  const leaf = (lo || hi) && (h / 4294967296) ** sched.keep < fraction
  const face = (h & 2) === 2 ? 1 : -1
  const leaves = []
  if (leaf) {
    if (lo && hi) leaves.push({ hinge: -1, face }, { hinge: 1, face: -face })
    else {
      const hinge = hi ? 1 : -1
      leaves.push({ hinge, face }, { hinge, face: -face })
    }
  }
  // The doorway's own hash, independent of the swing bits above.
  const variant = hash2i(salt ^ 0x2b7d, ga, gb) / 4294967296
  const { fn, role, roomSide, decay, schedule, batch, tone, wrong, number, privacy } = sched
  return { axis, line, cell, leaf, leaves, tone, style: schedule.style, variant, fn, role, roomSide, decay, schedule, batch, wrong, number, privacy }
}

// One doorway as collectDoorways resolves it (the caller has checked the
// edge is a PASSAGE_DOOR). The dressing reads it to know whether a door is
// hung: a guest room whose leaf stands empty shows its number on the header.
export function doorwayAt(data, axis, line, cell, fraction, set = worldSurfaceSet(data.mapFamily, data.worldSeed)) {
  const v = axis === 'v'
  // Neighbours along the line: the wall either side of the gap.
  const wallAt = (c) => c >= 0 && c < CHUNK && (v ? data.wallV[vIdx(line, c)] : data.wallH[hIdx(c, line)]) === 1
  const ga = data.cx * CHUNK + (v ? line : cell)
  const gb = data.cz * CHUNK + (v ? cell : line)
  const sched = scheduleDoor(data, axis, line, cell, set)
  return decorate(axis, line, cell, wallAt(cell - 1), wallAt(cell + 1), ga, gb, v ? SALT_V : SALT_H, fraction, sched)
}

export function collectDoorways(data, fraction) {
  const out = []
  const set = worldSurfaceSet(data.mapFamily, data.worldSeed)

  // Vertical lines (lx): a gap runs along z; neighbours are the line at z +/- 1.
  for (let lx = 0; lx < CHUNK; lx++) {
    for (let z = 0; z < CHUNK; z++) {
      if (data.passageV[vIdx(lx, z)] === PASSAGE_DOOR) out.push(doorwayAt(data, 'v', lx, z, fraction, set))
    }
  }

  // Horizontal lines (lz): a gap runs along x; neighbours are the line at x +/- 1.
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let x = 0; x < CHUNK; x++) {
      if (data.passageH[hIdx(x, lz)] === PASSAGE_DOOR) out.push(doorwayAt(data, 'h', lz, x, fraction, set))
    }
  }

  return out
}
