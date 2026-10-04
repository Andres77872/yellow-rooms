import { describe, expect, it } from 'vitest'
import { CELL } from '../constants.js'
import { signCell } from '../decalKinds.js'
import { generateChunk } from '../generate.js'
import { worldConfigForFamily } from '../mapFamily.js'
import { MAP_FAMILY_LATTICE, MAP_FAMILY_OFFICE, MAP_FAMILY_TOWER } from '../mapTypes.js'
import { collectInteriorDressing, PROP_TINT } from '../objects/dressing/index.js'
import { NUMERAL_GLYPHS, storeyNumber } from '../objects/dressing/notices.js'

// Authored level labels (ChunkData.levelLabel): the LEVEL plates print the
// label instead of the storey number, in the same seven-segment numerals.

const LABEL_ALPHABET = '0123456789-bACEFHLPUdrnoty '
const SEGMENTS = 'abcdefg'

// Where a plate's raised strokes sit: on its face, inside its outline.
function strokesOn(plate, ink) {
  const vertical = plate.sx < plate.sz
  const across = vertical ? plate.px : plate.pz
  const side = across > Math.round(across / CELL) * CELL ? 1 : -1
  return ink.filter((s) => {
    const off = vertical ? s.px - plate.px : s.pz - plate.pz
    const along = vertical ? s.pz - plate.pz : s.px - plate.px
    return Math.sign(off) === side && Math.abs(off) < 0.02 &&
      Math.abs(along) < (vertical ? plate.sz : plate.sx) / 2 && Math.abs(plate.py - s.py) < plate.sy / 2
  })
}

describe('level labels', () => {
  it('spells every label glyph on the seven-segment table', () => {
    for (const ch of LABEL_ALPHABET) {
      const segments = NUMERAL_GLYPHS[ch]
      expect(typeof segments, JSON.stringify(ch)).toBe('string')
      expect(new Set(segments).size, ch).toBe(segments.length)
      for (const seg of segments) expect(SEGMENTS, ch).toContain(seg)
    }
    expect(NUMERAL_GLYPHS[' ']).toBe('')
    // Every lit glyph reads as itself: no two share a segment set.
    const seen = new Map()
    for (const [ch, segments] of Object.entries(NUMERAL_GLYPHS)) {
      if (!segments) continue
      const key = [...segments].sort().join('')
      expect(seen.get(key), `${ch} looks like ${seen.get(key)}`).toBeUndefined()
      seen.set(key, ch)
    }
    // The letters in the conventional segment sets.
    const sorted = (ch) => [...NUMERAL_GLYPHS[ch]].sort().join('')
    expect(sorted('A')).toBe('abcefg')
    expect(sorted('E')).toBe('adefg')
    expect(sorted('F')).toBe('aefg')
    expect(sorted('L')).toBe('def')
    expect(sorted('d')).toBe('bcdeg')
    expect(sorted('o')).toBe('cdeg')
  })

  it('prints a chunk\'s levelLabel on its LEVEL plates, numerals included', () => {
    for (const family of [MAP_FAMILY_LATTICE, MAP_FAMILY_OFFICE, MAP_FAMILY_TOWER]) {
      const config = worldConfigForFamily(family)
      const level = signCell('level', family)
      let plates = 0
      for (let cz = 0; cz < 3; cz++) {
        for (let cx = 0; cx < 3; cx++) {
          const plain = generateChunk(4242, cx, 2, cz, config)
          const labelled = generateChunk(4242, cx, 2, cz, config)
          labelled.levelLabel = 'F13'
          const before = collectInteriorDressing(plain)
          const after = collectInteriorDressing(labelled)
          const platesBefore = before.decals.filter((p) => p.cell === level)
          const platesAfter = after.decals.filter((p) => p.cell === level)
          // Same plates, same places: only the number changes.
          expect(platesAfter.length, family).toBe(platesBefore.length)
          const ink = after.props.filter((p) => p.tint === PROP_TINT.signInk)
          for (const [i, p] of platesAfter.entries()) {
            expect(platesBefore[i].number, family).toBe(storeyNumber(2))
            expect(p.number, family).toBe('F13')
            expect([p.px, p.py, p.pz]).toEqual([platesBefore[i].px, platesBefore[i].py, platesBefore[i].pz])
            const segments = [...'F13'].reduce((n, c) => n + NUMERAL_GLYPHS[c].length, 0)
            expect(strokesOn(p, ink).length, family).toBe(segments)
            plates++
          }
        }
      }
      expect(plates, family).toBeGreaterThan(0)
    }
  })

  it('leaves a blank glyph unlit and keeps the plate', () => {
    const config = worldConfigForFamily(MAP_FAMILY_OFFICE)
    const level = signCell('level', MAP_FAMILY_OFFICE)
    let checked = 0
    for (let cx = 0; cx < 4 && !checked; cx++) {
      const d = generateChunk(4242, cx, 0, 0, config)
      d.levelLabel = 'P 2'
      const out = collectInteriorDressing(d)
      const ink = out.props.filter((p) => p.tint === PROP_TINT.signInk)
      for (const p of out.decals) {
        if (p.cell !== level) continue
        expect(p.number).toBe('P 2')
        expect(strokesOn(p, ink).length).toBe(NUMERAL_GLYPHS.P.length + NUMERAL_GLYPHS[2].length)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(0)
  })
})
