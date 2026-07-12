import { CHUNK } from './constants.js'
import { PASSAGE_OPEN } from './mapTypes.js'

const index = (x, z) => z * CHUNK + x

function labelComponents(data, respectColumns) {
  const labels = new Int16Array(CHUNK * CHUNK).fill(-1)
  let count = 0
  const stack = []
  for (let z0 = 0; z0 < CHUNK; z0++) {
    for (let x0 = 0; x0 < CHUNK; x0++) {
      const start = index(x0, z0)
      if (
        labels[start] !== -1 ||
        data.hasFloorHole(x0, z0) ||
        (respectColumns && data.colAt(x0, z0))
      ) continue
      labels[start] = count
      stack.push([x0, z0])
      while (stack.length) {
        const [x, z] = stack.pop()
        const visit = (nx, nz, wall) => {
          if (wall || nx < 0 || nx >= CHUNK || nz < 0 || nz >= CHUNK) return
          if (data.hasFloorHole(nx, nz)) return
          if (respectColumns && data.colAt(nx, nz)) return
          const ni = index(nx, nz)
          if (labels[ni] !== -1) return
          labels[ni] = count
          stack.push([nx, nz])
        }
        visit(x - 1, z, data.vAt(x, z))
        visit(x + 1, z, x === CHUNK - 1 ? 1 : data.vAt(x + 1, z))
        visit(x, z - 1, data.hAt(x, z))
        visit(x, z + 1, z === CHUNK - 1 ? 1 : data.hAt(x, z + 1))
      }
      count++
    }
  }
  return { labels, count }
}

function candidateWalls(data, labels, respectColumns) {
  const grouped = new Map()
  const add = (a, b, candidate) => {
    if (a < 0 || b < 0 || a === b) return
    const key = a < b ? `${a},${b}` : `${b},${a}`
    let list = grouped.get(key)
    if (!list) grouped.set(key, (list = []))
    list.push(candidate)
  }
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 1; x < CHUNK; x++) {
      if (!data.vAt(x, z)) continue
      if (data.hasFloorHole(x - 1, z) || data.hasFloorHole(x, z)) continue
      if (respectColumns && (data.colAt(x - 1, z) || data.colAt(x, z))) continue
      add(labels[index(x - 1, z)], labels[index(x, z)], { axis: 'v', line: x, cell: z })
    }
  }
  for (let z = 1; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      if (!data.hAt(x, z)) continue
      if (data.hasFloorHole(x, z - 1) || data.hasFloorHole(x, z)) continue
      if (respectColumns && (data.colAt(x, z - 1) || data.colAt(x, z))) continue
      add(labels[index(x, z - 1)], labels[index(x, z)], { axis: 'h', line: z, cell: x })
    }
  }
  return grouped
}

function joinComponents(data, rng, respectColumns, passage) {
  const { labels, count } = labelComponents(data, respectColumns)
  if (count <= 1) return 0
  const grouped = candidateWalls(data, labels, respectColumns)
  const parent = Array.from({ length: count }, (_, i) => i)
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]]
      a = parent[a]
    }
    return a
  }
  let opened = 0
  for (const key of rng.shuffle([...grouped.keys()])) {
    const [a, b] = key.split(',').map(Number)
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) continue
    parent[ra] = rb
    const list = grouped.get(key)
    const c = list[rng.int(0, list.length - 1)]
    if (c.axis === 'v') data.setPassageV(c.line, c.cell, passage)
    else data.setPassageH(c.cell, c.line, passage)
    opened++
  }
  return opened
}

// Enforce both representations of walkability used by the project:
//   1. the thin-wall cell graph (collision/LOS), and
//   2. the pathfinder graph, where a column occupies its whole navigation cell.
// Repairs are monotone: open the minimum component-tree edges; only if columns
// alone form an impenetrable cut do we remove a deterministic column.
export function repairChunkTopology(data, rng, passage = PASSAGE_OPEN) {
  const repairs = {
    connectivity: joinComponents(data, rng, false, passage),
    navigation: 0,
    columns: 0,
  }

  for (let guard = 0; guard < CHUNK * CHUNK; guard++) {
    const before = labelComponents(data, true)
    if (before.count <= 1) break
    const opened = joinComponents(data, rng, true, passage)
    repairs.navigation += opened
    const after = labelComponents(data, true)
    if (after.count <= 1) break
    if (opened > 0 && after.count < before.count) continue

    const columns = []
    for (let z = 0; z < CHUNK; z++) {
      for (let x = 0; x < CHUNK; x++) if (data.colAt(x, z)) columns.push([x, z])
    }
    if (columns.length === 0) break
    const [x, z] = columns[rng.int(0, columns.length - 1)]
    data.setCol(x, z, 0)
    repairs.columns++
  }
  return repairs
}

export function countChunkComponents(data, respectColumns = false) {
  return labelComponents(data, respectColumns).count
}
