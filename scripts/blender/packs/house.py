# Yellow Rooms — house pack (map 05, the house larger inside): the two class
# B props the existing residential furniture cannot stand in for, built by
# build_pack.py (`npm run build:pack -- house`) into public/models/house/.
#
#   hall_clock  PROP_HALL_CLOCK  a longcase (grandfather) clock: plinth, trunk
#                                with a glazed pendulum window, arched hood
#                                round a brass-spandrelled dial
#   radio       PROP_RADIO       a cathedral valve radio on a small cupboard
#                                side table; its dial glass keeps_bright (the
#                                set is on) and it carries the doc 17 `sound`
#                                socket (marker only, no consumer yet)
#
# Frame: game local (u right, y up, v front), origin at the footprint centre
# on the floor, front toward +v. Both pieces stand with their backs to a wall.
# Ids, dims and heights are the registry's (src/world/props/packs/house.js);
# the shadow proxies below are mirrored there.
#
# Look: red-brown mahogany banded by lighter mouldings, brass, painted per
# vertex like the furniture. Wood, paper, Bakelite and grille cloth reuse the
# furniture keys verbatim; brass reuses the stairwell pack's valveBrass (same
# colour and surface, restated in the house data module so this pack stands
# alone). New keys: the clock's and the side table's mahogany (the furniture
# woods read as pale pine next to it, which keeps the mouldings legible) and
# the radio's lit dial.

import math
import os

import bpy

from yr_kit import *  # noqa: F403  (yr_kit.__all__: primitives, G, R, TAU, make_mesh, marker, parsers)

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PAL = parse_js_rgb_table(os.path.join(REPO, "src", "world", "objects", "furniture", "palette.js"),
                         "FURN_TINT", min_entries=40)
REUSED = ("woodDark", "woodMid", "paperWhite", "keyDark", "slotDark", "rug")

NODE_PREFIX = "house_"
BUDGET = dict(tris=20_000, bytes=650_000)
# Same (rgb, metallic, roughness) split as the furniture pack: none are metal.
PALETTE = {k: (PAL[k], 0.0, 0.78) for k in REUSED}
PALETTE.update({
    "valveBrass": ((0.62, 0.45, 0.2), 0.85, 0.32),   # = packs/stairwell.py
    "mahogany": ((0.27, 0.13, 0.075), 0.0, 0.5),     # polished red-brown case wood
    "dialGlow": ((1.0, 0.66, 0.3), 0.0, 0.3),        # lit tuning-dial glass
})
KEEP_BRIGHT = {"dialGlow"}


# --- Helpers ----------------------------------------------------------------------

def prism(p, outline, v0, v1, key, bev=0.0):
    """Closed extrusion of a convex (u, y) outline along v from v0 to v1."""
    n = len(outline)
    verts = [G(a, b, h) for h in (v0, v1) for a, b in outline]
    faces = [tuple(range(n)), tuple(range(n, 2 * n))]
    faces += [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    obj = make_mesh(p, "prism", verts, faces, key, shading="weighted")
    if bev > 0:
        mod = obj.modifiers.new("bev", "BEVEL")
        mod.width = bev
        mod.segments = 1
        mod.limit_method = "ANGLE"
        activate(obj)
        bpy.ops.object.modifier_apply(modifier="bev")
        weighted_normals(obj)
    return obj


def arch(half_w, y0, spring, rise, n=8):
    """Round-headed outline (u, y), counter-clockwise: straight sides from y0
    to `spring` (none when they coincide: no zero-length edges), then an
    elliptical arch of half width `half_w` and `rise`."""
    pts = [(-half_w, y0), (half_w, y0)] if spring > y0 else []
    for k in range(n + 1):
        t = math.pi * k / n
        pts.append((half_w * math.cos(t), spring + rise * math.sin(t)))
    return pts


def hand(p, cu, cy, cv, length, width, angle, key):
    """A flat clock hand from the arbor at (cu, cy) toward `angle` degrees
    clockwise from 12, seen from the front."""
    a = R(angle)
    box(p, cu + math.sin(a) * length / 2, cy + math.cos(a) * length / 2, cv, width, length, 0.003,
        key, bev=0.0, rot=(0, a, 0))


def proxies(p, boxes):
    """occ_A / occ_B markers from (u0, u1, v0, v1, y0, y1, t) records."""
    for name, (u0, u1, v0, v1, y0, y1, t) in zip(("occ_A", "occ_B"), boxes):
        marker(p, name, (u0 + u1) / 2, (y0 + y1) / 2, (v0 + v1) / 2, u1 - u0, y1 - y0, v1 - v0, t=t)


# Shadow proxies, (u0, u1, v0, v1, y0, y1, t) per box, A first. Mirrored by
# src/world/props/packs/house.js (prop-models.test.js fits them to the GLBs).
PROXIES = {
    "hall_clock": [(-0.26, 0.26, -0.175, 0.16, 0.0, 1.47, 0), (-0.27, 0.27, -0.175, 0.175, 1.47, 2.0, 0)],
    "radio": [(-0.275, 0.275, -0.2, 0.2, 0.0, 0.635, 0), (-0.19, 0.19, -0.11, 0.135, 0.635, 0.94, 0)],
}


# --- hall_clock: 0.55 x 0.35, 2.05 tall ------------------------------------------------
# Longcase clock against the wall: skirted plinth with a raised panel, a
# narrower trunk whose door has a glazed window onto the brass pendulum and
# the two weights, a waist moulding, then the hood: a dial (white chapter
# disc, numeral strokes, hands stopped at 3:33) on a brass spandrel plate
# between two brass columns, under a cornice and an arched bonnet with
# three finials.

DIAL_Y = 1.675
DIAL_V = 0.145       # hood front face


def m_hall_clock(p):
    # Plinth: skirt, body, raised front panel, cap moulding.
    box(p, 0, 0.03, 0, 0.55, 0.06, 0.35, "mahogany", bev=0.012)
    box(p, 0, 0.25, -0.005, 0.51, 0.38, 0.31, "mahogany", bev=0.01)
    box(p, 0, 0.25, 0.155, 0.36, 0.25, 0.012, "mahogany", bev=0.004)
    box(p, 0, 0.455, -0.005, 0.53, 0.03, 0.33, "woodDark", bev=0.01)
    # Trunk and its door.
    box(p, 0, 0.955, -0.02, 0.43, 0.97, 0.27, "mahogany", bev=0.01)
    box(p, 0, 0.95, 0.121, 0.35, 0.86, 0.014, "mahogany", bev=0.004)
    # Pendulum window: dark interior plate, frame proud of it, the rod and
    # bob, and the two weights hanging beside the rod.
    box(p, 0, 1.03, 0.130, 0.19, 0.58, 0.006, "slotDark", bev=0.0)
    for su in (-1, 1):
        box(p, su * 0.11, 1.03, 0.137, 0.03, 0.64, 0.016, "mahogany", bev=0.0)
    for y in (0.725, 1.335):
        box(p, 0, y, 0.137, 0.19, 0.03, 0.016, "mahogany", bev=0.0)
    box(p, 0, 1.08, 0.1345, 0.012, 0.42, 0.004, "valveBrass", bev=0.0)
    cyl(p, 0, 0.86, 0.137, 0.055, 0.008, "valveBrass", axis="v", verts=16)
    for su in (-1, 1):
        box(p, su * 0.058, 1.15, 0.1355, 0.034, 0.17, 0.006, "valveBrass", bev=0.0)
        box(p, su * 0.058, 1.285, 0.1345, 0.003, 0.1, 0.003, "keyDark", bev=0.0)
    # Waist moulding, hood body.
    box(p, 0, 1.455, -0.01, 0.49, 0.03, 0.31, "woodDark", bev=0.01)
    box(p, 0, 1.675, -0.01, 0.51, 0.41, 0.31, "mahogany", bev=0.01)
    # Dial: spandrel plate, chapter disc, twelve numeral strokes, hands.
    box(p, 0, DIAL_Y, DIAL_V + 0.004, 0.34, 0.34, 0.008, "valveBrass", bev=0.003)
    cyl(p, 0, DIAL_Y, DIAL_V + 0.011, 0.15, 0.008, "paperWhite", axis="v", verts=24)
    face = DIAL_V + 0.0175
    for k in range(12):
        a = TAU * k / 12
        long_ = 0.034 if k % 3 == 0 else 0.022
        decal(p, math.sin(a) * 0.118, DIAL_Y + math.cos(a) * 0.118, face, 0.009, long_, "keyDark",
              rot=(0, a, 0))
    hand(p, 0, DIAL_Y, face + 0.002, 0.08, 0.014, 105, "keyDark")
    hand(p, 0, DIAL_Y, face + 0.005, 0.12, 0.009, 198, "keyDark")
    cyl(p, 0, DIAL_Y, face + 0.006, 0.012, 0.01, "valveBrass", axis="v", verts=8)
    # Brass hood columns flanking the dial.
    for su in (-1, 1):
        cyl(p, su * 0.218, DIAL_Y, DIAL_V + 0.004, 0.017, 0.38, "valveBrass", verts=8)
    # Cornice, arched bonnet, finials.
    box(p, 0, 1.9, -0.005, 0.55, 0.04, 0.35, "woodDark", bev=0.012)
    prism(p, arch(0.22, 1.92, 1.92, 0.085, n=8), -0.15, 0.15, "mahogany", bev=0.008)
    cyl(p, 0, 2.012, 0.0, 0.016, 0.02, "valveBrass", verts=8)
    sphere(p, 0, 2.03, 0.0, 0.02, "valveBrass", segments=8, rings=6)
    for su in (-1, 1):
        sphere(p, su * 0.24, 1.94, 0.13, 0.02, "valveBrass", segments=8, rings=6)
    proxies(p, PROXIES["hall_clock"])


# --- radio: 0.55 x 0.40, 0.95 tall ------------------------------------------------------
# A small cupboard side table (drawer over a door, on four short tapered
# legs) with a lace runner, and on it a cathedral valve radio: round-headed
# walnut cabinet, cloth grille behind three fret bars, a lit dial in a brass
# bezel between two Bakelite knobs.

TOP = 0.63           # table top surface
RB = 0.654           # radio cabinet bottom (on its plinth on the runner)


def m_radio(p):
    # Table: tapered legs, cupboard carcass, top, drawer and door fronts, knobs.
    for su in (-1, 1):
        for sv in (-1, 1):
            cone(p, su * 0.21, 0.065, sv * 0.13, 0.014, 0.022, 0.13, "mahogany", verts=8)
    box(p, 0, 0.37, -0.005, 0.5, 0.47, 0.35, "mahogany", bev=0.01)
    box(p, 0, 0.615, 0, 0.55, 0.03, 0.4, "mahogany", bev=0.01)
    box(p, 0, 0.525, 0.176, 0.44, 0.1, 0.012, "mahogany", bev=0.004)
    box(p, 0, 0.3, 0.176, 0.44, 0.31, 0.012, "mahogany", bev=0.004)
    sphere(p, 0, 0.525, 0.188, 0.014, "valveBrass", segments=8, rings=6)
    sphere(p, 0.17, 0.32, 0.188, 0.014, "valveBrass", segments=8, rings=6)
    # Lace runner under the set.
    box(p, 0, TOP + 0.0015, 0.01, 0.44, 0.006, 0.3, "paperWhite", bev=0.0)
    # Radio: plinth, round-headed cabinet.
    box(p, 0, RB - 0.01, 0.005, 0.38, 0.02, 0.235, "woodDark", bev=0.006)
    prism(p, arch(0.17, RB, RB + 0.15, 0.14, n=10), -0.1, 0.11, "woodMid", bev=0.012)
    # Grille cloth (round-headed, inset from the rim) and three fret bars.
    gb, gs, gr = RB + 0.1, RB + 0.15, 0.1
    prism(p, arch(0.115, gb, gs, gr, n=8), 0.104, 0.114, "rug")
    for u in (-0.055, 0.0, 0.055):
        top = gs + gr * math.sqrt(max(0.0, 1 - (u / 0.115) ** 2)) - 0.012
        box(p, u, (gb + top) / 2, 0.117, 0.014, top - gb, 0.008, "woodDark", bev=0.0)
    box(p, 0, gb + 0.006, 0.117, 0.23, 0.012, 0.008, "woodDark", bev=0.0)
    # Dial: brass bezel, lit glass, pointer; the two knobs either side.
    dy = RB + 0.052
    cyl(p, 0, dy, 0.113, 0.042, 0.008, "valveBrass", axis="v", verts=16)
    cyl(p, 0, dy, 0.116, 0.034, 0.006, "dialGlow", axis="v", verts=16)
    decal(p, 0.006, dy + 0.012, 0.1195, 0.003, 0.03, "keyDark", rot=(0, R(25), 0))
    for su in (-1, 1):
        cyl(p, su * 0.105, dy, 0.12, 0.021, 0.022, "keyDark", axis="v", verts=12, bev=0.003)
        decal(p, su * 0.105, dy + 0.011, 0.1315, 0.004, 0.014, "paperWhite")
    marker(p, "socket_sound_0", 0, RB + 0.2, 0.12, yrSocket="sound")
    proxies(p, PROXIES["radio"])


# Both kinds sit in the large tier: the clock is a 2 m piece with a dial
# (as many parts as the furniture bookshelf) and the radio is two objects,
# table and set; together they stay near 2,100 triangles.
MODELS = [
    dict(kind="hall_clock", build=m_hall_clock, kind_key="PROP_HALL_CLOCK", cls="B",
         dims=(0.55, 0.35), height=2.05, tier="large"),
    dict(kind="radio", build=m_radio, kind_key="PROP_RADIO", cls="B",
         dims=(0.55, 0.40), height=0.95, tier="large"),
]
