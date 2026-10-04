# Yellow Rooms — train pack (map 07, endless train): the longitudinal metro
# bench, a transverse seat pair and a flap ticket gate as class B props,
# built by build_pack.py (`npm run build:pack -- train`) into
# public/models/train/. Ids, dims and heights are the registry's
# (src/world/props/packs/train.js); the proxies below are mirrored there.
#
# Frame: game local (u right, y up, v front), origin at the footprint centre
# on the floor, front (the sitter / the entry end) toward +v.
#
# Look: one metro livery across the pack (warm grey moulded shells, satin
# stainless, a green line band), blue moquette with the priority seat in
# orange, painted per-vertex like the furniture. The seats sit on closed
# heater plinths, so both seating kinds keep a solid side silhouette that two
# shadow boxes hold. The gate's card reader and its go / stop lamps
# keep_bright: they are the only lit parts.

import math
import os

import bpy

from yr_kit import *  # noqa: F403  (yr_kit.__all__: primitives, R, TAU, lcg, marker, parsers)

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

# Reused furniture keys keep the furniture colour + surface (same split as
# packs/furniture.py), so a reused key never redefines yr_<key>.
PAL = parse_js_rgb_table(os.path.join(REPO, "src", "world", "objects", "furniture", "palette.js"),
                         "FURN_TINT", min_entries=40)
METAL_KEYS = {"chrome", "applianceSteel"}
REUSED = ("chrome", "applianceSteel", "slotDark", "keyDark", "screen", "ledGreen", "tvBlack",
          "paperWhite")

NODE_PREFIX = "train_"
BUDGET = dict(tris=20_000, bytes=650_000)
PALETTE = {k: (PAL[k], 0.85 if k in METAL_KEYS else 0.0, 0.32 if k in METAL_KEYS else 0.78)
           for k in REUSED}
# New keys; their runtime surfaces live in the pack data module.
PALETTE.update({
    "trainShell": ((0.6, 0.59, 0.55), 0.0, 0.45),         # moulded GRP shells, gate body
    "lineGreen": ((0.05, 0.3, 0.15), 0.0, 0.45),          # the line's livery band
    "moquette": ((0.1, 0.17, 0.36), 0.0, 0.95),           # seat cloth
    "moquettePriority": ((0.62, 0.22, 0.06), 0.0, 0.95),  # priority seat cloth
    "gateFlap": ((0.8, 0.2, 0.06), 0.0, 0.4),             # closed paddle
    "readerBlue": ((0.3, 0.62, 1.0), 0.0, 0.25),          # card target glow
    "stopRed": ((1.0, 0.16, 0.1), 0.0, 0.25),             # no-entry lamp
})
KEEP_BRIGHT = {"ledGreen", "readerBlue", "stopRed"}


# --- Local helpers ----------------------------------------------------------------

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
    if bev > 0:
        mod = obj.modifiers.new("bev", "BEVEL")
        mod.width = bev
        mod.segments = seg if seg else (2 if bev >= 0.02 else 1)
        mod.limit_method = "ANGLE"
        activate(obj)
        bpy.ops.object.modifier_apply(modifier="bev")
        weighted_normals(obj)
    return obj


def proxies(p, boxes):
    """occ_A / occ_B markers from (u0, u1, v0, v1, y0, y1, t) records."""
    for name, (u0, u1, v0, v1, y0, y1, t) in zip(("occ_A", "occ_B"), boxes):
        marker(p, name, (u0 + u1) / 2, (y0 + y1) / 2, (v0 + v1) / 2, u1 - u0, y1 - y0, v1 - v0, t=t)


def cushion(p, cu, cy, cv, su, sy, sv, key, rot=None):
    """Moquette pad: a rounded, slightly domed block."""
    return soft_box(p, cu, cy, cv, su, sy, sv, key, r=0.025, seg=2, cuts=0, rot=rot)


def heater_grille(p, cu, cy, fv, w):
    """Under-seat heater: a dark slot field crossed by stainless louvres."""
    decal(p, cu, cy, fv + 0.003, w, 0.13, "slotDark")
    for k in range(4):
        decal(p, cu, cy - 0.045 + 0.03 * k, fv + 0.005, w - 0.03, 0.012, "applianceSteel")


# Shadow proxies, (u0, u1, v0, v1, y0, y1, t) per box, A first. Mirrored by
# src/world/props/packs/train.js (prop-models.test.js fits them to the GLBs).
PROXIES = {
    "metro_bench": [(-1.05, 1.05, -0.26, 0.23, 0, 0.48, 0), (-1.03, 1.03, -0.28, -0.17, 0.48, 0.9, 0)],
    "seat_pair": [(-0.49, 0.5, -0.29, 0.3, 0, 0.49, 0), (-0.49, 0.49, -0.36, -0.2, 0.49, 1.1, 0)],
    "ticket_gate": [(-0.16, 0.08, -0.73, 0.73, 0, 1.02, 0), (0.08, 0.28, -0.02, 0.02, 0.5, 0.9, 0)],
}


# --- Metro bench -------------------------------------------------------------------------
# In-car longitudinal bench: three moquette seats on a moulded deck over a
# stainless heater plinth, a shell backrest that rises to the window line and
# tubular stainless armrests at both ends. The +u seat is the priority seat.

ARM = [(-0.24, 0.6), (0.06, 0.62), (0.15, 0.6), (0.2, 0.53), (0.21, 0.42)]


def m_metro_bench(p):
    # Plinth on a recessed toe kick; one grille per seat.
    box(p, 0, 0.03, -0.06, 1.96, 0.06, 0.36, "slotDark", bev=0.0)
    box(p, 0, 0.215, -0.04, 2.02, 0.35, 0.42, "applianceSteel", bev=0.012)
    seats = (-0.69, 0.0, 0.69)
    for cu in seats:
        heater_grille(p, cu, 0.2, 0.17, 0.5)
    # Seat deck and the backrest shell (rounded cap rolling toward the sitter).
    box(p, 0, 0.395, 0.0, 2.06, 0.035, 0.52, "trainShell", bev=0.01)
    prism(p, rrect(-0.275, -0.225, 0.4, 0.9, 0.0, 0.022, n=3), -1.03, 1.03, "trainShell",
          axis="u", bev=0.008)
    decal(p, 0, 0.85, -0.2235, 2.0, 0.03, "lineGreen")  # livery line under the cap
    for cu in seats:
        key = "moquettePriority" if cu > 0.5 else "moquette"
        cushion(p, cu, 0.445, 0.02, 0.64, 0.075, 0.47, key)
        cushion(p, cu, 0.645, -0.2, 0.62, 0.33, 0.07, key, rot=(R(-7), 0, 0))
    # Tubular armrests: from the backrest round over the seat front to the deck.
    for su in (-1.03, 1.03):
        tube(p, [(su, y, v) for v, y in ARM], 0.016, "chrome", seg=8, sub=3)
    proxies(p, PROXIES["metro_bench"])


# --- Transverse seat pair ---------------------------------------------------------------
# Commuter pair facing +v: two seats on a heater plinth, a tall raked shell
# back with white headrest covers, an aisle armrest (+u) and a stainless grab
# bar across the back's top for whoever stands behind.

TILT = R(-8)                 # backrest rake (top toward -v)
BACK = (0.0, 0.75, -0.3)     # shell centre (u, y, v)


def _on_back(dy, dv):
    """Point at (dy up, dv toward +v) in the raked shell's frame -> (y, v)."""
    s, c = math.sin(TILT), math.cos(TILT)
    return BACK[1] + dy * c - dv * s, BACK[2] + dv * c + dy * s


def m_seat_pair(p):
    box(p, 0, 0.03, -0.07, 0.86, 0.06, 0.42, "slotDark", bev=0.0)
    box(p, 0, 0.215, -0.05, 0.92, 0.35, 0.5, "applianceSteel", bev=0.012)
    heater_grille(p, 0, 0.2, 0.2, 0.7)
    box(p, 0, 0.395, 0.0, 0.98, 0.035, 0.66, "trainShell", bev=0.01)
    # Raked shell back and its pads.
    box(p, BACK[0], BACK[1], BACK[2], 0.98, 0.7, 0.07, "trainShell", bev=0.02, rot=(TILT, 0, 0))
    for cu in (-0.245, 0.245):
        cushion(p, cu, 0.455, 0.03, 0.46, 0.08, 0.58, "moquette")
        y, v = _on_back(0.0, 0.065)
        cushion(p, cu, y, v, 0.44, 0.6, 0.07, "moquette", rot=(TILT, 0, 0))
        y, v = _on_back(0.22, 0.1)
        cushion(p, cu, y, v, 0.34, 0.14, 0.025, "paperWhite", rot=(TILT, 0, 0))
    # Livery stripe and a seat-number plate on the back of the shell.
    y, v = _on_back(0.05, -0.037)
    decal(p, 0, y, v, 0.9, 0.04, "lineGreen", rot=(-TILT, 0, R(180)))
    y, v = _on_back(0.15, -0.038)
    decal(p, -0.3, y, v, 0.08, 0.04, "applianceSteel", rot=(-TILT, 0, R(180)))
    # Grab bar on stand-offs across the top rear of the shell.
    y, v = _on_back(0.28, -0.035)
    bar = [(-0.4, y, v), (-0.4, y, v - 0.06), (0.4, y, v - 0.06), (0.4, y, v)]
    tube(p, bar, 0.014, "chrome", seg=8)
    # Aisle armrest on a short post.
    box(p, 0.47, 0.62, -0.02, 0.05, 0.05, 0.4, "trainShell", bev=0.015)
    box(p, 0.47, 0.51, -0.16, 0.035, 0.18, 0.04, "applianceSteel", bev=0.008)
    proxies(p, PROXIES["seat_pair"])


# --- Ticket gate ---------------------------------------------------------------------------
# Cabinet between two passages, entry end toward +v: stainless body on a dark
# kick, green line band, dark top with the slanted card reader (blue target),
# a ticket slot and a little status screen. One closed paddle flap swings out
# of the +u flank; sensor windows line that flank. Green arrow on the entry
# end, red cross on the exit end.

GU0, GU1, GV = -0.15, 0.08, 0.72   # body u range, half length


def _sign(p, fv, key, marks, facing):
    """Lamp glyph on an end face: decal bars (du, dy, length, angle)."""
    rot_z = 0 if facing > 0 else R(180)
    cu = (GU0 + GU1) / 2
    decal(p, cu, 0.83, fv + facing * 0.003, 0.12, 0.12, "tvBlack", rot=(0, 0, rot_z))
    for du, dy, ln, ang in marks:
        decal(p, cu + du, 0.83 + dy, fv + facing * 0.005, 0.016, ln, key, rot=(0, R(ang), rot_z))


def m_ticket_gate(p):
    body = rrect(GU0, GU1, -GV, GV, 0.04, 0.04, n=3)
    prism(p, rrect(GU0 + 0.02, GU1 - 0.02, -GV + 0.02, GV - 0.02, 0.03, 0.03, n=3), 0.0, 0.07,
          "slotDark")
    prism(p, body, 0.06, 0.88, "applianceSteel", bev=0.01)
    prism(p, rrect(GU0 - 0.004, GU1 + 0.004, -GV - 0.004, GV + 0.004, 0.044, 0.044, n=3), 0.87,
          0.93, "lineGreen")
    prism(p, rrect(GU0 + 0.002, GU1 - 0.002, -GV + 0.002, GV - 0.002, 0.04, 0.04, n=3), 0.925,
          0.99, "keyDark", bev=0.012)
    cu = (GU0 + GU1) / 2
    # Card reader: slanted pad near the entry end with its glowing target.
    th = R(16)
    box(p, cu, 1.01, 0.5, 0.19, 0.05, 0.18, "trainShell", bev=0.012, rot=(th, 0, 0))
    off = 0.0265
    decal(p, cu, 1.01 + off * math.cos(th), 0.5 + off * math.sin(th), 0.13, 0.12, "readerBlue",
          face="y", rot=(th, 0, 0))
    # Ticket slot, status screen, return slot (exit end).
    decal(p, cu, 0.9915, 0.25, 0.1, 0.02, "slotDark", face="y")
    box(p, cu, 1.0, 0.05, 0.17, 0.03, 0.14, "trainShell", bev=0.008)
    decal(p, cu, 1.0165, 0.05, 0.13, 0.1, "screen", face="y")
    decal(p, cu, 1.0175, 0.07, 0.08, 0.02, "ledGreen", face="y")
    decal(p, cu, 0.9915, -0.45, 0.1, 0.02, "slotDark", face="y")
    # Flap housing, sensor windows and the closed paddle on the +u flank.
    fu = GU1 + 0.003
    decal(p, fu, 0.7, 0.0, 0.1, 0.46, "slotDark", face="u")
    for sv in (-0.42, 0.42):
        decal(p, fu, 0.72, sv, 0.4, 0.05, "tvBlack", face="u")
    flap = [(u, y) for y, u in rrect(0.5, 0.9, GU1 - 0.03, 0.28, 0.0, 0.08, n=4)]
    prism(p, flap, -0.015, 0.015, "gateFlap", axis="v", bev=0.006)
    for side in (-1, 1):
        decal(p, 0.2, 0.7, side * 0.0175, 0.1, 0.035, "paperWhite",
              rot=(0, 0, 0 if side > 0 else R(180)))
    # -u flank: service door seams.
    for sv in (-0.36, 0.36):
        decal(p, GU0 - 0.003, 0.47, sv, 0.6, 0.66, "slotDark", face="-u")
        decal(p, GU0 - 0.005, 0.47, sv, 0.58, 0.64, "applianceSteel", face="-u")
    # Go arrow (entry end) and stop cross (exit end).
    _sign(p, GV, "ledGreen", [(0, -0.015, 0.08, 0), (-0.018, 0.012, 0.05, 45), (0.018, 0.012, 0.05, -45)], 1)
    _sign(p, -GV, "stopRed", [(0, 0, 0.1, 45), (0, 0, 0.1, -45)], -1)
    proxies(p, PROXIES["ticket_gate"])


MODELS = [
    dict(kind="metro_bench", build=m_metro_bench, kind_key="PROP_METRO_BENCH", cls="B",
         dims=(2.1, 0.55), height=0.9, tier="large"),
    dict(kind="seat_pair", build=m_seat_pair, kind_key="PROP_SEAT_PAIR", cls="B",
         dims=(1.0, 0.75), height=1.1, tier="large"),
    dict(kind="ticket_gate", build=m_ticket_gate, kind_key="PROP_TICKET_GATE", cls="B",
         dims=(0.3, 1.5), height=1.05, tier="detailed"),
]
