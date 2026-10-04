import { CHUNK } from '../../constants.js'
import { exitCellClear } from '../../tiles/cells.js'
import { cellWalkable } from '../../tiles/holeMasks.js'
import { bakeExitsAt } from '../../tiles/familyChunk.js'
import { tileKeyOf } from '../../tiles/tileKey.js'
import { DISTRICT, EXIT_CY, TILE, districtLayout, exitAnchor, spawnCell } from './geometry.js'

// The stairwell's spawn and exit hooks (spec §8.1, §8.2, §12.1).
//
// Spawn: district (0,0), the landing inside shaft A's fire door, storey 0.
// Exit: shaft B's landing at G = −(15 + hash % 26) ∈ [−40, −15] in district
// (0,0). Shaft B runs through every storey and band −1 always holds an A↔B
// transfer at storey −3, so the route is down A to −3, across, down B to G,
// all inside district (0,0) (proofBox).
export { exitAnchor }

export const stub = false

// §8.2: incremented on the last-resort path; the family suite requires 0.
export const exitHookStats = { lastResort: 0 }

export const exitBounds = Object.freeze({ minChunks: 0, maxChunks: DISTRICT, cy: EXIT_CY })

// District (0,0) × storeys [G − 1, 1].
export const proofBox = (anchor) => ({
  chunks: { x0: 0, z0: 0, x1: DISTRICT - 1, z1: DISTRICT - 1 },
  cy: [anchor.cy - 1, 1],
})

export function spawn({ worldSeed = 0 } = {}) {
  const s = spawnCell(worldSeed >>> 0)
  return { cx: s.cx, cz: s.cz, lx: s.lx, lz: s.lz, yaw: null }
}

const asExit = (gx, gz, cy) => {
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  return { cx, cy, cz, lx: gx - cx * CHUNK, lz: gz - cz * CHUNK }
}

// The fallback storeys around G (§8.2: up to 8 steps), all inside the proof
// box and the exit bounds: G, G + 1, G − 1, G + 2 … G + 8.
function fallbackStoreys(G) {
  const out = [G, G + 1, G - 1]
  for (let k = 2; k <= 8; k++) out.push(G + k)
  return out.filter((y) => y >= EXIT_CY[0] && y <= EXIT_CY[1])
}

export function exit({ worldSeed = 0, config, generate } = {}) {
  const seed = worldSeed >>> 0
  const anchor = exitAnchor(seed)
  const ok = (c) => {
    const d = generate(c.cx, c.cy, c.cz)
    return !!d && cellWalkable(d, c.lx, c.lz) && exitCellClear(d, c.lx, c.lz)
  }
  // 1. The anchor tile's markExit candidates (B's landing outside its door,
  //    then inside it).
  const k = tileKeyOf(TILE, anchor.cx, anchor.cy, anchor.cz)
  const marked = (config ? bakeExitsAt(seed, k, config) : []).map((c) => asExit(c.gx, c.gz, c.cy))
  for (const c of marked) if (ok(c)) return c
  // 2. The same two cells (then shaft A's) on the storeys around G.
  const L = districtLayout(seed, 0, 0)
  for (const cy of fallbackStoreys(anchor.cy)) {
    for (const { x: gx, z: gz } of [L.B.out, L.B.inside, L.A.out, L.A.inside]) {
      const c = asExit(gx, gz, cy)
      if (ok(c)) return c
    }
  }
  // 3. Last resort: the anchor tile's first candidate, unconditionally.
  exitHookStats.lastResort++
  return marked[0] ?? { cx: anchor.cx, cy: anchor.cy, cz: anchor.cz, lx: anchor.lx, lz: anchor.lz }
}
