import { CELL_CORRIDOR } from '../mapTypes.js'

function neighbours(i, size) {
  const x = i % size
  const z = Math.floor(i / size)
  const result = []
  if (x > 0) result.push(i - 1)
  if (x + 1 < size) result.push(i + 1)
  if (z > 0) result.push(i - size)
  if (z + 1 < size) result.push(i + size)
  return result
}

// Mixed-zone districts can clip a wing into several pieces. Join every
// reservation and portal to the architectural graph within its active
// component. Multi-source BFS chooses the shortest missing connector; it
// cannot tunnel through an inactive chunk or change a boundary contract.
export function connectCirculation(plan, corridor, components) {
  const { size, active } = plan
  const seen = new Uint8Array(active.length)
  const queue = new Int32Array(active.length)
  const previous = new Int32Array(active.length)
  for (const component of components.cells) {
    const start = component.find((i) => corridor[i]) ?? component[0]
    if (!corridor[start]) corridor[start] = CELL_CORRIDOR
    let head = 0
    let tail = 0
    const flood = (first) => {
      seen[first] = 1
      queue[tail++] = first
      while (head < tail) {
        for (const next of neighbours(queue[head++], size)) {
          if (!active[next] || !corridor[next] || seen[next]) continue
          seen[next] = 1
          queue[tail++] = next
        }
      }
    }
    flood(start)
    while (component.some((i) => corridor[i] && !seen[i])) {
      previous.fill(-2)
      head = 0
      tail = 0
      for (const i of component) {
        if (!seen[i]) continue
        previous[i] = -1
        queue[tail++] = i
      }
      let reached = -1
      while (head < tail && reached < 0) {
        const at = queue[head++]
        for (const next of neighbours(at, size)) {
          if (!active[next] || previous[next] !== -2) continue
          previous[next] = at
          if (corridor[next] && !seen[next]) {
            reached = next
            break
          }
          queue[tail++] = next
        }
      }
      if (reached < 0) throw new Error('architectural circulation cannot reach an active reservation')
      let at = reached
      while (at >= 0) {
        if (!corridor[at]) corridor[at] = CELL_CORRIDOR
        at = previous[at]
      }
      head = 0
      tail = 0
      // Flood from the new endpoint through the entire newly joined path.
      flood(reached)
    }
  }
}

