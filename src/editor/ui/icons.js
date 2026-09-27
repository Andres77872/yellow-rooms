// Inline SVG icons (no dependencies, no external assets). 24-unit viewBox,
// stroked with currentColor so they follow the control's text colour.

const C = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`

export const ICONS = {
  select: 'M5 3l13 7.5-5.5 1.5L10 18z M12.5 12l5 6',
  room: 'M4 4h16v16H4z M12 4v6 M12 14v6 M4 12h5',
  wall: 'M3 5h18v14H3z M3 12h18 M9 5v7 M15 12v7',
  cell: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  object: 'M4 10h16 M6 10v9 M18 10v9 M8 10V5h8v5',
  lamp: 'M9 18h6 M10 21h4 M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z',
  erase: 'M4 15l9-9 6 6-7 7H8z M9 10l6 6 M12 21h9',
  section: 'M4 6h16 M4 12h16 M4 18h16 M12 3v18',
  probe: `${C(12, 12, 5)} M12 3v4 M12 17v4 M3 12h4 M17 12h4`,
  author: 'M6 21V7l6-4 6 4v14 M6 11h12 M6 15h12 M10 21v-3h4v3',
  undo: 'M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5 M20 9H10a6 6 0 0 0 0 12h3',
  file: 'M6 3h8l4 4v14H6z M14 3v4h4 M12 11v6 M9 14h6',
  import: 'M12 3v12 M7 10l5 5 5-5 M4 17v3h16v-3',
  export: 'M12 15V3 M7 8l5-5 5 5 M4 17v3h16v-3',
  download: 'M12 3v12 M7 10l5 5 5-5 M4 17v3h16v-3',
  search: `${C(11, 11, 7)} M16 16l5 5`,
  help: `${C(12, 12, 9)} M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7v.5 M12 17h.01`,
  map: 'M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z M9 3v15 M15 6v15',
  eye: `M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z ${C(12, 12, 3)}`,
  building: 'M5 21V4h14v17 M9 8h2 M13 8h2 M9 12h2 M13 12h2 M9 16h2 M13 16h2 M3 21h18',
  pulse: 'M3 12h4l3-8 4 16 3-8h4',
  info: `${C(12, 12, 9)} M12 11v6 M12 7h.01`,
  cube: 'M12 2l9 5v10l-9 5-9-5V7z M3 7l9 5 9-5 M12 12v10',
  layers: 'M12 3l9 5-9 5-9-5z M3 13l9 5 9-5',
  fit: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
  home: 'M3 11l9-8 9 8 M5 9v11h14V9',
  zoomIn: `${C(11, 11, 7)} M16 16l5 5 M8 11h6 M11 8v6`,
  zoomOut: `${C(11, 11, 7)} M16 16l5 5 M8 11h6`,
  up: 'M12 19V5 M6 11l6-6 6 6',
  down: 'M12 5v14 M6 13l6 6 6-6',
  chevron: 'M9 6l6 6-6 6',
  close: 'M6 6l12 12 M18 6L6 18',
  lock: 'M6 11h12v10H6z M8 11V7a4 4 0 0 1 8 0v4',
  unlock: 'M6 11h12v10H6z M8 11V7a4 4 0 0 1 7.5-2',
  globe: `${C(12, 12, 9)} M3 12h18 M12 3a14 14 0 0 1 0 18 M12 3a14 14 0 0 0 0 18`,
  doc: 'M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6 M9 16h6',
  history: `${C(12, 12, 9)} M12 7v5l3 2`,
  panel: 'M3 4h18v16H3z M15 4v16',
  keyboard: 'M3 6h18v12H3z M7 10h.01 M11 10h.01 M15 10h.01 M7 14h10',
  rotate: 'M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7',
  trash: 'M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3',
  warn: 'M12 3l10 18H2z M12 10v5 M12 18h.01',
  check: 'M5 12l5 5 9-10',
  play: 'M7 4l13 8-13 8z',
  swap: 'M7 4v16 M3 8l4-4 4 4 M17 20V4 M13 16l4 4 4-4',
  crosshair: `${C(12, 12, 8)} M12 2v6 M12 16v6 M2 12h6 M16 12h6`,
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7',
  scan: 'M4 8V4h4 M16 4h4v4 M20 16v4h-4 M8 20H4v-4 M4 12h16',
  diff: 'M8 3v18 M16 3v18 M4 8h8 M12 16h8',
  table: 'M3 5h18v14H3z M3 10h18 M3 15h18 M9 5v14',
  palette: `${C(12, 12, 9)} M8 10h.01 M12 7h.01 M16 10h.01 M15 15a2 2 0 0 1-3 2`,
  terminal: 'M4 5h16v14H4z M7 9l3 3-3 3 M12 15h5',
  dot: C(12, 12, 4),
}

const NS = 'http://www.w3.org/2000/svg'

// Build an <svg> icon. Decorative by default (aria-hidden); pass `label` for
// an icon that is the control's only content.
export function icon(name, { size = 16, label = null, className = 'edt-icon' } = {}) {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.7')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('class', className)
  if (label) {
    svg.setAttribute('role', 'img')
    svg.setAttribute('aria-label', label)
  } else {
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('focusable', 'false')
  }
  const path = document.createElementNS(NS, 'path')
  path.setAttribute('d', ICONS[name] ?? ICONS.dot)
  svg.appendChild(path)
  return svg
}
