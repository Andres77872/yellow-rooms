import { describe, expect, it } from 'vitest'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { auditChunkFamilyRegistrations } from '../familyAudit.js'
import { MAP_FAMILY_HOTEL,
  MAP_FAMILY_OFFICE, MAP_FAMILY_LATTICE, MAP_FAMILY_SEWER, MAP_FAMILY_TOWER } from '../mapTypes.js'
import { worldConfigForFamily } from '../mapFamily.js'
import { buildChunk } from '../pipeline.js'

// `auditChunkFamilyRegistrations` is the one family-audit surface that runs on
// real generator output: every chunk a family emits must carry an identity the
// adapter registry knows, and every canonical descriptor must be well formed.
// It is what catches "a new family/kind shipped without registering it".
//
// The release/rollback/activation-evidence validators in familyAudit.js gate
// the release process rather than the generator, and are exercised end to end
// against a real corpus by `npm run audit:world` — not duplicated here.

// Coordinates where each family's canonical structures actually stamp; these
// mirror the golden fixtures pinned in generate.test.js.
function patch(seed, config, cells) {
  const chunks = new Map()
  for (const [cx, cy, cz] of cells) {
    chunks.set(`${cx},${cy},${cz}`, buildChunk(seed, cx, cy, cz, config))
  }
  return chunks
}

function span(xs, ys, zs) {
  const cells = []
  for (const cy of ys) for (const cz of zs) for (const cx of xs) cells.push([cx, cy, cz])
  return cells
}

const FAMILIES = [
  {
    family: 'office',
    config: DEFAULT_WORLD_CONFIG,
    chunks: () => patch(12345, DEFAULT_WORLD_CONFIG, [[-3, -15, -1], [-2, -15, -1], [0, 0, 0]]),
  },
  {
    family: MAP_FAMILY_SEWER,
    chunks: () => patch(24151, worldConfigForFamily(MAP_FAMILY_SEWER), [
      [2, -1, -3], [2, 0, -3], [2, 1, -3],
    ]),
  },
  {
    family: MAP_FAMILY_TOWER,
    chunks: () => patch(23063, worldConfigForFamily(MAP_FAMILY_TOWER), span(
      [-4], [-22, -21, -20], [-3, -2]
    )),
  },
  {
    family: MAP_FAMILY_LATTICE,
    // The lattice audit reasons over the whole district, so the fixture covers
    // the full 4x4 footprint across all five floors.
    chunks: () => patch(2387080720, worldConfigForFamily(MAP_FAMILY_LATTICE), span(
      [0, 1, 2, 3], [-21, -20, -19, -18, -17], [-4, -3, -2, -1]
    )),
  },
  {
    family: MAP_FAMILY_HOTEL,
    chunks: () => patch(12345, worldConfigForFamily(MAP_FAMILY_HOTEL), [
      [-3, -15, -1], [-2, -15, -1], [0, 0, 0],
    ]),
  },
]

describe('generated chunk family registration', () => {
  it.each(FAMILIES.map((f) => ({ family: f.family, build: f.chunks })))(
    'audits every generated $family chunk through a registered adapter',
    ({ family, build }) => {
      const chunks = build()
      const report = auditChunkFamilyRegistrations(chunks)

      expect(report.failures).toEqual([])
      expect(report.ok).toBe(true)
      // The whole patch really is the family under test, so the audit is not
      // trivially passing on office fabric.
      expect(report.familyCounts).toEqual({ [family]: chunks.size })
    }
  )

  it('fails closed when a family claims a descriptor it does not own', () => {
    // v26: Hotel projects its own atrium grammar, so take the office pair.
    const hotel = buildChunk(12345, -3, -15, -1, worldConfigForFamily(MAP_FAMILY_OFFICE))
    // The office multilevel descriptor carries no family of its own, so an
    // unrelated family must not be able to adopt it by assertion.
    const report = auditChunkFamilyRegistrations([
      { mapFamily: MAP_FAMILY_TOWER, structure: hotel.structure },
    ])

    expect(report.ok).toBe(false)
    expect(report.failures).toEqual([
      { family: MAP_FAMILY_TOWER, kind: 'officeMultilevel', reason: 'missing-kind-adapter' },
    ])
  })

  it('fails closed on an unregistered family identity', () => {
    const office = buildChunk(12345, 0, 0, 0, DEFAULT_WORLD_CONFIG)
    const report = auditChunkFamilyRegistrations([{ ...office, mapFamily: 'arcology' }])

    expect(report.ok).toBe(false)
    expect(report.failures).toContainEqual({
      family: 'arcology',
      kind: null,
      reason: 'missing-family-adapter',
    })
  })
})
