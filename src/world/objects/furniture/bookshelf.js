import { BOOKSHELF_W, BOOKSHELF_D, BOOKSHELF_H } from '../../constants.js'
import { FURN_TINT } from './palette.js'
import { builder } from './frame.js'

// Bookshelf: tall archive shelf — side panels, back, four shelves of book
// blocks, a cornice, and a horizontal paper stack on the top shelf.
export function bookshelf(f, out) {
  const b = builder(f, out)
  const W = BOOKSHELF_W
  const D = BOOKSHELF_D
  const H = BOOKSHELF_H
  for (const s of [-1, 1]) {
    b(s * (W / 2 - 0.02), H / 2, 0, 0.04, H, D, FURN_TINT.shelfWood) // side
  }
  b(0, H / 2, -(D / 2 - 0.015), W - 0.08, H - 0.06, 0.03, FURN_TINT.panel) // back
  b(0, 0.04, 0, W - 0.06, 0.08, D - 0.02, FURN_TINT.shelfWood) // kick
  b(0, H - 0.02, 0, W + 0.03, 0.05, D + 0.02, FURN_TINT.shelfWood) // cornice
  // Three filled shelves: shelf board + three book blocks of staggered
  // heights, colours cycling through the archive palette.
  const books = [FURN_TINT.bookRed, FURN_TINT.bookBlue, FURN_TINT.bookTan]
  const heights = [0.28, 0.24, 0.3]
  const offs = [-0.28, 0.02, 0.3]
  for (let s = 0; s < 3; s++) {
    const y = 0.32 + s * 0.38
    b(0, y, 0, W - 0.08, 0.03, D - 0.05, FURN_TINT.shelfWood) // shelf board
    for (let k = 0; k < 3; k++) {
      const h = heights[(s + k) % 3]
      b(offs[k], y + 0.015 + h / 2, 0, 0.2, h, D - 0.12, books[(s + k) % 3])
    }
  }
  // Top shelf: board + a horizontal stack of flat files.
  const top = 0.32 + 3 * 0.38
  b(0, top, 0, W - 0.08, 0.03, D - 0.05, FURN_TINT.shelfWood)
  b(0.1, top + 0.045, 0, 0.26, 0.05, 0.2, FURN_TINT.bookTan)
  b(0.1, top + 0.09, 0, 0.22, 0.04, 0.17, FURN_TINT.bookRed)
  b(-0.25, top + 0.06, 0, 0.24, 0.08, 0.19, FURN_TINT.paperWhite)
}
