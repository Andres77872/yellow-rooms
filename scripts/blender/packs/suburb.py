# Yellow Rooms — suburb pack (map 03, sleeping suburb): the four class-B yard
# props of the night street, built by build_pack.py
# (`npm run build:pack -- suburb`) into public/models/suburb/.
#
# Registry: src/world/props/packs/suburb.js (ids, dims, heights, the box
# fallback and the lamp-shadow proxies, whose numbers PROXIES below repeats so
# the manifest carries the same boxes). Front faces +v (FACING.S).
#
# Art direction: domestic and slightly worn, readable at 3-6 m under a single
# ceiling tube. Each prop keeps one strong silhouette cue — the raised flag,
# the two wheels and the riser bar, the pointed hat, the gable and its dark
# doorway — and a bright accent colour against the cool night grade. Paint
# carries the wear (yr_shading.paint); no textures.

import math

import bpy

from yr_kit import *  # noqa: F403  (yr_kit.__all__: primitives, R, TAU, lcg, marker, ...)

NODE_PREFIX = "suburb_"
# 17-asset-manifest.md "03 Sleeping Suburb": the whole map's static set is
# about 7,500 triangles / 300 KB; these four props take a small share of it.
BUDGET = dict(tris=7_500, bytes=300_000)

# key -> (linear rgb, metallic, roughness). Furniture keys keep the furniture
# pack's colours and split (src/world/objects/furniture/palette.js FURN_TINT);
# the new keys' runtime surfaces live in the data module's `surfaces`.
PALETTE = {
    # furniture vocabulary
    "woodMid": ((0.55, 0.43, 0.3), 0.0, 0.78),
    "woodDark": ((0.38, 0.29, 0.2), 0.0, 0.78),
    "keyDark": ((0.16, 0.16, 0.17), 0.0, 0.78),
    "slotDark": ((0.14, 0.14, 0.15), 0.0, 0.78),
    "chrome": ((0.75, 0.78, 0.8), 0.85, 0.32),
    "paperWhite": ((0.9, 0.88, 0.8), 0.0, 0.78),
    "porcelain": ((0.92, 0.93, 0.92), 0.0, 0.78),
    # suburb
    "mailboxSteel": ((0.22, 0.3, 0.42), 0.35, 0.5),
    "mailFlag": ((0.78, 0.1, 0.05), 0.0, 0.5),
    "bikeTeal": ((0.06, 0.42, 0.46), 0.3, 0.38),
    "bikePlastic": ((0.86, 0.85, 0.8), 0.0, 0.5),
    "gnomeRed": ((0.72, 0.09, 0.06), 0.0, 0.38),
    "gnomeBlue": ((0.12, 0.24, 0.55), 0.0, 0.42),
    "gnomeSkin": ((0.86, 0.6, 0.47), 0.0, 0.45),
    "gnomeStone": ((0.5, 0.49, 0.46), 0.0, 0.92),
    "kennelRed": ((0.42, 0.12, 0.08), 0.0, 0.82),
    "roofShingle": ((0.17, 0.18, 0.2), 0.0, 0.92),
}
KEEP_BRIGHT = set()  # nothing here glows

# occ_A / occ_B lamp-shadow boxes (u0, u1, v0, v1, y0, y1, t), the same
# numbers as the data module's `proxies` (fitted to these GLBs with the
# prop-models IoU harness). The bike is a frame: two boxes hold about half of
# its silhouette whatever their size (see the data module).
PROXIES = {
    "mailbox": [(-0.1, 0.1, -0.24, 0.252, 0.9, 1.14, 0), (-0.045, 0.045, -0.105, -0.015, 0.0, 0.9, 0)],
    "kids_bike": [(-0.035, 0.05, -0.57, 0.57, 0.0, 0.6, 0), (-0.22, 0.22, 0.1, 0.13, 0.64, 0.71, 0)],
    "gnome": [(-0.12, 0.12, -0.1, 0.12, 0.0, 0.3, 0), (-0.06, 0.06, -0.06, 0.04, 0.3, 0.41, 0)],
    "doghouse": [(-0.44, 0.44, -0.55, 0.55, 0.56, 0.94, 0), (-0.38, 0.38, -0.46, 0.45, 0.05, 0.6, 0)],
}


# --- Local solids ------------------------------------------------------------

def _bevel(obj, width, seg=1):
    """Chamfer a make_mesh solid like finish() does for primitives."""
    mod = obj.modifiers.new("bev", "BEVEL")
    mod.width = width
    mod.segments = seg
    mod.limit_method = "ANGLE"
    activate(obj)
    bpy.ops.object.modifier_apply(modifier="bev")
    weighted_normals(obj)
    return obj


def prism_v(p, prof, v0, v1, key, bev=0.0):
    """Closed solid: the (u, y) outline `prof` (convex, any winding)
    extruded along v from v0 to v1."""
    n = len(prof)
    verts = [G(u, y, v0) for u, y in prof] + [G(u, y, v1) for u, y in prof]
    faces = [tuple(range(n)), tuple(range(n, 2 * n))]
    faces += [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    obj = make_mesh(p, "prism", verts, faces, key, shading="weighted" if not bev else "flat")
    return _bevel(obj, bev) if bev else obj


def _ray_hit(c, ang, poly):
    """First crossing of the ray from c at angle `ang` with the closed polyline."""
    du, dy = math.cos(ang), math.sin(ang)
    best = None
    for i in range(len(poly)):
        (au, ay), (bu, by) = poly[i], poly[(i + 1) % len(poly)]
        eu, ey = bu - au, by - ay
        den = du * ey - dy * eu
        if abs(den) < 1e-12:
            continue
        t = ((au - c[0]) * ey - (ay - c[1]) * eu) / den
        s = ((au - c[0]) * dy - (ay - c[1]) * du) / den
        if t > 1e-9 and -1e-9 <= s <= 1 + 1e-9 and (best is None or t < best):
            best = t
    return (c[0] + du * best, c[1] + dy * best)


def frame_panel(p, outer, inner, centre, v0, v1, key, bev=0.0):
    """Closed slab between v0 and v1: the convex outline `outer` with the
    convex hole `inner` cut through it (a doorway in a gable board). Both
    outlines are resampled on shared rays from `centre` (inside the hole) so
    the ring is a clean band of quads; every corner of either outline keeps
    its own ray."""
    angs = sorted({round(math.atan2(y - centre[1], u - centre[0]) % TAU, 9) for u, y in outer + inner})
    o = [_ray_hit(centre, a, outer) for a in angs]
    i = [_ray_hit(centre, a, inner) for a in angs]
    n = len(angs)
    verts = ([G(u, y, v1) for u, y in o] + [G(u, y, v1) for u, y in i]
             + [G(u, y, v0) for u, y in o] + [G(u, y, v0) for u, y in i])
    OF, IF, OB, IB = 0, n, 2 * n, 3 * n
    faces = []
    for k in range(n):
        j = (k + 1) % n
        faces.append((OF + k, OF + j, IF + j, IF + k))   # front band
        faces.append((OB + k, IB + k, IB + j, OB + j))   # back band
        faces.append((IF + k, IF + j, IB + j, IB + k))   # doorway jamb
        faces.append((OF + k, OB + k, OB + j, OF + j))   # outer rim
    obj = make_mesh(p, "frame_panel", verts, faces, key, shading="weighted" if not bev else "flat")
    return _bevel(obj, bev) if bev else obj


def arch(hw, y0, yc, seg=8):
    """Round-headed opening outline: straight jambs from y0 up to the spring
    line yc, a half circle of radius hw above it (counter-clockwise)."""
    pts = [(-hw, y0), (hw, y0)]
    pts += [(hw * math.cos(math.pi * k / seg), yc + hw * math.sin(math.pi * k / seg)) for k in range(seg + 1)]
    return pts


# --- Mailbox on post -------------------------------------------------------------

def m_mailbox(p):
    # Rural mailbox: round-topped steel box on a support board, the red flag
    # raised on its right flank (mail waiting that nobody collects).
    BOT, HW, SIDE, V0, V1 = 0.92, 0.1, 0.12, -0.24, 0.24
    shell = [(-HW, BOT), (HW, BOT)] + [(HW * math.cos(math.pi * k / 8), BOT + SIDE + HW * math.sin(math.pi * k / 8))
                                       for k in range(9)]
    prism_v(p, shell, V0, V1, "mailboxSteel")
    # Door: a slightly larger lid plate with a rolled lip and a pull tab.
    lid = [(-HW - 0.006, BOT - 0.004), (HW + 0.006, BOT - 0.004)] + [
        ((HW + 0.006) * math.cos(math.pi * k / 8), BOT + SIDE + (HW + 0.006) * math.sin(math.pi * k / 8))
        for k in range(9)]
    prism_v(p, lid, V1, V1 + 0.012, "mailboxSteel")
    box(p, 0, BOT + SIDE + 0.07, V1 + 0.018, 0.05, 0.022, 0.014, "chrome", bev=0.0)
    # House number plate on the left flank.
    decal(p, -HW - 0.003, BOT + 0.075, 0.03, 0.22, 0.07, "paperWhite", face="-u")
    for k in range(3):
        decal(p, -HW - 0.005, BOT + 0.075, -0.045 + k * 0.06, 0.03, 0.05, "keyDark", face="-u")
    # Flag: pivot boss, raised arm, flag blade pointing forward.
    cyl(p, HW + 0.012, BOT + 0.07, -0.13, 0.018, 0.024, "chrome", axis="u", verts=8)
    box(p, HW + 0.02, BOT + 0.15, -0.13, 0.012, 0.19, 0.026, "mailFlag", bev=0.004)
    box(p, HW + 0.02, BOT + 0.225, -0.075, 0.012, 0.09, 0.13, "mailFlag", bev=0.0)
    # Support board, square post with a chamfered cap line, front brace.
    box(p, 0, BOT - 0.016, -0.01, 0.16, 0.032, 0.46, "woodMid", bev=0.006)
    box(p, 0, (BOT - 0.032) / 2, -0.06, 0.09, BOT - 0.032, 0.09, "woodMid", bev=0.012)
    box(p, 0, 0.8, 0.075, 0.04, 0.25, 0.035, "woodMid", bev=0.0, rot=(R(45), 0, 0))
    # Lawn-worn dark foot where the post meets the ground.
    box(p, 0, 0.04, -0.06, 0.1, 0.08, 0.1, "woodDark", bev=0.0)


# --- Kid's bike --------------------------------------------------------------------

WHEEL_R, TYRE_R, AXLE_Y, AXLE_V = 0.2, 0.026, 0.2, 0.37


def _wheel(p, v, n=16):
    # Fat tyre (flat tread, flat sidewalls: a square-section ring reads as
    # rubber where a 4-sided torus reads as a diamond) round a white plastic
    # mag disc that reads solid at a distance.
    r0, r1, hw = WHEEL_R - 2 * TYRE_R, WHEEL_R, TYRE_R
    section = ((r1, -hw), (r1, hw), (r0, hw), (r0, -hw))
    verts = []
    for i in range(n):
        a = TAU * i / n
        for r, u in section:
            verts.append(G(u, AXLE_Y + r * math.cos(a), v + r * math.sin(a)))
    faces = [(i * 4 + k, i * 4 + (k + 1) % 4, ((i + 1) % n) * 4 + (k + 1) % 4, ((i + 1) % n) * 4 + k)
             for i in range(n) for k in range(4)]
    make_mesh(p, "tyre", verts, faces, "keyDark")
    cyl(p, 0, AXLE_Y, v, r0 + 0.006, 0.026, "bikePlastic", axis="u", verts=12)


def m_kids_bike(p):
    rear, front = -AXLE_V, AXLE_V
    bb = (-0.05, 0.17)          # bottom bracket (v, y)
    seat = (-0.17, 0.47)        # seat cluster
    head_lo, head_hi = (0.255, 0.4), (0.225, 0.52)
    _wheel(p, rear)
    _wheel(p, front)
    T = "bikeTeal"
    # Step-through frame: down tube, low top tube, seat tube.
    tube(p, [(0, head_lo[1] + 0.02, head_lo[0] - 0.01), (0, 0.26, 0.08), (0, bb[1], bb[0])], 0.021, T, seg=5)
    tube(p, [(0, head_hi[1] - 0.03, head_hi[0] - 0.005), (0, seat[1] - 0.03, seat[0] + 0.01)], 0.016, T, seg=5)
    tube(p, [(0, bb[1], bb[0]), (0, seat[1], seat[0])], 0.018, T, seg=5)
    cyl(p, 0, (head_lo[1] + head_hi[1]) / 2, (head_lo[0] + head_hi[0]) / 2, 0.024, 0.14, T, verts=8,
        rot=(R(-14), 0, 0))
    # Rear triangle straddling the wheel, fork blades round the front one.
    for su in (-1, 1):
        u = su * 0.036
        tube(p, [(u * 0.5, bb[1], bb[0]), (u, AXLE_Y, rear)], 0.011, T, seg=5)
        tube(p, [(u * 0.5, seat[1] - 0.02, seat[0]), (u, AXLE_Y + 0.01, rear)], 0.01, T, seg=5)
        tube(p, [(u * 0.5, head_lo[1], head_lo[0]), (u, 0.3, head_lo[0] + 0.07), (u, AXLE_Y, front)],
             0.011, T, seg=5)
    # Seat post and a stubby kid saddle.
    tube(p, [(0, seat[1], seat[0]), (0, 0.565, -0.2)], 0.012, "chrome", seg=5)
    soft_box(p, 0, 0.585, -0.215, 0.11, 0.045, 0.2, "keyDark", r=0.016, seg=1, cuts=0, taper=0.15)
    # Stem and riser handlebar with fat grips.
    tube(p, [(0, head_hi[1], head_hi[0]), (0, 0.6, 0.205), (0, 0.635, 0.17)], 0.012, "chrome", seg=5)
    tube(p, [(-0.175, 0.69, 0.115), (-0.1, 0.665, 0.14), (0, 0.635, 0.17), (0.1, 0.665, 0.14),
             (0.175, 0.69, 0.115)], 0.011, "chrome", seg=5)
    for su in (-1, 1):
        cyl(p, su * 0.185, 0.692, 0.113, 0.017, 0.07, "keyDark", axis="u", verts=6)
    # Chain case over the drive side, cranks and pedals (left back, right fore).
    box(p, 0.045, bb[1] + 0.02, -0.2, 0.014, 0.11, 0.36, T, bev=0.0)
    for su, dv, dy in ((1, 0.085, -0.04), (-1, -0.085, 0.04)):
        box(p, su * 0.065, bb[1] + dy / 2, bb[0] + dv / 2, 0.014, 0.022, 0.1, "chrome", bev=0.0,
            rot=(-math.atan2(dy, dv), 0, 0))
        box(p, su * 0.11, bb[1] + dy, bb[0] + dv, 0.07, 0.022, 0.05, "keyDark", bev=0.0)
    # Kickstand down to the floor on the left.
    tube(p, [(-0.03, bb[1], bb[0] - 0.05), (-0.11, 0.008, bb[0] - 0.13)], 0.008, "chrome", seg=5)


# --- Garden gnome ------------------------------------------------------------------

def m_gnome(p):
    # Glazed resin gnome on a square stone plinth, hands folded on the belly
    # under the beard, tall red hat with its tip bent forward.
    box(p, 0, 0.025, 0, 0.24, 0.05, 0.24, "gnomeStone", bev=0.012)
    for su in (-1, 1):
        box(p, su * 0.045, 0.072, 0.03, 0.07, 0.045, 0.11, "keyDark", bev=0.014)
    lathe(p, 0, 0, [(0.085, 0.08, 0.06), (0.098, 0.092, 0.12, 0, 0.008), (0.094, 0.086, 0.2, 0, 0.006),
                    (0.074, 0.066, 0.255), (0.04, 0.036, 0.285)], "gnomeBlue", segments=10)
    lathe(p, 0, 0, [(0.103, 0.097, 0.14, 0, 0.008), (0.102, 0.096, 0.165, 0, 0.008)], "keyDark", segments=10,
          cap_bottom=False, cap_top=False)
    box(p, 0, 0.152, 0.104, 0.04, 0.03, 0.012, "chrome", bev=0.0)
    for su in (-1, 1):
        tube(p, [(su * 0.085, 0.25, -0.005), (su * 0.1, 0.2, 0.03), (su * 0.05, 0.175, 0.085)],
             0.024, "gnomeBlue", seg=6, sub=2)
        sphere(p, su * 0.03, 0.176, 0.098, 0.024, "gnomeSkin", segments=6, rings=4)
    sphere(p, 0, 0.318, 0.004, 0.056, "gnomeSkin", segments=10, rings=6)
    cone(p, 0, 0.25, 0.05, 0.012, 0.06, 0.12, "porcelain", verts=8, rot=(R(10), 0, 0))
    sphere(p, 0, 0.314, 0.06, 0.019, "gnomeSkin", segments=6, rings=4)
    lathe(p, 0, 0, [(0.064, 0.062, 0.33), (0.05, 0.048, 0.37, 0, -0.003), (0.032, 0.03, 0.405, 0, 0.004),
                    (0.014, 0.013, 0.435, 0, 0.022), (0.003, 0.003, 0.448, 0, 0.042)],
          "gnomeRed", segments=10)


# --- Doghouse ----------------------------------------------------------------------

def m_doghouse(p):
    # Gable kennel on two skids: red board walls with white corner trim, an
    # arched doorway in a framed front board, dark shingle roof overhanging
    # the walls, a name plate over the door.
    HW, Y0, EAVE, APEX, VB, VF = 0.36, 0.05, 0.6, 0.95, -0.46, 0.40
    slope = (APEX - EAVE) / HW
    gable = [(-HW, Y0), (HW, Y0), (HW, EAVE), (0, APEX), (-HW, EAVE)]
    for su in (-1, 1):
        box(p, su * 0.28, Y0 / 2, -0.03, 0.07, Y0, 0.96, "woodDark", bev=0.0)
    prism_v(p, gable, VB, VF, "kennelRed")
    # Front board with the doorway; the body's dark face shows through it.
    door = arch(0.16, 0.085, 0.4)
    frame_panel(p, [(-HW - 0.01, Y0), (HW + 0.01, Y0), (HW + 0.01, EAVE), (0, APEX + slope * 0.01),
                    (-HW - 0.01, EAVE)], door, (0, 0.3), VF, VF + 0.05, "kennelRed")
    # Dark backing sunk into the body: the doorway reads 4 cm deep.
    prism_v(p, arch(0.161, 0.086, 0.4), VF - 0.02, VF + 0.006, "slotDark")
    # White trim: door surround, corner boards, sill.
    frame_panel(p, arch(0.2, 0.06, 0.4), door, (0, 0.3), VF + 0.05, VF + 0.068, "paperWhite")
    for su in (-1, 1):
        for v in (VB + 0.02, VF + 0.03):
            box(p, su * (HW - 0.008), (Y0 + EAVE) / 2, v, 0.05, EAVE - Y0, 0.05, "paperWhite", bev=0.0)
    # Clapboard lines on the flanks and the back.
    for k in range(1, 6):
        y = Y0 + k * (EAVE - Y0) / 6
        for su in (-1, 1):
            decal(p, su * (HW + 0.003), y, (VB + VF) / 2, VF - VB - 0.08, 0.012, "slotDark",
                  face="u" if su > 0 else "-u")
        decal(p, 0, y, VB - 0.003, 2 * HW - 0.08, 0.012, "slotDark", rot=(0, 0, R(180)))
    # Name plate on the gable.
    box(p, 0, 0.71, VF + 0.058, 0.22, 0.06, 0.016, "paperWhite", bev=0.004)
    decal(p, 0, 0.71, VF + 0.067, 0.16, 0.018, "keyDark")
    # Roof: two shingle slabs on the gable slope, three proud courses each,
    # a ridge cap. Courses wander a few millimetres (seeded) like real tabs.
    a = math.atan(slope)
    t, reach = 0.035, 0.47
    L = reach / math.cos(a)
    rnd = lcg(0x03a1)
    for su in (-1, 1):
        cu = su * (reach / 2 + math.sin(a) * t / 2)
        cy = APEX - slope * reach / 2 + math.cos(a) * t / 2
        box(p, cu, cy, 0, L, t, 1.1, "roofShingle", bev=0.008, rot=(0, su * a, 0))
        for k in range(3):
            s = (k + 1) / 4 + (rnd() - 0.5) * 0.02          # fraction down the slope
            du = reach * s
            ou = su * (du + math.sin(a) * (t + 0.004))
            oy = APEX - slope * du + math.cos(a) * (t + 0.004)
            box(p, ou, oy, 0, 0.05, 0.012, 1.1, "roofShingle", bev=0.0, rot=(0, su * a, 0))
    # Ridge cap: its eaves sink into the slabs, its crown covers their meeting.
    box(p, 0, APEX + 0.02, 0, 0.08, 0.035, 1.12, "roofShingle", bev=0.01)


# --- Pack table ----------------------------------------------------------------------

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
    _kind("mailbox", m_mailbox, (0.35, 0.55), 1.2, "simple"),
    _kind("kids_bike", m_kids_bike, (0.45, 1.2), 0.75, "detailed"),
    _kind("gnome", m_gnome, (0.3, 0.3), 0.45, "detailed"),
    _kind("doghouse", m_doghouse, (0.9, 1.1), 1.0, "detailed"),
]
