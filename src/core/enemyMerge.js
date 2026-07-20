// Combine any number of enemy update() results into one so the Engine reacts
// to whichever enemy is the bigger threat. The CLOSEST drives proximity-slow;
// ANY being visible stresses sanity; tension is the max. Beam/stare are
// Stalker-only (the others are flashlight-immune), so inBeam/frozen come from
// the FIRST result — pass the Stalker as `a`.
export function mergeEnemy(a, ...rest) {
  const m = {
    caught: a.caught,
    dist: a.dist,
    seen: a.seen,
    tension: a.tension,
    inBeam: a.inBeam,
    frozen: a.frozen,
  }
  for (const b of rest) {
    m.caught = m.caught || b.caught
    m.dist = Math.min(m.dist, b.dist)
    m.seen = m.seen || b.seen
    m.tension = Math.max(m.tension, b.tension)
  }
  return m
}
