// Generic bounded flood-fill over a cell grid. Shared by the connectivity tests
// and the debug WorldMapTool so there is ONE validator, not two.
//
//   w, h        grid dimensions (cells)
//   startX/Z    seed cell
//   canPass(ax, az, bx, bz)  -> bool : may you step between 4-adjacent cells?
//
// Returns a Uint8Array(w*h) marking reachable cells (1) from the seed.
export function floodReachable(startX, startZ, w, h, canPass) {
  const seen = new Uint8Array(w * h)
  if (startX < 0 || startX >= w || startZ < 0 || startZ >= h) return seen
  const stack = [startX, startZ]
  seen[startZ * w + startX] = 1
  while (stack.length) {
    const z = stack.pop()
    const x = stack.pop()
    // east, west, south, north
    if (x + 1 < w && !seen[z * w + x + 1] && canPass(x, z, x + 1, z)) {
      seen[z * w + x + 1] = 1
      stack.push(x + 1, z)
    }
    if (x - 1 >= 0 && !seen[z * w + x - 1] && canPass(x, z, x - 1, z)) {
      seen[z * w + x - 1] = 1
      stack.push(x - 1, z)
    }
    if (z + 1 < h && !seen[(z + 1) * w + x] && canPass(x, z, x, z + 1)) {
      seen[(z + 1) * w + x] = 1
      stack.push(x, z + 1)
    }
    if (z - 1 >= 0 && !seen[(z - 1) * w + x] && canPass(x, z, x, z - 1)) {
      seen[(z - 1) * w + x] = 1
      stack.push(x, z - 1)
    }
  }
  return seen
}
