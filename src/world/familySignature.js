import { CHUNK, cIdx, hIdx, vIdx } from './constants.js'
import {
  CELL_ATRIUM,
  CELL_BRIDGE,
  CELL_CORRIDOR,
  CELL_ROOM,
  CELL_STAIR,
  CELL_VOID,
  COLUMN_FURNITURE,
  PASSAGE_DOOR,
  PASSAGE_WIDE,
  WALL_RAIL,
  WALL_WINDOW,
} from './mapTypes.js'

// Layout-only family signatures. Every feature reads collision/topology
// rasters and slab openings — never palette, furniture art, lamp colour or
// room-role names — so two families that differ only in dressing produce the
// same signature. `familyDistinctness` turns per-family samples into a
// separation report (nearest-centroid accuracy, pairwise effect sizes) and
// `skeletonOverlap` measures how much of one family's plan is literally
// another family's plan at the same seed and coordinates.

export const SIGNATURE_FEATURES = Object.freeze([
  'roomShare',
  'corridorShare',
  'hallShare',
  'massShare',
  'verticalShare',
  'holeShare',
  'wallDensity',
  'doorDensity',
  'wideDensity',
  'meanRoomArea',
  'roomAreaCv',
  'meanFreeRun',
  'columnDensity',
  'seamWallShare',
  'railDensity',
  'windowDensity',
  'spacesPerChunk',
])

const VERTICAL_KINDS = new Set([CELL_STAIR, CELL_ATRIUM, CELL_VOID, CELL_BRIDGE])

function structuralColumn(d, i) {
  return d.cols[i] !== 0 && d.cols[i] !== COLUMN_FURNITURE
}

// Signature of an n×n chunk patch on floor cy. `dataAt(cx, cy, cz)` returns
// ChunkData (generated or edited).
export function patchSignature(dataAt, cx0, cz0, n, cy) {
  let cells = 0
  let room = 0
  let corridor = 0
  let hall = 0
  let mass = 0
  let vertical = 0
  let holes = 0
  let walls = 0
  let doors = 0
  let wide = 0
  let columns = 0
  let seamEdges = 0
  let seamWalls = 0
  let rails = 0
  let windows = 0
  const areas = new Map()
  const spaces = new Set()
  const chunks = []
  for (let cz = cz0; cz < cz0 + n; cz++) {
    for (let cx = cx0; cx < cx0 + n; cx++) {
      const d = dataAt(cx, cy, cz)
      if (!d) continue
      chunks.push(d)
      for (let lz = 0; lz < CHUNK; lz++) {
        for (let lx = 0; lx < CHUNK; lx++) {
          const i = cIdx(lx, lz)
          const kind = d.cellKind[i]
          cells++
          if (structuralColumn(d, i)) {
            mass++
            columns++
          } else if (kind === CELL_ROOM) room++
          else if (kind === CELL_CORRIDOR) corridor++
          else if (!VERTICAL_KINDS.has(kind)) hall++
          if (VERTICAL_KINDS.has(kind)) vertical++
          if (d.hasFloorHole(lx, lz) || d.hasCeilHole(lx, lz)) holes++
          if (kind === CELL_ROOM && d.spaceId[i]) {
            const key = `${d.cx},${d.cz},${d.spaceId[i]}`
            areas.set(key, (areas.get(key) ?? 0) + 1)
          }
          if (d.spaceId[i]) spaces.add(`${d.cx},${d.cz},${d.spaceId[i]}`)
          const v = vIdx(lx, lz)
          const h = hIdx(lx, lz)
          if (d.wallV[v]) walls++
          if (d.wallH[h]) walls++
          if (d.passageV[v] === PASSAGE_DOOR) doors++
          if (d.passageH[h] === PASSAGE_DOOR) doors++
          if (d.passageV[v] === PASSAGE_WIDE) wide++
          if (d.passageH[h] === PASSAGE_WIDE) wide++
          if (d.wallFeatureV[v] === WALL_RAIL) rails++
          if (d.wallFeatureH[h] === WALL_RAIL) rails++
          if (d.wallFeatureV[v] === WALL_WINDOW) windows++
          if (d.wallFeatureH[h] === WALL_WINDOW) windows++
          if (lx === 0) {
            seamEdges++
            if (d.wallV[v]) seamWalls++
          }
          if (lz === 0) {
            seamEdges++
            if (d.wallH[h]) seamWalls++
          }
        }
      }
    }
  }
  const runs = freeRuns(chunks)
  const area = [...areas.values()]
  const meanArea = area.length ? area.reduce((a, b) => a + b, 0) / area.length : 0
  const sdArea = area.length
    ? Math.sqrt(area.reduce((a, b) => a + (b - meanArea) ** 2, 0) / area.length)
    : 0
  const c = Math.max(1, cells)
  return {
    roomShare: room / c,
    corridorShare: corridor / c,
    hallShare: hall / c,
    massShare: mass / c,
    verticalShare: vertical / c,
    holeShare: holes / c,
    wallDensity: walls / c,
    doorDensity: doors / c,
    wideDensity: wide / c,
    meanRoomArea: meanArea,
    roomAreaCv: meanArea ? sdArea / meanArea : 0,
    meanFreeRun: runs,
    columnDensity: columns / c,
    seamWallShare: seamEdges ? seamWalls / seamEdges : 0,
    railDensity: rails / c,
    windowDensity: windows / c,
    spacesPerChunk: chunks.length ? spaces.size / chunks.length : 0,
  }
}

// Mean length (cells) of maximal straight walkable runs along both axes,
// clipped to each chunk: a cheap proxy for the scale of open space.
function freeRuns(chunks) {
  let total = 0
  let count = 0
  const blocked = (d, lx, lz) => structuralColumn(d, cIdx(lx, lz)) || d.cellKind[cIdx(lx, lz)] === CELL_VOID
  for (const d of chunks) {
    for (let lz = 0; lz < CHUNK; lz++) {
      let run = 0
      for (let lx = 0; lx < CHUNK; lx++) {
        const cut = blocked(d, lx, lz) || (lx > 0 && d.wallV[vIdx(lx, lz)])
        if (cut && run) {
          total += run
          count++
          run = 0
        }
        if (!blocked(d, lx, lz)) run++
      }
      if (run) {
        total += run
        count++
      }
    }
    for (let lx = 0; lx < CHUNK; lx++) {
      let run = 0
      for (let lz = 0; lz < CHUNK; lz++) {
        const cut = blocked(d, lx, lz) || (lz > 0 && d.wallH[hIdx(lx, lz)])
        if (cut && run) {
          total += run
          count++
          run = 0
        }
        if (!blocked(d, lx, lz)) run++
      }
      if (run) {
        total += run
        count++
      }
    }
  }
  return count ? total / count : 0
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)

// samples: { family: [signature, ...] }. Features are standardized by the
// pooled within-family standard deviation (floored so a constant feature
// cannot dominate). Returns leave-one-out nearest-centroid accuracy, the
// confusion counts, and the pairwise centroid distance in pooled-sd units
// (RMS over features — a multivariate effect size; ≥ 1 reads as clearly
// different, < 0.5 as the same layout with noise).
export function familyDistinctness(samples, features = SIGNATURE_FEATURES) {
  const families = Object.keys(samples).filter((f) => samples[f].length)
  const sd = {}
  for (const f of features) {
    let ss = 0
    let n = 0
    for (const fam of families) {
      const xs = samples[fam].map((s) => s[f])
      const m = mean(xs)
      for (const x of xs) ss += (x - m) ** 2
      n += xs.length - 1
    }
    const all = families.flatMap((fam) => samples[fam].map((s) => s[f]))
    const range = Math.max(...all) - Math.min(...all)
    sd[f] = Math.max(Math.sqrt(ss / Math.max(1, n)), range * 0.02, 1e-6)
  }
  const z = (s) => features.map((f) => s[f] / sd[f])
  const sums = {}
  for (const fam of families) {
    sums[fam] = features.map(() => 0)
    for (const s of samples[fam]) z(s).forEach((v, i) => (sums[fam][i] += v))
  }
  const dist2 = (a, b) => a.reduce((acc, v, i) => acc + (v - b[i]) ** 2, 0)
  const confusion = Object.fromEntries(families.map((f) => [f, Object.fromEntries(families.map((g) => [g, 0]))]))
  let correct = 0
  let total = 0
  for (const fam of families) {
    const n = samples[fam].length
    for (const s of samples[fam]) {
      const v = z(s)
      let best = null
      let bestD = Infinity
      for (const other of families) {
        const k = other === fam ? n - 1 : samples[other].length
        if (!k) continue
        const c = sums[other].map((x, i) => (other === fam ? (x - v[i]) / k : x / k))
        const d = dist2(v, c)
        if (d < bestD) {
          bestD = d
          best = other
        }
      }
      confusion[fam][best]++
      if (best === fam) correct++
      total++
    }
  }
  const centroid = Object.fromEntries(families.map((fam) => [fam, sums[fam].map((x) => x / samples[fam].length)]))
  const pairwise = {}
  for (let a = 0; a < families.length; a++) {
    for (let b = a + 1; b < families.length; b++) {
      const A = centroid[families[a]]
      const B = centroid[families[b]]
      const diffs = A.map((v, i) => Math.abs(v - B[i]))
      pairwise[`${families[a]}~${families[b]}`] = {
        rms: Math.sqrt(diffs.reduce((acc, d) => acc + d * d, 0) / diffs.length),
        top: features
          .map((f, i) => [f, diffs[i]])
          .sort((x, y) => y[1] - x[1])
          .slice(0, 3)
          .map(([f, d]) => `${f} ${d.toFixed(1)}`),
      }
    }
  }
  const means = Object.fromEntries(families.map((fam) => [fam, Object.fromEntries(features.map((f) => [f, mean(samples[fam].map((s) => s[f]))]))]))
  return { accuracy: total ? correct / total : 0, confusion, pairwise, means, sd }
}

// Same seed, same chunk coordinates, two families: how much of the plan is
// shared. wallJaccard over every owned wall edge; seamAgreement is the share
// of chunk-seam edges whose wall/open state matches; seamOpeningsShared is the
// share of A's seam openings that B also opens at the identical position (the
// "same doors in the same places" signal); seamKappa corrects the seam
// agreement for chance.
export function skeletonOverlap(dataAtA, dataAtB, cx0, cz0, n, cy) {
  let inter = 0
  let union = 0
  let seam = 0
  let seamSame = 0
  let openA = 0
  let openB = 0
  let openBoth = 0
  for (let cz = cz0; cz < cz0 + n; cz++) {
    for (let cx = cx0; cx < cx0 + n; cx++) {
      const a = dataAtA(cx, cy, cz)
      const b = dataAtB(cx, cy, cz)
      if (!a || !b) continue
      for (let lz = 0; lz < CHUNK; lz++) {
        for (let lx = 0; lx < CHUNK; lx++) {
          const v = vIdx(lx, lz)
          const h = hIdx(lx, lz)
          for (const [wa, wb, onSeam] of [
            [a.wallV[v], b.wallV[v], lx === 0],
            [a.wallH[h], b.wallH[h], lz === 0],
          ]) {
            if (wa || wb) union++
            if (wa && wb) inter++
            if (!onSeam) continue
            seam++
            if (!!wa === !!wb) seamSame++
            if (!wb) openB++
            if (!wa) {
              openA++
              if (!wb) openBoth++
            }
          }
        }
      }
    }
  }
  // Cohen's kappa of the seam states: agreement beyond what two independent
  // plans with the same opening rates would reach by chance (0 = unrelated
  // skeletons, 1 = the same skeleton).
  const po = seam ? seamSame / seam : 0
  const pa = seam ? openA / seam : 0
  const pb = seam ? openB / seam : 0
  const pe = pa * pb + (1 - pa) * (1 - pb)
  return {
    wallJaccard: union ? inter / union : 0,
    seamAgreement: po,
    seamOpeningsShared: openA ? openBoth / openA : 0,
    seamKappa: pe < 1 ? (po - pe) / (1 - pe) : 0,
  }
}
