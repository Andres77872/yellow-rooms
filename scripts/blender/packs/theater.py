# Yellow Rooms — theater pack (map 11, empty theater): the ghost light, the
# stage manager's prompt desk, a 3-seat row of tip-up stalls seats and a road
# case as class B props, built by build_pack.py (`npm run build:pack --
# theater`) into public/models/theater/. Ids, dims and heights are the
# registry's (src/world/props/packs/theater.js); the proxies below are
# mirrored there.
#
# Frame: game local (u right, y up, v front), origin at the footprint centre
# on the floor, front toward +v (the operator's side of the prompt desk, the
# audience side of the seat row).
#
# Look: backstage black (painted carcasses, flight-case laminate) against red
# plush and worn timber, painted per-vertex like the furniture. The bare bulb
# and the cue lamps keep_bright: they are the only "lit" parts of the pack.
# The ghost light carries a light socket at its bulb and the prompt desk one
# at its cue panel (doc 17 classes them B+E); markers only, no consumer yet.

import math
import os

import bpy

from yr_kit import *  # noqa: F403  (yr_kit.__all__: primitives, R, TAU, lcg, marker, parsers)

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

# Reused furniture keys keep the furniture colour + surface (same split as
# packs/furniture.py), so a reused key never redefines yr_<key>.
PAL = parse_js_rgb_table(os.path.join(REPO, "src", "world", "objects", "furniture", "palette.js"),
                         "FURN_TINT", min_entries=40)
METAL_KEYS = {"chrome", "applianceSteel", "legMetal"}
REUSED = ("keyDark", "slotDark", "tvBlack", "legMetal", "chrome", "applianceSteel", "woodDark",
          "woodMid", "paperWhite", "ledGreen")

NODE_PREFIX = "theater_"
BUDGET = dict(tris=20_000, bytes=650_000)
PALETTE = {k: (PAL[k], 0.85 if k in METAL_KEYS else 0.0, 0.32 if k in METAL_KEYS else 0.78)
           for k in REUSED}
# New keys; their runtime surfaces live in the pack data module.
PALETTE.update({
    "ghostBulb": ((1.0, 0.8, 0.5), 0.0, 0.3),        # bare tungsten bulb (lit)
    "cueRed": ((0.95, 0.09, 0.05), 0.0, 0.3),        # cue-light standby lamps (lit)
    "seatPlush": ((0.19, 0.012, 0.018), 0.0, 0.92),  # red stalls velvet
    "caseBlack": ((0.045, 0.045, 0.05), 0.0, 0.55),  # flight-case laminate
})
KEEP_BRIGHT = {"ghostBulb", "cueRed", "ledGreen"}


# --- Local helpers ----------------------------------------------------------------

def _bevel(obj, width, seg=None):
    """finish()'s angle-limited chamfer for meshes built by make_mesh."""
    mod = obj.modifiers.new("bev", "BEVEL")
    mod.width = width
    mod.segments = seg if seg else (2 if width >= 0.02 else 1)
    mod.limit_method = "ANGLE"
    activate(obj)
    bpy.ops.object.modifier_apply(modifier="bev")
    weighted_normals(obj)
    return obj


def rrect(a0, a1, b0, b1, r_lo=0.0, r_hi=0.0, n=4):
    """Rounded rectangle outline in an (a, b) plane, counter-clockwise. r_lo
    rounds the two corners at b0, r_hi the two at b1 (n segments each)."""
    pts = []
    corners = ((a1, b0, r_lo, -90), (a1, b1, r_hi, 0), (a0, b1, r_hi, 90), (a0, b0, r_lo, 180))
    for ca, cb, r, start in corners:
        if r <= 0:
            pts.append((ca, cb))
            continue
        oa = ca - r if ca == a1 else ca + r
        ob = cb + r if cb == b0 else cb - r
        for k in range(n + 1):
            t = math.radians(start + 90 * k / n)
            pts.append((oa + r * math.cos(t), ob + r * math.sin(t)))
    return pts


def prism(p, outline, lo, hi, key, axis="y", bev=0.0, seg=None, at=None, rot=None):
    """Closed straight extrusion. axis y: outline (u, v), extruded y lo..hi;
    axis u: outline (v, y), extruded along u; axis v: outline (u, y), along v.
    With `at` (game coords) the outline is local to that point and the part
    turns by `rot` about it (a reclined seat back)."""
    n = len(outline)
    verts = []
    for h in (lo, hi):
        for a, b in outline:
            if axis == "y":
                verts.append(G(a, h, b))
            elif axis == "u":
                verts.append(G(h, b, a))
            else:
                verts.append(G(a, b, h))
    faces = [tuple(reversed(range(n))), tuple(range(n, 2 * n))]
    faces += [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    obj = make_mesh(p, "prism", verts, faces, key, shading="weighted",
                    location=G(*at) if at else None, rot=rot)
    return _bevel(obj, bev, seg) if bev > 0 else obj


def proxies(p, boxes):
    """occ_A / occ_B markers from (u0, u1, v0, v1, y0, y1, t) records."""
    for name, (u0, u1, v0, v1, y0, y1, t) in zip(("occ_A", "occ_B"), boxes):
        marker(p, name, (u0 + u1) / 2, (y0 + y1) / 2, (v0 + v1) / 2, u1 - u0, y1 - y0, v1 - v0, t=t)


def tilted(y, v, dy, dv, th):
    """(y, v) of the point (dy up, dv toward +v) of a part centred on (y, v)
    and tilted by th about u (positive th drops its +v edge)."""
    return (y + dy * math.cos(th) - dv * math.sin(th), v + dv * math.cos(th) + dy * math.sin(th))


# Shadow proxies, (u0, u1, v0, v1, y0, y1, t) per box, A first. Mirrored by
# src/world/props/packs/theater.js (prop-models.test.js fits them to the GLBs).
PROXIES = {
    # The crib from the caster yokes up (the wheels are mostly air), then the
    # pole and cage column, widened on +u for the flex.
    "ghost_light": [(-0.205, 0.205, -0.205, 0.205, 0.08, 0.363, 0),
                    (-0.024, 0.036, -0.024, 0.024, 0.363, 1.88, 0)],
    "prompt_desk": [(-0.55, 0.55, -0.29, 0.2, 0.0, 1.04, 0), (-0.55, 0.55, -0.29, 0.3, 1.04, 1.25, 0)],
    "seat_row": [(-1.0, 1.0, -0.35, 0.24, 0.0, 0.66, 0), (-0.96, 0.96, -0.4, -0.22, 0.66, 0.95, 0)],
    "road_case": [(-0.6, 0.6, -0.3, 0.3, 0.1, 1.0, 0), (-0.6, 0.6, -0.3, 0.3, 0.0, 0.1, 0)],
}


# --- Ghost light ----------------------------------------------------------------------
# The bare bulb left burning on an empty stage: a caged lamp on a two-stage
# pole, stepped into a base plate on four swivel casters and held down by a
# crib of fly-floor counterweight bricks; its flex runs down the pole and
# lies coiled on the weights.

BULB = [(0.016, 1.705), (0.021, 1.718), (0.037, 1.738), (0.054, 1.765), (0.06, 1.79),
        (0.056, 1.815), (0.043, 1.836), (0.022, 1.849), (0.004, 1.853)]


def m_ghost_light(p):
    # Base plate on swivel casters (a yoke over each wheel).
    prism(p, rrect(-0.21, 0.21, -0.21, 0.21, 0.05, 0.05, n=3), 0.085, 0.13, "keyDark", bev=0.01)
    for su in (-1, 1):
        for sv in (-1, 1):
            cu, cv = 0.15 * su, 0.15 * sv
            box(p, cu, 0.06, cv, 0.034, 0.05, 0.044, "legMetal", bev=0.0)
            cyl(p, cu, 0.032, cv, 0.032, 0.026, "slotDark", axis="u", verts=8)
    # Counterweight crib: four layers of two bricks either side of the pole,
    # each layer turned 90 degrees (a 1 mm gap keeps the faces apart).
    for layer in range(4):
        y = 0.13 + 0.029 + layer * 0.058
        for s in (-1, 1):
            if layer % 2 == 0:
                box(p, 0, y, s * 0.11, 0.4, 0.057, 0.17, "legMetal", bev=0.005)
            else:
                box(p, s * 0.11, y, 0, 0.17, 0.057, 0.4, "legMetal", bev=0.005)
    # Pole: collar on the crib, lower tube, clamp with its T-knob, upper tube.
    cyl(p, 0, 0.376, 0, 0.036, 0.03, "keyDark", verts=12)
    cyl(p, 0, 0.58, 0, 0.024, 0.9, "keyDark", verts=12)
    cyl(p, 0, 1.035, 0, 0.032, 0.06, "keyDark", verts=12)
    cyl(p, -0.045, 1.035, 0, 0.007, 0.05, "keyDark", axis="u", verts=6)
    cyl(p, -0.072, 1.035, 0, 0.012, 0.012, "keyDark", axis="u", verts=8)
    cyl(p, 0, 1.34, 0, 0.019, 0.58, "chrome", verts=10)
    # Lampholder and the bare bulb.
    cyl(p, 0, 1.665, 0, 0.024, 0.08, "tvBlack", verts=12)
    lathe(p, 0, 0, [(r, r, y) for r, y in BULB], "ghostBulb", segments=10)
    # Wire cage: collar ring, belly ring, six bowed bars, top hub.
    torus(p, 0, 1.7, 0, 0.026, 0.004, "chrome", major_seg=10, minor_seg=3)
    torus(p, 0, 1.778, 0, 0.088, 0.004, "chrome", major_seg=14, minor_seg=3)
    for i in range(6):
        a = TAU * (i + 0.5) / 6
        ca, sa = math.cos(a), math.sin(a)
        pts = [(r * ca, y, r * sa) for r, y in ((0.026, 1.7), (0.07, 1.722), (0.088, 1.778),
                                                (0.072, 1.84), (0.018, 1.876))]
        tube(p, pts, 0.0035, "chrome", seg=3)
    cyl(p, 0, 1.878, 0, 0.02, 0.012, "chrome", verts=8)
    # Flex: out of the lampholder, down the pole (two clips), coiled on the crib.
    tube(p, [(0.026, 1.66, 0), (0.026, 1.6, 0), (0.026, 1.2, 0), (0.03, 0.9, 0), (0.03, 0.5, 0),
             (0.045, 0.403, 0.03), (0.085, 0.38, 0.075)], 0.006, "tvBlack", seg=4)
    for y in (1.25, 0.66):
        cyl(p, 0, y, 0, 0.032 if y < 1 else 0.027, 0.02, "keyDark", verts=8)
    torus(p, 0.1, 0.382, 0.1, 0.055, 0.008, "tvBlack", major_seg=12, minor_seg=3)
    marker(p, "socket_light_0", 0, 1.78, 0, yrSocket="light", lampKind="bare")
    proxies(p, PROXIES["ghost_light"])


# --- Prompt desk ----------------------------------------------------------------------------
# The stage manager's desk in the prompt corner: a painted black console with
# a sloped timber writing top, an open script, and a rear upstand carrying the
# cue-light panel (a red standby and a green go lamp per channel, a toggle
# under each) under a hooded desk light. A talkback mic on a gooseneck and a
# headset hung on the side complete it.

def m_prompt_desk(p):
    rnd = lcg(0x0BA1)
    # Recessed kick, then the carcass (side profile: back taller than front).
    box(p, 0, 0.03, -0.04, 1.0, 0.06, 0.44, "slotDark", bev=0.0)
    prism(p, [(-0.29, 0.055), (0.2, 0.055), (0.2, 0.975), (-0.29, 1.055)], -0.53, 0.53, "keyDark",
          axis="u", bev=0.01)
    # Front: two door panels with pulls, and a scuffed kick plate.
    for du in (-0.26, 0.26):
        decal(p, du, 0.52, 0.2025, 0.46, 0.8, "slotDark")
        decal(p, du, 0.52, 0.205, 0.44, 0.78, "keyDark")
        box(p, du - 0.17 if du > 0 else du + 0.17, 0.78, 0.212, 0.016, 0.12, 0.016, "applianceSteel",
            bev=0.0)
    decal(p, 0, 0.09, 0.2035, 1.04, 0.05, "legMetal")
    # Sloped timber writing top with a front lip.
    th = R(9.5)
    yc, vc = 1.015, 0.03
    box(p, 0, yc, vc, 1.1, 0.034, 0.54, "woodMid", bev=0.008, rot=(th, 0, 0))
    ly, lv = tilted(yc, vc, 0.022, 0.262, th)
    box(p, 0, ly, lv, 1.06, 0.018, 0.016, "woodDark", bev=0.0, rot=(th, 0, 0))
    # Open script binder and a pencil on the top.
    for side in (-1, 1):
        py, pv = tilted(yc, vc, 0.021 + 0.006 * (1 + side * 0.3), 0.06, th)
        box(p, 0.06 + side * 0.115, py, pv, 0.22, 0.008, 0.29, "paperWhite", bev=0.0,
            rot=(th, 0, R(side * -2.5)))
    py, pv = tilted(yc, vc, 0.019, 0.06, th)
    box(p, 0.06, py, pv, 0.48, 0.006, 0.3, "woodDark", bev=0.0, rot=(th, 0, 0))
    py, pv = tilted(yc, vc, 0.024, 0.17, th)
    cyl(p, -0.33, py, pv, 0.004, 0.17, "woodMid", axis="u", verts=6)
    # Rear upstand: the cue-light panel faces the operator (+v).
    box(p, 0, 1.15, -0.22, 1.1, 0.2, 0.14, "keyDark", bev=0.01)
    fv = -0.15
    decal(p, 0, 1.14, fv + 0.002, 0.98, 0.14, "slotDark")
    # Standby (red) row above the go (green) row, each on a black bezel rail;
    # every standby burns, a few go lamps too, the rest are dark lenses.
    for y in (1.18, 1.135):
        box(p, 0, y, fv + 0.005, 0.92, 0.042, 0.01, "tvBlack", bev=0.0)
    for i in range(6):
        cu = -0.4 + i * 0.16
        lit = rnd()
        for y, key in ((1.18, "cueRed"), (1.135, "ledGreen" if lit < 0.35 else "slotDark")):
            cyl(p, cu, y, fv + 0.012, 0.016, 0.006, key, axis="v", verts=8)
        box(p, cu, 1.09, fv + 0.012, 0.008, 0.008, 0.022, "chrome", bev=0.0,
            rot=(R(-20 if lit < 0.5 else 20), 0, 0))
        decal(p, cu, 1.09, fv + 0.0045, 0.03, 0.02, "applianceSteel")
    # Hooded desk light over the writing top (bulb strip under the hood).
    box(p, 0, 1.235, -0.125, 1.0, 0.024, 0.09, "keyDark", bev=0.006)
    box(p, 0, 1.216, -0.087, 1.0, 0.026, 0.012, "keyDark", bev=0.0)
    decal(p, 0, 1.2215, -0.12, 0.86, 0.03, "ghostBulb", face="y", rot=(R(180), 0, 0))
    # Talkback mic on a gooseneck (left), stopwatch by the script (right).
    tube(p, [(-0.47, 1.25, -0.22), (-0.47, 1.27, -0.19), (-0.465, 1.275, -0.13), (-0.46, 1.262, -0.07)],
         0.006, "legMetal", seg=5)
    cyl(p, -0.47, 1.25, -0.22, 0.016, 0.012, "tvBlack", verts=8)
    sphere(p, -0.458, 1.258, -0.055, 0.018, "tvBlack", segments=8, rings=6, scale=(1, 1, 1.3))
    sy, sv = tilted(yc, vc, 0.024, -0.12, th)
    cyl(p, 0.42, sy, sv, 0.03, 0.012, "applianceSteel", verts=12, rot=(th, 0, 0))
    # Headset on a hook on the right side: headband arc, two ear cups.
    box(p, 0.545, 0.985, -0.05, 0.03, 0.012, 0.012, "legMetal", bev=0.0)
    hu = 0.548
    tube(p, [(hu, 0.92, -0.13), (hu, 0.985, -0.1), (hu, 1.0, -0.05), (hu, 0.985, 0.0), (hu, 0.92, 0.03)],
         0.007, "tvBlack", seg=5, sub=2)
    for cv in (-0.135, 0.035):
        cyl(p, hu, 0.88, cv, 0.035, 0.03, "tvBlack", axis="u", verts=12)
    # Back (against the proscenium wall): service hatch, cue-cable gland, vents.
    back = (0, 0, R(180))
    decal(p, 0.1, 0.55, -0.2925, 0.6, 0.6, "slotDark", rot=back)
    decal(p, 0.1, 0.55, -0.295, 0.56, 0.56, "keyDark", rot=back)
    cyl(p, -0.38, 0.2, -0.3, 0.03, 0.03, "tvBlack", axis="v", verts=10)
    for i in range(3):
        decal(p, 0, 1.2 - i * 0.03, -0.2925, 0.6, 0.012, "slotDark", rot=back)
    marker(p, "socket_light_0", 0, 1.16, fv + 0.02, yrSocket="light", lampKind="cue")
    proxies(p, PROXIES["prompt_desk"])


# --- Theatre seat row -----------------------------------------------------------------------
# Three tip-up stalls seats, all down, on four cast standards with timber
# arm caps. Red plush pads on timber shells; the backs reach the floor as a
# closed rear panel (the row behind sees timber), the aisle ends carry a row
# letter plaque.

STANDARD = [(-0.34, 0.0), (0.23, 0.0), (0.23, 0.03), (0.21, 0.06), (0.19, 0.58), (0.15, 0.62),
            (-0.27, 0.62), (-0.31, 0.58), (-0.33, 0.06)]


def m_seat_row(p):
    rnd = lcg(0x0BA2)
    for au in (-0.955, -0.315, 0.315, 0.955):
        prism(p, STANDARD, au - 0.024, au + 0.024, "keyDark", axis="u", bev=0.008)
        box(p, au, 0.645, -0.03, 0.075, 0.05, 0.56, "woodMid", bev=0.016)
    for cu in (-0.635, 0.0, 0.635):
        sag = 0.004 + 0.006 * rnd()
        # Back: timber shell to the floor, reclined plush pad in front.
        tb = R(-7)
        prism(p, rrect(-0.3, 0.3, -0.45, 0.45, 0.0, 0.09, n=3), -0.025, 0.025, "woodDark", axis="v",
              bev=0.012, at=(cu, 0.5, -0.32), rot=(tb, 0, 0))
        py, pv = tilted(0.5, -0.32, 0.17, 0.065, tb)
        soft_box(p, cu, py, pv, 0.54, 0.5, 0.08, "seatPlush", r=0.025, seg=1, puff=(0.0, 0.0, 0.018),
                 rot=(tb, 0, 0))
        # Seat (down): timber pan under a plush cushion, tipped slightly back.
        ts = R(-3)
        box(p, cu, 0.405, 0.0, 0.54, 0.03, 0.44, "woodDark", bev=0.008, rot=(ts, 0, 0))
        sy, sv = tilted(0.405, 0.0, 0.058, 0.0, ts)
        soft_box(p, cu, sy, sv, 0.53, 0.09, 0.43, "seatPlush", r=0.03, puff=(0.0, 0.012, 0.012),
                 sag=sag, rot=(ts, 0, 0))
        # Seat number plate high on the shell's back.
        ny, nv = tilted(0.5, -0.32, 0.37, -0.0265, tb)
        decal(p, cu, ny, nv, 0.06, 0.035, "applianceSteel", rot=(-tb, 0, R(180)))
    # Row-letter plaques on the aisle faces of the end standards.
    decal(p, 0.98, 0.42, -0.08, 0.1, 0.07, "applianceSteel", face="u")
    decal(p, -0.98, 0.42, -0.08, 0.1, 0.07, "applianceSteel", face="-u")
    proxies(p, PROXIES["seat_row"])


# --- Road case ----------------------------------------------------------------------------------
# A black flight case on four casters: laminate panels framed by aluminium
# angle on every edge, ball corners, a lid seam with butterfly latches,
# recessed spring handles on the ends and a blank stencil plate.

def _latch(p, cu, cy, cv, face):
    """Butterfly latch dish proud of a v (front/back) or u (end) face."""
    if face == "v":
        s = 1 if cv > 0 else -1
        box(p, cu, cy, cv + s * 0.004, 0.08, 0.1, 0.008, "applianceSteel", bev=0.0)
        box(p, cu, cy + 0.005, cv + s * 0.01, 0.05, 0.02, 0.008, "chrome", bev=0.0)
    else:
        s = 1 if cu > 0 else -1
        box(p, cu + s * 0.004, cy, cv, 0.008, 0.1, 0.08, "applianceSteel", bev=0.0)
        box(p, cu + s * 0.01, cy + 0.005, cv, 0.008, 0.02, 0.05, "chrome", bev=0.0)


def m_road_case(p):
    W, D, y0, y1 = 1.18, 0.58, 0.11, 0.99
    hw, hd = W / 2, D / 2
    # Caster board and four swivel casters.
    box(p, 0, 0.1, 0, W - 0.02, 0.02, D - 0.02, "tvBlack", bev=0.004)
    for su in (-1, 1):
        for sv in (-1, 1):
            cu, cv = su * (hw - 0.09), sv * (hd - 0.08)
            box(p, cu, 0.085, cv, 0.1, 0.01, 0.09, "legMetal", bev=0.0)
            box(p, cu, 0.062, cv, 0.042, 0.036, 0.05, "legMetal", bev=0.0)
            cyl(p, cu, 0.04, cv, 0.04, 0.032, "slotDark", axis="u", verts=10)
    # Laminate body (lid seam at ls) and the aluminium angle on all twelve edges.
    ls = 0.84
    box(p, 0, (y0 + ls) / 2, 0, W, ls - y0 - 0.006, D, "caseBlack", bev=0.004)
    box(p, 0, (ls + y1) / 2, 0, W, y1 - ls - 0.006, D, "caseBlack", bev=0.004)
    a = 0.026
    for y in (y0 + a / 2, y1 - a / 2):
        for sv in (-1, 1):
            box(p, 0, y, sv * (hd - a / 2 + 0.003), W - 0.06, a, a, "applianceSteel", bev=0.004)
        for su in (-1, 1):
            box(p, su * (hw - a / 2 + 0.003), y, 0, a, a, D - 0.06, "applianceSteel", bev=0.004)
    for su in (-1, 1):
        for sv in (-1, 1):
            box(p, su * (hw - a / 2 + 0.003), (y0 + y1) / 2, sv * (hd - a / 2 + 0.003), a, y1 - y0 - 0.06,
                a, "applianceSteel", bev=0.004)
            for y in (y0 + 0.02, y1 - 0.02):
                sphere(p, su * (hw - 0.012), y, sv * (hd - 0.012), 0.024, "chrome", segments=6, rings=4)
    # Lid seam: a raised aluminium tongue band all round.
    box(p, 0, ls, 0, W + 0.008, 0.022, D + 0.008, "applianceSteel", bev=0.004)
    # Butterfly latches: two each on front and back, one on each end.
    for sv in (-1, 1):
        for cu in (-0.36, 0.36):
            _latch(p, cu, ls, sv * (hd + 0.004), "v")
    for su in (-1, 1):
        _latch(p, su * (hw + 0.004), ls, 0, "u")
        # Recessed spring handle: dish plate and a bar.
        box(p, su * (hw + 0.003), 0.58, 0, 0.006, 0.12, 0.22, "applianceSteel", bev=0.0)
        decal(p, su * (hw + 0.0065), 0.585, 0, 0.16, 0.06, "slotDark", face="u" if su > 0 else "-u")
        box(p, su * (hw + 0.012), 0.6, 0, 0.012, 0.022, 0.15, "tvBlack", bev=0.004)
    # Stencil plate and a strip of gaffer tape on the front.
    decal(p, -0.24, 0.6, hd + 0.003, 0.3, 0.12, "paperWhite")
    decal(p, 0.22, 0.42, hd + 0.003, 0.36, 0.05, "woodMid", rot=(0, R(4), 0))
    proxies(p, PROXIES["road_case"])


MODELS = [
    dict(kind="ghost_light", build=m_ghost_light, kind_key="PROP_GHOST_LIGHT", cls="B",
         dims=(0.5, 0.5), height=1.9, tier="large"),
    dict(kind="prompt_desk", build=m_prompt_desk, kind_key="PROP_PROMPT_DESK", cls="B",
         dims=(1.1, 0.6), height=1.25, tier="large"),
    dict(kind="seat_row", build=m_seat_row, kind_key="PROP_SEAT_ROW", cls="B",
         dims=(2.0, 0.75), height=0.95, tier="large"),
    dict(kind="road_case", build=m_road_case, kind_key="PROP_ROAD_CASE", cls="B",
         dims=(1.2, 0.6), height=1.0, tier="large"),
]
