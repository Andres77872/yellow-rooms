import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { CELL, CHUNK, vIdx } from '../../../constants.js'
import { signCell } from '../../../decalKinds.js'
import { PASSAGE_DOOR } from '../../../mapTypes.js'
import { collectInteriorDressing } from '../../../objects/dressing/index.js'
import { plateFace, pushPlate, signagePlan } from '../../../objects/dressing/notices.js'
import { Chunk } from '../../../Chunk.js'
import { createGeometries } from '../../../../render/geometries.js'
import { createExitPlacement } from '../../../../core/exitPlacement.js'
import { isSolidMassChunk } from '../../../tiles/solidChunk.js'
import { forcedFamilyConfig } from '../../forced.js'
import { familySpawn } from '../../hooks.js'
import { worldSource } from '../../reach.js'
import { TILE, UNLISTED, carPlateOf, exitAnchor, exitTileOf, footprint, portRow0, skeleton, stationPlatesOf } from '../geometry.js'
import { trainPlates } from '../plates.js'

// The train in the runtime (spec §12.10 "playable"): the real pipeline's
// chunks build into render chunks (meshes, stair cells, lamps, plates), solid
// chunks take the mass fast path, and the engine's exit placement lands in
// the exit station's concourse closet.

const geom = createGeometries()
const material = new THREE.MeshBasicMaterial()
const materials = new Proxy({}, { get: () => material })
const config = forcedFamilyConfig('train')

const instancesOf = (group) => {
  let n = 0
  group.traverse((o) => { if (o.isInstancedMesh) n += o.count })
  return n
}

describe('train runtime', () => {
  it('tiles 0..1 build: the cars mesh with plates and tinted lamps, every core chunk carries stair cells, out-of-band chunks are fast-path mass', () => {
    const seed = 1
    for (const cy of [-1, 0, 1, 2]) {
      for (let cx = 0; cx < 2 * TILE.w; cx++) {
        const c = new Chunk(cx, cy, 0, seed, materials, geom, null, config, null)
        expect(c.data.mapFamily).toBe('train')
        if (footprint(seed, cx, cy, 0) === 'solid') {
          expect(isSolidMassChunk(c.data), `${cx},${cy}`).toBe(true)
          expect(instancesOf(c.group)).toBe(0)
        } else {
          expect(instancesOf(c.group), `${cx},${cy}`).toBeGreaterThan(0)
          expect(typeof c.data.levelLabel, `plate ${cx},${cy}`).toBe('string')
          if (cy === 0) expect(c.data.lamps.some((l) => l.lit && l.tint === 0xe4fff0)).toBe(true)
          if (skeleton(seed, Math.floor(cx / TILE.w)).cores.some((q) => q.chunk === cx % TILE.w)) {
            expect(c.stairCells.size, `stair cells ${cx},${cy}`).toBeGreaterThan(0)
          }
        }
        c.dispose()
      }
    }
  }, 60_000)

  it('the engine exit placement takes the hook: the exit station\'s closet on storey 1; the spawn is the car-0 aisle on storey 0', () => {
    for (const seedText of ['train', 'last train']) {
      const worldSeed = 0x7a17 + seedText.length
      const ex = createExitPlacement(seedText, 1, worldSeed, config)
      const a = exitAnchor(worldSeed)
      expect([ex.cx, ex.cy, ex.cz, ex.lx, ex.lz]).toEqual([a.cx, 1, 0, a.lx, a.lz])
      expect(Math.floor(ex.cx / TILE.w)).toBe(exitTileOf(worldSeed))
      expect(Number.isFinite(ex.x) && Number.isFinite(ex.y) && Number.isFinite(ex.z)).toBe(true)
      const sp = familySpawn(config, worldSeed)
      expect([sp.cx, sp.cz, sp.lx, sp.lz]).toEqual([0, 0, 3, portRow0(worldSeed, 0)])
    }
  })

  // The plates the train declares (plates.js) drawn the way the dressing
  // hunk draws them (Phase I request: dressing/index.js feeds each descriptor
  // to notices.js pushPlate with its sign cell), so what a player sees is
  // pinned here before the hunk lands, and through collectInteriorDressing
  // once it has.
  const drawPlates = (d) => {
    const decals = []
    const props = []
    for (const p of trainPlates(d)) {
      const cell = signCell(p.sign, d.mapFamily)
      expect(cell, `sign ${p.sign}`).toBeGreaterThanOrEqual(0)
      pushPlate(decals, props, p.axis === 'v', p.line * CELL, p.side, (p.cell + 0.5) * CELL, p.y, p.w, p.h, cell, { base: p.base, rough: 0.45, number: p.number })
    }
    return { decals, props }
  }
  const aabb = (r) => [r.px - r.sx / 2, r.px + r.sx / 2, r.py - r.sy / 2, r.py + r.sy / 2, r.pz - r.sz / 2, r.pz + r.sz / 2]
  const overlaps = (a, b) => [0, 2, 4].every((i) => a[i] < b[i + 1] - 1e-4 && b[i] < a[i + 1] - 1e-4)

  it('plates a player sees: every car numbered over both gangway doors, station names on the platform and concourse, nonE at the exit station', () => {
    let lies = 0
    let drifts = 0
    let stationBoards = 0
    for (const seed of [1, 6, 777, 0x5eed]) {
      const src = worldSource(seed, config)
      const ex = exitTileOf(seed)
      for (let cx = -12; cx < 4 * (ex + 1); cx++) {
        const tx = Math.floor(cx / TILE.w)
        const lc = cx - tx * TILE.w
        for (const cy of [0, 1]) {
          if (footprint(seed, cx, cy, 0) === 'solid') {
            expect(trainPlates(src.chunkAt(cx, cy, 0))).toEqual([])
            continue
          }
          const d = src.chunkAt(cx, cy, 0)
          const plates = trainPlates(d)
          const { decals } = drawPlates(d)
          expect(decals.length).toBe(plates.length)
          const at = `${seed} ${cx},${cy}`
          // On a real face, clear of everything the office layer hangs there.
          const plan = signagePlan(d)
          for (const p of plates) {
            if (p.axis === 'h') expect(plateFace(d, plan, false, p.line, p.cell, p.side), `board face ${at}`).toBe(true)
            else if (p.line < CHUNK) expect(d.passageV[vIdx(p.line, p.cell)], `gangway door ${at}`).toBe(PASSAGE_DOOR)
          }
          const dressing = collectInteriorDressing(d)
          const others = [...dressing.decals, ...dressing.signs, ...dressing.props, ...dressing.trim].filter((o) => !o.numeral && !decals.some((m) => m.px === o.px && m.py === o.py && m.pz === o.pz && m.number === o.number))
          for (const m of decals) for (const o of others) expect(overlaps(aabb(m), aabb(o)), `plate ${m.number} overlaps dressing ${at}`).toBe(false)
          const sk = skeleton(seed, tx)
          const boards = plates.filter((p) => p.axis === 'h').map((p) => p.number)
          if (cy === 0) {
            // Every gangway door in the chunk: a panel facing each car.
            const want = []
            for (const j of sk.joints) {
              const line = j.x - lc * CHUNK
              if (line < 0 || line >= CHUNK) continue
              if (line > 0) want.push(carPlateOf(seed, tx, j.west))
              want.push(carPlateOf(seed, tx, j.east))
            }
            const east = lc === TILE.w - 1 ? sk.cars[sk.n - 1] : sk.joints.find((q) => q.x === (lc + 1) * CHUNK)
            if (east) want.push(lc === TILE.w - 1 ? carPlateOf(seed, tx, east.j) : carPlateOf(seed, tx, east.west))
            expect(plates.filter((p) => p.axis === 'v').map((p) => p.number), at).toEqual(want)
            for (const n of want) expect(n).toMatch(/^C[1-9]$/)
            for (const j of sk.joints) if (carPlateOf(seed, tx, j.east) !== `C${j.east + 1}` && j.x >= lc * CHUNK && j.x < (lc + 1) * CHUNK) lies++
          }
          const names = stationPlatesOf(seed, tx, cy)?.find((q) => q.chunk === lc)
          if (!names) {
            expect(boards, at).toEqual([])
            continue
          }
          // At most one board per station chunk on each storey: the
          // platform's back wall (cy 0), the concourse's free-side wall (cy 1).
          expect(boards.length, `board ${at}`).toBeLessThanOrEqual(1)
          if (boards.length) {
            stationBoards++
            expect(boards[0], at).toBe(names.name)
            if (tx === ex) expect(boards[0], at).toBe(UNLISTED)
            if (names.name !== stationPlatesOf(seed, tx, cy)[0].name) drifts++
          }
        }
      }
    }
    expect(lies, 'lying car plates drawn').toBeGreaterThan(0)
    expect(drifts, 'drifting boards drawn').toBeGreaterThan(0)
    expect(stationBoards, 'station boards drawn').toBeGreaterThan(10)
  }, 60_000)

  // Once Phase I registers the family plates (src/world/families/plates.js
  // and the dressing hunk), the runtime dressing itself draws them.
  const wired = existsSync(new URL('../../plates.js', import.meta.url))
  it.skipIf(!wired)('the runtime dressing draws the declared plates (nonE on the exit concourse, C<n> in a plain car)', () => {
    const seed = 1
    const src = worldSource(seed, config)
    const ex = exitTileOf(seed)
    const numbers = (cx, cy) => collectInteriorDressing(src.chunkAt(cx, cy, 0)).decals.map((r) => r.number).filter((n) => n != null)
    const st = skeleton(seed, ex).station
    expect(st.chunks1.some((c) => numbers(ex * TILE.w + c, 1).includes(UNLISTED))).toBe(true)
    let plain = -1
    for (let cx = -8; cx < 0 && plain < 0; cx++) if (!stationPlatesOf(seed, Math.floor(cx / TILE.w), 0)?.some((q) => q.chunk === ((cx % 4) + 4) % 4)) plain = cx
    expect(numbers(plain, 0)).toEqual(expect.arrayContaining(trainPlates(src.chunkAt(plain, 0, 0)).map((p) => p.number)))
  })
})
