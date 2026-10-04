# Yellow Rooms — stairwell pack (map 04, endless stairwell): the class B props
# of src/world/props/packs/stairwell.js, built by build_pack.py
# (`npm run build:pack -- stairwell`) into public/models/stairwell/.
#
# Frame: game local frame (u right, y up, v front), origin at the footprint
# centre on the floor, back (-v) against the wall. Dims and heights equal the
# registry (maps spec §6); the occ_* proxies below are copied verbatim into the
# pack's data module, so keep the two in step.
#
# Art direction: the stairwell is painted block under cool tubes, so the
# props carry the only saturated colour on a landing (fire-service red, a
# brown rubber wedge). Silhouettes first: the riser runs the full height and
# the hose coil reads through the open cabinet front at landing distance.

import bmesh
import bpy

from yr_kit import *  # noqa: F403  (yr_kit.__all__: primitives, R, TAU, lcg, marker)

NODE_PREFIX = "stairwell_"
# Map 04's share of the static pack budget (17-asset-manifest.md: ~2,500 tris).
BUDGET = dict(tris=2_500, bytes=100_000)
# key -> (linear rgb, metallic, roughness). New keys (hoseRed, valveBrass,
# wedgeRubber) have their runtime surface in src/world/props/packs/stairwell.js.
PALETTE = {
    "hoseRed": ((0.5, 0.05, 0.035), 0.0, 0.42),      # fire-service enamel
    "valveBrass": ((0.62, 0.45, 0.2), 0.85, 0.32),   # landing valve + nozzle
    "wedgeRubber": ((0.3, 0.16, 0.08), 0.0, 0.9),    # door wedge
    "chrome": ((0.75, 0.78, 0.8), 0.85, 0.32),       # flanges, handle, reel hub
    "slotDark": ((0.14, 0.14, 0.15), 0.0, 0.78),     # cabinet interior
    "paperWhite": ((0.9, 0.88, 0.8), 0.0, 0.78),     # canvas hose, FIRE HOSE sign
}


def _solid(p, name, verts, faces, key, bev=0.0):
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
    finish(o, key, bev=bev)
    p.append(o)
    return o


def _recessed_box(p, u0, u1, y0, y1, v0, v1, rim, depth, key, bev=0.008):
    """A box whose front (+v) face is a frame of width `rim` around a pocket
    `depth` deep: an open cabinet in one closed mesh (28 tris before bevel)."""
    a0, a1, b0, b1, vb = u0 + rim, u1 - rim, y0 + rim, y1 - rim, v1 - depth
    verts = [
        (u0, y0, v0), (u1, y0, v0), (u1, y1, v0), (u0, y1, v0),     # 0-3 back
        (u0, y0, v1), (u1, y0, v1), (u1, y1, v1), (u0, y1, v1),     # 4-7 front outer
        (a0, b0, v1), (a1, b0, v1), (a1, b1, v1), (a0, b1, v1),     # 8-11 front inner
        (a0, b0, vb), (a1, b0, vb), (a1, b1, vb), (a0, b1, vb),     # 12-15 pocket floor
    ]
    faces = [
        (0, 3, 2, 1), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7),
        (4, 5, 9, 8), (5, 6, 10, 9), (6, 7, 11, 10), (7, 4, 8, 11),
        (8, 9, 13, 12), (9, 10, 14, 13), (10, 11, 15, 14), (11, 8, 12, 15),
        (12, 13, 14, 15),
    ]
    return _solid(p, "cabinet", verts, faces, key, bev=bev)


# --- Standpipe: riser + landing valve + hose cabinet ------------------------------
# Wall pieces stand 0.06 m off the wall face (floorPlan.js addPiece), so the
# wall-mounted parts reach back to WALL (0.055 past the -0.15 footprint edge,
# well inside the 0.15 m GLB tolerance): cabinet, sign and elbow touch the wall.

WALL = -0.205
RU, RV, RR = -0.30, -0.135, 0.057    # riser axis (u, v) and radius (DN100)
CU0, CU1, CY0, CY1 = -0.16, 0.40, 0.80, 1.60   # cabinet box
CV0, CV1 = WALL, 0.055
VY = 1.0                              # landing valve height
VV = RV + 0.065                       # valve body centre (v)


def m_standpipe(p):
    # Riser: floor flange, painted pipe with grooved couplings, a swept elbow
    # into the wall at the top (the riser never stops in mid-air).
    cyl(p, RU, 0.007, RV, 0.075, 0.014, "chrome", verts=10)
    cyl(p, RU, 0.94, RV, RR, 1.86, "hoseRed", verts=10)
    # The upper coupling sleeves the pipe/elbow joint (no coplanar overlap).
    for y in (0.36, 1.87):
        cyl(p, RU, y, RV, RR + 0.009, 0.05, "hoseRed", verts=10)
    tube(p, [(RU, 1.87, RV), (RU, 1.91, RV), (RU, 1.952, -0.152), (RU, 1.97, -0.19),
             (RU, 1.97, WALL)], RR, "hoseRed", seg=10, shading="smooth")

    # Landing valve on the riser's face: brass body, red handwheel toward the
    # stair, capped outlet pointing down.
    box(p, RU, VY, VV, 0.075, 0.11, 0.11, "valveBrass", bev=0.0)
    torus(p, RU, VY + 0.005, VV + 0.065, 0.068, 0.011, "hoseRed", axis="v", major_seg=8, minor_seg=4)
    box(p, RU, VY + 0.005, VV + 0.061, 0.13, 0.014, 0.014, "hoseRed", bev=0.0)
    box(p, RU, VY + 0.005, VV + 0.061, 0.014, 0.13, 0.014, "hoseRed", bev=0.0)
    cyl(p, RU, VY - 0.085, VV, 0.034, 0.07, "valveBrass", verts=6)

    # Branch into the cabinet's flank.
    cyl(p, (RU + CU0) / 2, 1.3, RV, 0.028, CU0 - RU, "hoseRed", axis="u", verts=6)

    # Open-front hose cabinet: dark pocket, coiled canvas hose on a hub, the
    # nozzle hanging bottom right, lever handle; the sign on the wall above.
    _recessed_box(p, CU0, CU1, CY0, CY1, CV0, CV1, 0.045, 0.09, "hoseRed")
    cu, cy = (CU0 + CU1) / 2, 1.215
    decal(p, cu, (CY0 + CY1) / 2, CV1 - 0.0875, CU1 - CU0 - 0.11, CY1 - CY0 - 0.11, "slotDark")
    # Three hose turns: V grooves steep enough (> smooth angle) to stay crisp.
    turns = [(0.055 + 0.045 * k / 2, 0.064 if k % 2 else 0.044) for k in range(7)]
    lathe(p, 0, 0, [(0.055, 0.055, 0.0)] + [(r, r, d) for r, d in turns] + [(0.19, 0.19, 0.0)],
          "paperWhite", segments=12, closed=True, pivot=(cu, cy, CV1 - 0.088), rot=(R(90), 0, 0))
    cyl(p, cu, cy, CV1 - 0.03, 0.042, 0.024, "chrome", axis="v", verts=6)
    tube(p, [(cu + 0.16, cy - 0.11, CV1 - 0.05), (cu + 0.2, cy - 0.21, CV1 - 0.046),
             (cu + 0.2, cy - 0.29, CV1 - 0.046)], 0.017, "paperWhite", seg=6)
    cone(p, cu + 0.2, cy - 0.32, CV1 - 0.046, 0.011, 0.02, 0.05, "valveBrass", verts=6)
    box(p, CU1 - 0.022, 1.2, CV1 + 0.011, 0.016, 0.11, 0.022, "chrome", bev=0.0)

    box(p, cu, 1.715, WALL + 0.008, 0.36, 0.09, 0.016, "paperWhite", bev=0.0)
    for du, w in ((-0.083, 0.12), (0.075, 0.14)):  # "FIRE HOSE": two words of red
        decal(p, cu + du, 1.715, WALL + 0.0185, w, 0.044, "hoseRed")


# --- Doorstop: rubber wedge, thick heel at the back ---------------------------------

W_HW = 0.06                # half width (u)
W_TOP = [                  # (v, y) top profile, back heel to the thin toe
    (-0.1, 0.046), (-0.096, 0.05), (-0.05, 0.05),
    (-0.035, 0.0455), (-0.03, 0.0485), (-0.022, 0.0448),
    (-0.002, 0.0389), (0.003, 0.0419), (0.011, 0.0382),
    (0.031, 0.0323), (0.036, 0.0353), (0.044, 0.0316),
    (0.1, 0.008),
]


def m_doorstop(p):
    # One extruded height-field prism (column quads, so the grip ribs across
    # the slope never fold a flank polygon); the heel is the flat thick end.
    n = len(W_TOP)
    verts = []
    for su in (-W_HW, W_HW):
        verts += [(su, y, v) for v, y in W_TOP] + [(su, 0.0, v) for v, _ in W_TOP]

    def T(s, i):  # top vertex i of side s
        return s * 2 * n + i

    def B(s, i):  # bottom vertex i of side s
        return s * 2 * n + n + i

    faces = []
    for i in range(n - 1):
        faces.append((T(0, i), T(0, i + 1), T(1, i + 1), T(1, i)))    # top
        faces.append((B(0, i), B(1, i), B(1, i + 1), B(0, i + 1)))    # bottom
        for s in (0, 1):
            faces.append((B(s, i), B(s, i + 1), T(s, i + 1), T(s, i)))  # flanks
    faces.append((B(0, 0), T(0, 0), T(1, 0), B(1, 0)))                  # heel
    faces.append((B(0, n - 1), B(1, n - 1), T(1, n - 1), T(0, n - 1)))  # toe
    _solid(p, "wedge", verts, faces, "wedgeRubber", bev=0.002)


# --- Shadow proxies: (u0, u1, v0, v1, y0, y1, t), A first ----------------------------
PROXIES = {
    "standpipe": [(CU0, CU1, CV0, CV1, CY0, CY1, 0), (-0.36, -0.24, WALL, -0.075, 0.0, 2.03, 0)],
    "doorstop": [(-0.06, 0.06, -0.1, 0.1, 0.0, 0.02, 0), (-0.06, 0.06, -0.1, 0.0, 0.0, 0.05, 0)],
}


def _with_proxies(kind, build):
    def run(p):
        build(p)
        for name, (u0, u1, v0, v1, y0, y1, t) in zip(("occ_A", "occ_B"), PROXIES[kind]):
            marker(p, name, (u0 + u1) / 2, (y0 + y1) / 2, (v0 + v1) / 2, u1 - u0, y1 - y0, v1 - v0, t=t)
    return run


MODELS = [
    dict(kind="standpipe", kind_key="PROP_STANDPIPE", cls="B", build=_with_proxies("standpipe", m_standpipe),
         dims=(0.80, 0.30), height=2.05, tier="detailed"),
    dict(kind="doorstop", kind_key="PROP_DOORSTOP", cls="B", build=_with_proxies("doorstop", m_doorstop),
         dims=(0.12, 0.20), height=0.05, tier="simple"),
]
