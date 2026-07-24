// World-geometry detail is deliberately independent from chunk visibility.
// A streamed structure slice remains visible as one continuous volume; only
// its decorative child batches become cheaper as the horizontal chunk ring
// recedes into fog.

export const RENDER_DETAIL_FULL = 'full'
export const RENDER_DETAIL_REDUCED = 'reduced'
export const RENDER_DETAIL_SHELL = 'shell'

export const RENDER_DETAIL_LEVELS = Object.freeze([
  RENDER_DETAIL_FULL,
  RENDER_DETAIL_REDUCED,
  RENDER_DETAIL_SHELL,
])

export const RENDER_DETAIL_PROFILE_NAMES = Object.freeze([
  'low',
  'medium',
  'high',
  'ultra',
])

// `fullRing` is inclusive. `shellRing` is the first ring allowed to drop large
// silhouettes; Infinity means the profile retains silhouettes everywhere.
export const RENDER_DETAIL_PROFILES = Object.freeze({
  low: Object.freeze({ fullRing: 1, shellRing: 4 }),
  medium: Object.freeze({ fullRing: 2, shellRing: 4 }),
  high: Object.freeze({ fullRing: 2, shellRing: 4 }),
  ultra: Object.freeze({ fullRing: 3, shellRing: Number.POSITIVE_INFINITY }),
})

export const DEFAULT_RENDER_DETAIL_PROFILE = 'high'

export function normalizeRenderDetailProfile(profile) {
  return Object.hasOwn(RENDER_DETAIL_PROFILES, profile)
    ? profile
    : DEFAULT_RENDER_DETAIL_PROFILE
}

export function normalizeRenderDetailLevel(level) {
  return RENDER_DETAIL_LEVELS.includes(level) ? level : RENDER_DETAIL_FULL
}

export function renderDetailForRing(ring, profile = DEFAULT_RENDER_DETAIL_PROFILE) {
  const resolved = RENDER_DETAIL_PROFILES[normalizeRenderDetailProfile(profile)]
  let distance = 0
  if (ring === Number.POSITIVE_INFINITY) distance = ring
  else if (Number.isFinite(ring)) distance = Math.max(0, Math.floor(ring))
  if (distance <= resolved.fullRing) return RENDER_DETAIL_FULL
  if (
    Number.isFinite(resolved.shellRing) &&
    distance >= resolved.shellRing
  ) return RENDER_DETAIL_SHELL
  return RENDER_DETAIL_REDUCED
}

export function renderDetailForChunk(
  playerCx,
  playerCz,
  chunkCx,
  chunkCz,
  profile = DEFAULT_RENDER_DETAIL_PROFILE
) {
  const ring = Math.max(
    Math.abs(chunkCx - playerCx),
    Math.abs(chunkCz - playerCz)
  )
  return renderDetailForRing(ring, profile)
}
