import { CELL, CHUNK, cIdx } from '../../constants.js'
import { CELL_BRIDGE } from '../../mapTypes.js'
import { ACCENT_CYCLE, LATTICE_TINT } from './palette.js'
import { STAIR_E, STAIR_W } from '../../structures/slab.js'

// Tower-family extras layered over the office dressing: deck seam strips
// along the skybridge (the boundary cue a long exposed span needs), and a
// per-floor accent marker at every stair landing — the floor-first anchor cue
// from the wayfinding research, so each level of the tower is identifiable
// the moment you arrive on it.

const SEAM_STEP = 4

export function collectTowerExtras(data, props, signs) {
  const chunkGx = data.cx * CHUNK
  const chunkGz = data.cz * CHUNK

  const kindAt = (lx, lz) =>
    lx >= 0 && lx < CHUNK && lz >= 0 && lz < CHUNK
      ? data.cellKind[cIdx(lx, lz)]
      : -1

  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      if (kindAt(lx, lz) !== CELL_BRIDGE) continue
      const alongX = kindAt(lx - 1, lz) === CELL_BRIDGE || kindAt(lx + 1, lz) === CELL_BRIDGE
      const g = alongX ? chunkGx + lx : chunkGz + lz
      if (((g % SEAM_STEP) + SEAM_STEP) % SEAM_STEP !== 0) continue
      props.push(alongX
        ? { px: (lx + 0.5) * CELL, py: 0.015, pz: (lz + 0.5) * CELL, sx: 0.16, sy: 0.03, sz: CELL, tint: LATTICE_TINT.seam }
        : { px: (lx + 0.5) * CELL, py: 0.015, pz: (lz + 0.5) * CELL, sx: CELL, sy: 0.03, sz: 0.16, tint: LATTICE_TINT.seam })
    }
  }

  // Floor identity marker: a lit accent band above each stair landing, keyed
  // by the floor index so every level wears one consistent colour.
  const accent = ACCENT_CYCLE[((data.cy % ACCENT_CYCLE.length) + ACCENT_CYCLE.length) % ACCENT_CYCLE.length]
  const marker = (cell, dir) => {
    if (!cell) return
    const horizontal = dir === STAIR_E || dir === STAIR_W
    signs.push({
      px: (cell.lx + 0.5) * CELL,
      py: 2.45,
      pz: (cell.lz + 0.5) * CELL,
      sx: horizontal ? 0.12 : 0.7,
      sy: 0.14,
      sz: horizontal ? 0.7 : 0.12,
      tint: accent,
    })
  }
  marker(data.stairUp?.landing, data.stairUp?.dir)
  marker(data.stairDown?.exit, data.stairDown?.dir)
}
