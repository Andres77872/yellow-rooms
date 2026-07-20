import { deepFreeze } from '../mapFamily.js'

// Tall-structure slab halves expose void cells that kill below a death plane.
// Tower uses one flat plane at the structure base; lattice derives a per-cell
// plane from the nearest anchor's exposure. The carrier shape is shared so
// validation, audit, and the runtime hard-void query consume one format.
export function lethalVoidHalfFromSlice(structure, slice, deathYmmAt) {
  if (
    !slice ||
    slice.hasRoom === false ||
    slice.voidCells.length === 0
  ) return null
  return deepFreeze({
    id: structure.id,
    family: structure.family,
    lowerCy: slice.lowerCy,
    cells: slice.voidCells.map(({ lx, lz }) => ({
      lx,
      lz,
      deathYmm: deathYmmAt(lx, lz),
    })),
  })
}
