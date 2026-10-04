# Yellow Rooms — babel pack (map 06, the library of Babel): the class B props
# of the hexagonal galleries, built by build_pack.py
# (`npm run build:pack -- babel`) into public/models/babel/.
#
#   corner_shelf  PROP_CORNER_SHELF  a bookcase whose face runs at 45 degrees
#                                    across a cell corner, so a square room
#                                    reads as a chamfered (hexagonal) gallery
#   lectern       PROP_LECTERN       a panelled reading stand, slanted desk
#                                    with an open book and a ribbon marker
#
# Corner shelf orientation (shared with src/world/props/packs/babel.js and
# the kinds that place it): the footprint is the 1.15 m square centred on the
# origin with its +u/+v corner cut off. Two short returns (0.20 m) run along
# the edges u = +0.575 and v = +0.575 from the back walls; the face joins them
# along u + v = 0.20, from (+0.575, -0.375) to (-0.375, +0.575). At facing S
# (0) the piece therefore sits in its back-left (-u, -v) corner and its books
# look toward (+u, +v); every other facing rotates that corner with the piece
# like any furniture front. The returns are not decoration: a pure triangle
# cannot be held by two axis-aligned shadow boxes (proxy IoU < 0.8).
#
# Dims and heights mirror the registry (the tests compare the manifest
# against it). Colours reuse the furniture book and wood keys verbatim, so the
# pack introduces no new runtime surface.

import math
import os

import bmesh
import bpy
from mathutils import Vector

from yr_kit import *  # noqa: F403  (yr_kit.__all__: primitives, G, R, finish, lcg, marker, parsers)

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PAL = parse_js_rgb_table(os.path.join(REPO, "src", "world", "objects", "furniture", "palette.js"),
                         "FURN_TINT", min_entries=40)

NODE_PREFIX = "babel_"
BUDGET = dict(tris=20_000, bytes=650_000)
KEYS = ("shelfWood", "woodDark", "woodMid", "panel", "bookRed", "bookBlue", "bookTan", "paperWhite")
# Same (rgb, metallic, roughness) split as the furniture pack: none are metal.
PALETTE = {k: (PAL[k], 0.0, 0.78) for k in KEYS}
KEEP_BRIGHT = set()  # nothing emits: the galleries are lit by their globe lamps


# --- Helpers -------------------------------------------------------------------
# Oriented prisms: the corner shelf is all 45-degree plates and the lectern's
# desk is a slope, which the axis-aligned box() cannot express.

def extrude(p, o, X, Y, Z, poly, z0, z1, key, bev=0.006):
    """Closed prism: convex `poly` [(x, y)] in the plane spanned by the
    game-frame unit vectors X, Y through `o`, extruded along Z from z0 to z1."""
    O, X, Y, Z = Vector(o), Vector(X), Vector(Y), Vector(Z)
    n = len(poly)
    verts = [G(*(O + X * x + Y * y + Z * z)) for z in (z0, z1) for x, y in poly]
    faces = [tuple(range(n)), tuple(range(n, 2 * n))]
    faces += [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    mesh = bpy.data.meshes.new("prism")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new("prism", mesh)
    # Bevel narrower than the thinnest side, like box() clamps its own.
    xs, ys = [q[0] for q in poly], [q[1] for q in poly]
    thin = min(max(xs) - min(xs), max(ys) - min(ys), abs(z1 - z0))
    bev = min(bev, thin / 2.5) if bev >= 0.002 else 0.0
    finish(obj, key, bev=bev)
    p.append(obj)
    return obj


UP = (0, 1, 0)
AU = (1, 0, 0)
AV = (0, 0, 1)


def plate(p, poly, y0, y1, key, bev=0.006):
    """Vertical prism over a game-frame (u, v) polygon."""
    return extrude(p, (0, 0, 0), AU, AV, UP, poly, y0, y1, key, bev=bev)


def clip(poly, a, b, c):
    """Convex polygon [(u, v)] cut to the half-plane a*u + b*v <= c."""
    out = []
    for i, P in enumerate(poly):
        Q = poly[(i + 1) % len(poly)]
        fp = a * P[0] + b * P[1] - c
        fq = a * Q[0] + b * Q[1] - c
        if fp <= 0:
            out.append(P)
        if (fp < 0 < fq) or (fq < 0 < fp):
            t = fp / (fp - fq)
            out.append((P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])))
    return out


def square(lo, hi):
    return [(lo, lo), (hi, lo), (hi, hi), (lo, hi)]


# --- corner_shelf: 1.15 x 1.15, 1.85 tall ---------------------------------------------

S = 0.575                   # half the square footprint
RET = 0.20                  # return length: the face is u + v = RET
SQ2 = math.sqrt(2.0)
FN = (1 / SQ2, 0.0, 1 / SQ2)        # face normal (+u, +v), game (u, y, v)
FE = (1 / SQ2, 0.0, -1 / SQ2)       # along the face, toward its +u end
FACE_LEN = SQ2 * (2 * S - RET)      # 1.343 between the returns' outer edges
FACE_MID = (RET / 2, RET / 2)
BACK_DEPTH = 0.32           # the false back behind the book rows
WALL_T = 0.02               # back panels along the two walls
RET_T = 0.035               # return (end panel) thickness
STILE_W, STILE_D = 0.07, 0.045
SHELF_T = 0.03
CARCASS_TOP = 1.75
# Compartments (book floor y, ceiling y); the boards between them are SHELF_T.
COMPARTMENTS = ((0.12, 0.53), (0.56, 0.97), (1.00, 1.38), (1.41, CARCASS_TOP))
BOOKS = ("bookTan", "bookRed", "woodDark", "bookBlue", "bookTan", "bookRed", "paperWhite", "bookBlue")


def _face_point(a, depth, y):
    """Game-frame point `a` along the face (from its middle toward +u) and
    `depth` behind it."""
    return (FACE_MID[0] + FE[0] * a - FN[0] * depth, y, FACE_MID[1] + FE[2] * a - FN[2] * depth)


def _band(front, back=None, inset=0.0):
    """The footprint square (inset from every edge) between the face-parallel
    lines u + v = front and u + v = back."""
    poly = clip(square(-S + inset, S - inset), 1, 1, front)
    if back is not None:
        poly = clip(poly, -1, -1, -back)
    return poly


def _book_row(p, rnd, y0, y1, row):
    """One shelf of spines along the face: mostly upright volumes, one
    leaning into a gap, one lying stack; a paper label on some spines."""
    a = -FACE_LEN / 2 + STILE_W + 0.025
    a_max = FACE_LEN / 2 - STILE_W - 0.025
    room = y1 - y0 - 0.025
    stack_at = (5, 11, 3, 8)[row]
    gap_at = (13, 4, 9, 2)[row]
    k = 0
    while a < a_max - 0.07:
        tint = BOOKS[int(rnd() * len(BOOKS)) % len(BOOKS)]
        if k == stack_at:
            # Two or three volumes lying flat, slightly askew.
            for j in range(3 if row != 1 else 2):
                bw, bd = 0.2 - 0.02 * j, 0.21 - 0.01 * j
                c = _face_point(a + 0.11, 0.025 + bd / 2, y0 + 0.018 + 0.035 * j)
                box(p, c[0], c[1], c[2], bw, 0.034, bd, BOOKS[(row + j * 3) % len(BOOKS)], bev=0.0,
                    rot=(0, 0, R(45 + 4 - 5 * j)))
            a += 0.23
        elif k == gap_at:
            # A gap, the last book before it leaning across.
            bw, bh = 0.045, min(room, 0.27 + 0.03 * rnd())
            lean = R(18)
            da = math.sin(lean) * bh / 2 + math.cos(lean) * bw / 2 + 0.004
            c = _face_point(a + da, 0.03 + 0.105, y0 + math.cos(lean) * bh / 2 + math.sin(lean) * bw / 2)
            box(p, c[0], c[1], c[2], bw, bh, 0.21, tint, bev=0.0, rot=(0, lean, R(45)))
            a += bw * math.cos(lean) + bh * math.sin(lean) + 0.012
        else:
            bw = 0.042 + 0.026 * rnd()
            bh = min(room, 0.25 + 0.09 * rnd())
            bd = 0.19 + 0.05 * rnd()
            c = _face_point(a + bw / 2, 0.022 + bd / 2, y0 + bh / 2)
            box(p, c[0], c[1], c[2], bw, bh, bd, tint, bev=0.0, rot=(0, 0, R(45)))
            if rnd() < 0.3 and tint != "paperWhite":
                # Spine label just proud of the spine, facing out along FN.
                q = _face_point(a + bw / 2, 0.022 - 0.002, y0 + bh * 0.72)
                decal(p, q[0], q[1], q[2], bw * 0.6, 0.045, "paperWhite", rot=(0, 0, R(45)))
            a += bw + 0.003
        k += 1


def m_corner_shelf(p):
    rnd = lcg(0x06A1)
    # Carcass: two back panels on the walls, two returns, a false back
    # parallel to the face (the book rows' backdrop; it also closes the deep
    # corner so the piece is one sealed volume).
    box(p, 0, CARCASS_TOP / 2, -S + WALL_T / 2, 2 * S, CARCASS_TOP, WALL_T, "shelfWood", bev=0.004)
    box(p, -S + WALL_T / 2, CARCASS_TOP / 2, WALL_T / 2, WALL_T, CARCASS_TOP, 2 * S - WALL_T,
        "shelfWood", bev=0.004)
    box(p, S - RET_T / 2, CARCASS_TOP / 2, -S + WALL_T + (RET - WALL_T) / 2, RET_T, CARCASS_TOP,
        RET - WALL_T, "shelfWood", bev=0.006)
    box(p, -S + WALL_T + (RET - WALL_T) / 2, CARCASS_TOP / 2, S - RET_T / 2, RET - WALL_T, CARCASS_TOP,
        RET_T, "shelfWood", bev=0.006)
    back = RET - SQ2 * BACK_DEPTH
    plate(p, _band(back, back - SQ2 * 0.02, inset=0.01), 0.09, CARCASS_TOP, "panel", bev=0.0)
    # Recessed plinth (toe kick), bottom board, the shelf boards.
    plate(p, _band(RET - 0.05, inset=0.01), 0.0, 0.09, "woodDark", bev=0.006)
    shelf = _band(RET, back - 0.01, inset=0.012)
    plate(p, shelf, 0.09, COMPARTMENTS[0][0], "shelfWood", bev=0.006)
    for y0, _ in COMPARTMENTS[1:]:
        plate(p, shelf, y0 - SHELF_T, y0, "shelfWood", bev=0.006)
    # Two-step cornice over a top board: the only part that leans out past
    # the face (still inside the square).
    plate(p, _band(RET + 0.005), CARCASS_TOP, 1.78, "shelfWood", bev=0.006)
    plate(p, _band(RET + 0.025), 1.78, 1.81, "woodDark", bev=0.008)
    plate(p, _band(RET + 0.05), 1.81, 1.85, "shelfWood", bev=0.01)
    # Front stiles at both ends of the face, flush with the returns.
    for side in (-1, 1):
        a = side * (FACE_LEN / 2 - STILE_W / 2 - 0.012)
        c = _face_point(a, STILE_D / 2 - 0.006, (0.09 + CARCASS_TOP) / 2)
        extrude(p, c, FE, UP, FN, [(-STILE_W / 2, -(CARCASS_TOP - 0.09) / 2),
                                   (STILE_W / 2, -(CARCASS_TOP - 0.09) / 2),
                                   (STILE_W / 2, (CARCASS_TOP - 0.09) / 2),
                                   (-STILE_W / 2, (CARCASS_TOP - 0.09) / 2)],
                -STILE_D / 2, STILE_D / 2, "woodDark", bev=0.008)
    for row, (y0, y1) in enumerate(COMPARTMENTS):
        _book_row(p, rnd, y0, y1, row)
    # Shadow proxies: two steps fitted to the cut square (the registry's
    # PROP_CORNER_SHELF proxies, src/world/props/packs/babel.js).
    marker(p, "occ_A", -0.0125, 0.925, -0.2875, 1.125, 1.85, 0.575, t=0)
    marker(p, "occ_B", -0.2875, 0.925, -0.0125, 0.575, 1.85, 1.125, t=0)


# --- lectern: 0.60 x 0.50, 1.20 tall ---------------------------------------------------

DESK_FRONT = (0.25, 1.01)   # (v, y) of the slope's low front edge
DESK_BACK = (-0.25, 1.19)   # (v, y) of its high back edge
DESK_BASE = 0.96
_sl = math.hypot(DESK_FRONT[0] - DESK_BACK[0], DESK_BACK[1] - DESK_FRONT[1])
SLOPE = (0.0, (DESK_BACK[1] - DESK_FRONT[1]) / _sl, (DESK_BACK[0] - DESK_FRONT[0]) / _sl)  # up the desk
SNORM = (0.0, -SLOPE[2], SLOPE[1])  # desk normal: up and toward the reader (+v)
EDGE = (0.0, DESK_FRONT[1], DESK_FRONT[0])


def _on_desk(t, h):
    """Point `t` metres up the slope from the front edge, `h` above it."""
    return tuple(EDGE[i] + SLOPE[i] * t + SNORM[i] * h for i in range(3))


def m_lectern(p):
    # Panelled pedestal on a plinth, a moulded cap under the desk.
    box(p, 0, 0.035, 0, 0.46, 0.07, 0.38, "woodDark", bev=0.014)
    box(p, 0, 0.495, 0, 0.36, 0.85, 0.28, "shelfWood", bev=0.012)
    for sv in (-1, 1):
        box(p, 0, 0.49, sv * 0.1435, 0.27, 0.66, 0.009, "woodMid", bev=0.003)
        box(p, sv * 0.1835, 0.49, 0, 0.009, 0.66, 0.19, "woodMid", bev=0.003)
    box(p, 0, 0.94, 0, 0.44, 0.04, 0.36, "woodDark", bev=0.012)
    # The slanted desk: a wedge, low edge toward the reader (+v), and a book
    # stop along its front.
    extrude(p, (0, 0, 0), AV, UP, AU, [(DESK_FRONT[0], DESK_BASE), DESK_FRONT, DESK_BACK,
                                       (DESK_BACK[0], DESK_BASE)], -0.3, 0.3, "woodMid", bev=0.012)
    extrude(p, _on_desk(0.013, 0.0), AU, SNORM, SLOPE, [(-0.28, -0.006), (0.28, -0.006), (0.28, 0.028),
                                                        (-0.28, 0.028)], -0.013, 0.013, "woodDark",
            bev=0.005)
    # The open book: cover boards, two page blocks that rise from the gutter
    # and fall to the fore-edge, a ribbon over the book stop.
    o = _on_desk(0.0, 0.0)
    extrude(p, o, AU, SNORM, SLOPE, [(-0.225, 0.0), (0.225, 0.0), (0.225, 0.012), (-0.225, 0.012)],
            0.04, 0.35, "bookRed", bev=0.003)
    page = [(0.006, 0.012), (0.212, 0.012), (0.212, 0.026), (0.055, 0.035), (0.006, 0.023)]
    for X in (AU, (-1, 0, 0)):
        extrude(p, o, X, SNORM, SLOPE, page, 0.05, 0.34, "paperWhite", bev=0.002)
    box(p, 0.07, 0.975, 0.2535, 0.016, 0.1, 0.003, "bookRed", bev=0.0)
    # Shadow proxies: pedestal and desk (the registry's PROP_LECTERN proxies).
    marker(p, "occ_A", 0, 0.48, 0, 0.36, 0.96, 0.3, t=0)
    marker(p, "occ_B", 0, 1.08, 0, 0.6, 0.24, 0.5, t=0)


MODELS = [
    dict(kind="corner_shelf", kind_key="PROP_CORNER_SHELF", cls="B", build=m_corner_shelf,
         dims=(1.15, 1.15), height=1.85, tier="large"),
    dict(kind="lectern", kind_key="PROP_LECTERN", cls="B", build=m_lectern,
         dims=(0.60, 0.50), height=1.20, tier="detailed"),
]
