# Yellow Rooms — playplace pack (map 10, playplace): the child-scale table and
# chair, an upright arcade cabinet, a foam punch bag on a weighted base and a
# mascot statue as class B props, built by build_pack.py
# (`npm run build:pack -- playplace`) into public/models/playplace/. Ids, dims
# and heights are the registry's (src/world/props/packs/playplace.js); the
# proxies below are mirrored there, so keep the two in step.
#
# Frame: game local (u right, y up, v front), origin at the footprint centre
# on the floor, front toward +v (the arcade's player side, the mascot's face).
#
# Look: moulded primary-colour plastic, every edge rounded, against the
# carpet. The furniture is child scale on purpose (the "scale wrongness" of
# doc 10): it must read as a kids' table at a glance, so the silhouettes are
# chunky and the colours flat. The arcade screen, marquee and coin slots
# keep_bright (attract mode). The mascot is a generic party bear, no brand.
#
# Shadow proxies: the IoU harness compares every side view with at most two
# boxes, so the table carries a bin shelf and the chair a panel back that runs
# to the floor; both are real kids'-furniture forms and keep the silhouettes
# solid enough for two boxes.

import os

import bmesh
import bpy

from yr_kit import *  # noqa: F403  (yr_kit.__all__: primitives, R, TAU, lcg, marker, parsers)

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

# Reused furniture keys keep the furniture colour + surface (same split as
# packs/furniture.py), so a reused key never redefines yr_<key>.
PAL = parse_js_rgb_table(os.path.join(REPO, "src", "world", "objects", "furniture", "palette.js"),
                         "FURN_TINT", min_entries=40)
METAL_KEYS = {"chrome"}
REUSED = ("chrome", "keyDark", "slotDark")

NODE_PREFIX = "playplace_"
# Map 10's share of the static pack budget (17-asset-manifest.md: ~7,600 tris, ~305 KB).
BUDGET = dict(tris=7_600, bytes=305_000)
PALETTE = {k: (PAL[k], 0.85 if k in METAL_KEYS else 0.0, 0.32 if k in METAL_KEYS else 0.78)
           for k in REUSED}
# New keys; their runtime surfaces live in the pack data module.
PALETTE.update({
    "playRed": ((0.6, 0.045, 0.035), 0.0, 0.45),       # moulded plastic, primary set
    "playBlue": ((0.03, 0.13, 0.52), 0.0, 0.45),
    "playYellow": ((0.86, 0.56, 0.03), 0.0, 0.45),
    "playGreen": ((0.05, 0.34, 0.07), 0.0, 0.45),
    "arcadeBody": ((0.07, 0.04, 0.17), 0.0, 0.55),     # purple laminate cabinet
    "arcadeScreen": ((0.12, 0.42, 0.78), 0.0, 0.1),    # lit CRT (attract mode)
    "arcadeGlow": ((0.98, 0.72, 0.22), 0.0, 0.25),     # marquee, sprites, coin slots
    "mascotFur": ((0.42, 0.17, 0.05), 0.0, 0.6),       # painted fibreglass
    "mascotCream": ((0.82, 0.62, 0.36), 0.0, 0.6),
})
KEEP_BRIGHT = {"arcadeScreen", "arcadeGlow"}


# --- Local helpers ----------------------------------------------------------------

def _solid(p, name, verts, faces, key, bev=0.0, seg=None):
    """Closed custom mesh from game-frame verts, bevelled like box()."""
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(G(*v)) for v in verts], [], faces)
    mesh.update()
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(mesh)
    bm.free()
    o = bpy.data.objects.new(name, mesh)
    finish(o, key, bev=bev, seg=seg)
    p.append(o)
    return o


def _prism(p, name, profile, u0, u1, key, bev=0.0, seg=None):
    """A (v, y) side profile extruded across u0..u1: one closed slab."""
    n = len(profile)
    verts = [(u0, y, v) for v, y in profile] + [(u1, y, v) for v, y in profile]
    faces = [tuple(range(n)), tuple(range(n, 2 * n))]
    faces += [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    return _solid(p, name, verts, faces, key, bev=bev, seg=seg)


def _quad(p, pts, key):
    """Decal quad from four game-frame corners, counter-clockwise seen from
    the side it faces (single sided: backface culling is on)."""
    return make_mesh(p, "decal", [G(*q) for q in pts], [(0, 1, 2, 3)], key,
                     shading="flat", recalc=False)


def _slope_quad(p, a, b, ua, ub, key, off):
    """Decal on the sloped front face running from (va, ya) up to (vb, yb):
    the strip between fractions a..b (bottom..top) of `face`, u in ua..ub,
    pushed `off` along the face normal."""
    (va, ya), (vb, yb) = a, b
    dv, dy = vb - va, yb - ya
    ln = (dv * dv + dy * dy) ** 0.5
    nv, ny = dy / ln, -dv / ln  # outward normal of a face climbing toward -v
    va, ya, vb, yb = va + nv * off, ya + ny * off, vb + nv * off, yb + ny * off
    return _quad(p, [(ua, ya, va), (ub, ya, va), (ub, yb, vb), (ua, yb, vb)], key)


def _lerp2(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


# --- Child table: rounded slab top, red apron, chunky legs, a bin shelf ------------
# 1.20 x 0.80 x 0.55: adult-table footprint at knee height (the wrongness).

T_H = 0.55
T_LEG_U, T_LEG_V = 0.49, 0.29


def m_child_table(p):
    # Thick moulded top with big plan radii, a rounded lip all round.
    lathe(p, 0, 0, [(0.575, 0.375, 0.13, 0.47), (0.6, 0.4, 0.15, 0.49),
                    (0.6, 0.4, 0.15, 0.53), (0.58, 0.38, 0.135, T_H)],
          "playYellow", segments=16, shape="rrect")
    # Apron band tucked under the lip (its top hides inside the slab).
    lathe(p, 0, 0, [(0.55, 0.35, 0.11, 0.40), (0.55, 0.35, 0.11, 0.475)],
          "playRed", segments=16, shape="rrect", cap_top=False)
    for su in (-1, 1):
        for sv in (-1, 1):
            cyl(p, su * T_LEG_U, 0.21, sv * T_LEG_V, 0.045, 0.42, "playBlue", verts=8)
    # Low shelf between the legs carrying three storage bins.
    box(p, 0, 0.075, 0, 2 * T_LEG_U, 0.03, 2 * T_LEG_V, "playBlue", bev=0.008)
    for cu, key in ((-0.31, "playGreen"), (0.0, "playRed"), (0.31, "playGreen")):
        box(p, cu, 0.19, 0.0, 0.29, 0.2, 0.5, key, bev=0.012)
        decal(p, cu, 0.25, 0.253, 0.11, 0.03, "keyDark")  # hand-hold slot


# --- Child chair: one-piece moulded shell, panel back to the floor ---------------
# 0.38 x 0.38 x 0.60; seat at 0.30 (a five-year-old's knee).

C_BACK_V0, C_BACK_V1 = -0.19, -0.145


def m_child_chair(p):
    box(p, 0, 0.3, (C_BACK_V0 + C_BACK_V1) / 2, 0.36, 0.6, C_BACK_V1 - C_BACK_V0, "playRed",
        bev=0.03, seg=2)
    box(p, 0, 0.29, 0.02, 0.38, 0.055, 0.34, "playRed", bev=0.02, seg=2)
    for su in (-1, 1):
        cyl(p, su * 0.15, 0.135, 0.145, 0.022, 0.27, "playRed", verts=8)
    # Hand hole near the top of the back, both faces.
    decal(p, 0, 0.52, C_BACK_V1 + 0.002, 0.13, 0.035, "keyDark")
    _quad(p, [(0.065, 0.5025, C_BACK_V0 - 0.002), (-0.065, 0.5025, C_BACK_V0 - 0.002),
              (-0.065, 0.5375, C_BACK_V0 - 0.002), (0.065, 0.5375, C_BACK_V0 - 0.002)], "keyDark")


# --- Arcade cabinet: classic upright --------------------------------------------
# 0.75 x 0.85 x 1.85, back (-v) to the wall. Side panels carry the full
# profile; the body sits 0.02 behind their front edge, so the screen, coin
# door and marquee read recessed between them.

A_W = 0.375                       # half width
A_SIDE = 0.03                     # side panel thickness
A_BACK = -0.425
A_TOP = 1.84
# Side profile (v, y), back bottom first, counter-clockwise seen from +u.
A_PROFILE = [(A_BACK, 0.0), (0.2, 0.0), (0.2, 0.86), (0.16, 0.99), (0.07, 1.52),
             (0.23, 1.56), (0.23, A_TOP), (A_BACK, A_TOP)]
A_SCREEN = ((0.14, 0.99), (0.05, 1.52))      # sloped screen face of the inset body (v, y)
A_INSET = 0.02


def m_arcade(p):
    for su in (-1, 1):
        _prism(p, "side", A_PROFILE, su * (A_W - A_SIDE), su * A_W, "arcadeBody", bev=0.008)
    # Body: front inset, back and top 5 mm shy of the panels' (no coplanar seams).
    inner = [(v - A_INSET if v > 0 else A_BACK + 0.005, min(y, A_TOP - 0.005)) for v, y in A_PROFILE]
    _prism(p, "body", inner, -(A_W - A_SIDE) - 0.002, A_W - A_SIDE + 0.002, "arcadeBody")

    # Screen: dark bezel on the slope, the lit picture inside it, two attract
    # mode sprites (a ghost-like blob and a row of dots) as glow strokes.
    lo, hi = A_SCREEN
    _slope_quad(p, _lerp2(lo, hi, 0.02), _lerp2(lo, hi, 0.98), -0.31, 0.31, "keyDark", 0.003)
    _slope_quad(p, _lerp2(lo, hi, 0.12), _lerp2(lo, hi, 0.9), -0.25, 0.25, "arcadeScreen", 0.006)
    for t0, t1, u0, u1 in ((0.32, 0.36, -0.19, 0.19), (0.55, 0.7, -0.05, 0.05),
                           (0.55, 0.62, 0.1, 0.16), (0.55, 0.62, -0.16, -0.1)):
        _slope_quad(p, _lerp2(lo, hi, t0), _lerp2(lo, hi, t1), u0, u1, "arcadeGlow", 0.009)

    # Marquee: lit panel across the hood front, a red title bar on it.
    mv = 0.23 - A_INSET + 0.003
    decal(p, 0, 1.7, mv, 0.62, 0.2, "arcadeGlow")
    decal(p, 0, 1.7, mv + 0.003, 0.44, 0.07, "playRed")

    # Control panel: a blue deck between the side panels, joystick + buttons.
    box(p, 0, 0.93, 0.29, 2 * (A_W - A_SIDE) - 0.004, 0.11, 0.27, "playBlue", bev=0.02)
    cyl(p, -0.17, 1.02, 0.31, 0.009, 0.08, "chrome", verts=6)
    sphere(p, -0.17, 1.07, 0.31, 0.026, "playRed", segments=8, rings=6)
    for cu, cv, key in ((0.02, 0.33, "playRed"), (0.1, 0.35, "playYellow"), (0.18, 0.33, "playGreen"),
                        (0.06, 0.26, "playYellow"), (0.14, 0.26, "playRed")):
        cyl(p, cu, 0.99, cv, 0.019, 0.016, key, verts=8)

    # Coin door with two lit coin slots, a dark kick plate at the floor.
    dv = 0.2 - A_INSET + 0.003
    decal(p, 0, 0.5, dv, 0.26, 0.34, "slotDark")
    for cu in (-0.06, 0.06):
        decal(p, cu, 0.58, dv + 0.003, 0.04, 0.07, "arcadeGlow")
    decal(p, 0, 0.06, dv, 2 * (A_W - A_SIDE) - 0.03, 0.1, "keyDark")

    # Side art: two slanted stripes on each outer face.
    for su, face in ((-1, "-u"), (1, "u")):
        for y, key, w in ((1.15, "playYellow", 0.07), (1.05, "playRed", 0.05)):
            decal(p, su * (A_W + 0.003), y, -0.15, 0.5, w, key, face=face, rot=(R(18), 0, 0))

    # Attract-mode sockets (no consumer yet): the screen and its floor glow.
    sc = _lerp2(lo, hi, 0.5)
    marker(p, "socket_screen_0", 0, sc[1], sc[0] + 0.01, yrSocket="screen")
    marker(p, "socket_glow_0", 0, 1.25, 0.45, yrSocket="glow")


# --- Foam punch bag on a weighted base -----------------------------------------
# 0.80 x 0.80 x 1.60: a rounded-square water base and a banded foam column.

def m_punch_bag(p):
    lathe(p, 0, 0, [(0.37, 0.37, 0.13, 0.0), (0.385, 0.385, 0.14, 0.03), (0.385, 0.385, 0.14, 0.11),
                    (0.32, 0.32, 0.12, 0.17), (0.17, 0.17, 0.08, 0.19)],
          "playYellow", segments=16, shape="rrect")
    # Foam column in stacked, slightly bulged segments.
    sections = (("playRed", [(0.13, 0.13, 0.17), (0.185, 0.185, 0.24), (0.195, 0.195, 0.36)]),
                ("playBlue", [(0.195, 0.195, 0.36), (0.205, 0.205, 0.62), (0.195, 0.195, 0.88)]),
                ("playYellow", [(0.195, 0.195, 0.88), (0.205, 0.205, 0.95), (0.195, 0.195, 1.02)]),
                ("playBlue", [(0.195, 0.195, 1.02), (0.205, 0.205, 1.22), (0.195, 0.195, 1.42)]),
                ("playRed", [(0.195, 0.195, 1.42), (0.185, 0.185, 1.51), (0.15, 0.15, 1.57),
                             (0.07, 0.07, 1.6)]))
    for key, profile in sections:
        lathe(p, 0, 0, profile, key, segments=16)


# --- Mascot statue: a party bear on a plinth -------------------------------------
# 0.80 x 0.70 x 1.90. Generic cartoon bear: big head, round ears, cream muzzle
# and belly, one paw waving, bow tie and a party hat.

def m_mascot(p):
    lathe(p, 0, 0, [(0.4, 0.35, 0.1, 0.0), (0.4, 0.35, 0.1, 0.17)],
          "playBlue", segments=16, shape="rrect", cap_top=False)
    lathe(p, 0, 0, [(0.4, 0.35, 0.1, 0.17), (0.4, 0.35, 0.1, 0.215), (0.38, 0.33, 0.085, 0.24)],
          "playYellow", segments=16, shape="rrect", cap_bottom=False)
    decal(p, 0, 0.09, 0.352, 0.3, 0.08, "playYellow")   # name plaque

    # Feet and stubby legs.
    for su in (-1, 1):
        sphere(p, su * 0.12, 0.275, 0.06, 0.1, "mascotFur", scale=(1, 0.5, 1.3), segments=8, rings=6)
        sphere(p, su * 0.12, 0.42, 0.0, 0.11, "mascotFur", scale=(1, 1.5, 1), segments=8, rings=6)
    # Pear-shaped body and the cream belly.
    lathe(p, 0, 0, [(0.12, 0.1, 0.38), (0.24, 0.2, 0.48), (0.27, 0.22, 0.65), (0.25, 0.2, 0.85),
                    (0.18, 0.15, 1.0), (0.1, 0.09, 1.1)], "mascotFur", segments=16)
    sphere(p, 0, 0.68, 0.135, 0.2, "mascotCream", scale=(0.8, 1.05, 0.55), segments=12, rings=6)

    # Arms: the left paw waves, the right hangs.
    tube(p, [(-0.19, 0.95, 0.0), (-0.3, 1.02, 0.02), (-0.36, 1.16, 0.04), (-0.36, 1.28, 0.05)],
         0.065, "mascotFur", seg=8)
    sphere(p, -0.36, 1.33, 0.05, 0.08, "mascotFur", segments=8, rings=6)
    tube(p, [(0.19, 0.95, 0.0), (0.28, 0.86, 0.03), (0.31, 0.72, 0.06)], 0.065, "mascotFur", seg=8)
    sphere(p, 0.31, 0.67, 0.07, 0.08, "mascotFur", segments=8, rings=6)

    # Head: ears with cream insides, muzzle, nose, eyes.
    sphere(p, 0, 1.3, 0.02, 0.25, "mascotFur", segments=16, rings=10)
    for su in (-1, 1):
        sphere(p, su * 0.18, 1.5, 0.0, 0.085, "mascotFur", scale=(1, 1, 0.55), segments=8, rings=6)
        sphere(p, su * 0.18, 1.5, 0.03, 0.05, "mascotCream", scale=(1, 1, 0.4), segments=8, rings=4)
        sphere(p, su * 0.085, 1.36, 0.235, 0.032, "keyDark", segments=8, rings=4)
    sphere(p, 0, 1.22, 0.2, 0.11, "mascotCream", scale=(1.15, 0.8, 0.8), segments=12, rings=6)
    sphere(p, 0, 1.265, 0.29, 0.04, "keyDark", scale=(1.3, 0.9, 0.9), segments=8, rings=4)

    # Bow tie and party hat (pom-pom on top).
    for su in (-1, 1):
        cone(p, su * 0.055, 1.07, 0.15, 0.055, 0.008, 0.1, "playRed", rot=(0, R(-90 * su), 0), verts=8)
    sphere(p, 0, 1.07, 0.16, 0.026, "playRed", segments=8, rings=4)
    cone(p, 0.05, 1.64, 0.0, 0.1, 0.012, 0.25, "playYellow", rot=(0, R(14), 0), verts=12)
    sphere(p, 0.08, 1.77, 0.0, 0.035, "playRed", segments=8, rings=4)


# --- Shadow proxies: (u0, u1, v0, v1, y0, y1, t), A first (the more opaque) ------
PROXIES = {
    "child_table": [(-0.6, 0.6, -0.4, 0.4, 0.4, 0.55, 0), (-0.53, 0.53, -0.34, 0.34, 0.06, 0.3, 0)],
    "child_chair": [(-0.18, 0.18, C_BACK_V0, C_BACK_V1, 0.0, 0.6, 0), (-0.19, 0.19, -0.19, 0.19, 0.265, 0.315, 0)],
    "arcade": [(-0.375, 0.375, -0.425, 0.21, 0.0, 1.84, 0), (-0.345, 0.345, 0.21, 0.425, 0.875, 0.985, 0)],
    "punch_bag": [(-0.2, 0.2, -0.2, 0.2, 0.17, 1.6, 0), (-0.385, 0.385, -0.385, 0.385, 0.0, 0.19, 0)],
    "mascot": [(-0.25, 0.24, -0.18, 0.21, 0.24, 1.57, 0), (-0.4, 0.4, -0.35, 0.35, 0.0, 0.24, 0)],
}


def _with_proxies(kind, build):
    def run(p):
        build(p)
        for name, (u0, u1, v0, v1, y0, y1, t) in zip(("occ_A", "occ_B"), PROXIES[kind]):
            marker(p, name, (u0 + u1) / 2, (y0 + y1) / 2, (v0 + v1) / 2, u1 - u0, y1 - y0, v1 - v0, t=t)
    return run


MODELS = [
    dict(kind="child_table", kind_key="PROP_CHILD_TABLE", cls="B",
         build=_with_proxies("child_table", m_child_table), dims=(1.20, 0.80), height=0.55, tier="detailed"),
    dict(kind="child_chair", kind_key="PROP_CHILD_CHAIR", cls="B",
         build=_with_proxies("child_chair", m_child_chair), dims=(0.38, 0.38), height=0.60, tier="simple"),
    dict(kind="arcade", kind_key="PROP_ARCADE", cls="B",
         build=_with_proxies("arcade", m_arcade), dims=(0.75, 0.85), height=1.85, tier="detailed"),
    dict(kind="punch_bag", kind_key="PROP_PUNCH_BAG", cls="B",
         build=_with_proxies("punch_bag", m_punch_bag), dims=(0.80, 0.80), height=1.60, tier="detailed"),
    dict(kind="mascot", kind_key="PROP_MASCOT", cls="B",
         build=_with_proxies("mascot", m_mascot), dims=(0.80, 0.70), height=1.90, tier="large"),
]
