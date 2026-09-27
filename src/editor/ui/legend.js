import {
  CELL_ATRIUM, CELL_BRIDGE, CELL_CORRIDOR, CELL_LOBBY, CELL_OPEN, CELL_ROOM, CELL_STAIR, CELL_VOID,
} from '../../world/mapTypes.js'
import { ZONE_OFFICE, ZONE_PILLARS, ZONE_SEWER, ZONE_WAREHOUSE } from '../../world/constants.js'
import { SPACE_ROLE_PALETTE, STRUCTURE_FAMILY_COLORS, ZONE_TINT, roomRoleLabel } from '../../debug/mapInspect.js'
import { KIND_FILL, heat } from './MapView2D.js'
import { h } from './dom.js'

// Colour legends for the plan: layers, fill modes and the help sheet. The
// colours are the ones MapView2D draws with.

const FAMILY_HINTS = {
  office: 'Office: irregular room districts, bullpens and galleries; atria, light wells, stair halls, light courts and bureau halls.',
  hotel: 'Hotel: long double-loaded wings of small guest rooms; open-well stairs, Portman and grand atria, ballrooms, motel courts.',
  sewer: 'Sewer: dry tunnels and chambers in rock; drop shafts, weir chambers, cisterns, surge chambers, stepwells, pressure tanks.',
  tower: 'Tower: broad galleries round huge service cores; naves and courts, stair cores, carceri naves, car-park decks, panoptic wells.',
  lattice: 'Lattice: alleys, open yards and booths under catwalk districts; stair pylons, gantries, escalator spines, module hills, abysses.',
}

export const familyLabel = (f) => (f ? f[0].toUpperCase() + f.slice(1) : '—')
export const familyHint = (f) => FAMILY_HINTS[f] ?? `The ${f} map family.`
export const familyColor = (f) => STRUCTURE_FAMILY_COLORS[f] ?? '#e0a07a'

const opaque = (rgba, a = 0.9) => rgba.replace(/[\d.]+\)$/, `${a})`)

export const LAYER_LEGEND = {
  grid: [{ color: 'rgba(94,80,26,0.9)', label: 'cell lines', kind: 'line' }],
  labels: [{ color: '#ffe6a0', label: 'room id · role', kind: 'text' }],
  ghost: [{ color: 'rgba(120,170,220,0.8)', label: 'storey below', kind: 'line' }],
  ceiling: [{ color: 'rgba(200,190,255,0.9)', label: 'open above', kind: 'dash' }],
  stairs: [{ color: '#f0e08a', label: '↑ up', kind: 'fill' }, { color: '#8fd0c0', label: '↓ down', kind: 'fill' }],
  structures: Object.keys(STRUCTURE_FAMILY_COLORS).map((f) => ({ color: STRUCTURE_FAMILY_COLORS[f], label: f, kind: 'line' }))
    .concat([{ color: '#ff9ae0', label: 'authored', kind: 'line' }]),
  lethal: [{ color: 'rgba(220,40,40,0.8)', label: 'drop', kind: 'fill' }, { color: 'rgba(255,140,0,0.85)', label: 'invalid half', kind: 'fill' }],
  issues: [{ color: 'rgba(230,50,40,0.9)', label: 'error', kind: 'fill' }, { color: 'rgba(240,160,40,0.9)', label: 'warning', kind: 'fill' }],
  diff: [{ color: 'rgba(255,80,140,0.95)', label: 'structure', kind: 'line' }, { color: 'rgba(220,120,255,0.8)', label: 'other', kind: 'line' }],
  sim: [
    { color: heat(0.1), label: 'near', kind: 'fill' }, { color: heat(0.9), label: 'far', kind: 'fill' },
    { color: '#7fffa0', label: 'path', kind: 'line' }, { color: 'rgba(120,220,255,0.85)', label: 'isovist', kind: 'line' },
    { color: '#ff5a4a', label: 'dead end', kind: 'fill' }, { color: '#ff7ae0', label: 'pin', kind: 'line' },
  ],
}

const KIND_NAMES = [
  [CELL_OPEN, 'open'], [CELL_ROOM, 'room'], [CELL_CORRIDOR, 'corridor'], [CELL_LOBBY, 'lobby'],
  [CELL_STAIR, 'stair'], [CELL_ATRIUM, 'atrium'], [CELL_VOID, 'void'], [CELL_BRIDGE, 'bridge'],
]

export function fillLegend(mode) {
  if (mode === 'kind') return KIND_NAMES.map(([k, label]) => ({ color: opaque(KIND_FILL[k], 0.75), label, kind: 'fill' }))
  if (mode === 'zone') {
    return [[ZONE_OFFICE, 'office'], [ZONE_PILLARS, 'pillars'], [ZONE_WAREHOUSE, 'warehouse'], [ZONE_SEWER, 'sewer']]
      .filter(([z]) => ZONE_TINT[z]).map(([z, label]) => ({ color: opaque(ZONE_TINT[z], 0.7), label, kind: 'fill' }))
  }
  if (mode === 'space') return [{ color: 'hsl(40,65%,55%)', label: 'one hue', kind: 'fill' }, { color: 'hsl(200,65%,55%)', label: 'per space id', kind: 'fill' }]
  if (mode === 'role') {
    return Object.entries(SPACE_ROLE_PALETTE).map(([role, color]) => ({ color, label: roomRoleLabel(Number(role)) ?? role, kind: 'fill' }))
  }
  if (mode === 'owner') {
    return Object.entries(STRUCTURE_FAMILY_COLORS).map(([f, color]) => ({ color, label: `${f} participant`, kind: 'fill' }))
      .concat([{ color: '#cfe8ff', label: '↑↓ slice / stair tags', kind: 'text' }])
  }
  if (mode === 'gen') return [0, 5, 10, 20].map((ms) => ({ color: heat(ms / 20), label: `${ms}${ms === 20 ? '+' : ''} ms`, kind: 'fill' }))
  return []
}

export function legendEl(items, { className = '' } = {}) {
  const root = h('div', { class: `edt-legend-row ${className}`.trim(), role: 'list' })
  for (const it of items) {
    const sw = h('span', { class: `edt-sw edt-sw-${it.kind ?? 'fill'}` })
    if (it.kind === 'line' || it.kind === 'dash') sw.style.borderColor = it.color
    else if (it.kind === 'text') sw.style.color = it.color
    else sw.style.background = it.color
    if (it.kind === 'text') sw.textContent = 'Aa'
    root.appendChild(h('span', { class: 'edt-legend-item', role: 'listitem' }, sw, it.label))
  }
  return root
}

// Everything the plan draws, for the help sheet.
export function planLegend() {
  return [
    { title: 'Cell kinds (fill “kind”)', items: fillLegend('kind') },
    { title: 'Stairs', items: LAYER_LEGEND.stairs },
    { title: 'Structures by family', items: LAYER_LEGEND.structures },
    { title: 'Openings & voids', items: [...LAYER_LEGEND.ceiling, ...LAYER_LEGEND.lethal, ...LAYER_LEGEND.ghost] },
    { title: 'Review', items: [...LAYER_LEGEND.issues, ...LAYER_LEGEND.diff] },
    { title: 'Simulations', items: LAYER_LEGEND.sim },
    { title: 'Walls & openings', items: [
      { color: '#b8a85a', label: 'wall', kind: 'line' }, { color: '#8fd0c0', label: 'door', kind: 'line' },
      { color: 'rgba(143,208,192,0.5)', label: 'wide opening', kind: 'line' }, { color: '#f8f1a8', label: 'lit lamp', kind: 'fill' },
      { color: '#6b5a2a', label: 'dead lamp', kind: 'line' }, { color: 'rgba(120,200,255,0.85)', label: 'section cut', kind: 'dash' },
    ] },
  ]
}
