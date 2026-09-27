import { CELL_CORRIDOR, CELL_LOBBY } from '../mapTypes.js'
import { RNG } from '../core/rng.js'
import { connectCirculation } from './architectureCirculation.js'

// A hotel is laid out from its guest corridors outwards, rather than by
// subdividing an office floor. Repeated room bays face both sides of a wing;
// a public hall and a transverse circulation spine collect those wings.
// Atrium galleries/bridges still come from the canonical multilevel contract.
// Inspiration: Georgia Tech, "The Atrium Hotel Grammar" (Ligler/Economou,
// 2018), https://shape.design.gatech.edu/Research/Projects/2018_Atrium/index.html

const index = (size, x, z) => z * size + x


// `options` (config.office.hotel, projected per family in v26): the wing
// module (cells between guest corridors) and the guest-bay widths. The
// defaults reproduce the v25 grammar.
export function createHotelArchitecture(plan, seed, candidate, components, options = {}) {
  const spacing = Array.isArray(options.wingSpacing) ? options.wingSpacing : [10, 12]
  const bays = Array.isArray(options.bay) ? options.bay : [3, 5]
  const suiteChance = Number.isFinite(options.suiteChance) ? options.suiteChance : 0.17
  const rng = RNG.fromHash(seed, plan.dx, plan.dz, 0x48e7 ^ candidate)
  const { size, active } = plan
  const axis = rng.chance(0.5) ? 'x' : 'z'
  const variant = rng.pick(['spine', 'gallery-loop', 'offset-wings'])
  const corridor = new Uint8Array(active.length)
  const leafField = new Int16Array(active.length).fill(-1)
  const architecture = []
  const cell = (u, v) => axis === 'x' ? index(size, u, v) : index(size, v, u)
  const stamp = (kind, u0, v0, u1, v1, cellKind = CELL_CORRIDOR) => {
    const cells = []
    for (let v = Math.max(0, v0); v <= Math.min(size - 1, v1); v++) {
      for (let u = Math.max(0, u0); u <= Math.min(size - 1, u1); u++) {
        const i = cell(u, v)
        if (!active[i]) continue
        corridor[i] = Math.max(corridor[i], cellKind)
        cells.push(i)
      }
    }
    if (!cells.length) return
    const xs = cells.map((i) => i % size)
    const zs = cells.map((i) => Math.floor(i / size))
    architecture.push({
      kind, axis, variant, cells,
      bounds: { x0: Math.min(...xs), z0: Math.min(...zs), x1: Math.max(...xs), z1: Math.max(...zs) },
    })
  }

  // Evenly distribute wings with seeded margins and bay depth. The number
  // depends on district size, so a two-chunk district retains usable rooms.
  const wingCount = Math.max(2, Math.round(size / rng.int(spacing[0], spacing[1])))
  const margin = rng.int(3, 5)
  const wingLines = Array.from({ length: wingCount }, (_, wing) =>
    Math.round(margin + wing * (size - 1 - margin * 2) / (wingCount - 1))
  )
  for (const line of wingLines) stamp('hotel-guest-wing', 0, line, size - 1, line)

  const spine = variant === 'offset-wings'
    ? rng.int(Math.floor(size * 0.25), Math.floor(size * 0.4))
    : rng.int(Math.floor(size * 0.42), Math.floor(size * 0.58))
  stamp('hotel-cross-hall', spine, 0, spine, size - 1)
  if (variant === 'gallery-loop') {
    // A second connection makes a circulation loop around room courts,
    // without converting the whole room field to an open lobby.
    const second = spine < size / 2 ? size - 5 : 4
    stamp('hotel-gallery-loop', second, wingLines[0], second, wingLines.at(-1))
  } else if (variant === 'offset-wings') {
    const second = size - spine - 1
    stamp('hotel-return-hall', second, wingLines[1], second, wingLines.at(-1))
  }

  // The sudden transition from a narrow repeating wing into a broad empty
  // reception hall is architectural: these cells never become furnished
  // guest rooms. Keep the hall inside a contiguous active footprint.
  const lobbyCandidates = []
  for (const line of wingLines) {
    for (const u of [spine, Math.floor(size / 2), Math.floor(size / 4), Math.floor(size * 3 / 4)]) {
      if (u < 3 || u >= size - 3 || line < 2 || line >= size - 2) continue
      let full = true
      for (let v = line - 2; v <= line + 2 && full; v++) {
        for (let x = u - 3; x <= u + 3; x++) {
          if (!active[cell(x, v)]) { full = false; break }
        }
      }
      if (full) lobbyCandidates.push({ u, v: line })
    }
  }
  if (lobbyCandidates.length) {
    const lobby = rng.pick(lobbyCandidates)
    stamp('hotel-reception-hall', lobby.u - 3, lobby.v - 2, lobby.u + 3, lobby.v + 2, CELL_LOBBY)
  }

  // Partition the space BETWEEN guest corridors into back-to-back room
  // rows. Bays align along each wing, producing repeated door rhythm; some
  // wider bays become suites. Every row fronts a corridor directly.
  const rows = []
  rows.push([0, wingLines[0] - 1])
  for (let wing = 1; wing < wingLines.length; wing++) {
    const low = wingLines[wing - 1] + 1
    const high = wingLines[wing] - 1
    const middle = Math.floor((low + high) / 2)
    rows.push([low, middle], [middle + 1, high])
  }
  rows.push([wingLines.at(-1) + 1, size - 1])
  let leaf = 0
  for (const [v0, v1] of rows) {
    const bay = rng.int(bays[0], bays[1])
    let u = 0
    while (u < size) {
      let width = Math.min(size - u, rng.chance(suiteChance) ? bay + 2 : bay)
      if (size - u - width < bays[0]) width = size - u
      for (let v = v0; v <= v1; v++) {
        for (let x = u; x < u + width; x++) leafField[cell(x, v)] = leaf
      }
      u += width
      leaf++
    }
  }

  for (const portal of plan.portals) corridor[index(size, portal.x, portal.z)] = CELL_LOBBY
  for (const lobby of [...plan.stairLobbies, ...plan.multilevelLobbies]) {
    for (const i of lobby.cells) corridor[i] = CELL_LOBBY
    for (const mouth of lobby.mouths || [lobby.mouth]) {
      corridor[index(size, mouth.x, mouth.z)] = CELL_LOBBY
    }
  }
  connectCirculation(plan, corridor, components)
  return { corridor, components, leafField, architecture }
}
