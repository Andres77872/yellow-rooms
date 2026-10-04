# Yellow Rooms — showroom pack (map 09, the infinite showroom): the class B
# props of the big-box store, built by build_pack.py
# (`npm run build:pack -- showroom`) into public/models/showroom/.
#
#   bag_bin   PROP_BAG_BIN   the returns bin by the tills, heaped with
#                            knotted yellow carrier bags, on four casters
#   flatpack  PROP_FLATPACK  flat-pack furniture boxes stacked on a
#                            1200 x 800 pallet, strapped, top boxes loose
#
# Dims and heights mirror src/world/props/packs/showroom.js (the registry the
# tests compare the manifest against). Front faces +v. Retail colours stay
# generic on purpose: plain labels, no lettering, no logos.

import math

from yr_kit import *  # noqa: F403  (yr_kit.__all__: primitives, R, TAU, lcg, marker)

NODE_PREFIX = "showroom_"
# §8 pack budget (a map's static assets); these two props use a small share.
BUDGET = dict(tris=20_000, bytes=650_000)
# key -> (linear rgb, metallic, roughness). New keys (bagYellow, returnBin,
# flatpackCard) carry their runtime surface in the pack data module.
PALETTE = {
    "bagYellow": ((0.95, 0.68, 0.04), 0.0, 0.5),       # carrier-bag polythene
    "returnBin": ((0.2, 0.22, 0.25), 0.0, 0.6),       # moulded charcoal tub
    "flatpackCard": ((0.74, 0.57, 0.35), 0.0, 0.88),   # kraft corrugated board
    "bookTan": ((0.62, 0.52, 0.36), 0.0, 0.78),       # older, darker board
    "shelfWood": ((0.5, 0.4, 0.28), 0.0, 0.78),       # pallet deck boards
    "woodMid": ((0.55, 0.43, 0.3), 0.0, 0.78),        # pallet blocks
    "keyDark": ((0.16, 0.16, 0.17), 0.0, 0.78),       # caster tyres, strapping, print
    "legMetal": ((0.32, 0.31, 0.3), 0.85, 0.32),      # caster forks
    "paperWhite": ((0.9, 0.88, 0.8), 0.0, 0.78),      # blank labels
}


# --- bag_bin: 0.70 x 0.50, 0.90 tall ------------------------------------------

BIN_W, BIN_D, BIN_H = 0.70, 0.50, 0.90
TUB_Y0, TUB_Y1, RIM_Y = 0.12, 0.665, 0.705
# Tub half extents at the base and at the shoulder under the rim: a moulded
# hamper tapers toward its casters.
TUB_B = (0.29, 0.19)
TUB_T = (0.335, 0.235)
RIM = (0.35, 0.25)          # == dims / 2: the rim is the widest line
RECESS_Y = 0.64             # floor of the shallow recess inside the rim
FILL_Y = 0.675              # heap height where it meets the rim's inner wall
# The heaped bags (u, v, radius, rise above FILL_Y): they bulge well over the
# rim so the bin reads as overfull from across the aisle.
BAGS = [(-0.2, -0.12, 0.15, 0.15), (0.06, -0.13, 0.15, 0.17), (0.24, -0.05, 0.13, 0.12),
        (-0.08, 0.08, 0.15, 0.16), (0.17, 0.12, 0.13, 0.13), (-0.27, 0.11, 0.11, 0.09),
        (0.3, 0.17, 0.08, 0.06)]


def _tub_half(y):
    t = (y - TUB_Y0) / (TUB_Y1 - TUB_Y0)
    return TUB_B[0] + (TUB_T[0] - TUB_B[0]) * t, TUB_B[1] + (TUB_T[1] - TUB_B[1]) * t


def _dome(u, v):
    """Heap height at (u, v): one round-shouldered dome per bag joined by a
    max, so creases fall where two bags press together (the painted pass
    darkens them)."""
    y = FILL_Y
    for lu, lv, r, h in BAGS:
        q = 1 - ((u - lu) ** 2 + (v - lv) ** 2) / (r * r)
        if q > 0:
            y = max(y, FILL_Y + h * q ** 0.45)
    return y


def _heap(p, rnd):
    """The bag heap as one closed heightfield; its skirt and floor sink below
    the recess floor, inside the tub shell."""
    hu, hv = 0.326, 0.226
    nu, nv = 11, 8
    verts = []
    for j in range(nv + 1):
        for i in range(nu + 1):
            u = -hu + 2 * hu * i / nu
            v = -hv + 2 * hv * j / nv
            if i in (0, nu) and j in (0, nv):
                u *= 0.94      # pull the corners inside the rim's rounded corners
                v *= 0.92
            if i in (0, nu) or j in (0, nv):
                y = FILL_Y
            else:
                y = _dome(u, v) + 0.006 * (rnd() - 0.5)
            verts.append(G(u, y, v))
    faces = []
    for j in range(nv):
        for i in range(nu):
            a = j * (nu + 1) + i
            faces.append((a, a + 1, a + nu + 2, a + nu + 1))
    # Border loop -> skirt down below the recess floor -> one bottom face.
    ring = ([i for i in range(nu + 1)] +
            [j * (nu + 1) + nu for j in range(1, nv + 1)] +
            [nv * (nu + 1) + i for i in range(nu - 1, -1, -1)] +
            [j * (nu + 1) for j in range(nv - 1, 0, -1)])
    base = len(verts)
    for k in ring:
        x, y, _ = verts[k]
        verts.append((x, y, RECESS_Y - 0.01))
    n = len(ring)
    for s in range(n):
        t = (s + 1) % n
        faces.append((ring[s], ring[t], base + t, base + s))
    faces.append(tuple(base + s for s in range(n)))
    make_mesh(p, "bag_heap", verts, faces, "bagYellow", shading="soft")


def _knot(p, u, v, ears=True):
    """A bag's tied neck on its dome: a knot and two handle ears."""
    top = _dome(u, v) - 0.004
    cone(p, u, top + 0.012, v, 0.024, 0.009, 0.032, "bagYellow", verts=6)
    if ears:
        for s in (-1, 1):
            tube(p, [(u, top + 0.02, v), (u + s * 0.035, top + 0.055, v + 0.006 * s),
                     (u + s * 0.052, top + 0.016, v - 0.004)], 0.008, "bagYellow", seg=4)


def m_bag_bin(p):
    # Casters: a fork plate under each corner of the tub base, rubber tyres.
    for su in (-1, 1):
        for sv in (-1, 1):
            cu, cv = su * 0.235, sv * 0.14
            box(p, cu, 0.096, cv, 0.06, 0.05, 0.05, "legMetal", bev=0.0)
            cyl(p, cu, 0.045, cv, 0.045, 0.034, "keyDark", axis="u", verts=8)
    # The tub: one closed rounded-rect shell. Up the tapered wall, out over a
    # rolled rim, then in and down to a shallow recess the heap sits in.
    lathe(p, 0, 0, [
        (TUB_B[0], TUB_B[1], 0.045, TUB_Y0),
        (TUB_T[0], TUB_T[1], 0.06, TUB_Y1),
        (RIM[0], RIM[1], 0.065, TUB_Y1 + 0.006),
        (RIM[0], RIM[1], 0.065, RIM_Y - 0.008),
        (RIM[0] - 0.01, RIM[1] - 0.01, 0.06, RIM_Y),
        (0.33, 0.23, 0.055, RIM_Y),
        (0.325, 0.225, 0.055, RECESS_Y),
    ], "returnBin", segments=16, shape="rrect", shading="weighted")
    # Moulded detail on the slanted walls: a blank label plate on the front,
    # hand-hold slots on both ends (all leaning with the taper).
    lean_v = math.atan2(TUB_T[1] - TUB_B[1], TUB_Y1 - TUB_Y0)
    lean_u = math.atan2(TUB_T[0] - TUB_B[0], TUB_Y1 - TUB_Y0)
    _, hv = _tub_half(0.48)
    decal(p, 0, 0.48, hv + 0.003, 0.26, 0.15, "paperWhite", rot=(lean_v, 0, 0))
    _, hv = _tub_half(0.32)
    decal(p, 0, 0.32, hv + 0.003, 0.4, 0.012, "keyDark", rot=(lean_v, 0, 0))
    hu, _ = _tub_half(0.59)
    decal(p, hu + 0.003, 0.59, 0, 0.16, 0.04, "keyDark", face="u", rot=(0, lean_u, 0))
    decal(p, -hu - 0.003, 0.59, 0, 0.16, 0.04, "keyDark", face="-u", rot=(0, -lean_u, 0))
    # The heap with its tied necks; one loose bag slumps over the front rim.
    _heap(p, lcg(0x0936))
    _knot(p, 0.06, -0.13)
    _knot(p, -0.08, 0.08)
    sphere(p, 0.02, 0.695, 0.215, 1.0, "bagYellow", scale=(0.14, 0.06, 0.09), segments=10, rings=5)
    marker(p, "occ_A", 0, 0.405, 0, 0.7, 0.61, 0.5, t=0)
    marker(p, "occ_B", 0.0, 0.77, 0.0, 0.64, 0.12, 0.46, t=0)


# --- flatpack: 1.20 x 0.80, 0.60 tall -----------------------------------------

PAL_H = 0.144   # EUR pallet: 22 mm bottom boards, 78 mm blocks, 22 + 22 mm deck


def _pallet(p):
    # Bottom boards along u (under the block rows), blocks, cross boards, deck.
    for v, w in ((-0.35, 0.1), (0.0, 0.145), (0.35, 0.1)):
        box(p, 0, 0.011, v, 1.2, 0.022, w, "shelfWood", bev=0.0)
    for u in (-0.5275, 0.0, 0.5275):
        for v, w in ((-0.35, 0.1), (0.0, 0.145), (0.35, 0.1)):
            box(p, u, 0.061, v, 0.145, 0.078, w, "woodMid", bev=0.0)
        box(p, u, 0.111, 0, 0.145, 0.022, 0.8, "shelfWood", bev=0.0)
    for v, w in ((-0.3275, 0.145), (-0.1625, 0.1), (0.0, 0.145), (0.1625, 0.1), (0.3275, 0.145)):
        box(p, 0, 0.133, v, 1.2, 0.022, w, "shelfWood", bev=0.005)


def m_flatpack(p):
    _pallet(p)
    y = PAL_H
    # Strapped unit: one wide box, a pair side by side, one more on top.
    box(p, 0, y + 0.06, 0, 1.16, 0.12, 0.76, "bookTan", bev=0.01)
    decal(p, 0.3, y + 0.06, 0.383, 0.22, 0.08, "paperWhite")
    decal(p, -0.2, y + 0.06, 0.383, 0.42, 0.012, "keyDark")
    y += 0.12
    box(p, 0.02, y + 0.045, -0.19, 1.12, 0.09, 0.37, "flatpackCard", bev=0.008)
    box(p, -0.01, y + 0.045, 0.19, 1.08, 0.09, 0.37, "flatpackCard", bev=0.008)
    decal(p, -0.3, y + 0.045, 0.378, 0.18, 0.06, "paperWhite")
    decal(p, 0.533, y + 0.045, 0.19, 0.2, 0.06, "paperWhite", face="u")
    y += 0.09
    box(p, -0.02, y + 0.055, 0.01, 1.1, 0.11, 0.72, "flatpackCard", bev=0.01, rot=(0, 0, R(1.5)))
    decal(p, -0.02, y + 0.055, 0.373, 0.2, 0.07, "paperWhite", rot=(0, 0, R(1.5)))
    y += 0.11
    # Two black straps over the bound unit (proud of the boxes, no z-fight).
    for u in (-0.36, 0.34):
        box(p, u, y + 0.003, 0.0, 0.026, 0.006, 0.778, "keyDark", bev=0.0)
        for s in (-1, 1):
            box(p, u, PAL_H + (y - PAL_H) / 2 + 0.003, s * 0.386, 0.026, y - PAL_H + 0.006, 0.006, "keyDark", bev=0.0)
    # Loose boxes on top, set down a little skew.
    box(p, -0.08, y + 0.0375, -0.06, 0.92, 0.075, 0.52, "bookTan", bev=0.008, rot=(0, 0, R(-3)))
    box(p, 0.02, y + 0.075 + 0.03, -0.02, 0.56, 0.06, 0.42, "flatpackCard", bev=0.008, rot=(0, 0, R(6)))
    decal(p, 0.02, y + 0.075 + 0.0605, -0.02, 0.2, 0.14, "paperWhite", face="y", rot=(0, 0, R(6)))
    marker(p, "occ_A", 0, 0.232, 0, 1.2, 0.464, 0.8, t=0)
    marker(p, "occ_B", -0.03, 0.532, -0.01, 1.02, 0.136, 0.62, t=0)


MODELS = [
    dict(kind="bag_bin", kind_key="PROP_BAG_BIN", cls="B", build=m_bag_bin,
         dims=(BIN_W, BIN_D), height=BIN_H, tier="detailed"),
    dict(kind="flatpack", kind_key="PROP_FLATPACK", cls="B", build=m_flatpack,
         dims=(1.20, 0.80), height=0.60, tier="detailed"),
]
