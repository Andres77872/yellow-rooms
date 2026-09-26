import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { lookTableMarkdown, tierTablesMarkdown } from '../../../scripts/tierTables.mjs'

// The chapter 14 record embeds the tier and look tables generated from the
// code (engine-improvement P27): this fails when the document drifts from
// core/graphics.js or render/lookProfile.js. Regenerate with
//   node scripts/gen-tier-tables.mjs --write
const DOC = fileURLToPath(new URL('../../../docs/engine-improvement/14-shadows-quality-style.md', import.meta.url))

function block(text, name) {
  const open = `<!-- generated:${name} -->`
  const close = `<!-- /generated:${name} -->`
  const a = text.indexOf(open)
  const b = text.indexOf(close)
  expect(a, `${open} present`).toBeGreaterThanOrEqual(0)
  expect(b, `${close} present`).toBeGreaterThan(a)
  return text.slice(a + open.length, b).trim()
}

describe('chapter 14 generated tables', () => {
  it('match the code', () => {
    const doc = readFileSync(DOC, 'utf8')
    expect(block(doc, 'tiers')).toBe(tierTablesMarkdown().trim())
    expect(block(doc, 'looks')).toBe(lookTableMarkdown().trim())
  })
})
