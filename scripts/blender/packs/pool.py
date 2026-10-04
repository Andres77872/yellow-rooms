# Yellow Rooms — pool prop pack (map 01, the poolrooms; the bandai seat is the
# sentō's): six class B props built by build_pack.py
# (`npm run build:pack -- pool`) into public/models/pool/ for the prop loader
# (src/render/furnitureModels.js loadPropModels).
#
# Single source of truth: dims, heights and the lamp-shadow proxies are parsed
# from the pack's data module (src/world/props/packs/pool.js), so the
# manifest, the registry and the IoU harness always agree.
#
# Look: glazed tile, white enamel and chrome, read under one ceiling tube at
# 3-6 m. Silhouettes stay blocky on purpose (solid side boards, closed
# plinths): the occupancy proxies are two boxes, and an open frame would cast
# a wrong shadow. Detail sits on faces as decals (grout, crosses, labels).

import math
import os
import re

import bpy

from yr_kit import *  # noqa: F403  (yr_kit.__all__: primitives, R, TAU, lcg, marker, parsers)

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
DATA = os.path.join(REPO, "src", "world", "props", "packs", "pool.js")

NODE_PREFIX = "pool_"
# Doc 17 sizes the whole poolrooms static set at ~4,800 tris / 190 KB; these
# six props are its class B share.
BUDGET = dict(tris=4_800, bytes=190_000)
METAL = (0.85, 0.32)
PALETTE = {
    # furniture keys (runtime surfaces already known)
    "chrome": ((0.75, 0.78, 0.8), *METAL),
    "applianceWhite": ((0.9, 0.91, 0.89), 0.0, 0.78),
    "woodMid": ((0.55, 0.43, 0.3), 0.0, 0.78),
    "woodDark": ((0.38, 0.29, 0.2), 0.0, 0.78),
    "towel": ((0.55, 0.68, 0.72), 0.0, 0.78),
    "paperWhite": ((0.9, 0.88, 0.8), 0.0, 0.78),
    "keyDark": ((0.16, 0.16, 0.17), 0.0, 0.78),
    "slotDark": ((0.14, 0.14, 0.15), 0.0, 0.78),
    "fabric": ((0.3, 0.34, 0.42), 0.0, 0.78),
    # pool keys (surfaces in src/world/props/packs/pool.js)
    "poolTile": ((0.78, 0.86, 0.86), 0.0, 0.2),       # glazed aqua-white ceramic
    "tileGrout": ((0.42, 0.52, 0.54), 0.0, 0.85),
    "poolGrip": ((0.1, 0.2, 0.3), 0.0, 0.9),          # non-slip pads, treads
    "rescueRed": ((0.62, 0.07, 0.06), 0.0, 0.6),      # crosses, rescue tube
    "floatBlue": ((0.08, 0.3, 0.68), 0.0, 0.9),       # closed-cell foam
    "floatYellow": ((0.9, 0.66, 0.08), 0.0, 0.9),
    "crateBlue": ((0.1, 0.26, 0.55), 0.0, 0.55),      # moulded plastic bin
    "tatami": ((0.6, 0.57, 0.34), 0.0, 0.92),
}
KEEP_BRIGHT = set()  # nothing in the pool set glows


# --- Data module parse (dims, height, proxies per file stem) -------------------

def _parse_data(path):
    src = open(path, encoding="utf-8").read()
    out = {}
    for block in re.split(r"\n    \{\n", src)[1:]:
        stem = re.search(r"kind: '(\w+)'", block)
        dims = re.search(r"dims: \[([\d.]+), ([\d.]+)\]", block)
        height = re.search(r"height: ([\d.]+)", block)
        prox = re.search(r"proxies: \[(.*?)\n      \]", block, re.S)
        if not (stem and dims and height and prox):
            continue
        boxes = []
        for row in re.findall(r"\[([-\d., ]+)\]", prox.group(1)):
            vals = [float(x) for x in row.split(",")]
            boxes.append(tuple(vals[:6]) + (int(vals[6]) if len(vals) > 6 else 0,))
        out[stem.group(1)] = dict(dims=(float(dims.group(1)), float(dims.group(2))),
                                  height=float(height.group(1)), proxies=boxes)
    if len(out) != 6:
        raise RuntimeError(f"pool.js parse failed ({sorted(out)})")
    return out


SPEC = _parse_data(DATA)


# --- Local helpers -----------------------------------------------------------------

def prism_u(p, u0, u1, poly, key, bev=0.0):
    """Board cut to the (v, y) outline `poly` (counter-clockwise seen from +u),
    extruded from u0 to u1: side panels whose edge follows a stair."""
    n = len(poly)
    verts = [(u, -v, y) for u in (u0, u1) for v, y in poly]
    faces = [tuple(reversed(range(n))), tuple(range(n, 2 * n))]
    faces += [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    obj = make_mesh(p, "prism", verts, faces, key, shading="flat")
    if bev > 0:
        mod = obj.modifiers.new("bev", "BEVEL")
        mod.width = bev
        mod.segments = 1
        mod.limit_method = "ANGLE"
        activate(obj)
        bpy.ops.object.modifier_apply(modifier="bev")
        weighted_normals(obj)
    return obj


def tilted(cv, cy, s, t, ang):
    """Point at distance s along and t above a slab line through (cv, cy)
    that rises toward -v at `ang` radians: returns (v, y)."""
    return cv - s * math.cos(ang) - t * math.sin(ang), cy + s * math.sin(ang) + t * math.cos(ang)


def cross_mark(p, cu, cy, cv, size, key, face="v", rot=None):
    """A red cross as three non-overlapping quads (no coplanar z-fight)."""
    bar = size * 0.32
    arm = (size - bar) / 2
    if face == "v":
        decal(p, cu, cy, cv, bar, size, key, rot=rot)
        for s in (-1, 1):
            decal(p, cu + s * (bar + arm) / 2, cy, cv, arm, bar, key, rot=rot)
    else:
        sgn = -1 if face == "u" else 1  # the side face's viewer-right is -v on +u
        decal(p, cu, cy, cv, bar, size, key, face=face)
        for s in (-1, 1):
            decal(p, cu, cy, cv + sgn * s * (bar + arm) / 2, arm, bar, key, face=face)


# --- Models ----------------------------------------------------------------------------

def m_starting_block(p):
    """Tiled plinth, a platform raked 6 deg toward the water (+v) with a grip
    pad and a track-start wedge, backstroke grips under the front lip."""
    ang = R(6)
    cv, cy = 0.0, 0.64  # platform slab centre
    # Plinth: tiled cube under the rear two thirds, grout as split decals.
    pv, ph, pw = -0.125, 0.62, 0.48
    box(p, 0, ph / 2, pv, pw, ph, 0.48, "poolTile", bev=0.016)
    rows = (0.155, 0.31, 0.465)
    for side in ("v", "-v", "u", "-u"):
        for i, y0 in enumerate((0.0,) + rows):
            y1 = rows[i] if i < len(rows) else ph
            mid, hgt = (y0 + y1) / 2, y1 - y0 - 0.008
            for off in (-0.08, 0.08):
                if side == "v":
                    decal(p, off, mid, pv + 0.243, 0.008, hgt, "tileGrout")
                elif side == "-v":
                    decal(p, off, mid, pv - 0.243, 0.008, hgt, "tileGrout", rot=(0, 0, R(180)))
                else:
                    su = 0.243 if side == "u" else -0.243
                    decal(p, su, mid, pv + off, 0.008, hgt, "tileGrout", face=side)
        for y in rows:
            if side == "v":
                decal(p, 0, y, pv + 0.244, pw - 0.03, 0.008, "tileGrout")
            elif side == "-v":
                decal(p, 0, y, pv - 0.244, pw - 0.03, 0.008, "tileGrout", rot=(0, 0, R(180)))
            else:
                decal(p, 0.244 if side == "u" else -0.244, y, pv, 0.45, 0.008, "tileGrout", face=side)
    # Lane plates on both sides (proud of the grout).
    for su, face in ((0.248, "u"), (-0.248, "-u")):
        decal(p, su, 0.39, pv, 0.2, 0.17, "poolGrip", face=face)
        r = -1 if face == "u" else 1  # viewer-right along v on this face
        for x, y, w, h in ((0.02, 0.39, 0.016, 0.12), (-0.014, 0.375, 0.052, 0.016),
                           (-0.032, 0.4165, 0.016, 0.067)):  # a white lane "4"
            decal(p, su * 1.012, y, pv + r * x, w, h, "applianceWhite", face=face)
    # Neck under the platform (fills the rake above the flat plinth top).
    nv, ny = tilted(cv, cy, 0.125, -0.05, ang)
    box(p, 0, ny, nv, pw - 0.02, 0.06, 0.48, "poolTile", bev=0.008, rot=(ang, 0, 0))
    # Platform slab, grip pad, track-start wedge.
    box(p, 0, cy, cv, 0.5, 0.04, 0.76, "applianceWhite", bev=0.012, rot=(ang, 0, 0))
    gv, gy = tilted(cv, cy, 0.0, 0.025, ang)
    box(p, 0, gy, gv, 0.44, 0.012, 0.66, "poolGrip", bev=0.004, rot=(ang, 0, 0))
    wv, wy = tilted(cv, cy, 0.27, 0.03, ang)
    lean = R(-48)
    box(p, 0, wy + 0.05 * math.cos(lean), wv + 0.05 * math.sin(lean) - 0.01, 0.4, 0.105, 0.03,
        "poolGrip", bev=0.008, rot=(lean, 0, 0))
    # Backstroke grips hang from the front lip.
    lip = cy - 0.02 - 0.3 * math.sin(ang) + 0.01
    tube(p, [(-0.19, lip, 0.3), (-0.19, 0.5, 0.3), (0.19, 0.5, 0.3), (0.19, lip, 0.3)],
         0.013, "chrome", seg=6)


def m_lifeguard_chair(p):
    """Tall white chair: solid side boards whose front edge follows a tread
    stair, a closed back board, a slatted seat and raked backrest, chrome
    hand rails, red crosses and a rescue tube on its hook."""
    side = [(-0.55, 0.0), (0.55, 0.0), (0.55, 0.42), (0.06, 1.4), (-0.55, 1.4)]
    for s in (-1, 1):
        u0, u1 = sorted((s * 0.395, s * 0.445))
        prism_u(p, u0, u1, side, "applianceWhite", bev=0.012)
        face = "u" if s > 0 else "-u"
        cross_mark(p, s * 0.448, 1.1, -0.2, 0.24, "rescueRed", face=face)
        decal(p, s * 0.448, 0.04, 0.0, 1.08, 0.06, "tileGrout", face=face)  # scuffed kick band
    # Back board and its cross.
    box(p, 0, 0.7, -0.53, 0.8, 1.36, 0.03, "applianceWhite", bev=0.006)
    cross_mark(p, 0, 1.0, -0.548, 0.22, "rescueRed", rot=(0, 0, R(180)))
    # Treads up the front (their top views tile the stair).
    for i, y in enumerate((0.33, 0.63, 0.93, 1.23)):
        front = 0.55 if y < 0.42 else 0.55 - 0.5 * (y - 0.42)
        box(p, 0, y, front - 0.085, 0.8, 0.035, 0.17, "poolGrip", bev=0.006)
    # Seat: board + slats as grooves.
    box(p, 0, 1.43, -0.21, 0.8, 0.06, 0.62, "woodMid", bev=0.012)
    for k in range(1, 5):
        decal(p, 0, 1.4625, -0.52 + k * 0.124, 0.74, 0.008, "woodDark", face="y")
    # Raked backrest on two posts.
    ang = R(-9)
    box(p, 0, 1.76, -0.5, 0.72, 0.36, 0.035, "woodMid", bev=0.01, rot=(ang, 0, 0))
    # Chrome rails: up the stair edge, along as an armrest, down into the board.
    for s in (-1, 1):
        u = s * 0.42
        tube(p, [(u, 0.4, 0.53), (u, 0.8, 0.53), (u, 1.76, 0.05), (u, 1.76, -0.46), (u, 1.38, -0.46)],
             0.016, "chrome", seg=6)
        tube(p, [(u, 0.92, 0.29), (u, 1.28, 0.29)], 0.012, "chrome", seg=5)
        tube(p, [(u * 0.86, 1.44, -0.5), (u * 0.86, 2.0, -0.565)], 0.014, "chrome", seg=5)
    # Ring buoy on a hook on the right board.
    buoy = torus(p, 0.487, 0.62, -0.2, 0.19, 0.04, "rescueRed", major_seg=14, minor_seg=5)
    buoy.rotation_euler = (0, R(90), 0)
    cyl(p, 0.47, 0.84, -0.2, 0.012, 0.05, "chrome", axis="u", verts=6)


def m_lounger(p):
    """White resin lounger: full-length frame, slatted bed, raised slatted
    backrest on a strut, foot legs, head wheels, a folded towel."""
    # Frame rails (full length) and foot rail.
    for s in (-1, 1):
        box(p, s * 0.315, 0.24, 0.0, 0.05, 0.1, 1.92, "applianceWhite", bev=0.012)
    box(p, 0, 0.235, 0.94, 0.6, 0.09, 0.04, "applianceWhite", bev=0.01)
    box(p, 0, 0.235, -0.94, 0.6, 0.09, 0.04, "applianceWhite", bev=0.01)
    # Bed slats over a recessed deck (the gaps read dark, not see-through).
    box(p, 0, 0.255, 0.26, 0.58, 0.02, 1.3, "tileGrout", bev=0.0)
    pitch, n = 0.12, 11
    for k in range(n):
        box(p, 0, 0.288, -0.38 + 0.055 + k * pitch, 0.6, 0.024, 0.098, "applianceWhite", bev=0.0)
    # Raised backrest: hinged at v=-0.40, rising toward the head.
    ang = R(14)
    hv, hy = -0.4, 0.3
    L = 0.57
    for s in (-1, 1):
        rv, ry = tilted(hv, hy - 0.02, L / 2, 0.0, ang)
        box(p, s * 0.31, ry, rv, 0.05, 0.06, L, "applianceWhite", bev=0.01, rot=(ang, 0, 0))
    for k in range(5):
        sv, sy = tilted(hv, hy, 0.06 + k * 0.11, 0.0, ang)
        box(p, 0, sy, sv, 0.58, 0.024, 0.09, "applianceWhite", bev=0.0, rot=(ang, 0, 0))
    # Strut propping the backrest.
    for s in (-1, 1):
        tube(p, [(s * 0.27, 0.27, -0.55), (s * 0.27, 0.38, -0.86)], 0.014, "applianceWhite", seg=5)
    # Foot legs, head wheels on brackets.
    for s in (-1, 1):
        box(p, s * 0.3, 0.1, 0.86, 0.05, 0.2, 0.07, "applianceWhite", bev=0.01)
        box(p, s * 0.3, 0.14, -0.82, 0.04, 0.1, 0.07, "applianceWhite", bev=0.0)
        cyl(p, s * 0.3, 0.07, -0.82, 0.07, 0.035, "keyDark", axis="u", verts=10)
    # Folded towel on the foot end.
    soft_box(p, 0.02, 0.318, 0.6, 0.44, 0.036, 0.3, "towel", r=0.012, seg=1, cuts=0)
    decal(p, 0.02, 0.3, 0.751, 0.4, 0.018, "applianceWhite")  # its fold edge stripe


def m_kickboard(p):
    """Two-layer foam kickboard, rounded nose toward +v."""
    hu, hv = 0.15, 0.225
    lathe(p, 0, 0, [(hu - 0.006, hv - 0.006, 0.07, 0.0), (hu, hv, 0.075, 0.006), (hu, hv, 0.075, 0.011)],
          "floatYellow", shape="rrect", segments=16)
    lathe(p, 0, 0, [(hu, hv, 0.075, 0.011), (hu, hv, 0.075, 0.022), (hu - 0.008, hv - 0.008, 0.068, 0.03)],
          "floatBlue", shape="rrect", segments=16, cap_bottom=False)
    for s in (-1, 1):
        decal(p, s * 0.07, 0.0305, 0.13, 0.05, 0.09, "floatYellow", face="y")


def m_lost_bin(p):
    """Tapered blue bin with a rolled rim, a 'lost property' card, hand
    holes, and the leftovers: towel, arm float, goggles, a flip-flop."""
    lathe(p, 0, 0, [(0.27, 0.195, 0.04, 0.0), (0.287, 0.21, 0.045, 0.78), (0.3, 0.223, 0.05, 0.8),
                    (0.3, 0.223, 0.05, 0.84), (0.282, 0.205, 0.042, 0.84), (0.27, 0.193, 0.035, 0.6)],
          "crateBlue", shape="rrect", segments=16)
    # Front card + its 'writing'.
    fv = 0.195 + 0.015 * 0.5 + 0.004
    decal(p, 0, 0.5, fv, 0.3, 0.16, "paperWhite", rot=(R(-1.1), 0, 0))
    for k, w in enumerate((0.22, 0.16, 0.19)):
        decal(p, -0.11 + w / 2, 0.545 - k * 0.04, fv + 0.002, w, 0.014, "keyDark", rot=(R(-1.1), 0, 0))
    # Hand holes on both ends.
    for s, face in ((1, "u"), (-1, "-u")):
        decal(p, s * 0.288, 0.68, 0.0, 0.16, 0.05, "slotDark", face=face)
    # Leftovers spilling over the rim.
    soft_box(p, -0.08, 0.8, -0.03, 0.34, 0.1, 0.3, "towel", r=0.03, seg=1, cuts=0, rot=(0, R(-12), R(8)))
    torus(p, 0.16, 0.82, 0.04, 0.065, 0.026, "floatYellow", major_seg=12, minor_seg=5)
    for s in (-1, 1):
        cyl(p, 0.08 + s * 0.035, 0.87, 0.12, 0.024, 0.016, "floatBlue", verts=10)
    tube(p, [(0.045, 0.87, 0.12), (0.0, 0.86, 0.06), (0.06, 0.85, 0.02), (0.155, 0.87, 0.12)],
         0.004, "keyDark", seg=4)
    box(p, 0.13, 0.78, -0.12, 0.1, 0.02, 0.25, "floatBlue", bev=0.008, rot=(R(30), 0, R(20)))


def m_bandai(p):
    """Sentō bandai: a raised wooden booth, tatami floor and cushion inside a
    counter on three sides, coin tray and bell on the front ledge, a price
    board on a post at the back corner."""
    W, D = 1.2, 0.9
    box(p, 0, 0.04, 0, W - 0.04, 0.08, D - 0.04, "woodDark", bev=0.008)                  # plinth
    box(p, 0, 0.415, 0, W - 0.02, 0.67, D - 0.02, "woodMid", bev=0.014)                  # base
    # Front face: framed panels (stiles as decals).
    for k in range(5):
        decal(p, -0.47 + k * 0.235, 0.415, D / 2 - 0.006, 0.03, 0.6, "woodDark")
    decal(p, 0, 0.73, D / 2 - 0.006, W - 0.06, 0.025, "woodDark")
    for s, face in ((1, "u"), (-1, "-u")):
        for k in range(3):
            decal(p, s * (W / 2 - 0.006), 0.415, -0.3 + k * 0.3, 0.03, 0.6, "woodDark", face=face)
    # Raised floor: tatami and a cushion.
    box(p, 0, 0.765, -0.03, W - 0.14, 0.03, D - 0.12, "tatami", bev=0.004)
    soft_box(p, -0.08, 0.81, -0.12, 0.46, 0.07, 0.46, "fabric", r=0.025, seg=1, cuts=0)
    # Counter walls on three sides, capped with a darker ledge.
    box(p, 0, 0.97, D / 2 - 0.03, W - 0.02, 0.4, 0.04, "woodMid", bev=0.008)
    for s in (-1, 1):
        # Side walls stop behind the front wall and ledge: no coplanar faces.
        box(p, s * (W / 2 - 0.035), 0.97, -0.02, 0.04, 0.4, D - 0.1, "woodMid", bev=0.008)
        box(p, s * (W / 2 - 0.045), 1.184, -0.07, 0.1, 0.028, D - 0.14, "woodDark", bev=0.008)
    box(p, 0, 1.185, D / 2 - 0.07, W, 0.03, 0.16, "woodDark", bev=0.008)
    # On the ledge: coin tray, bell, ticket stack.
    box(p, 0.2, 1.212, D / 2 - 0.07, 0.2, 0.024, 0.11, "chrome", bev=0.006)
    box(p, 0.2, 1.218, D / 2 - 0.07, 0.17, 0.02, 0.085, "slotDark", bev=0.0)
    sphere(p, -0.32, 1.2, D / 2 - 0.07, 0.035, "chrome", scale=(1, 0.8, 1), segments=10, rings=5)
    box(p, -0.12, 1.215, D / 2 - 0.08, 0.12, 0.03, 0.08, "paperWhite", bev=0.004)
    # Price board on a post at the back-left corner.
    pu, pv = -(W / 2 - 0.04), -(D / 2 - 0.05)
    box(p, pu, 1.38, pv, 0.04, 0.4, 0.04, "woodDark", bev=0.006)
    box(p, pu + 0.17, 1.45, pv + 0.025, 0.36, 0.26, 0.025, "woodDark", bev=0.006)
    decal(p, pu + 0.17, 1.45, pv + 0.0395, 0.31, 0.21, "paperWhite")
    for k, w in enumerate((0.24, 0.18, 0.22, 0.12)):
        decal(p, pu + 0.04 + w / 2, 1.52 - k * 0.045, pv + 0.0415, w, 0.016, "keyDark")


# --- Spec ----------------------------------------------------------------------------------

def _with_proxies(kind, build):
    """The builder plus its occ_* markers from pool.js (never exported)."""
    def run(p):
        build(p)
        for name, (u0, u1, v0, v1, y0, y1, t) in zip(("occ_A", "occ_B"), SPEC[kind]["proxies"]):
            marker(p, name, (u0 + u1) / 2, (y0 + y1) / 2, (v0 + v1) / 2, u1 - u0, y1 - y0, v1 - v0, t=t)
    return run


def _kind(kind, build, tier="detailed"):
    return dict(kind=kind, kind_key="PROP_" + kind.upper(), cls="B", build=_with_proxies(kind, build),
                dims=SPEC[kind]["dims"], height=SPEC[kind]["height"], tier=tier)


MODELS = [
    _kind("starting_block", m_starting_block),
    _kind("lifeguard_chair", m_lifeguard_chair),
    _kind("lounger", m_lounger),
    _kind("kickboard", m_kickboard, tier="simple"),
    _kind("lost_bin", m_lost_bin),
    _kind("bandai", m_bandai),
]
