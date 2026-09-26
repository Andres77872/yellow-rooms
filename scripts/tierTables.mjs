// Markdown tables of the quality tiers and look profiles, generated from the
// code (see gen-tier-tables.mjs). Pure: importable from tests.
import { AO_TIERS, FLASH_TIERS, GRAPHICS_PRESETS, PRESET_ORDER, SHADOW_TIERS, TIER_ORDER, VOL_TIERS } from '../src/core/graphics.js'
import { LOOK_ORDER, LOOK_PROFILES } from '../src/render/lookProfile.js'

const fmt = (v) => {
  if (v === true) return 'yes'
  if (v === false) return 'no'
  if (Array.isArray(v)) return `[${v.map((x) => +Number(x).toFixed(3)).join(', ')}]`
  if (typeof v === 'number') return String(+v.toFixed(3))
  return String(v)
}

function table(title, rows, cols) {
  const head = `| ${title} | ${cols.join(' | ')} |`
  const sep = `|---|${cols.map(() => '---').join('|')}|`
  return [head, sep, ...rows.map(([label, cells]) => `| ${label} | ${cells.map(fmt).join(' | ')} |`)].join('\n')
}

function tierTable(name, tiers) {
  const keys = Object.keys(tiers.off)
  return table(name, keys.map((k) => [k, TIER_ORDER.map((t) => tiers[t][k])]), TIER_ORDER)
}

export function tierTablesMarkdown() {
  const presetKeys = Object.keys(GRAPHICS_PRESETS.high)
  return [
    tierTable('world shadows (`shadowQuality`)', SHADOW_TIERS),
    '',
    tierTable('flashlight shadows (`flashShadowQuality`)', FLASH_TIERS),
    '',
    tierTable('ambient occlusion (`aoQuality`)', AO_TIERS),
    '',
    tierTable('light shafts (`volQuality`)', VOL_TIERS),
    '',
    table('preset', presetKeys.map((k) => [k, PRESET_ORDER.map((p) => GRAPHICS_PRESETS[p][k])]), PRESET_ORDER),
  ].join('\n')
}

function paths(o, prefix = '') {
  const out = []
  for (const [k, v] of Object.entries(o)) {
    const p = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...paths(v, p))
    else out.push(p)
  }
  return out
}
const at = (o, p) => p.split('.').reduce((x, k) => x?.[k], o)

export function lookTableMarkdown() {
  const keys = paths(LOOK_PROFILES[LOOK_ORDER[0]]).filter((p) => !['id', 'label', 'version'].includes(p))
  return table('lever', keys.map((k) => [k, LOOK_ORDER.map((id) => at(LOOK_PROFILES[id], k))]), LOOK_ORDER)
}
