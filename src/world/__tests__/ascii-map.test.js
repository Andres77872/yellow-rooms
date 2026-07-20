import { describe, expect, it } from 'vitest'
import { ASCII_LEGEND, renderAsciiChunk, renderAsciiPatch } from '../asciiMap.js'
import { ChunkData } from '../ChunkData.js'
import { CHUNK, ZONE_OFFICE } from '../constants.js'
import { buildChunk } from '../pipeline.js'
import {
  CELL_ATRIUM,
  CELL_BRIDGE,
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_ROOM,
  CELL_VOID,
  COLUMN_FURNITURE,
  COLUMN_MONUMENTAL,
  COLUMN_STANDARD,
  PASSAGE_DOOR,
  PASSAGE_WALL,
  PASSAGE_WIDE,
  WALL_WINDOW,
} from '../mapTypes.js'
import { discoverTowerFixture } from './tower-fixture.js'

// Grid coordinates for a single rendered chunk without ruler margin:
// cell (lx,lz) -> row 2*lz+1, col 2*lx+1; its West edge col 2*lx, North edge
// row 2*lz.
const cellAt = (lines, lx, lz) => lines[2 * lz + 1][2 * lx + 1]
const westEdgeAt = (lines, lx, lz) => lines[2 * lz + 1][2 * lx]
const northEdgeAt = (lines, lx, lz) => lines[2 * lz][2 * lx + 1]

function handBuiltChunk() {
  const data = new ChunkData(0, 0, 0, ZONE_OFFICE)
  data.setV(3, 2, 1)
  data.setV(4, 2, 0, PASSAGE_DOOR)
  data.setH(5, 3, 1, PASSAGE_WALL, WALL_WINDOW)
  data.setH(6, 3, 0, PASSAGE_WIDE)
  data.setCol(2, 2, COLUMN_STANDARD)
  data.setCol(3, 3, COLUMN_MONUMENTAL)
  data.setCol(4, 4, COLUMN_FURNITURE)
  const kinds = [CELL_ROOM, CELL_CORRIDOR, CELL_LOBBY, CELL_ATRIUM, CELL_BRIDGE, CELL_VOID]
  kinds.forEach((kind, i) => {
    data.cellKind[6 * CHUNK + (6 + i)] = kind
  })
  data.lamps.push({ lx: 1, lz: 1, lit: true }, { lx: 2, lz: 1, lit: false })
  data.exit = { lx: 12, lz: 12 }
  data.stairUp = {
    dir: 'E',
    landing: { lx: 5, lz: 8 },
    run: [{ lx: 6, lz: 8 }, { lx: 7, lz: 8 }],
    exit: { lx: 8, lz: 8 },
  }
  data.stairDown = {
    dir: 'E',
    landing: { lx: 1, lz: 10 },
    run: [{ lx: 2, lz: 10 }, { lx: 3, lz: 10 }],
    exit: { lx: 4, lz: 10 },
  }
  return data
}

describe('ascii map renderer', () => {
  it('renders every glyph family of a hand-built chunk at its exact grid position', () => {
    const lines = renderAsciiChunk(handBuiltChunk(), { ruler: false }).split('\n')

    expect(lines).toHaveLength(CHUNK * 2 + 1)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(CHUNK * 2 + 1)

    expect(westEdgeAt(lines, 3, 2)).toBe('|')
    expect(westEdgeAt(lines, 4, 2)).toBe('d')
    expect(northEdgeAt(lines, 5, 3)).toBe('w')
    expect(northEdgeAt(lines, 6, 3)).toBe('_')
    expect(cellAt(lines, 2, 2)).toBe('#')
    expect(cellAt(lines, 3, 3)).toBe('M')
    expect(cellAt(lines, 4, 4)).toBe('f')
    expect(cellAt(lines, 6, 6)).toBe('.')
    expect(cellAt(lines, 7, 6)).toBe(',')
    expect(cellAt(lines, 8, 6)).toBe('L')
    expect(cellAt(lines, 9, 6)).toBe('A')
    expect(cellAt(lines, 10, 6)).toBe('=')
    expect(cellAt(lines, 11, 6)).toBe('~')
    expect(cellAt(lines, 1, 1)).toBe('*')
    expect(cellAt(lines, 2, 1)).toBe('o')
    expect(cellAt(lines, 12, 12)).toBe('E')
    // stairUp: landing + run on this floor; its exit lives on the layer above.
    expect(cellAt(lines, 5, 8)).toBe('^')
    expect(cellAt(lines, 6, 8)).toBe('%')
    expect(cellAt(lines, 7, 8)).toBe('%')
    expect(cellAt(lines, 8, 8)).toBe(' ')
    // stairDown: exit + run holes; its landing lives on the layer below.
    expect(cellAt(lines, 4, 10)).toBe('v')
    expect(cellAt(lines, 2, 10)).toBe('%')
    expect(cellAt(lines, 3, 10)).toBe('%')
    expect(cellAt(lines, 1, 10)).toBe(' ')
    // corners everywhere; unknown neighbours close the patch boundary.
    expect(lines[0][0]).toBe('+')
    expect(westEdgeAt(lines, 0, 5)).toBe(' ') // owned West line, open by default
    expect(lines[2 * 5 + 1][CHUNK * 2]).toBe('|') // East boundary: unknown -> wall
    expect(lines[CHUNK * 2][2 * 5 + 1]).toBe('-') // South boundary: unknown -> wall
  })

  it('is deterministic and dimensioned over a generated tower patch', () => {
    const { config, seed, structure } = discoverTowerFixture()
    expect(structure).not.toBeNull()

    const cy = structure.baseCy + 1
    const [a, b] = structure.participants
    const X0 = Math.min(a.cx, b.cx)
    const Z0 = Math.min(a.cz, b.cz)
    const NX = Math.abs(a.cx - b.cx) + 1
    const NZ = Math.abs(a.cz - b.cz) + 1
    const cache = new Map()
    const dataAt = (cx, ccy, cz) => {
      const key = `${cx},${ccy},${cz}`
      if (!cache.has(key)) cache.set(key, buildChunk(seed, cx, ccy, cz, config))
      return cache.get(key)
    }

    const first = renderAsciiPatch(dataAt, X0, cy, Z0, NX, NZ)
    const second = renderAsciiPatch(dataAt, X0, cy, Z0, NX, NZ)

    expect(second).toBe(first)
    const lines = first.split('\n')
    expect(lines).toHaveLength(1 + NZ * CHUNK * 2 + 1) // ruler header + grid rows
    expect(lines[0]).toContain(`cx ${X0}`)
    expect(lines[1]).toContain(`cz ${Z0}`)
  })

  it('marks lethal cells, bridges, and unknown chunks with matching counts on a tower floor', () => {
    const { config, seed, structure } = discoverTowerFixture()
    expect(structure).not.toBeNull()

    const [a, b] = structure.participants
    const X0 = Math.min(a.cx, b.cx)
    const Z0 = Math.min(a.cz, b.cz)
    const NX = Math.abs(a.cx - b.cx) + 1
    const NZ = Math.abs(a.cz - b.cz) + 1

    // Find a structure floor whose participants carry a lethal down half.
    let floor = null
    const floors = new Map()
    for (let cy = structure.baseCy; cy <= structure.topCy; cy++) {
      const patch = structure.participants.map((p) => buildChunk(seed, p.cx, cy, p.cz, config))
      floors.set(cy, patch)
      if (floor === null && patch.some((d) => d.lethalVoidDown)) floor = cy
    }
    expect(floor).not.toBeNull()

    const patch = floors.get(floor)
    const byKey = new Map(patch.map((d) => [`${d.cx},${d.cz}`, d]))
    const dataAt = (cx, cy, cz) => (cy === floor ? byKey.get(`${cx},${cz}`) ?? null : null)
    const out = renderAsciiPatch(dataAt, X0, floor, Z0, NX, NZ, { ruler: false })

    const count = (ch) => out.split('').filter((c) => c === ch).length
    const lethalCells = patch.reduce(
      (n, d) => n + (d.lethalVoidDown?.cells?.length ?? 0),
      0
    )
    const bridgeCells = patch.reduce(
      (n, d) => n + d.cellKind.reduce((m, k) => m + (k === CELL_BRIDGE ? 1 : 0), 0),
      0
    )
    expect(count('X')).toBe(lethalCells)
    expect(count('!')).toBe(0)
    // CELL_BRIDGE cells render '=' unless a stair or lethal glyph outranks
    // them; tower decks never overlap those, so counts match exactly.
    expect(count('=')).toBe(bridgeCells)

    // A patch widened by one unknown chunk column renders '?' cells there.
    const widened = renderAsciiPatch(dataAt, X0, floor, Z0, NX + 1, NZ, { ruler: false })
    expect(widened).toContain('?')
  })

  it('exports a legend covering every cell glyph', () => {
    for (const glyph of ['E', '^', 'v', '%', 'X', '!', '~', '=', 'M', '#', 'f', '*', 'o', 'L', 'A', '?']) {
      expect(ASCII_LEGEND).toContain(glyph)
    }
  })
})
