# Yellow Rooms — terminal pack (map 08, airport terminal): the gate podium,
# 3-seat beam seating and a departures-screen (FIDS) totem as class B props,
# built by build_pack.py (`npm run build:pack -- terminal`) into
# public/models/terminal/. Ids, dims and heights are the registry's
# (src/world/props/packs/terminal.js); the proxies below are mirrored there.
#
# Frame: game local (u right, y up, v front), origin at the footprint centre
# on the floor, front (the passenger side) toward +v.
#
# Look: one airport livery across the pack (cool grey lacquer, a deep airline
# blue, satin aluminium), painted per-vertex like the furniture. The FIDS
# screens and the reader LED keep_bright: they are the only "lit" parts, and
# the boards carry generic rows of light bars, never text.

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
REUSED = ("chrome", "applianceSteel", "counterTop", "slotDark", "keyDark", "screen", "ledGreen",
          "tvBlack")

NODE_PREFIX = "terminal_"
BUDGET = dict(tris=20_000, bytes=650_000)
PALETTE = {k: (PAL[k], 0.85 if k in METAL_KEYS else 0.0, 0.32 if k in METAL_KEYS else 0.78)
           for k in REUSED}
# New keys; their runtime surfaces live in the pack data module.
PALETTE.update({
    "gateShell": ((0.56, 0.58, 0.6), 0.0, 0.4),        # livery lacquer (podium, totem)
    "airlineBlue": ((0.08, 0.2, 0.46), 0.0, 0.42),     # brand band / logo panel
    "beamSeatShell": ((0.17, 0.24, 0.34), 0.0, 0.48),  # moulded polypropylene seats
    "fidsScreen": ((0.03, 0.07, 0.18), 0.0, 0.1),      # lit board background
    "fidsBar": ((0.86, 0.88, 0.9), 0.0, 0.25),         # white rows (times, places)
    "fidsAmber": ((0.95, 0.62, 0.12), 0.0, 0.25),      # status column, header strip
})
KEEP_BRIGHT = {"ledGreen", "fidsScreen", "fidsBar", "fidsAmber"}


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


def prism(p, outline, lo, hi, key, axis="y", bev=0.0, seg=None):
    """Closed straight extrusion. axis y: outline (u, v), extruded y lo..hi;
    axis u: outline (v, y), extruded along u; axis v: outline (u, y), along v."""
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
    obj = make_mesh(p, "prism", verts, faces, key, shading="weighted")
    return _bevel(obj, bev, seg) if bev > 0 else obj


def proxies(p, boxes):
    """occ_A / occ_B markers from (u0, u1, v0, v1, y0, y1, t) records."""
    for name, (u0, u1, v0, v1, y0, y1, t) in zip(("occ_A", "occ_B"), boxes):
        marker(p, name, (u0 + u1) / 2, (y0 + y1) / 2, (v0 + v1) / 2, u1 - u0, y1 - y0, v1 - v0, t=t)


# Shadow proxies, (u0, u1, v0, v1, y0, y1, t) per box, A first. Mirrored by
# src/world/props/packs/terminal.js (prop-models.test.js fits them to the GLBs).
PROXIES = {
    "gate_podium": [(-0.9, 0.9, -0.39, 0.4, 0, 0.95, 0), (-0.9, 0.9, 0.03, 0.4, 0.95, 1.1, 0)],
    "beam_seat": [(-0.95, 0.95, -0.215, 0.23, 0.32, 0.655, 0), (-0.95, 0.95, -0.26, -0.2, 0.495, 0.83, 0)],
    "fids": [(-0.65, 0.65, -0.07, 0.07, 0.6, 2.04, 0), (-0.42, 0.42, -0.17, 0.17, 0, 0.6, 0)],
}


# --- Gate podium ---------------------------------------------------------------------
# Passenger side (+v): a tall ledge with the boarding-pass reader and a dark
# info screen in the fascia over the airline band. Agent side (-v): a lower
# work surface with a monitor sunk at a slant against the ledge.

def m_gate_podium(p):
    # Recessed plinth, then the lacquered body with rounded passenger corners.
    box(p, 0, 0.045, -0.01, 1.66, 0.09, 0.6, "slotDark", bev=0.0)
    prism(p, rrect(-0.88, 0.88, -0.36, 0.36, 0.05, 0.15, n=4), 0.08, 0.925, "gateShell", bev=0.012)
    # Raised passenger ledge and its counter cap.
    prism(p, rrect(-0.88, 0.88, 0.04, 0.36, 0.0, 0.15, n=4), 0.91, 1.065, "gateShell")
    prism(p, rrect(-0.905, 0.905, 0.025, 0.395, 0.02, 0.17, n=4), 1.06, 1.095, "counterTop", bev=0.01)
    # Agent work surface (rear), dipped into the body so no faces coincide.
    prism(p, rrect(-0.895, 0.895, -0.39, 0.06, 0.05, 0.0, n=3), 0.915, 0.95, "counterTop", bev=0.008)
    # Front fascia: dark info screen in a bezel, logo panel, airline band.
    fv = 0.36
    box(p, -0.33, 0.7, fv + 0.008, 0.7, 0.4, 0.016, "keyDark", bev=0.006)
    decal(p, -0.33, 0.7, fv + 0.0185, 0.64, 0.34, "screen")
    box(p, 0.4, 0.7, fv + 0.006, 0.5, 0.4, 0.012, "airlineBlue", bev=0.0)
    cyl(p, 0.4, 0.72, fv + 0.0135, 0.09, 0.005, "gateShell", axis="v", verts=12)
    decal(p, 0.4, 0.72, fv + 0.0185, 0.022, 0.15, "airlineBlue", rot=(0, R(-35), 0))
    box(p, 0, 0.3, fv + 0.006, 1.42, 0.12, 0.012, "airlineBlue", bev=0.0)
    decal(p, 0, 0.385, fv + 0.0035, 1.42, 0.02, "counterTop")
    # Boarding-pass reader on the ledge: slanted dark-glass pad, green LED.
    rv, ru = 0.24, 0.52
    box(p, ru, 1.112, rv, 0.2, 0.034, 0.17, "keyDark", bev=0.01)
    tilt = (R(14), 0, 0)
    box(p, ru, 1.118, rv - 0.01, 0.17, 0.02, 0.13, "keyDark", bev=0.006, rot=tilt)
    decal(p, ru, 1.1292, rv - 0.0072, 0.13, 0.095, "screen", face="y", rot=tilt)
    decal(p, ru, 1.112, rv + 0.088, 0.12, 0.012, "ledGreen")
    # Agent monitor sunk at a slant (screen up and toward -v) on the work top.
    th = R(-24)
    box(p, -0.22, 1.02, -0.12, 0.5, 0.03, 0.3, "keyDark", bev=0.008, rot=(th, 0, 0))
    off = 0.0165
    decal(p, -0.22, 1.02 + off * math.cos(th), -0.12 + off * math.sin(th), 0.44, 0.24, "screen",
          face="y", rot=(th, 0, 0))
    # Keyboard and a paper tray on the work surface.
    box(p, -0.2, 0.958, -0.315, 0.4, 0.016, 0.12, "keyDark", bev=0.0)
    box(p, 0.45, 0.966, -0.2, 0.3, 0.032, 0.22, "slotDark", bev=0.0)
    # Agent side: drawer pedestal fronts and a cable grommet.
    for y in (0.72, 0.46, 0.22):
        box(p, 0.55, y, -0.364, 0.46, 0.22 if y > 0.3 else 0.24, 0.012, "gateShell", bev=0.0)
        box(p, 0.55, y + 0.07, -0.374, 0.16, 0.016, 0.014, "applianceSteel", bev=0.0)
    decal(p, -0.25, 0.5, -0.3635, 1.0, 0.7, "slotDark", rot=(0, 0, R(180)))
    proxies(p, PROXIES["gate_podium"])


# --- Beam seating ----------------------------------------------------------------------
# Three moulded shells on a chrome beam, divided by solid cast-aluminium arm
# plates with black pads; two T-legs. The arm plates keep the side silhouette
# solid between seat and armrest (one proxy box holds it).

SEAT_PATH = [(0.27, 0.392), (0.252, 0.438), (0.19, 0.452), (0.0, 0.445), (-0.15, 0.448),
             (-0.215, 0.49), (-0.235, 0.6), (-0.25, 0.72), (-0.265, 0.828)]


def _shell(p, cu, half):
    """One moulded seat: a thick swept profile, dished pan, wrapped back."""
    def wave(a, s, y, i):
        x = (a - cu) / half
        if i <= 4:
            return 0.0, -0.012 * (1 - x * x)          # pan dish
        return 0.025 * x * x * max(0.0, min(1.0, (y - 0.47) / 0.25)), 0.0  # back wraps forward
    obj = ribbon(p, SEAT_PATH, 0.036, cu - half, cu + half, "beamSeatShell", plane="vy", segs=3,
                 wave=wave)
    _bevel(obj, 0.008)
    smooth_by_angle(obj, angle=0.6)
    return obj


ARM = [(0.245, 0.43), (0.245, 0.6), (0.21, 0.635), (-0.2, 0.635), (-0.215, 0.6), (-0.215, 0.36),
       (-0.06, 0.305), (0.02, 0.305), (0.2, 0.36)]


def m_beam_seat(p):
    # Beam: a chrome box section the shells and arm plates bolt onto.
    box(p, 0, 0.3375, -0.02, 1.86, 0.075, 0.09, "chrome", bev=0.012)
    for cu in (-0.62, 0.0, 0.62):
        _shell(p, cu, 0.268)
        box(p, cu, 0.395, -0.02, 0.26, 0.045, 0.2, "slotDark", bev=0.0)  # seat bracket
    for au in (-0.93, -0.31, 0.31, 0.93):
        prism(p, ARM, au - 0.02, au + 0.02, "applianceSteel", axis="u", bev=0.01)
        box(p, au, 0.645, 0.02, 0.06, 0.03, 0.44, "keyDark", bev=0.01)
    # T-legs: post, sled foot, glides.
    for lu in (-0.62, 0.62):
        box(p, lu, 0.165, -0.02, 0.055, 0.31, 0.055, "chrome", bev=0.01)
        box(p, lu, 0.034, -0.02, 0.06, 0.03, 0.34, "chrome", bev=0.01)
        for gv in (-0.17, 0.13):
            cyl(p, lu, 0.0095, gv, 0.024, 0.019, "keyDark", verts=8)
    proxies(p, PROXIES["beam_seat"])


# --- Departures screen totem -----------------------------------------------------------
# Livery housing with two stacked landscape boards on a ballasted plinth. Each
# board: a header strip, then rows of white bars (time, place, flight) and a
# status bar, lengths from a fixed LCG so rebuilds are byte-identical.

def _board(p, cy, w, h, fv, rnd):
    box(p, 0, cy, fv + 0.006, w + 0.06, h + 0.06, 0.012, "tvBlack", bev=0.005)
    decal(p, 0, cy, fv + 0.0145, w, h, "fidsScreen")
    top = cy + h / 2
    decal(p, 0, top - 0.035, fv + 0.017, w - 0.04, 0.05, "airlineBlue")
    decal(p, -w / 2 + 0.09, top - 0.035, fv + 0.0195, 0.1, 0.02, "fidsAmber")
    rows = 7
    pitch = (h - 0.1) / rows
    for r in range(rows):
        y = top - 0.085 - pitch * (r + 0.5) + 0.01
        x = -w / 2 + 0.03
        for col, (lo, hi, key) in enumerate(((0.08, 0.1, "fidsBar"), (0.24, 0.42, "fidsBar"),
                                             (0.1, 0.14, "fidsBar"), (0.1, 0.16, "fidsAmber"))):
            ln = lo + (hi - lo) * rnd()
            slot = (0.12, 0.48, 0.2, 0.2)[col]
            if col == 3:
                key = "ledGreen" if rnd() < 0.3 else "fidsAmber"
            decal(p, x + ln / 2, y, fv + 0.017, ln, 0.026, key)
            x += slot + 0.03


def m_fids(p):
    rnd = lcg(0x08A1)
    # Plinth: kick, lacquered cabinet with a vent band, cap slab.
    box(p, 0, 0.025, 0, 0.78, 0.05, 0.28, "slotDark", bev=0.008)
    prism(p, rrect(-0.42, 0.42, -0.17, 0.17, 0.05, 0.05, n=3), 0.045, 0.56, "gateShell", bev=0.012)
    decal(p, 0, 0.14, 0.1735, 0.6, 0.05, "slotDark")
    box(p, 0, 0.58, 0, 0.6, 0.05, 0.1, "keyDark", bev=0.008)  # collar
    # Housing (rounded in the u-y plane), header cap and the two boards.
    prism(p, rrect(-0.65, 0.65, 0.6, 2.04, 0.03, 0.06, n=4), -0.065, 0.065, "gateShell", axis="v",
          bev=0.012)
    fv = 0.065
    box(p, 0, 1.985, fv + 0.004, 1.2, 0.05, 0.008, "airlineBlue", bev=0.003)
    _board(p, 1.625, 1.16, 0.58, fv, rnd)
    _board(p, 0.955, 1.16, 0.58, fv, rnd)
    # Back: service hatch seams and vents.
    decal(p, 0, 1.3, -0.0685, 1.0, 1.1, "slotDark", rot=(0, 0, R(180)))
    decal(p, 0, 1.3, -0.0705, 0.96, 1.06, "gateShell", rot=(0, 0, R(180)))
    for i in range(4):
        decal(p, 0, 1.9 - i * 0.03, -0.0725, 0.5, 0.012, "slotDark", rot=(0, 0, R(180)))
    proxies(p, PROXIES["fids"])


MODELS = [
    dict(kind="gate_podium", build=m_gate_podium, kind_key="PROP_GATE_PODIUM", cls="B",
         dims=(1.8, 0.8), height=1.1, tier="detailed"),
    dict(kind="beam_seat", build=m_beam_seat, kind_key="PROP_BEAM_SEAT", cls="B",
         dims=(1.95, 0.7), height=0.85, tier="large"),
    dict(kind="fids", build=m_fids, kind_key="PROP_FIDS", cls="B",
         dims=(1.3, 0.45), height=2.05, tier="detailed"),
]
