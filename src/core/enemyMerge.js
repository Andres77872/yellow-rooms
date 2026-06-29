// Combine two enemy update() results into one so the Engine reacts to whichever
// enemy is the bigger threat. The CLOSEST drives proximity-slow; EITHER being
// visible stresses sanity; tension is the max. Beam/stare are Stalker-only (the
// Pursuer is flashlight-immune), so inBeam/frozen come from the first (Stalker)
// result — pass the Stalker as `a`.
export function mergeEnemy(a, b) {
  return {
    caught: a.caught || b.caught,
    dist: Math.min(a.dist, b.dist),
    seen: a.seen || b.seen,
    tension: Math.max(a.tension, b.tension),
    inBeam: a.inBeam,
    frozen: a.frozen,
  }
}
