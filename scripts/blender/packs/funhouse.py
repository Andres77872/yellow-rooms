# Yellow Rooms — funhouse pack (map 12, funhouse): the security booth's CCTV
# monitor desk and a ball-and-track marble toy on a small table, the class B
# props of src/world/props/packs/funhouse.js, built by build_pack.py
# (`npm run build:pack -- funhouse`) into public/models/funhouse/. Ids, dims
# and heights are the registry's (maps spec §6); the proxies below are
# mirrored there.
#
# Frame: game local (u right, y up, v front), origin at the footprint centre
# on the floor, front toward +v (the guard's side of the desk, the player's
# side of the marble run), back against the wall.
#
# Look: the funhouse floor is saturated neon, so the toy carries the pack's
# loud primaries (red and blue tracks on a yellow board, chrome balls) while
# the booth stays drab office steel; its screens keep_bright and are the
# only "lit" parts. Doc 17 classes the CCTV monitor E (render-to-texture,
# "the only true view of the Ames room"): the main screen carries a screen
# socket (marker only, no consumer yet). The ball track is the tilt tell:
# ramps, a spirit level on the table and the lift all read a slope.

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
REUSED = ("cabinetPaint", "copierBody", "laminate", "rackFace", "tvBlack", "keyDark", "slotDark",
          "chrome", "applianceSteel", "ledGreen", "paperWhite", "bookBlue", "bookRed", "porcelain",
          "woodMid", "woodDark", "bottleBlue")

NODE_PREFIX = "funhouse_"
# These two props' share of map 12's ~12,700-tri static pack
# (17-asset-manifest.md). The doc's own guesses (~150 tris for the CCTV
# fixture, ~900 for the ball track and its siblings) predate the painted
# detail both need to read at booth distance; each stays in the large tier.
BUDGET = dict(tris=3_500, bytes=130_000)
PALETTE = {k: (PAL[k], 0.85 if k in METAL_KEYS else 0.0, 0.32 if k in METAL_KEYS else 0.78)
           for k in REUSED}
# New keys; their runtime surfaces live in the pack data module.
PALETTE.update({
    "cctvScreen": ((0.5, 0.78, 0.7), 0.0, 0.1),     # phosphor glow (lit)
    "cctvImage": ((0.15, 0.3, 0.25), 0.0, 0.1),    # dim camera picture on the glow (lit)
    "recRed": ((0.95, 0.06, 0.04), 0.0, 0.3),       # REC lamp (lit)
    "funRed": ((0.72, 0.035, 0.03), 0.0, 0.4),      # toy enamel
    "funYellow": ((0.92, 0.6, 0.04), 0.0, 0.45),
    "funBlue": ((0.03, 0.14, 0.62), 0.0, 0.4),
})
KEEP_BRIGHT = {"cctvScreen", "cctvImage", "recRed", "ledGreen"}


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


def plate(p, outline, v, key):
    """Flat n-gon facing +v at depth v (outline in (u, y)): a screen face."""
    verts = [G(a, b, v) for a, b in outline]
    return make_mesh(p, "plate", verts, [tuple(range(len(verts)))], key, shading="flat", recalc=False)


def frustum(p, cu, cy, v_front, v_back, front, back, key, bev=0.0):
    """Closed tapered block along v: (half-u, half-y) rectangles `front` at
    v_front and `back` at v_back (a CRT's neck housing)."""
    verts = []
    for v, (a, b) in ((v_front, front), (v_back, back)):
        verts += [G(cu - a, cy - b, v), G(cu + a, cy - b, v), G(cu + a, cy + b, v), G(cu - a, cy + b, v)]
    faces = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
    obj = make_mesh(p, "frustum", verts, faces, key, shading="weighted")
    return _bevel(obj, bev) if bev > 0 else obj


def proxies(p, boxes):
    """occ_A / occ_B markers from (u0, u1, v0, v1, y0, y1, t) records."""
    for name, (u0, u1, v0, v1, y0, y1, t) in zip(("occ_A", "occ_B"), boxes):
        marker(p, name, (u0 + u1) / 2, (y0 + y1) / 2, (v0 + v1) / 2, u1 - u0, y1 - y0, v1 - v0, t=t)


# Shadow proxies, (u0, u1, v0, v1, y0, y1, t) per box, A first. Mirrored by
# src/world/props/packs/funhouse.js (prop-models.test.js fits them to the GLBs).
PROXIES = {
    "cctv": [(-0.4, 0.4, -0.275, 0.275, 0.0, 0.755, 0), (-0.29, 0.15, -0.27, 0.12, 0.755, 1.395, 0)],
    "ball_track": [(-0.5, 0.5, -0.3, 0.3, 0.0, 0.54, 0), (-0.46, 0.46, -0.29, -0.07, 0.54, 1.18, 0)],
}


# --- CCTV monitor desk ------------------------------------------------------------------
# A grey steel office desk (end panel, kneehole with a modesty panel, a
# three-drawer pedestal) carrying the booth's monitor stack: a time-lapse
# VCR, a 14" CRT in a metal case showing a four-camera split, and a 9"
# spot monitor on top. A PTZ joystick keyboard, the guard's open logbook
# and a mug sit in front; the cable loom drops down the back.

def _screen(p, cu, cy, v, w, h, quad, rnd):
    """Bezel surround, phosphor face and the camera picture: dim corridor
    floors in perspective (one per quadrant on a split screen)."""
    plate(p, rrect(cu - w / 2 - 0.018, cu + w / 2 + 0.018, cy - h / 2 - 0.018, cy + h / 2 + 0.018,
                   0.02, 0.02, n=2), v, "tvBlack")
    plate(p, rrect(cu - w / 2, cu + w / 2, cy - h / 2, cy + h / 2, 0.014, 0.014, n=2), v + 0.002,
          "cctvScreen")
    cells = ((-1, -1), (1, -1), (-1, 1), (1, 1)) if quad else ((0, 0),)
    cw, ch = (w / 2, h / 2) if quad else (w, h)
    for su, sy in cells:
        qu, qy = cu + su * cw / 2, cy + sy * ch / 2
        # A room seen from a high corner camera: the floor below a slanted
        # skirting line, a dark doorway standing on it, a time-stamp strip.
        side = 1 if rnd() < 0.5 else -1
        y_lo, y_hi = qy - ch * (0.08 + 0.12 * rnd()), qy + ch * (0.05 + 0.1 * rnd())
        yl, yr = (y_hi, y_lo) if side > 0 else (y_lo, y_hi)
        verts = [G(qu - cw * 0.46, qy - ch * 0.46, v + 0.004), G(qu + cw * 0.46, qy - ch * 0.46, v + 0.004),
                 G(qu + cw * 0.46, yr, v + 0.004), G(qu - cw * 0.46, yl, v + 0.004)]
        make_mesh(p, "floor", verts, [(0, 1, 2, 3)], "cctvImage", shading="flat", recalc=False)
        du = qu - side * cw * 0.22
        dy = yl + (yr - yl) * (du - (qu - cw * 0.46)) / (cw * 0.92)
        decal(p, du, dy + ch * 0.17, v + 0.0045, cw * 0.17, ch * 0.34, "cctvImage")
        decal(p, qu - cw * 0.2, qy + ch * 0.38, v + 0.004, cw * 0.42, ch * 0.05, "cctvImage")
    if quad:
        decal(p, cu, cy, v + 0.005, w, 0.006, "tvBlack")
        decal(p, cu, cy, v + 0.005, 0.006, h, "tvBlack")


def m_cctv(p):
    rnd = lcg(0x0CA1)
    W, D, top = 0.8, 0.55, 0.755
    hw, hd = W / 2, D / 2
    # Desk top: laminate on a steel frame.
    box(p, 0, top - 0.015, 0, W, 0.03, D, "laminate", bev=0.008)
    box(p, 0, top - 0.04, 0, W - 0.03, 0.02, D - 0.03, "cabinetPaint", bev=0.0)
    # Left end panel and the modesty panel (back of the kneehole).
    box(p, -hw + 0.0125, 0.36, 0, 0.025, 0.72, D - 0.02, "cabinetPaint", bev=0.006)
    box(p, -0.17, 0.38, -hd + 0.03, 0.42, 0.62, 0.02, "cabinetPaint", bev=0.005)
    # Right pedestal: carcass on a recessed plinth, three drawers.
    pu0, pu1 = 0.02, hw
    pc = (pu0 + pu1) / 2
    box(p, pc, 0.385, -0.01, pu1 - pu0, 0.67, D - 0.02, "cabinetPaint", bev=0.006)
    box(p, pc, 0.025, -0.02, pu1 - pu0 - 0.04, 0.05, D - 0.06, "slotDark", bev=0.0)
    fv = hd - 0.02  # carcass front
    for y0, y1 in ((0.57, 0.71), (0.33, 0.56), (0.07, 0.32)):
        box(p, pc, (y0 + y1) / 2, fv + 0.007, pu1 - pu0 - 0.03, y1 - y0 - 0.012, 0.016, "copierBody",
            bev=0.005)
        box(p, pc, y1 - 0.035, fv + 0.021, 0.14, 0.018, 0.014, "applianceSteel", bev=0.0)
        decal(p, pc + 0.11, y1 - 0.035, fv + 0.018, 0.045, 0.022, "paperWhite")
    # Time-lapse VCR: cassette door, clock window, REC lamp, buttons.
    vu, vcr0, vcr1 = -0.07, top, top + 0.08
    box(p, vu, (vcr0 + vcr1) / 2, -0.06, 0.42, vcr1 - vcr0, 0.34, "rackFace", bev=0.006)
    vf = 0.11
    decal(p, vu - 0.07, vcr0 + 0.045, vf + 0.002, 0.2, 0.03, "slotDark")
    decal(p, vu + 0.12, vcr0 + 0.05, vf + 0.002, 0.09, 0.024, "tvBlack")
    decal(p, vu + 0.12, vcr0 + 0.05, vf + 0.004, 0.07, 0.014, "ledGreen")
    cyl(p, vu - 0.18, vcr0 + 0.05, vf + 0.004, 0.006, 0.006, "recRed", axis="v", verts=8)
    for i in range(5):
        decal(p, vu + 0.06 + i * 0.03, vcr0 + 0.018, vf + 0.002, 0.018, 0.01, "keyDark")
    # Main 14" monitor: metal case, rear neck housing, front bezel.
    mu, m0, m1 = vu, vcr1, vcr1 + 0.36
    mc = (m0 + m1) / 2
    box(p, mu, mc, -0.035, 0.44, m1 - m0, 0.27, "rackFace", bev=0.012)
    frustum(p, mu, mc + 0.01, -0.17, -0.265, (0.17, 0.135), (0.1, 0.085), "rackFace", bev=0.008)
    bf = 0.12
    box(p, mu, mc, bf - 0.015, 0.45, m1 - m0 + 0.01, 0.03, "keyDark", bev=0.008)
    _screen(p, mu, mc + 0.025, bf + 0.001, 0.33, 0.25, True, rnd)
    # Control strip under the screen: power LED and four knobs.
    cyl(p, mu + 0.18, m0 + 0.03, bf + 0.003, 0.006, 0.006, "ledGreen", axis="v", verts=8)
    for i in range(4):
        cyl(p, mu - 0.15 + i * 0.05, m0 + 0.03, bf + 0.006, 0.011, 0.012, "slotDark", axis="v", verts=6)
    # Rack handles on the case sides read the "metal monitor" at a distance.
    for s in (-1, 1):
        box(p, mu + s * 0.226, mc, 0.06, 0.014, 0.18, 0.02, "applianceSteel", bev=0.0)
    marker(p, "socket_screen_0", mu, mc + 0.025, bf + 0.004, yrSocket="screen", feed="cctv")
    # 9" spot monitor on top, turned a little toward the chair: built about
    # its own centre, then yawed and set on the main case.
    s0, s1 = m1 - 0.003, m1 + 0.197
    sp = []
    box(sp, 0, 0, 0, 0.27, s1 - s0, 0.22, "rackFace", bev=0.01)
    box(sp, 0, 0, 0.105, 0.275, s1 - s0 - 0.006, 0.02, "keyDark", bev=0.006)
    _screen(sp, 0, 0.012, 0.116, 0.19, 0.14, False, rnd)
    cyl(sp, 0.11, -0.075, 0.118, 0.005, 0.006, "ledGreen", axis="v", verts=8)
    _turn(sp, mu - 0.02, (s0 + s1) / 2, -0.04, R(-6))
    p.extend(sp)
    # Desk clutter: PTZ joystick keyboard, logbook and pen, a mug.
    ku, kv = 0.27, 0.12
    prism(p, [(kv - 0.075, top), (kv + 0.075, top), (kv + 0.075, top + 0.025), (kv - 0.075, top + 0.05)],
          ku - 0.1, ku + 0.1, "keyDark", axis="u", bev=0.006)
    th = math.atan2(0.025, 0.15)
    for r in range(3):
        for c in range(4):
            bu, bvv = ku - 0.085 + c * 0.024, kv + 0.045 - r * 0.028
            by = top + 0.05 - 0.025 * (bvv - (kv - 0.075)) / 0.15 + 0.002
            decal(p, bu, by, bvv, 0.016, 0.016, "slotDark" if (r + c) % 3 else "ledGreen", face="y",
                  rot=(th, 0, 0))
    cyl(p, ku + 0.055, top + 0.07, kv - 0.01, 0.006, 0.06, "chrome", verts=6)
    cyl(p, ku + 0.055, top + 0.045, kv - 0.01, 0.022, 0.012, "slotDark", verts=10)
    sphere(p, ku + 0.055, top + 0.105, kv - 0.01, 0.018, "bookRed", segments=6, rings=4)
    # Open logbook (blue cover, two page blocks) and a pen.
    lu, lv = -0.27, 0.19
    box(p, lu, top + 0.004, lv, 0.3, 0.008, 0.2, "bookBlue", bev=0.0, rot=(0, 0, R(4)))
    for s in (-1, 1):
        box(p, lu + s * 0.072, top + 0.014, lv, 0.135, 0.012, 0.185, "paperWhite", bev=0.0, rot=(0, 0, R(4)))
    cyl(p, lu + 0.03, top + 0.026, lv + 0.02, 0.004, 0.13, "keyDark", axis="u", verts=6, rot=(0, R(90), R(30)))
    # Mug, back right.
    lathe(p, 0.3, -0.16, [(0.035, 0.035, top), (0.04, 0.04, top + 0.095), (0.034, 0.034, top + 0.095),
                          (0.03, 0.03, top + 0.075)], "porcelain", segments=8)
    torus(p, 0.344, top + 0.05, -0.16, 0.02, 0.005, "porcelain", axis="v", major_seg=6, minor_seg=3)
    # Cable loom from the stack down the back of the desk.
    tube(p, [(-0.02, 1.0, -0.27), (0.04, 0.85, -0.28), (0.08, 0.6, -0.285), (0.1, 0.25, -0.285),
             (0.12, 0.02, -0.27)], 0.012, "tvBlack", seg=4, sub=2)
    proxies(p, PROXIES["cctv"])


def _turn(objs, cu, cy, cv, yaw):
    """Yaw a sub-assembly built about the origin around the vertical axis and
    move it to (cu, cy, cv). matrix_basis, not matrix_world: fresh objects
    have no evaluated world matrix yet. The driver applies it on join."""
    from mathutils import Matrix
    m = Matrix.Translation(G(cu, cy, cv)) @ Matrix.Rotation(yaw, 4, "Z")
    for o in objs:
        o.matrix_basis = m @ o.matrix_basis


# --- Ball track -----------------------------------------------------------------------------
# A wooden marble run on a small painted table: two shaped cheeks hold a
# yellow board with six red / blue ramps zig-zagging down to a catch tray;
# a crank-driven spiral lift on the right carries the chrome balls back to
# the top. The table is panelled on the sides and back (a closed shadow,
# a lower shelf with the ball crate behind the open front); a spirit level
# lies on its front edge, the tilt tell of the map.

def m_ball_track(p):
    rnd = lcg(0x0CA2)
    W, D, T = 1.0, 0.6, 0.54
    hw, hd = W / 2, D / 2
    # Table: top, legs, side and back panels, front apron, lower shelf.
    box(p, 0, T - 0.02, 0, W, 0.04, D, "woodMid", bev=0.01)
    for su in (-1, 1):
        for sv in (-1, 1):
            box(p, su * (hw - 0.03), (T - 0.04) / 2, sv * (hd - 0.03), 0.055, T - 0.04, 0.055, "funRed",
                bev=0.008)
        box(p, su * (hw - 0.03), 0.28, 0, 0.025, 0.42, D - 0.1, "funBlue", bev=0.004)
    box(p, 0, 0.28, -hd + 0.03, W - 0.1, 0.42, 0.025, "funBlue", bev=0.004)
    box(p, 0, 0.455, hd - 0.03, W - 0.1, 0.07, 0.03, "funBlue", bev=0.006)
    box(p, 0, 0.09, 0, W - 0.1, 0.025, D - 0.08, "woodMid", bev=0.004)
    # Front apron drawer pull and the ball crate on the shelf.
    box(p, 0, 0.455, hd - 0.008, 0.12, 0.02, 0.016, "applianceSteel", bev=0.0)
    box(p, -0.22, 0.155, 0.03, 0.3, 0.105, 0.24, "woodDark", bev=0.006)
    decal(p, -0.22, 0.2085, 0.03, 0.27, 0.21, "slotDark", face="y")
    for i in range(4):
        sphere(p, -0.32 + i * 0.07, 0.212, 0.03 + (rnd() - 0.5) * 0.12, 0.022, "chrome", segments=6, rings=4)
    # Spirit level on the table's front edge: yellow body, green vial.
    box(p, 0.16, T + 0.02, 0.2, 0.5, 0.04, 0.03, "funYellow", bev=0.005)
    decal(p, 0.16, T + 0.02, 0.2155, 0.07, 0.018, "slotDark")
    cyl(p, 0.16, T + 0.02, 0.217, 0.007, 0.06, "bottleBlue", axis="u", verts=8)
    # Marble run: shaped cheeks (foot forward), board, crossbar.
    V0, V1, Y1 = -0.29, -0.07, 1.15
    cheek = _cheek(V0, V1, T, Y1)
    for su in (-1, 1):
        prism(p, cheek, su * 0.445 - 0.015, su * 0.445 + 0.015, "woodMid", axis="u", bev=0.006)
    box(p, 0, 0.84, -0.26, 0.87, 0.6, 0.02, "funYellow", bev=0.004)
    box(p, 0, Y1 + 0.015, -0.18, 0.93, 0.03, 0.21, "woodMid", bev=0.008)
    # Catch tray at the foot of the board.
    box(p, 0, T + 0.012, -0.18, 0.86, 0.024, 0.15, "funBlue", bev=0.004)
    for sv in (-1, 1):
        box(p, 0, T + 0.03, -0.18 + sv * 0.07, 0.86, 0.035, 0.012, "funBlue", bev=0.0)
    for i in range(3):
        sphere(p, -0.3 + i * 0.12 + rnd() * 0.04, T + 0.042, -0.18 + (rnd() - 0.5) * 0.05, 0.018, "chrome",
               segments=6, rings=4)
    # Zig-zag ramps: U channels tilted along u, alternating colour and fall;
    # the top one takes the lift's balls at the right, the bottom one tips
    # them into the tray at the left. Each stops short at its low end so a
    # ball drops onto the next ramp's high end.
    n, yt, yb, rv = 5, 1.075, 0.655, -0.215
    for i in range(n):
        yc = yt - i * (yt - yb) / (n - 1)
        low_left = i % 2 == 0
        a, b = (-0.34, 0.32 if i == 0 else 0.3) if low_left else (-0.4, 0.24)
        cu, L = (a + b) / 2, b - a
        tilt = R(4.5) if low_left else R(-4.5)
        _ramp(p, cu, yc, rv, L, tilt, "funRed" if low_left else "funBlue")
        if i != 2:  # a ball rolling on most ramps
            bu = a + (0.2 + 0.6 * rnd()) * L
            by = yc + (bu - cu) * math.tan(tilt) + 0.011
            sphere(p, bu, by, rv, 0.018, "chrome", segments=6, rings=4)
    # Funnel where the lift tips out over the top ramp.
    lathe(p, 0.37, -0.21, [(0.012, 0.012, 1.09), (0.04, 0.04, 1.125), (0.034, 0.034, 1.125),
                            (0.01, 0.01, 1.1)], "funYellow", segments=10)
    # Spiral lift: a rod and a helical flight, chrome balls riding it.
    lu, lv, l0, l1 = 0.37, -0.21, T + 0.03, 1.09
    cyl(p, lu, (l0 + l1) / 2, lv, 0.008, l1 - l0, "chrome", verts=8)
    turns, per = 5, 6
    pts = []
    for k in range(turns * per + 1):
        ang = TAU * k / per
        y = l0 + 0.02 + (l1 - l0 - 0.04) * k / (turns * per)
        pts.append((lu + 0.034 * math.cos(ang), y, lv + 0.034 * math.sin(ang)))
    tube(p, pts, 0.0065, "applianceSteel", seg=3)
    for k in (7, 19, 27):
        ang = TAU * k / per
        y = l0 + 0.02 + (l1 - l0 - 0.04) * k / (turns * per) + 0.02
        sphere(p, lu + 0.034 * math.cos(ang), y, lv + 0.034 * math.sin(ang), 0.016, "chrome", segments=6,
               rings=4)
    # Crank on the right cheek: hub, arm, handle.
    cu = 0.445 + 0.015
    cyl(p, cu + 0.012, 0.92, -0.2, 0.025, 0.024, "funYellow", axis="u", verts=10)
    box(p, cu + 0.03, 0.88, -0.2, 0.014, 0.1, 0.03, "funRed", bev=0.004)
    cyl(p, cu + 0.05, 0.84, -0.2, 0.012, 0.05, "woodDark", axis="u", verts=8)
    proxies(p, PROXIES["ball_track"])


def _cheek(v0, v1, y0, y1):
    """Marble-run cheek profile in (v, y): a foot running forward along the
    table, a sloped toe, the upright with rounded top corners."""
    top = rrect(v0, v1, y0, y1, 0.0, 0.05, n=2)
    # rrect starts at (v1, y0); keep its upper corners (after the first point).
    upper = [pt for pt in top if pt[1] > y0 + 1e-6]
    return [(v0, y0), (0.0, y0), (0.0, y0 + 0.03), (v1, y0 + 0.08)] + upper


def _ramp(p, cu, cy, cv, length, tilt, key):
    """U channel along u (floor and two lips) tilted by `tilt` about v, as
    one closed prism across u."""
    w, h, t = 0.075, 0.03, 0.008
    a, b = cv - w / 2, cv + w / 2
    outline = [(a, -h / 2), (b, -h / 2), (b, h / 2), (b - t, h / 2), (b - t, -h / 2 + t),
               (a + t, -h / 2 + t), (a + t, h / 2), (a, h / 2)]
    obj = prism(p, outline, -length / 2, length / 2, key, axis="u")
    obj.location = G(cu, cy, 0)
    obj.rotation_euler = (0, -tilt, 0)
    return obj


MODELS = [
    dict(kind="cctv", build=m_cctv, kind_key="PROP_CCTV", cls="B",
         dims=(0.8, 0.55), height=1.4, tier="large"),
    dict(kind="ball_track", build=m_ball_track, kind_key="PROP_BALL_TRACK", cls="B",
         dims=(1.0, 0.6), height=1.2, tier="large"),
]
