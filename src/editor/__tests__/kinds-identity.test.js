import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  KINDS_FIXTURE_PATH,
  KIND_SEEDS,
  computeKindDigests,
  diffKindDigests,
} from '../../../scripts/kinds-digest.mjs'
import { PROTOTYPE_KINDS } from '../prototypes.js'

// Invariant I10: the editor's kinds keep producing byte-identical .yrmap
// documents (version-normalised to 28) while their bodies move into
// src/world. Refresh only on purpose: node scripts/kinds-digest.mjs --write.
describe('editor kind identity', () => {
  const pinned = JSON.parse(readFileSync(KINDS_FIXTURE_PATH, 'utf8'))

  it('pins every prototype kind over the fixed seeds', () => {
    expect(Object.keys(pinned)).toEqual(
      PROTOTYPE_KINDS.flatMap((kind) => KIND_SEEDS.map((seed) => `${kind.id}:${seed}`))
    )
  })

  it('serializes every kind to the pinned bytes', () => {
    expect(diffKindDigests(pinned, computeKindDigests())).toEqual([])
  })
})
