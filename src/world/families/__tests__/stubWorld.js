// Test-only stub world (spec §12.0) for the framework tests.
//
// The framework tests (backend, seams, reach-oracle, mass-fast-path, …) pin
// the stub world's exact layout: 1×1-chunk tiles on storey 0 only, ports
// 6..7 on every west/north seam, spawn (0,0) cell (6,6), exit anchor chunk
// (6,0) cell (6,6). They used to borrow a family that was still a stub;
// once a family agent lands the real world that borrow breaks, and after
// Phase B none is left. Instead a test file installs these mocks so ONE
// valid liminal id (STUB_WORLD_ID) runs the stub program, whatever the real
// family has become:
//
//   vi.mock('../generators.js', (orig) => import('./stubWorld.js').then((m) => m.mockGenerators(orig)))
//   vi.mock('../planners.js', (orig) => import('./stubWorld.js').then((m) => m.mockPlanners(orig)))
//
// (paths relative to the test file). Only the generator and planner
// registries are swapped: chunk generation (pipeline → familyChunk) reads
// nothing else. hooks.js is NOT mocked — familySpawn/familyExitHook call the
// module-local hookOf, so a mocked export would not reach them; tests that
// need the stub spawn/exit use STUB_SPAWN_CELL / STUB_EXIT_CELL directly.
//
// The id keeps its real record (code, palette, prop packs, salt), so
// forcedFamilyConfig(STUB_WORLD_ID), ChunkData.mapFamily and FAMILY_SALT all
// stay valid.

export const STUB_WORLD_ID = 'stairwell'

// Spawn and exit of the stub world (tiles/stub.js STUB_SPAWN, stubPlanner.js
// STUB_EXIT_ANCHOR), restated so tests need not import the hooks.
export const STUB_SPAWN_CELL = Object.freeze({ cx: 0, cz: 0, lx: 6, lz: 6 })
export const STUB_EXIT_CELL = Object.freeze({ cx: 6, cy: 0, cz: 0, lx: 6, lz: 6 })

// Factory bodies. Import ORDER matters: a vi.mock factory that dynamically
// imports a module which (transitively) imports the module being mocked
// deadlocks. The planner factory therefore imports only the leaf
// tiles/stubPlanner.js; the generator factory resolves the real registry
// first (which already loads tiles/stub.js for the families still stubbed)
// and only then the stub program.

// vi.mock factory body for families/generators.js. `lookup(id)` (optional)
// is consulted first, for files that also inject private generators.
export async function mockGenerators(importOriginal, { id = STUB_WORLD_ID, lookup = null } = {}) {
  const real = await importOriginal()
  const { stubGeometry } = await import('../../tiles/stubPlanner.js')
  const { FAMILY_SALT } = await import('../../tiles/tileKey.js')
  const { stubGenerator } = await import('../../tiles/stub.js')
  const generator = stubGenerator(id, stubGeometry(FAMILY_SALT[id]))
  return {
    ...real,
    familyGenerator: (x) => lookup?.(x) ?? (x === id ? generator : real.familyGenerator(x)),
  }
}

// vi.mock factory body for families/planners.js. `lookup(id)` (optional) is
// consulted first, e.g. backend.test's per-test planner override.
export async function mockPlanners(importOriginal, { id = STUB_WORLD_ID, lookup = null } = {}) {
  const real = await importOriginal()
  const { STUB_PLANNER } = await import('../../tiles/stubPlanner.js')
  return {
    ...real,
    familyPlanner: (x) => lookup?.(x) ?? (x === id ? STUB_PLANNER : real.familyPlanner(x)),
  }
}
