import { CELL_CORRIDOR, CELL_LOBBY, MAP_FAMILY_TOWER } from '../mapTypes.js'
import { RNG } from '../core/rng.js'
import { connectCirculation } from './architectureCirculation.js'

// These solid-floor plans give the infrastructure families an identity on
// every floor, including the intervals between their finite vertical bands.
// Tower circulation surrounds massive cores; Lattice circulation is an alley
// network punctuated by open transfer plazas. The canonical structure stamps
// alone introduce real shafts, elevated decks, rails, and slab apertures.
const index = (size, x, z) => z * size + x

function architecturalField(plan, axis, variant) {
  const { size, active } = plan
  const corridor = new Uint8Array(active.length)
  const leafField = new Int16Array(active.length).fill(-1)
  const architecture = []
  const cell = (u, v) => axis === 'x' ? index(size, u, v) : index(size, v, u)
  const bounds = (u0, v0, u1, v1) => axis === 'x'
    ? { x0: u0, z0: v0, x1: u1, z1: v1 }
    : { x0: v0, z0: u0, x1: v1, z1: u1 }
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
    if (cells.length) architecture.push({ kind, axis, variant, bounds: bounds(u0, v0, u1, v1), cells })
  }
  let leaf = 0
  const bay = (u0, v0, u1, v1) => {
    for (let v = v0; v <= v1; v++) {
      for (let u = u0; u <= u1; u++) leafField[cell(u, v)] = leaf
    }
    leaf++
  }
  return { corridor, leafField, architecture, stamp, bay, cell }
}

function towerArchitecture(plan, rng) {
  const { size } = plan
  const axis = rng.chance(0.5) ? 'x' : 'z'
  const variant = rng.pick(['perimeter-gallery', 'twin-core', 'processional-hall'])
  const field = architecturalField(plan, axis, variant)
  const { stamp, bay } = field
  const margin = rng.int(3, 5)
  const ringLow = margin
  const ringHigh = size - margin - 2
  const hallWidth = variant === 'processional-hall' ? 4 : 3
  const hall = variant === 'twin-core'
    ? Math.floor(size * rng.range(0.36, 0.43))
    : Math.floor((size - hallWidth) / 2)
  const crossLines = [Math.floor(size / 3), Math.floor(size * 2 / 3)]

  // Broad, uninterrupted perimeter galleries frame six large core bays.
  // Their long perspectives and the axial nave are unlike a room maze or a
  // hotel's repeated narrow guest wings. Cross halls connect every core face.
  stamp('tower-perimeter-gallery', ringLow, ringLow, ringHigh + 1, ringLow + 1)
  stamp('tower-perimeter-gallery', ringLow, ringHigh, ringHigh + 1, ringHigh + 1)
  stamp('tower-perimeter-gallery', ringLow, ringLow + 2, ringLow + 1, ringHigh - 1)
  stamp('tower-perimeter-gallery', ringHigh, ringLow + 2, ringHigh + 1, ringHigh - 1)
  stamp('tower-axial-hall', hall, 0, hall + hallWidth - 1, size - 1, CELL_LOBBY)
  for (const line of crossLines) stamp('tower-transfer-gallery', 0, line, size - 1, line + 1)
  if (variant === 'twin-core') {
    const returnLine = Math.min(ringHigh - 3, hall + hallWidth + 7)
    stamp('tower-core-return', returnLine, ringLow, returnLine + 1, ringHigh + 1)
  }

  // Core slabs, not random BSP leaves: room boundaries inherit the structural
  // grid. The end vestibules and narrow exterior service strips are separate
  // bays, so validation can absorb a clipped strip without erasing a core.
  const us = [...new Set([0, ringLow, ringLow + 2, hall, hall + hallWidth, ringHigh, ringHigh + 2, size])].sort((a, b) => a - b)
  const vs = [...new Set([0, ringLow, ringLow + 2, ...crossLines.flatMap((v) => [v, v + 2]), ringHigh, ringHigh + 2, size])].sort((a, b) => a - b)
  for (let v = 0; v + 1 < vs.length; v++) {
    for (let u = 0; u + 1 < us.length; u++) bay(us[u], vs[v], us[u + 1] - 1, vs[v + 1] - 1)
  }
  // The outer service rim contains compact offices and control rooms beside
  // the much larger cores. Its small frontage modules preserve usable private
  // rooms instead of making every remaining bay an assembly-size chamber.
  const serviceBay = margin >= 5 ? 3 : 4
  for (let along = 0; along < size; along += serviceBay) {
    const end = Math.min(size - 1, along + serviceBay - 1)
    bay(along, 0, end, ringLow - 1)
    bay(along, ringHigh + 2, end, size - 1)
  }
  for (let along = ringLow; along < ringHigh + 2; along += serviceBay) {
    const end = Math.min(ringHigh + 1, along + serviceBay - 1)
    bay(0, along, ringLow - 1, end)
    bay(ringHigh + 2, along, size - 1, end)
  }
  return field
}

// `pitch` (config.office.lattice.alleyPitch, v26) is the block module
// between service alleys; the v25 grammar used [8, 11].
function alleyLines(size, rng, pitch = [8, 11]) {
  const lines = [rng.int(3, 5)]
  while (lines.at(-1) + pitch[0] < size - 4) lines.push(lines.at(-1) + rng.int(pitch[0], pitch[1]))
  if (size - 1 - lines.at(-1) > pitch[0] - 1) lines.push(size - 5)
  return lines
}

function latticeArchitecture(plan, rng, options = {}) {
  const { size, active } = plan
  const axis = rng.chance(0.5) ? 'x' : 'z'
  const variant = rng.pick(['service-grid', 'transfer-courts', 'long-concourse'])
  const field = architecturalField(plan, axis, variant)
  const { stamp, bay, cell } = field
  const pitch = Array.isArray(options.alleyPitch) ? options.alleyPitch : [8, 11]
  const us = alleyLines(size, rng, pitch)
  const vs = alleyLines(size, rng, pitch)
  for (const u of us) stamp('lattice-service-alley', u, 0, u, size - 1)
  for (const v of vs) stamp('lattice-service-alley', 0, v, size - 1, v)
  const concourse = us[Math.floor(us.length / 2)]
  stamp('lattice-concourse', concourse, 0, concourse + 1, size - 1)
  if (variant === 'long-concourse') {
    const line = vs[Math.floor(vs.length / 2)]
    stamp('lattice-concourse', 0, line, size - 1, line + 1)
  }

  // Utility bays fill the blocks between alleys. Their unequal modules follow
  // the graph spacing, with a single service partition in larger blocks.
  // The geometry is a street network with blocks, not double-loaded wings.
  const xCuts = [0, ...us.flatMap((u) => [u, u + 1]), size]
  const zCuts = [0, ...vs.flatMap((v) => [v, v + 1]), size]
  for (let v = 0; v + 1 < zCuts.length; v++) {
    for (let u = 0; u + 1 < xCuts.length; u++) {
      const u0 = xCuts[u], u1 = xCuts[u + 1] - 1
      const v0 = zCuts[v], v1 = zCuts[v + 1] - 1
      const serviceBlock = ((u >> 1) + (v >> 1)) % 2 === 0
      // v26: open utility yards between the alleys (config.office.lattice
      // .openBlockChance) — the ground plane of the catwalk city reads as
      // alleys, yards and booths rather than an office's room fabric.
      if (options.openBlockChance && rng.chance(options.openBlockChance)) {
        stamp('lattice-utility-yard', u0, v0, u1, v1, CELL_LOBBY)
      } else if (serviceBlock && u1 - u0 >= 5 && v1 - v0 >= 5) {
        // Three-cell service strips are actual storage/control bays. Other
        // blocks retain their full open utility-room span for larger uses.
        bay(u0, v0, u0 + 2, v1)
        bay(u0 + 3, v0, u1, v1)
      } else bay(u0, v0, u1, v1)
    }
  }

  const plazas = []
  for (const u of us) for (const v of vs) {
    if (u < 3 || v < 3 || u >= size - 3 || v >= size - 3) continue
    let complete = true
    for (let dv = -2; dv <= 2 && complete; dv++) {
      for (let du = -2; du <= 2; du++) {
        if (!active[cell(u + du, v + dv)]) { complete = false; break }
      }
    }
    if (complete) plazas.push({ u, v })
  }
  rng.shuffle(plazas)
  const count = (variant === 'transfer-courts' ? 3 : 2) + (options.extraPlazas ?? 0)
  for (const { u, v } of plazas.slice(0, count)) {
    stamp('lattice-transfer-plaza', u - 2, v - 2, u + 2, v + 2, CELL_LOBBY)
  }
  return field
}

export function createInfrastructureArchitecture(plan, seed, candidate, components, family, options = {}) {
  const tower = family === MAP_FAMILY_TOWER
  const rng = RNG.fromHash(seed, plan.dx, plan.dz, (tower ? 0x70a3 : 0x1a771c) ^ candidate)
  const field = tower ? towerArchitecture(plan, rng) : latticeArchitecture(plan, rng, options)
  const { corridor } = field
  for (const portal of plan.portals) corridor[index(plan.size, portal.x, portal.z)] = CELL_LOBBY
  for (const lobby of [...plan.stairLobbies, ...plan.multilevelLobbies]) {
    for (const i of lobby.cells) corridor[i] = CELL_LOBBY
    for (const mouth of lobby.mouths || [lobby.mouth]) {
      corridor[index(plan.size, mouth.x, mouth.z)] = CELL_LOBBY
    }
  }
  connectCirculation(plan, corridor, components)
  return {
    corridor, leafField: field.leafField, architecture: field.architecture, components,
  }
}
