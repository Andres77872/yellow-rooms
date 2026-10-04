import {
  AREA,
  BASIN,
  DECK,
  GALLERY,
  LAST,
  R,
  TILE_CELLS,
  bandKey,
  dice,
  grow,
  inRect,
  planSeedOf,
  stairCore,
  tilePorts,
  tileVolumes,
} from './geometry.js'

// The poolrooms storey grammar (doc 01 §4.1–§4.3): what fills a tile's deck
// (cy 0), basin (cy −1) and upper gallery (cy +1) around the pool volumes
// geometry.js placed and the tile's stair core (stairCore). Pure in
// (planSeed, volumes, ports); no canvas, no plan — tile.js compiles the result.
//
// 1. PARTITION. A guillotine BSP over the tile's cells 0..40 (the east column
//    and the south row are mass but for ports). A region holding two or more
//    volume boxes is cut by a channel (2, 1 or 0 cells wide) that crosses no
//    box; a region holding one box sheds slices off its sides (each a chamber
//    run behind a channel or a bare wall) until the leftover is the volume's
//    HALL (its box plus a 0–6-cell deck margin, at most 3 round the pit
//    room's box; the stair core's box becomes its LOBBY the same way, on the
//    deck and the gallery); a region holding none is cut on 1–2-cell
//    channels or shared walls down to leaves sized by a rolled target area
//    (deck 4–13 cells a side, basin 3–10, gallery 170–290 cells²).
// 2. MODULES. Deck leaves become tiled chambers (pillars "in impractical
//    places"), at most one lazy-river ring (a 2-cell channel round a mass
//    island, doc §5) and at most one sentō (changing room + bath behind a
//    curtain, in a leaf no seam port opens into). Basin leaves become plant
//    rooms (pump blocks with aisles), tank rooms and sumps; basin cuts are
//    1-cell service tunnels. The gallery is a terrace level, not a warren:
//    a handful of big rooms a tile — up to three open SUN TERRACES (courts
//    with a colonnade down their long sides), viewing rooms and lofts —
//    joined mostly by arcades and glass; its natatio box is the vault's
//    balcony hall; it has no seam ports (its own floor per tile, reached by
//    the stair core and the vault's flight).
// 3. CIRCULATION. Channels open into each other; every walled region joins
//    its neighbours through MOUTHS: a random spanning tree first (so the
//    storey is one walk graph), then extra mouths that close loops (deck
//    p 0.3, basin p 0.12). On the basin a share of the tree's leaves stays
//    unexcavated mass (dead ends pruned to rock). East/south port stubs are
//    forced open; the bath keeps the curtain as its only door.
// 4. ANOMALY SITES. Deck chamber mouths whose removal keeps the storey
//    connected are the lane-rope candidates (never the only route).
//
// Sameness is the elements' (the same tile, troffers, mouths and basins
// everywhere), never the arrangement's: every cut, size, count, module and
// mouth above comes from the tile's planSeed.

const N = TILE_CELLS

const CFG = Object.freeze({
  // Deck: chambers 4..8 cells a side (doc §4.1: 3×3 to 8×8); a leaf at most
  // 4 across and up to 16 long is a colonnaded WALK instead. Pool halls keep
  // a 0–5-cell deck margin round their basin (the big tiled halls with the
  // long sight lines over the water), chambers join through mouths, open
  // ARCADES (a pillar row instead of the wall) or glass; rim dead ends may
  // stay solid, so the tile's outline differs too. The pit room's hall
  // keeps at most 3 cells round its box (pitHall: doc §5's 6×6 pit room,
  // not a big bare hall round a small well).
  deck: Object.freeze({
    salt: 0x0dec0, minLeaf: 4, maxLeaf: 8, walkLeaf: true, stopP: 0.12, chanP: 0.5, chanW2: 0.55, sliceP: 0.3, sliceChanP: 0.7,
    hallMin: 1, hallRest: 4, hallMax: 8, sliceMin: 4, courts: 1, courtMin: 9, courtMax: 14, courtP: 0.6, leafArea: [36, 29],
    loopP: 0.3, mouthW2: 0.7, arcP: 0.3, glassP: 0.35, massP: 0.4, rimOnly: true, pitHall: true, storeyCy: DECK,
  }),
  // The upper gallery (cy +1): the sun-bathers' and spectators' level over
  // the deck. Big open SUN TERRACES (courts of 7–18 cells, up to three a
  // tile: a colonnade down their long sides, the middle open for the
  // lounger rows), colonnaded walks and glass-fronted viewing rooms, joined
  // by arcades (pillar rows, not walls) and glass more than by doors, round
  // the natatio vault's balcony; joined to the deck by the tile's stair core
  // (and the vault's own flight). Leaves stop splitting under a rolled
  // 170–290 cells² (rooms median about 90 cells², 8 a tile: a handful of
  // rooms, not an office's dozens) and a third of the dead ends stay rock.
  // No seam ports: like the basin, each tile's gallery is its own floor.
  gallery: Object.freeze({
    salt: 0x6a11e, minLeaf: 6, maxLeaf: 16, walkLeaf: true, stopP: 0.25, chanP: 0.25, chanW2: 0.7, sliceP: 0.25, sliceChanP: 0.4,
    hallMin: 1, hallRest: 4, hallMax: 7, sliceMin: 5, courts: 3, courtMin: 7, courtMax: 18, courtP: 0.8, leafArea: [170, 121],
    loopP: 0.3, mouthW2: 0.85, arcP: 0.7, glassP: 0.6, massP: 0.35, rimOnly: false, pitHall: false, storeyCy: GALLERY,
  }),
  basin: Object.freeze({
    salt: 0x0ba50, minLeaf: 3, maxLeaf: 10, walkLeaf: false, stopP: 0.15, chanP: 0.35, chanW2: 0.3, sliceP: 0.8, sliceChanP: 0.75,
    hallMin: 0, hallRest: 2, hallMax: 6, sliceMin: 3, courts: 0, courtMin: 0, courtMax: 0, courtP: 0, leafArea: null,
    loopP: 0.12, mouthW2: 0.15, arcP: 0.35, glassP: 0, massP: 0.55, rimOnly: false, pitHall: false, storeyCy: BASIN,
  }),
})

const width = (r) => r.x1 - r.x0 + 1
const depth = (r) => r.z1 - r.z0 + 1

// --- 1. partition --------------------------------------------------------------------

function partition(cfg, d, storey, vols, ports, stair) {
  const regions = []
  const grid = new Int16Array(N * N).fill(-1)
  const add = (type, rect, extra = {}) => {
    const r = { id: regions.length, type, rect, walled: !(type === 'chan' || type === 'port'), mass: false, ...extra }
    regions.push(r)
    for (let gz = rect.z0; gz <= rect.z1; gz++) for (let gx = rect.x0; gx <= rect.x1; gx++) grid[gz * N + gx] = r.id
    return r
  }
  // At most one lazy-river ring (doc: p 0.3 per district) and one sentō
  // (the alternative landmark, p 0.5) per tile; spent flags read true.
  const state = { river: !d.p(0.3), sento: !d.p(0.5), leafArea: 20, walks: 0, courts: 0 }
  const chanWidth = (room) => (d.p(cfg.chanW2) ? 2 : 1) * (room ? 1 : 1)

  // A cut of rect `r` along `axis` at c: strip [c, c + w − 1] (w = 0: a bare
  // line before c). Returns [a, strip | null, b].
  const cutAt = (r, axis, c, w) => {
    if (axis === 'x') return [R(r.x0, r.z0, c - 1, r.z1), w ? R(c, r.z0, c + w - 1, r.z1) : null, R(c + w, r.z0, r.x1, r.z1)]
    return [R(r.x0, r.z0, r.x1, c - 1), w ? R(r.x0, c, r.x1, c + w - 1) : null, R(r.x0, c + w, r.x1, r.z1)]
  }

  // Two or more boxes: a channel (or bare line) crossing none, boxes both sides.
  const multiCut = (r, boxes) => {
    const widths = d.p(0.6) ? [2, 1, 0] : [1, 2, 0]
    for (const w of widths) {
      const found = []
      for (const axis of ['x', 'z']) {
        const lo = axis === 'x' ? r.x0 : r.z0
        const hi = axis === 'x' ? r.x1 : r.z1
        for (let c = lo + 1; c + w - 1 <= hi - 1 || (w === 0 && c <= hi); c++) {
          let a = 0
          let b = 0
          let crossed = false
          for (const { box } of boxes) {
            const b0 = axis === 'x' ? box.x0 : box.z0
            const b1 = axis === 'x' ? box.x1 : box.z1
            if (b1 < c) a++
            else if (b0 > c + w - 1 && b0 >= c) b++
            else {
              crossed = true
              break
            }
          }
          if (!crossed && a && b) found.push({ axis, c, w })
        }
      }
      if (found.length) return d.pick(found)
    }
    return null
  }

  const split = (r, boxes) => {
    if (r.x1 < r.x0 || r.z1 < r.z0) return
    if (boxes.length >= 2) {
      const cut = multiCut(r, boxes)
      if (!cut) throw new Error('poolrooms grammar: volume boxes are not separable')
      const [a, strip, b] = cutAt(r, cut.axis, cut.c, cut.w)
      const lo = (x) => (cut.axis === 'x' ? x.box.x1 : x.box.z1) < cut.c
      split(a, boxes.filter(lo))
      if (strip) add('chan', strip)
      split(b, boxes.filter((x) => !lo(x)))
      return
    }
    if (boxes.length === 1) {
      const { box } = boxes[0]
      const m = { W: box.x0 - r.x0, E: r.x1 - box.x1, N: box.z0 - r.z0, S: r.z1 - box.z1 }
      const T = cfg.sliceMin
      // The pit room keeps a thin margin (at most sliceMin − 1 = 3 cells
      // round its box: doc §5's 6×6 pit room, not a big bare hall).
      const pit = cfg.pitHall && vols[boxes[0].vol]?.type === 'pitRoom'
      const hallMax = pit ? 1 : cfg.hallMax
      const hallRest = pit ? 1 : cfg.hallRest
      const sides = Object.keys(m).filter((s) => m[s] >= T)
      const wide = sides.filter((s) => m[s] > hallMax)
      // Shed slices until every hall margin is at most hallMax cells (a
      // side of sliceMin..hallMax may still be shed by chance).
      if (wide.length || (sides.length && d.p(cfg.sliceP))) {
        const s = d.pick(wide.length ? wide : sides)
        let w = d.p(cfg.sliceChanP) ? chanWidth(false) : 0
        w = Math.min(w, m[s] - T)
        // The hall margin kept on that side: deck 2–hallRest (the pool halls
        // are the big tiled rooms with the long views over the water),
        // basin 0–2.
        const lo = Math.min(cfg.hallMin, m[s] - T - w)
        const rest = lo + d.n(Math.min(hallRest, m[s] - T - w) - lo + 1)
        const t = m[s] - w - rest // slice thickness ≥ sliceMin
        let slice
        let strip = null
        let keep
        if (s === 'W') [slice, strip, keep] = cutAt(r, 'x', r.x0 + t, w)
        else if (s === 'N') [slice, strip, keep] = cutAt(r, 'z', r.z0 + t, w)
        else if (s === 'E') [keep, strip, slice] = cutAt(r, 'x', r.x1 - t - w + 1, w)
        else [keep, strip, slice] = cutAt(r, 'z', r.z1 - t - w + 1, w)
        rooms(slice)
        if (strip) add('chan', strip)
        split(keep, boxes)
        return
      }
      if (boxes[0].stair) add('lobby', r, { box })
      else add('hall', r, { vol: boxes[0].vol, box })
      return
    }
    rooms(r)
  }

  const rooms = (r) => {
    const w = width(r)
    const h = depth(r)
    if (w < 3 || h < 3) {
      add('chan', r) // a narrow leftover is a passage
      return
    }
    // A dry tiled COURT (at most cfg.courts a tile): on the deck a 9–14-cell
    // colonnaded hall with no basin, the doc's "big tiled halls"; on the
    // gallery a 7–18-cell sun terrace.
    if (state.courts < cfg.courts && w >= cfg.courtMin && h >= cfg.courtMin && w <= cfg.courtMax && h <= cfg.courtMax && d.p(cfg.courtP)) {
      state.courts++
      add('court', r)
      return
    }
    const m = cfg.minLeaf
    const canX = w >= 2 * m
    const canZ = h >= 2 * m
    // A leaf is at most maxLeaf a side, or a long thin one (≤ 4 across,
    // ≤ 2·maxLeaf along): on the deck a colonnaded walk, below a long room.
    const square = w <= cfg.maxLeaf && h <= cfg.maxLeaf
    const thin = !square && Math.min(w, h) <= 4 && Math.max(w, h) <= 2 * cfg.maxLeaf
    if ((!canX && !canZ) || ((square || thin) && (w * h <= state.leafArea || d.p(cfg.stopP)))) {
      if (!thin) {
        leaf(r)
        return
      }
      // At most three walks a tile; another thin leaf splits on, or stays
      // a long room when it cannot.
      if (cfg.walkLeaf && state.walks < 3 && d.p(0.6)) {
        state.walks++
        add('walk', r)
        return
      }
      if (!canX && !canZ) {
        leaf(r)
        return
      }
    }
    let axis
    if (canX && canZ) axis = w > h + 2 ? (d.p(0.8) ? 'x' : 'z') : h > w + 2 ? (d.p(0.8) ? 'z' : 'x') : d.p(0.5) ? 'x' : 'z'
    else axis = canX ? 'x' : 'z'
    const len = axis === 'x' ? w : h
    let cw = d.p(cfg.chanP) ? chanWidth(true) : 0
    cw = Math.min(cw, len - 2 * m)
    const lo = axis === 'x' ? r.x0 : r.z0
    const c = lo + m + d.n(len - 2 * m - cw + 1)
    const [a, strip, b] = cutAt(r, axis, c, cw)
    rooms(a)
    if (strip) add('chan', strip)
    rooms(b)
  }

  const leaf = (r) => {
    const w = width(r)
    const h = depth(r)
    if (storey === 'basin') {
      if (w >= 6 && h >= 6 && d.p(0.6)) add('plant', r)
      else if (w >= 5 && h >= 5 && d.p(0.5)) add('tank', r)
      else add('sump', r)
      return
    }
    if (storey !== 'deck') {
      add('chamber', r)
      return
    }
    // A leaf a seam port opens into (the bath keeps the curtain as its only
    // door, so the sentō never takes one).
    const span = (list, lo, hi) => (list ?? []).some((q) => q.a0 <= hi && q.a1 >= lo)
    const ported = !!ports && (
      (r.x0 <= 0 && span(ports.west, r.z0, r.z1)) || (r.z0 <= 0 && span(ports.north, r.x0, r.x1)) ||
      (r.x1 >= LAST - 1 && span(ports.east, r.z0, r.z1)) || (r.z1 >= LAST - 1 && span(ports.south, r.x0, r.x1)))
    if (!state.river && w >= 7 && h >= 7 && d.p(0.45)) {
      state.river = true
      add('river', r)
      add('island', grow(r, -2), { mass: true, walled: false })
      return
    }
    if (!state.sento && !ported && Math.max(w, h) >= 7 && Math.min(w, h) >= 4 && d.p(0.6)) {
      state.sento = true
      const alongX = w >= h
      const long = alongX ? w : h
      const a = 4 + d.n(long - 7 + 1) // the changing room: 4–5 cells along
      const bathFirst = d.p(0.5)
      const [p, , q] = cutAt(r, alongX ? 'x' : 'z', (alongX ? r.x0 : r.z0) + (bathFirst ? long - a : a), 0)
      const [changing, bath] = bathFirst ? [q, p] : [p, q]
      const c = add('changing', changing)
      add('bath', bath, { changing: c.id })
      return
    }
    add('chamber', r)
  }

  // The grain of the tile: a leaf stops splitting once it is no bigger than
  // a rolled area. Deck: 36–64 cells² (chambers up to 8×8, so a tile holds
  // about 6–14); gallery: 170–290 cells²; basin: the free area over a
  // rolled 10–17 service rooms.
  const boxes = vols.map((v, i) => ({ box: v.box, vol: i })).filter((b) => storey !== 'gallery' || vols[b.vol].levels > 2)
  if (stair && storey !== 'basin') boxes.push({ box: stair.box, vol: -1, stair: true })
  const free = (AREA.x1 + 1) * (AREA.z1 + 1) - vols.reduce((a, v) => a + width(v.box) * depth(v.box), 0)
  state.leafArea = cfg.leafArea
    ? cfg.leafArea[0] + d.n(cfg.leafArea[1])
    : Math.max(20, Math.min(cfg.maxLeaf * cfg.maxLeaf, Math.floor(free / (10 + d.n(8)))))
  split(AREA, boxes)
  if (ports) {
    for (const p of ports.east) add('port', R(LAST, p.a0, LAST, p.a1))
    for (const p of ports.south) add('port', R(p.a0, LAST, p.a1, LAST))
  }
  return { regions, grid }
}

// --- 3. circulation --------------------------------------------------------------------

function adjacency(regions, grid) {
  const pairs = new Map()
  const pairOf = (a, b) => {
    const key = a < b ? a * 4096 + b : b * 4096 + a
    let p = pairs.get(key)
    if (!p) {
      p = { key, a: Math.min(a, b), b: Math.max(a, b), edges: [] }
      pairs.set(key, p)
    }
    return p
  }
  for (let gz = 0; gz < N; gz++) {
    for (let gx = 0; gx < N; gx++) {
      const a = grid[gz * N + gx]
      if (a < 0 || regions[a].mass) continue
      if (gx + 1 < N) {
        const b = grid[gz * N + gx + 1]
        if (b >= 0 && b !== a && !regions[b].mass) pairOf(a, b).edges.push({ axis: 'v', gx: gx + 1, gz, cells: [[gx, gz], [gx + 1, gz]] })
      }
      if (gz + 1 < N) {
        const b = grid[(gz + 1) * N + gx]
        if (b >= 0 && b !== a && !regions[b].mass) pairOf(a, b).edges.push({ axis: 'h', gx, gz: gz + 1, cells: [[gx, gz], [gx, gz + 1]] })
      }
    }
  }
  return [...pairs.values()]
}

function circulate(cfg, d, storey, regions, grid, vols, ports) {
  // West/north port cells lie on the tile's own rim: their region stays.
  const holdsPort = (r) => !!ports && (
    (r.rect.x0 === 0 && ports.west.some((p) => p.a0 <= r.rect.z1 && p.a1 >= r.rect.z0)) ||
    (r.rect.z0 === 0 && ports.north.some((p) => p.a0 <= r.rect.x1 && p.a1 >= r.rect.x0)))
  const pairs = adjacency(regions, grid)
  const parent = regions.map((_, i) => i)
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const union = (a, b) => {
    a = find(a)
    b = find(b)
    if (a === b) return false
    parent[a] = b
    return true
  }
  // Stair halos of this storey: no mouth lands on a flight's landing ring.
  const halos = vols.flatMap((v) => v.halos.filter((h) => h.cy === cfg.storeyCy).map((h) => h.rect))
  const inHalo = (gx, gz) => halos.some((h) => inRect(h, gx, gz))
  const badEdge = (e) => e.cells.some(([gx, gz]) => inHalo(gx, gz))

  const links = []
  const linked = new Set()
  const mouth = (p, w, forced = false, kind = 'mouth') => {
    const es = p.edges
    let width = Math.min(w, es.length)
    let starts = []
    for (; width >= 1 && !starts.length; width--) {
      for (let s = 0; s + width <= es.length; s++) if (es.slice(s, s + width).every((e) => !badEdge(e))) starts.push([s, width])
    }
    const [s, wd] = starts.length ? d.pick(starts) : [Math.floor(es.length / 2), 1]
    const link = { pair: p, open: false, forced, kind, edges: es.slice(s, s + wd) }
    links.push(link)
    linked.add(p.key)
    union(p.a, p.b)
    return link
  }
  const open = (p) => {
    links.push({ pair: p, open: true, forced: true, kind: 'open', edges: p.edges })
    linked.add(p.key)
    union(p.a, p.b)
  }
  const isBath = (r) => r.type === 'bath'
  const excluded = (p) => {
    const A = regions[p.a]
    const B = regions[p.b]
    if (isBath(A)) return B.id !== A.changing
    if (isBath(B)) return A.id !== B.changing
    return false
  }
  const mouthW = () => (d.p(cfg.mouthW2) ? 2 : 1)
  // Two deck rooms side by side may open into each other along the whole
  // shared line: an ARCADE (tile.js stands a pillar every third cell of it).
  // Below, a plant room may lie open to its service tunnel behind a row of
  // pipe columns the same way.
  const arcadeOk = (p) => {
    const A = regions[p.a]
    const B = regions[p.b]
    const ok = storey !== 'basin'
      ? (r) => r.type === 'chamber' || r.type === 'walk' || r.type === 'court'
      : (r) => r.type === 'plant' || r.type === 'tank' || r.type === 'chan'
    const mixed = storey !== 'basin' || (A.type === 'chan') !== (B.type === 'chan')
    return cfg.arcP > 0 && ok(A) && ok(B) && mixed && p.edges.length >= 3 && !p.edges.some(badEdge)
  }
  const join = (p, kind) => {
    if (arcadeOk(p) && d.p(cfg.arcP)) {
      links.push({ pair: p, open: true, forced: false, kind: 'arcade', edges: p.edges })
      linked.add(p.key)
      union(p.a, p.b)
      return
    }
    mouth(p, mouthW(), false, kind)
  }

  // Forced: channels into channels, port stubs, the sentō curtain.
  for (const p of pairs) {
    const A = regions[p.a]
    const B = regions[p.b]
    if (!A.walled && !B.walled) open(p)
    else if (A.type === 'port' || B.type === 'port') {
      links.push({ pair: p, open: false, forced: true, kind: 'port', edges: p.edges })
      linked.add(p.key)
      union(p.a, p.b)
    } else if ((isBath(A) && A.changing === B.id) || (isBath(B) && B.changing === A.id)) mouth(p, 1, true, 'curtain')
  }
  // A random spanning tree over the walled joins (Kruskal on hashed order).
  const order = pairs.filter((p) => !linked.has(p.key) && !excluded(p)).map((p) => ({ p, k: d.n(1 << 30) }))
  order.sort((x, y) => x.k - y.k || x.p.key - y.p.key)
  for (const { p } of order) if (find(p.a) !== find(p.b)) join(p, 'mouth')

  // Prune a share of the tree's dead ends to unexcavated rock: anywhere on
  // the basin; on the deck only rim chambers (never one holding a port cell).
  if (cfg.massP > 0) {
    const degree = new Map()
    for (const l of links) for (const id of [l.pair.a, l.pair.b]) degree.set(id, (degree.get(id) ?? 0) + 1)
    const rim = (x) => x.rect.x0 <= 0 || x.rect.z0 <= 0 || x.rect.x1 >= LAST - 1 || x.rect.z1 >= LAST - 1
    for (const r of regions) {
      if (r.mass || r.type === 'hall' || r.type === 'lobby' || r.type === 'port' || degree.get(r.id) !== 1) continue
      if (cfg.rimOnly && (r.type !== 'chamber' || !rim(r) || holdsPort(r))) continue
      if (!d.p(cfg.massP)) continue
      r.mass = true
      for (let i = links.length - 1; i >= 0; i--) if (links[i].pair.a === r.id || links[i].pair.b === r.id) links.splice(i, 1)
    }
  }
  // Loops: extra mouths on joins the tree left closed.
  for (const { p } of order) {
    if (linked.has(p.key) || regions[p.a].mass || regions[p.b].mass) continue
    if (d.p(cfg.loopP)) join(p, 'loop')
  }
  return { pairs, links }
}

// Is every live region joined to region `from` when link `skip` is shut?
function connectedWithout(regions, links, skip) {
  const shut = skip instanceof Set ? skip : new Set([skip])
  const adj = new Map()
  for (const l of links) {
    if (shut.has(l)) continue
    for (const [x, y] of [[l.pair.a, l.pair.b], [l.pair.b, l.pair.a]]) {
      if (!adj.has(x)) adj.set(x, [])
      adj.get(x).push(y)
    }
  }
  const live = regions.filter((r) => !r.mass)
  if (!live.length) return true
  const seen = new Set([live[0].id])
  const queue = [live[0].id]
  while (queue.length) {
    const x = queue.pop()
    for (const y of adj.get(x) ?? []) {
      if (seen.has(y)) continue
      seen.add(y)
      queue.push(y)
    }
  }
  return live.every((r) => seen.has(r.id))
}

// --- the storey -----------------------------------------------------------------------

// One storey's grammar: regions (rect, type, walled, mass), the region grid,
// links (mouths), explicit edges for the plan, columns, and (deck) the rope
// candidates. `ports` (deck only) = tilePorts; null on the basin and in the
// finite kind.
export function storeyGrammar(storey, planSeed, vols, ports = null, stair = null) {
  const cfg = CFG[storey]
  const d = dice(planSeed, cfg.salt)
  const { regions, grid } = partition(cfg, d, storey, vols, ports, stair)
  const { pairs, links } = circulate(cfg, d, storey, regions, grid, vols, ports)
  const regionAt = (gx, gz) => (gx < 0 || gz < 0 || gx >= N || gz >= N ? null : regions[grid[gz * N + gx]] ?? null)

  // Explicit edges: every join with a walled side is a wall but for its mouth.
  const edges = []
  const mouthOf = new Map()
  for (const l of links) for (const e of l.edges) mouthOf.set(`${e.axis}:${e.gx},${e.gz}`, l)
  // Glass (deck): a run of windows between two of the open-plan spaces (a
  // chamber, a walk, a pool hall, a channel), so a chamber looks out over a
  // basin or down a channel: the long sight lines of the tiled halls.
  const glassy = (r) => r.type === 'chamber' || r.type === 'walk' || r.type === 'court' || r.type === 'hall' || r.type === 'chan'
  const room = (r) => r.type === 'plant' || r.type === 'tank' || r.type === 'sump' || r.type === 'changing' || r.type === 'bath'
  for (const p of pairs) {
    const A = regions[p.a]
    const B = regions[p.b]
    if (A.mass || B.mass || (!A.walled && !B.walled)) continue
    const glass = cfg.glassP > 0 && glassy(A) && glassy(B) && d.p(cfg.glassP)
    const near = (i) => p.edges.slice(Math.max(0, i - 1), i + 2).some((e) => mouthOf.has(`${e.axis}:${e.gx},${e.gz}`))
    for (const [i, e] of p.edges.entries()) {
      const l = mouthOf.get(`${e.axis}:${e.gx},${e.gz}`)
      if (l) {
        const door = l.kind === 'curtain' || (storey === 'basin' && (room(A) || room(B)))
        const passage = l.kind === 'arcade' ? 'open' : door ? 'door' : 'wide'
        edges.push({ axis: e.axis, gx: e.gx, gz: e.gz, wall: 0, passage, feature: 'plain' })
      } else {
        const win = glass && i > 0 && i < p.edges.length - 1 && !near(i)
        edges.push({ axis: e.axis, gx: e.gx, gz: e.gz, wall: 1, passage: 'wall', feature: win ? 'window' : 'plain' })
      }
    }
  }

  // Columns: deck pillars "in impractical places"; basin pump and tank blocks.
  const cols = []
  const colSet = new Set()
  const col = (gx, gz) => {
    cols.push({ gx, gz })
    colSet.add(gz * N + gx)
  }
  // Arcade pillars: every third cell along the open line, on its west/north
  // side, never on a cell another link opens into nor in a stair halo.
  const linkCells = new Set()
  for (const l of links) if (l.kind !== 'arcade') for (const e of l.edges) for (const [x, z] of e.cells) linkCells.add(z * N + x)
  for (const l of links) {
    if (l.kind !== 'arcade') continue
    for (let i = 1; i < l.edges.length - 1; i += 3) {
      const [x, z] = l.edges[i].cells[0]
      if (linkCells.has(z * N + x) || colSet.has(z * N + x)) continue
      col(x, z)
    }
  }
  // Stair halos of this storey (no pillar may stand on a landing ring).
  const halos = vols.flatMap((v) => v.halos.filter((hh) => hh.cy === cfg.storeyCy).map((hh) => hh.rect))
  const inHalo = (gx, gz) => halos.some((hh) => inRect(hh, gx, gz))
  for (const r of regions) {
    if (r.mass) continue
    const { x0, z0, x1, z1 } = r.rect
    const w = width(r.rect)
    const h = depth(r.rect)
    if (r.type === 'hall' && storey !== 'basin' && d.p(0.85)) {
      // The pool hall's margin: a colonnade round the basin on a rolled
      // 3- or 4-cell rhythm, off the hall's walls and the volume's box.
      const step = 3 + d.n(2)
      const ox = d.n(step)
      const oz = d.n(step)
      const ring = grow(r.box, 1)
      for (let gz = z0 + 1; gz <= z1 - 1; gz++) {
        for (let gx = x0 + 1; gx <= x1 - 1; gx++) {
          if ((gx - ox) % step || (gz - oz) % step || inRect(ring, gx, gz) || inHalo(gx, gz) || linkCells.has(gz * N + gx)) continue
          col(gx, gz)
        }
      }
      continue
    }
    if (r.type === 'court' && storey === 'gallery') {
      // The sun terrace: a colonnade down both long sides, one cell in, on
      // a rolled 3- or 4-cell rhythm; the middle stays open (lounger rows).
      const step = 3 + d.n(2)
      const alongX = w >= h
      const o = 1 + d.n(step)
      const lines = alongX ? [z0 + 1, z1 - 1] : [x0 + 1, x1 - 1]
      for (const c of lines) {
        for (let a = (alongX ? x0 : z0) + o; a <= (alongX ? x1 : z1) - 1; a += step) {
          const [gx, gz] = alongX ? [a, c] : [c, a]
          if (linkCells.has(gz * N + gx) || colSet.has(gz * N + gx) || inHalo(gx, gz)) continue
          col(gx, gz)
        }
      }
    } else if ((r.type === 'chamber' && w >= 8 && h >= 8 && d.p(0.55)) || r.type === 'court') {
      // A colonnade: pillar rows on a 3- or 4-cell rhythm, inset 2.
      const step = 3 + d.n(2)
      const ox = x0 + 2 + d.n(2)
      const oz = z0 + 2 + d.n(2)
      for (let gz = oz; gz <= z1 - 2; gz += step) for (let gx = ox; gx <= x1 - 2; gx += step) col(gx, gz)
    } else if (r.type === 'chamber' && w >= 5 && h >= 5) {
      for (let i = 0; i < 1 + d.n(2); i++) {
        const gx = x0 + 1 + d.n(w - 2)
        const gz = z0 + 1 + d.n(h - 2)
        if (gx < 2 || gz < 2 || gx > LAST - 3 || gz > LAST - 3) continue
        let crowded = linkCells.has(gz * N + gx)
        for (let dz = -1; dz <= 1 && !crowded; dz++) for (let dx = -1; dx <= 1 && !crowded; dx++) crowded = colSet.has((gz + dz) * N + gx + dx)
        if (crowded) continue
        col(gx, gz)
      }
    } else if (r.type === 'plant') {
      for (let bz = z0 + 1; bz + 1 <= z1 - 1; bz += 3) {
        for (let bx = x0 + 1; bx + 1 <= x1 - 1; bx += 3) {
          if (!d.p(0.75)) continue
          for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) col(bx + dx, bz + dz)
        }
      }
    } else if (r.type === 'tank') {
      const tw = Math.min(w - 2, 2 + d.n(2))
      const th = Math.min(h - 2, 2 + d.n(2))
      const tx = x0 + 1 + d.n(w - 2 - tw + 1)
      const tz = z0 + 1 + d.n(h - 2 - th + 1)
      for (let gz = tz; gz < tz + th; gz++) for (let gx = tx; gx < tx + tw; gx++) col(gx, gz)
    }
  }

  // Rope candidates: deck chamber mouths whose loss keeps the storey whole.
  const ropeSites = []
  const ropeLinks = []
  if (storey === 'deck') {
    for (const l of links) {
      if (l.forced || l.kind === 'arcade') continue
      if (regions[l.pair.a].type !== 'chamber' && regions[l.pair.b].type !== 'chamber') continue
      if (!connectedWithout(regions, links, l)) continue
      ropeSites.push(l.edges.map((e) => ({ axis: e.axis, gx: e.gx, gz: e.gz })))
      ropeLinks.push(l)
    }
  }

  const live = regions.filter((r) => !r.mass)
  const count = (t) => live.filter((r) => r.type === t).length
  const stats = {
    regions: live.length,
    chambers: count('chamber') + count('changing') + count('bath') + count('river') + count('plant') + count('tank') + count('sump'),
    channels: count('chan'),
    walks: count('walk'),
    courts: count('court'),
    arcades: links.filter((l) => l.kind === 'arcade').length,
    mouths: links.filter((l) => !l.open).length,
    // Cycle rank of the region graph: independent loops through the storey.
    loops: links.length - live.length + 1,
    deadEnds: live.filter((r) => r.walled && r.type !== 'hall' && links.filter((l) => l.pair.a === r.id || l.pair.b === r.id).length === 1).length,
  }
  return { storey, regions, grid, links, edges, cols, colSet, ropeSites, ropeLinks, stats, regionAt }
}

// --- chamber anomalies ----------------------------------------------------------------

// Doc 14 sets the poolrooms anomaly SEGMENT to the chamber: about 1 per 6
// chambers, at most one per chamber, never the same class twice in a row.
// On top of the tile's own anomaly (geometry.anomalyAt: the too-deep pit or
// a lane rope), each deck chamber of a tile that may hold anomalies rolls
// one with p CHAMBER_ANOMALY_P (hashed from the planSeed), in a hashed
// order; it takes its preferred class unless a chamber it links to holds it,
// else the other, else none:
//   'rope'   a lane rope (rails) across one of its mouths whose loss, with
//            every rope already strung, keeps the deck one graph;
//   'towel'  a lone lounger in the middle of the empty chamber, facing the
//            wall (doc 01: "a lone wet towel"; tile.js places it).
// `tileRope` (the tile anomaly's rope link, or null) counts as its
// chamber's anomaly. Pure in (planSeed, deck grammar, tileRope).
export const CHAMBER_ANOMALY_P = 0.13
export const CHAMBER_CLASSES = Object.freeze(['rope', 'towel'])

export function chamberAnomalies(planSeed, deck, tileRope = null) {
  const d = dice(planSeed, 0x0a40c)
  const isChamber = (id) => deck.regions[id]?.type === 'chamber' && !deck.regions[id].mass
  const nb = new Map()
  for (const l of deck.links) {
    for (const [x, y] of [[l.pair.a, l.pair.b], [l.pair.b, l.pair.a]]) {
      if (!nb.has(x)) nb.set(x, [])
      nb.get(x).push(y)
    }
  }
  const out = new Map()
  const closed = new Set()
  if (tileRope) {
    closed.add(tileRope)
    const id = isChamber(tileRope.pair.a) ? tileRope.pair.a : tileRope.pair.b
    out.set(id, { region: id, cls: 'rope', link: tileRope, tile: true })
  }
  const raw = []
  for (const r of deck.regions) {
    if (r.type !== 'chamber' || r.mass) continue
    const k = d.n(1 << 30)
    const hit = d.p(CHAMBER_ANOMALY_P)
    const pref = d.n(2)
    if (hit) raw.push({ r, k, pref })
  }
  raw.sort((a, b) => a.k - b.k || a.r.id - b.r.id)
  for (const { r, pref } of raw) {
    if (out.has(r.id)) continue
    const taken = new Set((nb.get(r.id) ?? []).map((id) => out.get(id)?.cls).filter(Boolean))
    for (const cls of pref ? ['towel', 'rope'] : ['rope', 'towel']) {
      if (taken.has(cls)) continue
      if (cls === 'towel') {
        out.set(r.id, { region: r.id, cls })
        break
      }
      const ok = deck.links.filter((l) => !l.forced && l.kind !== 'arcade' && !closed.has(l) &&
        (l.pair.a === r.id || l.pair.b === r.id) && connectedWithout(deck.regions, deck.links, new Set([...closed, l])))
      if (!ok.length) continue
      const link = ok[d.n(ok.length)]
      closed.add(link)
      out.set(r.id, { region: r.id, cls, link })
      break
    }
  }
  return [...out.values()].sort((a, b) => a.region - b.region)
}

// --- memoised per tile ----------------------------------------------------------------

const cache = new Map()
const CACHE_MAX = 256

// The three storeys' grammar of a tile given its planSeed, volumes and deck
// ports (null in the finite kind), with the tile's stair core (null when no
// place fits: the gallery is then the vault's balcony alone, or rock).
export function tileGrammar(planSeed, vols, ports) {
  const key = `${planSeed >>> 0}|${vols.map((v) => `${v.type}${v.box.x0},${v.box.z0},${v.box.x1},${v.box.z1}`).join(';')}|${ports ? JSON.stringify(ports) : '-'}`
  let hit = cache.get(key)
  if (hit) return hit
  const stair = stairCore(planSeed, vols)
  const upper = stair || vols.some((v) => v.levels > 2)
  hit = {
    stair,
    deck: storeyGrammar('deck', planSeed, vols, ports, stair),
    basin: storeyGrammar('basin', planSeed, vols, null),
    gallery: upper ? storeyGrammar('gallery', planSeed, vols, null, stair) : null,
  }
  cache.set(key, hit)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  return hit
}

// The basin's dark refuge: its smallest service room when that is at most
// 9 cells² (ties: the lower region id), else none. It hangs no tube and the
// fill light leaves it alone (tile.js poolFillWhere): a small dark room off
// the lit plant level (doc §4.2 "dark"), while the dark cells of the basin
// stay mostly the drained deep ends (doc §12).
export function darkRefuge(basin) {
  let best = null
  const size = (x) => (x.rect.x1 - x.rect.x0 + 1) * (x.rect.z1 - x.rect.z0 + 1)
  for (const x of basin.regions) {
    if (x.mass || (x.type !== 'plant' && x.type !== 'tank' && x.type !== 'sump') || size(x) > 9) continue
    if (!best || size(x) < size(best)) best = x
  }
  return best
}

// The world tile (tx, tz)'s grammar (pure in worldSeed and the tile).
export function worldTileGrammar(worldSeed, tx, tz) {
  return tileGrammar(planSeedOf(worldSeed, bandKey(tx, tz)), tileVolumes(worldSeed, tx, tz), tilePorts(worldSeed, tx, tz))
}

// Spawn candidates on a deck grammar (kind-local cells): channel cells whose
// eight neighbours are all live floor (no pillar, island or rim), nearest the
// tile's middle first; then roomy chamber cells the same way.
export function spawnCandidates(g, n = 9) {
  const live = (gx, gz) => {
    const r = g.regionAt(gx, gz)
    return !!r && !r.mass && r.type !== 'port' && !g.colSet.has(gz * N + gx)
  }
  const pick = (types) => {
    const out = []
    for (const r of g.regions) {
      if (r.mass || !types.includes(r.type)) continue
      for (let gz = r.rect.z0; gz <= r.rect.z1; gz++) {
        for (let gx = r.rect.x0; gx <= r.rect.x1; gx++) {
          if (g.regionAt(gx, gz) !== r || !live(gx, gz)) continue
          let ok = true
          for (let dz = -1; dz <= 1 && ok; dz++) for (let dx = -1; dx <= 1 && ok; dx++) ok = live(gx + dx, gz + dz)
          if (ok) out.push({ gx, gz })
        }
      }
    }
    const mid = (N - 1) / 2
    return out.sort((a, b) => Math.abs(a.gx - mid) + Math.abs(a.gz - mid) - (Math.abs(b.gx - mid) + Math.abs(b.gz - mid)) || a.gz - b.gz || a.gx - b.gx)
  }
  return [...pick(['chan']), ...pick(['walk', 'court', 'chamber', 'hall'])].slice(0, n)
}

// The world's spawn candidates: the deck of tile (0,0), GLOBAL cells (tile
// (0,0)'s origin is cell (0,0)).
export function spawnCells(worldSeed) {
  return spawnCandidates(worldTileGrammar(worldSeed >>> 0, 0, 0).deck).map((c) => Object.freeze({ ...c }))
}
