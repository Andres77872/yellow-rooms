// Shared local-frame mapping for the furniture model builders. Pieces are
// modelled in a local frame (u = width, v = depth, front toward +v) and
// mapped to the world by the placement record's `facing`:
// 0=+z 1=-z 2=+x 3=-x.

// facing → { ox: (u,v) => [x,z] offset, sz: (su,sv) => [sx,sz] size }.
function frame(facing) {
  switch (facing & 3) {
    case 1: return { ox: (u, v) => [-u, -v], sz: (su, sv) => [su, sv] }
    case 2: return { ox: (u, v) => [v, -u], sz: (su, sv) => [sv, su] }
    case 3: return { ox: (u, v) => [-v, u], sz: (su, sv) => [sv, su] }
    default: return { ox: (u, v) => [u, v], sz: (su, sv) => [su, sv] }
  }
}

// Returns a part pusher for one furniture record: each call appends one
// unit-box descriptor { px, py, pz, sx, sy, sz, tint } in CHUNK-LOCAL
// coordinates, which mesh.js batches into a single instanced draw with
// per-instance tints.
export function builder(f, out) {
  const fr = frame(f.facing)
  return (ou, y, ov, su, sy, sv, tint) => {
    const [ox, oz] = fr.ox(ou, ov)
    const [sx, sz] = fr.sz(su, sv)
    out.push({ px: f.x + ox, py: y, pz: f.z + oz, sx, sy, sz, tint })
  }
}
