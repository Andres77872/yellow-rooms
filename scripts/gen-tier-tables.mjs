#!/usr/bin/env node

// Generate the chapter 14 quality-tier and look tables from the code
// (engine-improvement P27). The document embeds the output between
// `<!-- generated:tiers -->` / `<!-- /generated:tiers -->` markers (and the
// same for `looks`); src/render/__tests__/doc-tables.test.js fails when the
// document drifts from core/graphics.js or render/lookProfile.js.
//
//   node scripts/gen-tier-tables.mjs            print both tables
//   node scripts/gen-tier-tables.mjs --write    rewrite the blocks in place

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tierTablesMarkdown, lookTableMarkdown } from './tierTables.mjs'

const DOC = fileURLToPath(new URL('../docs/engine-improvement/14-shadows-quality-style.md', import.meta.url))

export function replaceBlock(text, name, body) {
  const open = `<!-- generated:${name} -->`
  const close = `<!-- /generated:${name} -->`
  const a = text.indexOf(open)
  const b = text.indexOf(close)
  if (a < 0 || b < a) throw new Error(`missing ${open} block`)
  return `${text.slice(0, a + open.length)}\n${body}\n${text.slice(b)}`
}

const tiers = tierTablesMarkdown()
const looks = lookTableMarkdown()
if (process.argv.includes('--write')) {
  let doc = readFileSync(DOC, 'utf8')
  doc = replaceBlock(doc, 'tiers', tiers)
  doc = replaceBlock(doc, 'looks', looks)
  writeFileSync(DOC, doc)
  console.log('updated', DOC)
} else {
  console.log(tiers)
  console.log()
  console.log(looks)
}
