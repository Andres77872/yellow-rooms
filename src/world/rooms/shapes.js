// Procedural room shapes (v22). The BSP pass hands every district a field of
// rectangular leaves; this pass exchanges corner rectangles between adjacent
// leaves so rooms stop being an all-rectangle grid: the donor becomes an
// L-room, the receiver grows an alcove bump. Sizes stay procedural (BSP),
// shapes become procedural here.
//
// Safety model: this only RELABELS cells between leaves — every active cell
// keeps exactly one owner, so no holes can appear. Downstream the planner
// flood-fills fragments per (leaf, connectivity), merges undersized results,
// and absorbs unusable slivers into circulation (officePlan.js), so any
// exchange this pass makes is structurally safe; the candidate scorer then
// penalizes ugly outcomes. The guards below exist to keep the GOOD outcomes
// common, not to protect correctness:
//   - the cut leaves both remaining arms >= 3 cells (roomMin-scale);
//   - the cut area stays <= a quarter of the leaf (compactness >= 0.75);
//   - the receiving side of the cut must be one single neighbouring leaf, so
//     the bump attaches whole.
//
// Everything is driven by the plan candidate's room RNG stream, so shapes are
// a pure function of (seed, district, candidate) like the leaves themselves.

const CORNERS = [
  { west: true, north: true }, // NW
  { west: false, north: true }, // NE
  { west: true, north: false }, // SW
  { west: false, north: false }, // SE
]

function uniformNeighbour(field, size, cells) {
  let owner = -1
  for (const [x, z] of cells) {
    if (x < 0 || z < 0 || x >= size || z >= size) return -1
    const id = field[z * size + x]
    if (owner === -1) owner = id
    else if (id !== owner) return -1
  }
  return owner
}

// Mutate the leaf field in place. `cfg` supplies shapeChance (how many leaves
// attempt an exchange) and shapeMaxCut (largest cut arm, in cells). The RNG is
// consumed for every leaf in index order regardless of outcome, so a failed
// exchange never shifts the stream of the leaves after it.
export function carveLeafShapes(field, size, leaves, rng, cfg) {
  let exchanged = 0
  for (let i = 0; i < leaves.length; i++) {
    const wanted = rng.chance(cfg.shapeChance)
    const cw = rng.int(1, cfg.shapeMaxCut) // rng.int is INCLUSIVE
    const ch = rng.int(1, cfg.shapeMaxCut)
    const corner = rng.int(0, 3)
    const flip = rng.chance(0.5)
    if (!wanted) continue
    if (exchangeCorner(field, size, leaves, i, cw, ch, corner, flip)) exchanged++
  }
  return exchanged
}

// Exchange one corner rectangle of leaf `i` with a single adjacent leaf.
// All randomness is drawn up front by carveLeafShapes so the stream is
// stable per leaf index. Returns true when a donation happened.
function exchangeCorner(field, size, leaves, i, cwRoll, chRoll, cornerRoll, flip) {
  const { x0, z0, x1, z1 } = leaves[i]
  const w = x1 - x0 + 1
  const h = z1 - z0 + 1
  if (w < 4 || h < 4) return false
  let cw = Math.min(cwRoll, w - 3)
  let ch = Math.min(chRoll, h - 3)
  while (cw * ch * 4 > w * h) {
    if (cw >= ch && cw > 1) cw--
    else if (ch > 1) ch--
    else return false
  }
  const corner = CORNERS[cornerRoll]
  const cx0 = corner.west ? x0 : x1 - cw + 1
  const cz0 = corner.north ? z0 : z1 - ch + 1
  const cx1 = cx0 + cw - 1
  const cz1 = cz0 + ch - 1

  const sideCells = []
  const sideX = corner.west ? x0 - 1 : x1 + 1
  for (let z = cz0; z <= cz1; z++) sideCells.push([sideX, z])
  const capCells = []
  const capZ = corner.north ? z0 - 1 : z1 + 1
  for (let x = cx0; x <= cx1; x++) capCells.push([x, capZ])
  const edges = flip ? [sideCells, capCells] : [capCells, sideCells]
  for (const edge of edges) {
    const owner = uniformNeighbour(field, size, edge)
    if (owner < 0 || owner === i) continue
    for (let z = cz0; z <= cz1; z++) {
      for (let x = cx0; x <= cx1; x++) field[z * size + x] = owner
    }
    return true
  }
  return false
}
