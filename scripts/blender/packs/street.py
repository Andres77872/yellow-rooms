# Yellow Rooms — street pack: the shared street kit's class-B props
# (02 Night Lot, 03 Suburb, 09 Showroom): shopping cart, wheelie bin,
# dumpster and park bench. Built by build_pack.py
# (`npm run build:pack -- street`) into public/models/street/; the registry
# records (ids, dims, heights, box fallback, shadow proxies, surfaces) live in
# src/world/props/packs/street.js and must agree with MODELS below.
#
# Frame contract as furniture (src/world/objects/furniture/frame.js): game
# local frame u = width, v = depth with the FRONT toward +v, y up, origin at
# the footprint centre on the floor; Blender gets (u, -v, y).
#
# Art direction: the furniture pack's painted low-poly look, read at 3-6 m
# under a ceiling tube — strong silhouettes, chamfered hard edges, closed
# parts. The cart is wire work: thin rods alone alias to nothing at that
# range and leave the shadow proxies nothing to match, so its basket is a
# thin dark mesh shell (the "see-through" read) carrying chrome wires.

import math

import bpy
from mathutils import Vector

from yr_kit import *  # noqa: F403  (yr_kit.__all__: primitives, R, TAU, lcg, marker, parsers)

# --- Pack settings (build_pack.py spec contract) --------------------------------

NODE_PREFIX = "street_"
BUDGET = dict(tris=20_000, bytes=650_000)
# key -> (linear rgb, metallic, roughness). Furniture keys keep the furniture
# colours; the new keys' runtime surfaces are in the pack's data module.
PALETTE = {
    "chrome": ((0.75, 0.78, 0.8), 0.85, 0.32),
    "legMetal": ((0.32, 0.31, 0.3), 0.85, 0.32),
    "keyDark": ((0.16, 0.16, 0.17), 0.0, 0.78),
    "slotDark": ((0.14, 0.14, 0.15), 0.0, 0.78),
    "woodMid": ((0.55, 0.43, 0.3), 0.0, 0.78),
    "paperWhite": ((0.9, 0.88, 0.8), 0.0, 0.78),
    "cartMesh": ((0.08, 0.085, 0.09), 0.0, 0.7),   # the basket's wire field, read as a dark screen
    "cartGrip": ((0.6, 0.12, 0.1), 0.0, 0.55),      # handle and child-seat plastic
    "binGreen": ((0.18, 0.36, 0.22), 0.0, 0.62),    # HDPE body
    "binLid": ((0.14, 0.28, 0.17), 0.0, 0.58),
    "dumpsterGreen": ((0.13, 0.27, 0.2), 0.0, 0.55),  # enamelled steel
}


# --- Local helpers (explicit vertex lists: deterministic rebuilds) ---------------

def _bevel(o, bev):
    """finish()'s chamfer for meshes made by make_mesh."""
    mod = o.modifiers.new("bev", "BEVEL")
    mod.width = bev
    mod.segments = 1
    mod.limit_method = "ANGLE"
    activate(o)
    bpy.ops.object.modifier_apply(modifier="bev")
    weighted_normals(o)


def rod(p, a, b, r, key, sides=4, spin=0.25):
    """Closed n-sided prism between two game-frame points (wire work, tubes).
    `spin` turns the section by a fraction of a facet. Soft normals: a
    four-sided wire still shades round, and shares its 8 vertices."""
    A, B = G(*a), G(*b)
    d = (B - A).normalized()
    ref = Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))
    n1 = d.cross(ref).normalized()
    n2 = d.cross(n1)
    ring = []
    for k in range(sides):
        ang = TAU * (k + spin) / sides
        ring.append(n1 * (math.cos(ang) * r) + n2 * (math.sin(ang) * r))
    verts = [A + o for o in ring] + [B + o for o in ring]
    faces = [(k, (k + 1) % sides, sides + (k + 1) % sides, sides + k) for k in range(sides)]
    faces += [tuple(reversed(range(sides))), tuple(range(sides, 2 * sides))]
    return make_mesh(p, "rod", verts, faces, key, shading="soft")


def prism(p, profile, u0, u1, key, bev=0.0):
    """Side profile [(v, y), ...] (a convex outline) extruded across u0..u1."""
    n = len(profile)
    verts = [G(u0, y, v) for v, y in profile] + [G(u1, y, v) for v, y in profile]
    faces = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    faces += [tuple(reversed(range(n))), tuple(range(n, 2 * n))]
    o = make_mesh(p, "prism", verts, faces, key, shading="flat")
    if bev:
        _bevel(o, bev)
    return o


def lerp3(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


# --- Shopping cart ---------------------------------------------------------------
# Nested-trolley basket tapering to its nose (+v), floor rising to the front,
# red push handle at the back, four casters, a lower tray and a folded red
# child seat inside the back gate. POC m_shopping_cart, rebuilt with a mesh
# shell under the wires so it keeps a body from every side.

CART_T = 0.006  # basket shell thickness


def _cart_rings(s):
    """Basket corners shrunk by s: (lo, hi) rings ordered back-left,
    back-right, front-right, front-left."""
    def ring(hw_back, hw_front, v_back, v_front, y_back, y_front, up):
        return [(-(hw_back - s), y_back + up, v_back + s), (hw_back - s, y_back + up, v_back + s),
                (hw_front - s, y_front + up, v_front - s), (-(hw_front - s), y_front + up, v_front - s)]
    lo = ring(0.235, 0.19, -0.37, 0.36, 0.5, 0.56, s)
    hi = ring(0.28, 0.24, -0.4, 0.47, 0.93, 0.93, 0.0)
    return lo, hi


def _cart_shell(p):
    lo, hi = _cart_rings(0.0)
    ilo, ihi = _cart_rings(CART_T)
    verts = [G(*q) for q in lo + hi + ilo + ihi]
    faces = [(3, 2, 1, 0), (8, 9, 10, 11)]                       # outer / inner floor
    for i in range(4):
        j = (i + 1) % 4
        faces.append((i, j, 4 + j, 4 + i))                         # outer walls
        faces.append((8 + j, 8 + i, 12 + i, 12 + j))               # inner walls
        faces.append((4 + i, 4 + j, 12 + j, 12 + i))               # top rim band
    make_mesh(p, "cart_shell", verts, faces, "cartMesh", shading="flat")


def m_cart(p):
    _cart_shell(p)
    lo, hi = _cart_rings(CART_T / 2)                                 # wires ride the mid-shell
    # Rim (thick) and floor edge, run a little past the corners.
    for ring, r in ((hi, 0.0095), (lo, 0.0065)):
        for i in range(4):
            a, b = ring[i], ring[(i + 1) % 4]
            rod(p, lerp3(b, a, 1.02), lerp3(a, b, 1.02), r, "chrome", sides=6 if r > 0.008 else 4)
    wr = 0.0065
    # Walls: uprights, and a mid rail along each side.
    for (a0, a1, b0, b1, n, mid) in ((lo[1], lo[2], hi[1], hi[2], 7, True),
                                     (lo[0], lo[3], hi[0], hi[3], 7, True),
                                     (lo[3], lo[2], hi[3], hi[2], 4, False),
                                     (lo[0], lo[1], hi[0], hi[1], 4, False)):
        for k in range(1, n):
            t = k / n
            rod(p, lerp3(a0, a1, t), lerp3(b0, b1, t), wr, "chrome")
        if mid:
            rod(p, lerp3(a0, b0, 0.5), lerp3(a1, b1, 0.5), wr, "chrome")
    # Floor: two runners toward the nose.
    for t in (0.33, 0.67):
        rod(p, lerp3(lo[0], lo[1], t), lerp3(lo[3], lo[2], t), wr, "chrome")
    # Chassis: base rails, nose cross bar, casters.
    for s in (-1, 1):
        rod(p, (s * 0.24, 0.13, -0.41), (s * 0.19, 0.13, 0.38), 0.012, "legMetal")
    rod(p, (-0.2, 0.13, 0.38), (0.2, 0.13, 0.38), 0.011, "legMetal")
    for s in (-1, 1):
        for (cu, cv) in ((0.24, -0.38), (0.19, 0.36)):
            box(p, s * cu, 0.105, cv, 0.045, 0.05, 0.05, "legMetal", bev=0.0)
            cyl(p, s * cu, 0.055, cv - 0.012, 0.055, 0.03, "slotDark", axis="u", verts=8)
    # Uprights from the rails to the push handle, with struts to the basket.
    for s in (-1, 1):
        rod(p, (s * 0.24, 0.13, -0.41), (s * 0.275, 1.0, -0.465), 0.011, "legMetal", sides=6)
        rod(p, (s * 0.25, 0.5, -0.43), (s * 0.23, 0.505, -0.36), 0.008, "legMetal")
        rod(p, (s * 0.19, 0.14, 0.37), (s * 0.18, 0.56, 0.35), 0.009, "legMetal")
    # Red push handle with chrome end caps.
    cyl(p, 0, 1.0, -0.465, 0.019, 0.5, "cartGrip", axis="u", verts=8)
    for s in (-1, 1):
        cyl(p, s * 0.27, 1.0, -0.465, 0.021, 0.04, "chrome", axis="u", verts=8)
    # Lower tray on the rails, and the folded child seat inside the back gate.
    box(p, 0, 0.152, 0.0, 0.44, 0.012, 0.52, "cartMesh", bev=0.0)
    rod(p, (0, 0.16, -0.26), (0, 0.16, 0.26), 0.006, "chrome")
    box(p, 0, 0.8, -0.373, 0.4, 0.17, 0.014, "cartGrip", bev=0.0, rot=(R(-5.3), 0, 0))


# --- Wheelie bin -----------------------------------------------------------------
# 240 l kerbside bin: tapered body, overhanging lid with a front lip, push bar
# and hinge at the back over two wheels, front foot, lifting comb, white
# house-number stencil on the front.

def m_wheelie_bin(p):
    lathe(p, 0.0, 0.0, [(0.212, 0.232, 0.05, 0.05, 0, 0.038), (0.268, 0.292, 0.05, 0.88, 0, 0.016),
                        (0.288, 0.312, 0.04, 0.905, 0, 0.016), (0.288, 0.312, 0.04, 0.96, 0, 0.016)],
          "binGreen", segments=16, shape="rrect", shading="weighted")
    # Lid: slab, front lip, grab ridge.
    box(p, 0, 0.99, 0.022, 0.6, 0.05, 0.665, "binLid", bev=0.014)
    box(p, 0, 0.955, 0.343, 0.56, 0.06, 0.025, "binLid", bev=0.008)
    box(p, 0, 1.022, 0.27, 0.36, 0.018, 0.07, "binLid", bev=0.006)
    # Push bar on two brackets, hinge barrel.
    for s in (-1, 1):
        box(p, s * 0.19, 0.935, -0.32, 0.05, 0.09, 0.08, "binGreen", bev=0.01)
    cyl(p, 0, 0.945, -0.352, 0.017, 0.48, "binGreen", axis="u", verts=8)
    cyl(p, 0, 0.975, -0.31, 0.014, 0.5, "binLid", axis="u", verts=8)
    # Wheel well block, axle, wheels with hubs.
    box(p, 0, 0.14, -0.225, 0.38, 0.2, 0.09, "binGreen", bev=0.012)
    cyl(p, 0, 0.1, -0.265, 0.014, 0.5, "legMetal", axis="u", verts=8)
    for s in (-1, 1):
        cyl(p, s * 0.252, 0.1, -0.265, 0.1, 0.055, "slotDark", axis="u", verts=14)
        cyl(p, s * 0.282, 0.1, -0.265, 0.045, 0.008, "keyDark", axis="u", verts=10)
    # Front foot, lifting comb, number stencil.
    box(p, 0, 0.03, 0.235, 0.3, 0.06, 0.06, "binGreen", bev=0.01)
    box(p, 0, 0.84, 0.318, 0.44, 0.045, 0.03, "binGreen", bev=0.008, rot=(R(2.7), 0, 0))
    decal(p, 0, 0.58, 0.3, 0.16, 0.12, "paperWhite", rot=(R(2.7), 0, 0))


# --- Dumpster --------------------------------------------------------------------
# Front-load container: sloped front, top falling toward the front under two
# black plastic lids with ribs and back hinges, fork pockets along both ends,
# stiffening ribs, four swivel casters, a stencil plate.

DUMP_W = 1.68                       # body width (fork pockets reach the 1.9 footprint)
DUMP_BOT = 0.17
DUMP_BACK_V, DUMP_BACK_TOP = -0.48, 1.2
DUMP_FRONT_V0, DUMP_FRONT_V1, DUMP_FRONT_TOP = 0.3, 0.5, 1.06
DUMP_SLOPE = math.atan2(DUMP_BACK_TOP - DUMP_FRONT_TOP, DUMP_FRONT_V1 - DUMP_BACK_V)
DUMP_FRONT_LEAN = math.atan2(DUMP_FRONT_V1 - DUMP_FRONT_V0, DUMP_FRONT_TOP - DUMP_BOT)


def _dump_front(y):
    return DUMP_FRONT_V0 + (y - DUMP_BOT) * math.tan(DUMP_FRONT_LEAN)


def _dump_top(v):
    return DUMP_BACK_TOP - (v - DUMP_BACK_V) * math.tan(DUMP_SLOPE)


def m_dumpster(p):
    hw = DUMP_W / 2
    prism(p, [(DUMP_BACK_V, DUMP_BOT), (DUMP_FRONT_V0, DUMP_BOT), (DUMP_FRONT_V1, DUMP_FRONT_TOP),
              (DUMP_BACK_V, DUMP_BACK_TOP)], -hw, hw, "dumpsterGreen", bev=0.02)
    # Top rim channel: back, front and the two sloped sides.
    box(p, 0, DUMP_BACK_TOP - 0.03, DUMP_BACK_V - 0.012, DUMP_W + 0.04, 0.07, 0.05, "dumpsterGreen", bev=0.01)
    box(p, 0, DUMP_FRONT_TOP - 0.035, DUMP_FRONT_V1 + 0.01, DUMP_W + 0.04, 0.07, 0.05, "dumpsterGreen",
        bev=0.01, rot=(DUMP_FRONT_LEAN, 0, 0))
    vm = (DUMP_BACK_V + DUMP_FRONT_V1) / 2
    span = (DUMP_FRONT_V1 - DUMP_BACK_V) / math.cos(DUMP_SLOPE)
    for s in (-1, 1):
        box(p, s * (hw + 0.005), _dump_top(vm) - 0.03, vm, 0.05, 0.07, span, "dumpsterGreen", bev=0.01,
            rot=(DUMP_SLOPE, 0, 0))
    # Lids resting on the rim (their back edge on the hinges), ribs, front lip.
    lid_len = span + 0.07
    nx, ny = math.sin(DUMP_SLOPE), math.cos(DUMP_SLOPE)       # lid normal in (v, y)
    for s in (-1, 1):
        cu = s * (hw / 2 + 0.005)
        lv = vm + 0.02
        ly = _dump_top(lv) + 0.005 + 0.02 * ny
        box(p, cu, ly, lv + 0.02 * nx, hw - 0.02, 0.04, lid_len, "keyDark", bev=0.012,
            rot=(DUMP_SLOPE, 0, 0))
        for du in (-0.22, 0.22):
            box(p, cu + du, ly + 0.03 * ny, lv + 0.03 * nx, 0.06, 0.025, lid_len - 0.16, "keyDark",
                bev=0.008, rot=(DUMP_SLOPE, 0, 0))
        fv = lv + lid_len / 2 * math.cos(DUMP_SLOPE)
        box(p, cu, _dump_top(fv) - 0.03, fv + 0.012, hw - 0.06, 0.07, 0.03, "keyDark", bev=0.008)
        for du in (-0.3, 0.3):
            cyl(p, cu + du, DUMP_BACK_TOP + 0.03, DUMP_BACK_V - 0.035, 0.03, 0.12, "keyDark",
                axis="u", verts=8)
    # Fork pockets along both ends, open (dark) at front and back.
    for s in (-1, 1):
        pu = s * (hw + 0.045)
        box(p, pu, 0.82, -0.03, 0.09, 0.15, 0.84, "dumpsterGreen", bev=0.012)
        for dv, spin in ((0.39, 0), (-0.45, 180)):
            decal(p, pu, 0.82, dv + (0.003 if dv > 0 else -0.003), 0.064, 0.11, "slotDark",
                  rot=(0, 0, R(spin)))
    # Stiffening ribs: three on the sloped front, three on the back.
    lean = DUMP_FRONT_LEAN
    ry = (DUMP_BOT + DUMP_FRONT_TOP) / 2 - 0.04
    rv = _dump_front(ry) + 0.012 * math.cos(lean)
    for du in (-0.56, 0.0, 0.56):
        box(p, du, ry, rv, 0.06, 0.78, 0.03, "dumpsterGreen", bev=0.01, rot=(lean, 0, 0))
        box(p, du, 0.66, DUMP_BACK_V - 0.012, 0.06, 0.86, 0.03, "dumpsterGreen", bev=0.01)
    # Stencil plate on the front, between the ribs.
    py = 0.78
    decal(p, -0.28, py, _dump_front(py) + 0.004, 0.36, 0.2, "paperWhite", rot=(lean, 0, 0))
    # Bottom skid rails and four swivel casters.
    for dv in (-0.36, 0.2):
        box(p, 0, DUMP_BOT - 0.012, dv, DUMP_W - 0.1, 0.03, 0.08, "legMetal", bev=0.006)
    for su in (-0.7, 0.7):
        for cv in (-0.36, 0.2):
            box(p, su, 0.125, cv, 0.1, 0.06, 0.08, "legMetal", bev=0.008)
            cyl(p, su, 0.065, cv - 0.02, 0.065, 0.05, "slotDark", axis="u", verts=12, bev=0.006)


# --- Park bench ------------------------------------------------------------------
# Black cast ends (slim legs, deep seat arm, gently raked back post), four
# seat slats and four back slats in weathered wood, a front apron rail and a
# back tie rail under the seat, a centre bearer. The ends stay slim and the
# back nearly upright so two shadow boxes (seat band, back) hold the side view.

BENCH_RAKE = R(2.0)
BENCH_SEAT = 0.46       # seat top
BENCH_ARM = 0.325       # underside of the seat arm (top of the legs)


def m_bench(p):
    for s in (-1, 1):
        eu = s * 0.835
        for lv in (0.255, -0.262):
            box(p, eu, BENCH_ARM / 2 + 0.005, lv, 0.05, BENCH_ARM + 0.01, 0.035, "keyDark", bev=0.008)
        box(p, eu, 0.375, 0.005, 0.05, 0.1, 0.59, "keyDark", bev=0.01)                   # seat arm
        box(p, eu, 0.6, -0.27 - 0.25 * math.tan(BENCH_RAKE), 0.05, 0.5, 0.05, "keyDark",
            bev=0.008, rot=(-BENCH_RAKE, 0, 0))                                           # back post
    # Front apron and back tie rail between the ends, centre seat bearer.
    box(p, 0, 0.375, 0.282, 1.66, 0.095, 0.016, "keyDark", bev=0.0)
    box(p, 0, 0.39, -0.25, 1.66, 0.05, 0.016, "keyDark", bev=0.0)
    box(p, 0, 0.39, 0.0, 0.04, 0.07, 0.5, "keyDark", bev=0.0)
    # Seat slats.
    for k in range(4):
        box(p, 0, BENCH_SEAT - 0.018, -0.19 + k * 0.14, 1.8, 0.036, 0.12, "woodMid", bev=0.008)
    # Back slats on the raked posts' front faces.
    for k in range(4):
        y = 0.515 + k * 0.105
        v = -0.27 - (y - 0.35) * math.tan(BENCH_RAKE) + 0.04
        box(p, 0, y, v, 1.8, 0.09, 0.03, "woodMid", bev=0.008, rot=(-BENCH_RAKE, 0, 0))


# --- Kinds --------------------------------------------------------------------------
# Shadow proxies (u0, u1, v0, v1, y0, y1, t) = the registry's `proxies`
# (src/world/props/packs/street.js), fitted to these GLBs by the prop-models
# IoU harness; the manifest records them as occ_A / occ_B.

PROXIES = {
    "cart": [(-0.285, 0.285, -0.39, 0.42, 0.52, 0.94, 0), (-0.29, 0.29, -0.485, -0.445, 0.98, 1.02, 0)],
    "wheelie_bin": [(-0.3, 0.3, -0.29, 0.315, 0.02, 1.03, 0)],
    "dumpster": [(-0.93, 0.93, -0.52, 0.44, 0.17, 1.22, 0)],
    "bench": [(-0.9, 0.9, -0.28, 0.3, 0.325, 0.46, 0), (-0.9, 0.9, -0.31, -0.23, 0.36, 0.87, 0)],
}


def _with_proxies(kind, build):
    """The builder plus its occ_* markers (EMPTYs: never joined or exported)."""
    def run(p):
        build(p)
        for name, (u0, u1, v0, v1, y0, y1, t) in zip(("occ_A", "occ_B"), PROXIES[kind]):
            marker(p, name, (u0 + u1) / 2, (y0 + y1) / 2, (v0 + v1) / 2, u1 - u0, y1 - y0, v1 - v0, t=t)
    return run


def _kind(kind, build, dims, height, tier):
    return dict(kind=kind, kind_key="PROP_" + kind.upper(), cls="B", build=_with_proxies(kind, build),
                dims=dims, height=height, tier=tier)


MODELS = [
    _kind("cart", m_cart, (0.6, 1.0), 1.05, "detailed"),
    _kind("wheelie_bin", m_wheelie_bin, (0.6, 0.75), 1.07, "detailed"),
    _kind("dumpster", m_dumpster, (1.9, 1.1), 1.3, "large"),
    _kind("bench", m_bench, (1.8, 0.65), 0.85, "detailed"),
]
