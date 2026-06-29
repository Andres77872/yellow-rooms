import { CHUNK, fmod } from './constants.js'
import { hash2i } from './core/hash.js'

const U32 = 4294967296

function officeCfg(config) {
  const c = config.office?.corridors || {}
  return {
    spacing: c.spacing ?? config.border?.doorSpacing ?? 5,
    phaseSalt: c.phaseSalt ?? config.border?.doorPhaseSalt ?? 0x33a7,
    snap: c.mouthSnap ?? 2,
  }
}

function axisCode(axis) {
  return axis === 'x' ? 0x584f : 0x5a4f
}

export function officeGuidePhase(seed, config, axis) {
  const cfg = officeCfg(config)
  return hash2i((seed ^ cfg.phaseSalt) | 0, axisCode(axis), 0) % cfg.spacing
}

export function isOfficeGuideCoord(g, seed, config, axis) {
  const cfg = officeCfg(config)
  return fmod(g - officeGuidePhase(seed, config, axis), cfg.spacing) === 0
}

export function officeGuidePositions(gBase, seed, config, axis, interiorOnly = false) {
  const out = []
  const lo = interiorOnly ? 1 : 0
  const hi = interiorOnly ? CHUNK - 2 : CHUNK - 1
  for (let i = lo; i <= hi; i++) {
    if (isOfficeGuideCoord(gBase + i, seed, config, axis)) out.push(i)
  }
  return out
}

export function nearestOfficeGuideLocal(gBase, local, seed, config, axis) {
  const cfg = officeCfg(config)
  let best = local
  let bestD = Infinity
  for (let d = -cfg.snap; d <= cfg.snap; d++) {
    const p = local + d
    if (p < 1 || p > CHUNK - 2) continue
    if (!isOfficeGuideCoord(gBase + p, seed, config, axis)) continue
    const ad = Math.abs(d)
    if (ad < bestD) {
      best = p
      bestD = ad
    }
  }
  return best
}

function warehouseCfg(config) {
  const c = config.warehouse?.fragments || {}
  return {
    salt: c.salt ?? 0x8f37,
    chance: c.chance ?? 0.16,
    lineSpacing: c.lineSpacing ?? 4,
    anchorStep: c.anchorStep ?? 9,
    runLen: c.runLen ?? config.warehouse?.runLen ?? [3, 7],
  }
}

function warehouseLineAllowed(line, seed, cfg, axis) {
  const phase = hash2i((seed ^ cfg.salt) | 0, axisCode(axis), 1) % cfg.lineSpacing
  return fmod(line - phase, cfg.lineSpacing) === 0
}

function warehouseFragmentAt(pos, line, seed, config, axis) {
  const cfg = warehouseCfg(config)
  if (!warehouseLineAllowed(line, seed, cfg, axis)) return false
  const minLen = cfg.runLen[0]
  const maxLen = cfg.runLen[1]
  for (let start = pos - maxLen + 1; start <= pos; start++) {
    if (fmod(start, cfg.anchorStep) !== 0) continue
    const h = hash2i((seed ^ cfg.salt) | 0, start, line ^ axisCode(axis))
    if (h / U32 >= cfg.chance) continue
    const len = minLen + ((h >>> 8) % (maxLen - minLen + 1))
    if (pos >= start && pos < start + len) return true
  }
  return false
}

export function warehouseWallH(gx, lineGz, seed, config) {
  return warehouseFragmentAt(gx, lineGz, seed, config, 'x')
}

export function warehouseWallV(lineGx, gz, seed, config) {
  return warehouseFragmentAt(gz, lineGx, seed, config, 'z')
}
