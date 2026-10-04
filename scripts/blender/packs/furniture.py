# Yellow Rooms — furniture pack: the 23 collision-real FURN_* kinds
# (src/world/rooms/catalog.js) as polished low-poly models, built by
# build_pack.py (`npm run build:pack -- furniture`, or the legacy
# `npm run build:furniture` shim) into public/models/furniture/ for the
# runtime loader (src/render/furnitureModels.js). Re-runnable: dimensions and
# the part colour palette are parsed from the game sources, so tuning
# constants.js or palette.js and rebuilding re-syncs the models.
#
# Frame contract (matches src/world/objects/furniture/frame.js):
#   game local frame: u = width (x), v = depth (front toward +v), y = up,
#   origin at the footprint centre on the floor. In Blender (Z-up, glTF +Y-up
#   export) we build at (x=u, y=-v, z=y), so the exported model's front faces
#   glTF +Z — the facing=0 direction the mesher rotates per instance.
#
# Footprints MUST stay inside the collision extents (rooms/furnish.js
# PIECE_DIMS): the player sweeps a 2D AABB from those constants, so visual
# geometry can never be allowed to protrude past them. Small overhangs the
# original box models already had (rim, cornice, tray) are kept within the
# same tolerances (`overhang` below + the driver's 0.14 m).
#
# Art direction ("anime semi-realistic" backgrounds): clean readable shapes,
# soft upholstery/porcelain/cloth where the real object is soft or curved,
# detail concentrated at structural edges (mouldings, seams, handles, trays),
# and a painted per-vertex value pass (yr_shading.paint -> COLOR_0) instead of
# texture noise.
#
# Byte identity: the committed GLBs are rebuilds of exactly this module, so
# keep NODE_PREFIX "furn_", the palette's metal/roughness split, KEEP_BRIGHT,
# floor_z 0 and no sockets (sockets turn on export_extras).

import math
import os

from yr_kit import *  # noqa: F403  (yr_kit.__all__: primitives, R, TAU, lcg, marker, parsers)

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

# --- Single source of truth: parse the game sources --------------------------

C = parse_js_consts(os.path.join(REPO, "src", "world", "constants.js"), need=[
    "DESK_W", "DESK_D", "DESK_H", "CHAIR_W", "CHAIR_H", "CHAIR_SEAT_H",
    "TABLE_W", "TABLE_D", "TABLE_H", "CABINET_W", "CABINET_D", "CABINET_H",
    "COPIER_W", "COPIER_D", "COPIER_H", "COOLER_W", "COOLER_H",
    "PLANT_W", "PLANT_H", "RACK_W", "RACK_D", "RACK_H",
    "SOFA_W", "SOFA_D", "SOFA_H", "BOOKSHELF_W", "BOOKSHELF_D", "BOOKSHELF_H",
    "WHITEBOARD_W", "WHITEBOARD_D", "WHITEBOARD_H",
    "BED_W", "BED_D", "BED_H", "NIGHTSTAND_W", "NIGHTSTAND_H",
    "WARDROBE_W", "WARDROBE_D", "WARDROBE_H",
    "TOILET_W", "TOILET_D", "TOILET_H", "SINK_W", "SINK_D", "SINK_H",
    "TUB_W", "TUB_D", "TUB_H", "COUNTER_W", "COUNTER_D", "COUNTER_H",
    "STOVE_W", "STOVE_D", "STOVE_H", "FRIDGE_W", "FRIDGE_D", "FRIDGE_H",
    "TV_W", "TV_D", "TV_H", "ARMCHAIR_W", "ARMCHAIR_H",
    "WASHER_W", "WASHER_H"])
PAL = parse_js_rgb_table(os.path.join(REPO, "src", "world", "objects", "furniture", "palette.js"),
                         "FURN_TINT", min_entries=40)

# --- Pack settings (build_pack.py spec contract) --------------------------------

NODE_PREFIX = "furn_"
# Transfer/triangle budgets mirrored by src/render/__tests__/furniture-models.test.js.
BUDGET = dict(tris=20_000, bytes=650_000)
METAL_KEYS = {"chrome", "applianceSteel", "legMetal"}
PALETTE = {k: (rgb, 0.85 if k in METAL_KEYS else 0.0, 0.32 if k in METAL_KEYS else 0.78)
           for k, rgb in PAL.items()}
KEEP_BRIGHT = {"ledGreen"}  # status LEDs stay pure signal colour


# --- The 23 models -------------------------------------------------------------
# Each builder appends parts into `p` (list of objects). Same silhouettes and
# palette as the original box builders, upgraded where the real object is
# soft (upholstery, bedding, cloth), curved (porcelain, bottles, cables) or
# carries its detail at a structural edge (mouldings, seams, handles, trays).

def m_desk(p):
    W, D, H = C["DESK_W"], C["DESK_D"], C["DESK_H"]
    # Two-tone top: laminate slab over a slightly inset darker edge band.
    box(p, 0, H - 0.018, 0, W, 0.036, D, "laminate", bev=0.012)
    box(p, 0, H - 0.047, 0, W - 0.05, 0.022, D - 0.05, "panel", bev=0.004)
    box(p, -(W / 2 - 0.04), (H - 0.05) / 2, 0, 0.05, H - 0.05, D - 0.08, "legMetal", bev=0.008)
    box(p, W / 2 - 0.04, (H - 0.05) / 2, 0, 0.05, H - 0.05, D - 0.08, "legMetal", bev=0.008)
    box(p, 0, 0.45, -(D / 2 - 0.07), W - 0.2, 0.38, 0.025, "panel", bev=0.006)
    # Drawer pedestal (right): case, two proud fronts, bar pulls.
    box(p, W / 2 - 0.28, 0.33, 0, 0.42, 0.58, D - 0.12, "panel", bev=0.01)
    box(p, W / 2 - 0.28, 0.47, D / 2 - 0.052, 0.38, 0.17, 0.02, "drawerFace", bev=0.005)
    box(p, W / 2 - 0.28, 0.2, D / 2 - 0.052, 0.38, 0.3, 0.02, "drawerFace", bev=0.005)
    for y in (0.53, 0.33):
        box(p, W / 2 - 0.28, y, D / 2 - 0.036, 0.15, 0.018, 0.022, "legMetal", bev=0.005)
    # Monitor: foot plate, neck, back housing, thin bezel + screen, tilted back.
    mx, tilt = -0.2, (R(7), 0, 0)
    soft_box(p, mx, H + 0.008, -0.13, 0.26, 0.016, 0.19, "keyDark", r=0.006, seg=1, cuts=0)
    box(p, mx, H + 0.17, -0.2, 0.055, 0.32, 0.025, "keyDark", bev=0.008, rot=(R(4), 0, 0))
    box(p, mx, H + 0.37, -0.175, 0.36, 0.22, 0.035, "keyDark", bev=0.012, rot=tilt)
    box(p, mx, H + 0.375, -0.148, 0.62, 0.37, 0.02, "keyDark", bev=0.007, rot=tilt)
    decal(p, mx, H + 0.382, -0.1365, 0.584, 0.326, "screen", rot=tilt)
    # Cable from the monitor back through a grommet in the top.
    cyl(p, mx - 0.12, H + 0.001, -(D / 2 - 0.12), 0.032, 0.006, "slotDark", verts=14)
    tube(p, [(mx - 0.02, H + 0.3, -0.2), (mx - 0.07, H + 0.14, -0.25),
             (mx - 0.11, H + 0.05, -0.29), (mx - 0.12, H - 0.01, -(D / 2 - 0.12))],
         0.0065, "keyDark", seg=5, sub=2)
    # Keyboard (case + key field) and mouse.
    box(p, -0.05, H + 0.01, 0.16, 0.44, 0.02, 0.15, "keyDark", bev=0.006)
    decal(p, -0.06, H + 0.0215, 0.165, 0.39, 0.11, "legMetal", face="y")
    sphere(p, 0.28, H + 0.018, 0.17, 0.045, "keyDark", scale=(0.7, 0.45, 1.0), segments=10, rings=6)
    # Articulated desk lamp (back-left): base, two arm segments, shade.
    lx, lv = -(W / 2 - 0.16), -(D / 2 - 0.14)
    cyl(p, lx, H + 0.012, lv, 0.07, 0.024, "legMetal", verts=18)
    tube(p, [(lx, H + 0.02, lv), (lx, H + 0.2, lv - 0.04), (lx, H + 0.33, lv + 0.02)],
         0.011, "legMetal", seg=6, sub=2)
    tube(p, [(lx, H + 0.33, lv + 0.02), (lx + 0.02, H + 0.36, lv + 0.12), (lx + 0.03, H + 0.34, lv + 0.2)],
         0.01, "legMetal", seg=6, sub=2)
    cone(p, lx + 0.035, H + 0.3, lv + 0.23, 0.07, 0.035, 0.11, "shade", rot=(R(-30), 0, 0), verts=14)
    # Paper stack, a skewed loose sheet, and a mug.
    box(p, -(W / 2 - 0.26), H + 0.015, D / 2 - 0.19, 0.3, 0.03, 0.21, "paperWhite", bev=0.004)
    decal(p, -(W / 2 - 0.28), H + 0.033, D / 2 - 0.2, 0.28, 0.2, "paperWhite", face="y",
          rot=(0, 0, R(8)))
    lathe(p, 0.44, 0.19, [(0.034, 0.034, H), (0.037, 0.037, H + 0.09), (0.03, 0.03, H + 0.09),
                          (0.03, 0.03, H + 0.06)], "potClay", segments=14)
    torus(p, 0.475, H + 0.05, 0.19, 0.022, 0.006, "potClay", axis="v", major_seg=10, minor_seg=4)


def m_chair(p):
    W, H, SEAT = C["CHAIR_W"], C["CHAIR_H"], C["CHAIR_SEAT_H"]
    # Contoured seat: dished top, waterfall front edge.
    soft_box(p, 0, SEAT + 0.042, 0.015, W - 0.07, 0.08, W - 0.09, "fabric", r=0.03, seg=1,
             cuts=1, puff=(0.006, 0.01, 0.014), sag=0.014)
    box(p, 0, SEAT - 0.02, -0.01, 0.22, 0.04, 0.22, "keyDark", bev=0.008)
    # Shell back: curved around the sitter, lumbar swell, rearward lean.
    soft_box(p, 0, SEAT + 0.3, -(W / 2 - 0.07), W - 0.1, 0.36, 0.06, "fabric", r=0.026,
             seg=1, cuts=1, puff=(0.0, 0.01, 0.018), bend=0.045, taper=0.06, rot=(R(-9), 0, 0))
    # Spine bar from the seat mechanism up into the back.
    tube(p, [(0, SEAT - 0.03, -0.06), (0, SEAT - 0.03, -0.17), (0, SEAT + 0.06, -0.25),
             (0, SEAT + 0.24, -0.265)], 0.017, "keyDark", seg=6, sub=2)
    # Armrests: L supports + soft pads.
    for su in (-1, 1):
        tube(p, [(su * 0.08, SEAT - 0.03, 0.0), (su * 0.22, SEAT - 0.03, 0.0),
                 (su * 0.245, SEAT + 0.06, -0.01), (su * 0.245, SEAT + 0.19, -0.02)],
             0.013, "keyDark", seg=6, sub=1)
        soft_box(p, su * 0.245, SEAT + 0.205, -0.005, 0.055, 0.03, 0.22, "keyDark",
                 r=0.012, seg=1, cuts=0)
    # Gas lift + shroud.
    cyl(p, 0, SEAT / 2 + 0.02, 0, 0.024, SEAT - 0.06, "legMetal", verts=10)
    cone(p, 0, 0.17, 0, 0.05, 0.032, 0.14, "keyDark", verts=12)
    # Five-star base: radial legs sloping to twin-wheel casters.
    for i in range(5):
        a = i * TAU / 5 + 0.31
        cu, cv = 0.13 * math.cos(a), 0.13 * math.sin(a)
        box(p, cu, 0.085, cv, 0.25, 0.032, 0.05, "legMetal", bev=0.01,
            rot=(0, 0, -a))
        wu, wv = 0.255 * math.cos(a), 0.255 * math.sin(a)
        cyl(p, wu, 0.027, wv, 0.027, 0.036, "keyDark", verts=10, rot=(R(90), 0, a + R(90)))
        box(p, wu, 0.06, wv, 0.03, 0.03, 0.03, "keyDark", bev=0.0)


def m_table(p):
    W, D, H = C["TABLE_W"], C["TABLE_D"], C["TABLE_H"]
    box(p, 0, H - 0.022, 0, W, 0.044, D, "laminate", bev=0.016)
    box(p, 0, H - 0.054, 0, W - 0.06, 0.02, D - 0.06, "panel", bev=0.004)
    box(p, 0, H - 0.11, D / 2 - 0.08, W - 0.32, 0.09, 0.035, "panel", bev=0.006)
    box(p, 0, H - 0.11, -(D / 2 - 0.08), W - 0.32, 0.09, 0.035, "panel", bev=0.006)
    box(p, W / 2 - 0.13, H - 0.11, 0, 0.035, 0.09, D - 0.22, "panel", bev=0.006)
    box(p, -(W / 2 - 0.13), H - 0.11, 0, 0.035, 0.09, D - 0.22, "panel", bev=0.006)
    for su in (-1, 1):
        for sv in (-1, 1):
            cone(p, su * (W / 2 - 0.12), (H - 0.06) / 2 + 0.01, sv * (D / 2 - 0.12),
                 0.05, 0.036, H - 0.08, "legMetal", verts=12)
            cyl(p, su * (W / 2 - 0.12), 0.01, sv * (D / 2 - 0.12), 0.042, 0.02, "keyDark", verts=12)
    # Cable ports with a flush lid line.
    for gu in (-0.55, 0.55):
        cyl(p, gu, H + 0.003, 0, 0.055, 0.008, "keyDark", verts=18)
        decal(p, gu, H + 0.0075, 0, 0.07, 0.006, "legMetal", face="y")


def m_cabinet(p):
    W, D, H = C["CABINET_W"], C["CABINET_D"], C["CABINET_H"]
    box(p, 0, 0.05, -0.01, W - 0.06, 0.1, D - 0.06, "legMetal", bev=0.008)
    box(p, 0, (H + 0.1) / 2, 0, W, H - 0.1, D, "cabinetPaint", bev=0.014)
    box(p, 0, H - 0.004, 0, W - 0.02, 0.024, D - 0.02, "panel", bev=0.006)
    for su in (-1, 1):
        du = su * 0.2275
        box(p, du, 0.97, D / 2 + 0.008, 0.435, 1.6, 0.022, "panel", bev=0.006)
        # Pressed door panel: a proud inset whose chamfer catches the light.
        box(p, du, 0.9, D / 2 + 0.021, 0.33, 1.2, 0.008, "panel", bev=0.006)
        box(p, su * 0.05, 1.0, D / 2 + 0.032, 0.025, 0.2, 0.02, "legMetal", bev=0.004)
        decal(p, du, 1.6, D / 2 + 0.0225, 0.18, 0.06, "slotDark")
        decal(p, du, 1.6, D / 2 + 0.025, 0.14, 0.035, "paperWhite")
    cyl(p, 0.0, 1.18, D / 2 + 0.022, 0.012, 0.012, "chrome", axis="v", verts=10)


def m_copier(p):
    W, D, H = C["COPIER_W"], C["COPIER_D"], C["COPIER_H"]
    box(p, 0, 0.035, 0, W - 0.08, 0.07, D - 0.08, "slotDark", bev=0.006)
    box(p, 0, 0.5, 0, W, 0.86, D, "copierBody", bev=0.025)
    # Two paper cassettes with finger-pull slots.
    for y in (0.2, 0.42):
        box(p, 0, y, D / 2 + 0.004, W - 0.1, 0.19, 0.02, "drawerFace", bev=0.006)
        decal(p, 0, y + 0.07, D / 2 + 0.0175, 0.26, 0.02, "slotDark")
    # Scanner deck, glass lid + document feeder with its paper tray.
    box(p, 0, H - 0.1, -0.01, W - 0.04, 0.08, D - 0.06, "panel", bev=0.012)
    soft_box(p, -0.06, H - 0.03, -0.04, W - 0.22, 0.07, D - 0.22, "copierBody", r=0.02, seg=2, cuts=0)
    box(p, -0.08, H + 0.018, -0.02, W - 0.36, 0.02, D - 0.32, "panel", bev=0.006, rot=(R(-6), 0, 0))
    decal(p, -0.08, H + 0.03, -0.02, W - 0.42, D - 0.38, "paperWhite", face="y", rot=(R(-6), 0, 0))
    # Angled control panel with a small screen.
    box(p, W / 2 - 0.14, H - 0.07, D / 2 - 0.08, 0.24, 0.05, 0.16, "keyDark", bev=0.008, rot=(R(18), 0, 0))
    decal(p, W / 2 - 0.16, H - 0.044, D / 2 - 0.08, 0.12, 0.08, "screen", face="y", rot=(R(18), 0, 0))
    # Output slot + pulled tray with a printed stack.
    box(p, 0, 0.66, D / 2 + 0.006, 0.6, 0.06, 0.02, "slotDark", bev=0.0)
    box(p, 0, 0.61, D / 2 + 0.05, 0.62, 0.02, 0.12, "drawerFace", bev=0.004, rot=(R(-4), 0, 0))
    box(p, 0, 0.635, D / 2 + 0.05, 0.54, 0.03, 0.1, "paperWhite", bev=0.003, rot=(R(-4), 0, 0))
    for i in range(3):
        decal(p, -W / 2 - 0.003, 0.4 + i * 0.14, 0, D - 0.3, 0.06, "slotDark", face="-u")


def m_cooler(p):
    W, H = C["COOLER_W"], C["COOLER_H"]
    box(p, 0, 0.44, 0, W, 0.88, W, "coolerWhite", bev=0.035)
    # Recessed dispense bay: dark back, drip tray grille, two push taps
    # (red hot / blue cold — the one warm/cool accent pair in the office).
    box(p, 0, 0.63, W / 2 + 0.002, 0.24, 0.2, 0.012, "slotDark", bev=0.004)
    box(p, 0, 0.53, W / 2 + 0.035, 0.22, 0.02, 0.08, "legMetal", bev=0.004)
    for su, tint in ((-1, "bookRed"), (1, "bottleBlue")):
        box(p, su * 0.06, 0.7, W / 2 + 0.03, 0.05, 0.05, 0.06, "coolerWhite", bev=0.008)
        box(p, su * 0.06, 0.735, W / 2 + 0.042, 0.03, 0.02, 0.03, tint, bev=0.0)
        cyl(p, su * 0.06, 0.66, W / 2 + 0.045, 0.01, 0.03, "legMetal", verts=8)
    # Collar + the water bottle (grip rings, shoulder, neck, cap).
    lathe(p, 0, 0, [(0.16, 0.16, 0.87), (0.165, 0.165, 0.91), (0.13, 0.13, 0.925)],
          "coolerWhite", segments=14)
    lathe(p, 0, 0, [
        (0.13, 0.13, 0.905), (0.148, 0.148, 0.94), (0.15, 0.15, 1.04), (0.139, 0.139, 1.075),
        (0.15, 0.15, 1.11), (0.148, 0.148, 1.24), (0.118, 0.118, 1.295), (0.062, 0.062, 1.33),
        (0.05, 0.05, 1.345),
    ], "bottleBlue", segments=14)
    lathe(p, 0, 0, [(0.05, 0.05, 1.34), (0.055, 0.055, 1.35), (0.055, 0.055, 1.385),
                    (0.035, 0.035, 1.395)], "coolerWhite", segments=12)
    # Cup dispenser on the flank (slight overhang, as the original).
    cyl(p, W / 2 + 0.03, 0.68, 0.04, 0.036, 0.3, "coolerWhite", verts=12)
    cyl(p, W / 2 + 0.03, 0.52, 0.04, 0.03, 0.025, "slotDark", verts=10)


def m_plant(p):
    # Snake plant: lipped tapered pot, soil, a rosette of arching blades.
    lathe(p, 0, 0, [(0.145, 0.145, 0.0), (0.16, 0.16, 0.02), (0.188, 0.188, 0.3),
                    (0.205, 0.205, 0.31), (0.205, 0.205, 0.375), (0.182, 0.182, 0.38),
                    (0.176, 0.176, 0.35)], "potClay", segments=18)
    cyl(p, 0, 0.36, 0, 0.176, 0.02, "soil", verts=18)
    rnd = lcg(7)
    blades = [(0.0, 0.0, 0.74, 3), (0.05, 0.035, 0.66, 10), (-0.05, 0.03, 0.6, 14),
              (0.035, -0.05, 0.55, 18), (-0.045, -0.035, 0.5, 21), (0.09, -0.01, 0.43, 27),
              (-0.09, 0.015, 0.4, 30), (0.02, 0.085, 0.36, 33), (-0.02, -0.09, 0.33, 36),
              (0.07, 0.07, 0.28, 44), (-0.075, 0.06, 0.25, 48)]
    for i, (bu, bv, h, tilt) in enumerate(blades):
        a = i * 2.4 + 0.3
        leaf(p, bu, 0.365, bv, h, a, R(tilt), twist=0.25 + 0.5 * rnd(),
             width=0.85 + 0.3 * rnd(), arch=1.4 + 0.6 * rnd())


def m_rack(p):
    W, D, H = C["RACK_W"], C["RACK_D"], C["RACK_H"]
    box(p, 0, 0.05, 0, W - 0.06, 0.1, D - 0.04, "legMetal", bev=0.008)
    box(p, 0, H / 2 + 0.04, 0, W, H - 0.08, D, "rackDark", bev=0.012)
    box(p, 0, H / 2 + 0.04, D / 2 + 0.004, W - 0.1, H - 0.2, 0.02, "rackFace", bev=0.004)
    for su in (-1, 1):
        box(p, su * (W / 2 - 0.07), H / 2 + 0.04, D / 2 + 0.012, 0.035, H - 0.2, 0.014, "legMetal", bev=0.0)
    # Door pull on the right rail.
    box(p, W / 2 - 0.07, 1.05, D / 2 + 0.03, 0.02, 0.24, 0.02, "legMetal", bev=0.005)
    # Six server units with vent lines; status LEDs on a deterministic pattern.
    for i in range(6):
        y = 0.32 + i * 0.27
        box(p, 0, y, D / 2 + 0.012, W - 0.22, 0.21, 0.012, "slotDark", bev=0.0)
        decal(p, 0.12, y - 0.04, D / 2 + 0.0205, 0.3, 0.012, "rackFace")
        decal(p, 0.12, y, D / 2 + 0.0205, 0.3, 0.012, "rackFace")
        decal(p, -0.3, y + 0.05, D / 2 + 0.0205, 0.035, 0.02, "ledGreen")
        decal(p, -0.24, y + 0.05, D / 2 + 0.0205, 0.035, 0.02,
              "bookRed" if i == 3 else "ledGreen")
    box(p, 0, H - 0.005, 0, W - 0.16, 0.02, D - 0.16, "slotDark", bev=0.004)


def _upholstered(p, W, D, backs, arm_w, seat_top, frame_key="sofa", cushion_key="sofaCushion"):
    """Shared sofa/armchair body: wood legs, plinth, rolled arms, back frame,
    loose seat + back cushions (sagging, puffed, soft-edged)."""
    for su in (-1, 1):
        for sv in (-1, 1):
            cone(p, su * (W / 2 - 0.09), 0.055, sv * (D / 2 - 0.09), 0.03, 0.022, 0.11,
                 "woodDark", verts=8)
    inner = W - 2 * arm_w
    soft_box(p, 0, 0.23, 0.0, inner + 0.04, 0.24, D - 0.06, frame_key, r=0.03, seg=1, cuts=0)
    for su in (-1, 1):
        # Arms: rounded roll on top, slightly flared outer face.
        soft_box(p, su * (W / 2 - arm_w / 2), 0.39, 0.0, arm_w, 0.56, D, frame_key,
                 r=0.06, seg=2, cuts=0)
    soft_box(p, 0, 0.6, -(D / 2 - 0.085), inner + 0.02, 0.58, 0.17, frame_key,
             r=0.05, seg=2, cuts=0, rot=(R(-5), 0, 0))
    n = len(backs)
    cw = (inner - 0.01 * (n - 1)) / n
    for i in range(n):
        cu = -inner / 2 + cw / 2 + i * (cw + 0.01)
        # Seat cushion: soft sag in the middle, puffed front.
        soft_box(p, cu, seat_top - 0.08, 0.035, cw, 0.16, D - 0.24, cushion_key, r=0.045,
                 seg=1, cuts=1, puff=(0.006, 0.02, 0.018), sag=0.035)
        # Back cushion leaning into the frame, belly puffed forward.
        soft_box(p, cu, seat_top + 0.2, -(D / 2 - 0.215), cw - 0.01, 0.38, 0.15, cushion_key,
                 r=0.05, seg=1, cuts=1, puff=(0.004, 0.012, 0.03), rot=(R(-11), 0, 0))
    return inner


def m_sofa(p):
    W, D, H = C["SOFA_W"], C["SOFA_D"], C["SOFA_H"]
    inner = _upholstered(p, W, D, (0, 1), 0.17, 0.51)
    # One throw pillow tucked into the right corner (the lived-in accent).
    pillow(p, inner / 2 - 0.17, 0.68, -0.07, 0.34, 0.13, 0.32, "rug", thin=0.35,
           rot=(R(-68), R(-8), R(-18)))


def m_bookshelf(p):
    W, D, H = C["BOOKSHELF_W"], C["BOOKSHELF_D"], C["BOOKSHELF_H"]
    box(p, -(W / 2 - 0.02), H / 2 - 0.025, 0, 0.04, H - 0.05, D, "shelfWood", bev=0.006)
    box(p, W / 2 - 0.02, H / 2 - 0.025, 0, 0.04, H - 0.05, D, "shelfWood", bev=0.006)
    box(p, 0, H / 2, -(D / 2 - 0.015), W - 0.08, H - 0.06, 0.03, "panel", bev=0.003)
    # Recessed plinth + two-step cornice: the structural-edge detail.
    box(p, 0, 0.045, 0, W - 0.06, 0.09, D - 0.02, "shelfWood", bev=0.006)
    box(p, 0, 0.04, D / 2 - 0.028, W - 0.1, 0.07, 0.02, "woodDark", bev=0.004)
    box(p, 0, H - 0.04, 0, W + 0.01, 0.03, D + 0.01, "shelfWood", bev=0.005)
    box(p, 0, H - 0.01, 0, W + 0.04, 0.035, D + 0.03, "shelfWood", bev=0.008)
    tints = ["bookRed", "bookBlue", "bookTan", "paperWhite", "bookBlue", "bookTan"]
    rnd = lcg(1151)
    front = D / 2 - 0.035
    shelf_ys = (0.09, 0.47, 0.86, 1.25)
    for s, y0 in enumerate(shelf_ys):
        if s > 0:
            box(p, 0, y0 - 0.015, 0, W - 0.08, 0.03, D - 0.05, "shelfWood", bev=0.004)
        if s == 3:
            continue
        u = -(W / 2 - 0.05)
        umax = W / 2 - 0.05
        k = 0
        stack_at = (2, 7, 4)[s]
        gap_at = (9, 3, 12)[s]
        while u < umax - 0.06:
            if k == stack_at:
                # Horizontal stack: two or three books lying flat.
                wv = 0.2
                for j in range(3 if s != 1 else 2):
                    bw = 0.17 - 0.015 * j
                    box(p, u + 0.09, y0 + 0.018 + 0.034 * j, front - wv / 2 + 0.005 * j,
                        bw, 0.032, wv - 0.01 * j, tints[(s + k + j) % 6], bev=0.0,
                        rot=(0, 0, R(4 - 5 * j)))
                u += 0.19
            elif k == gap_at:
                # A gap with one book leaning into it.
                bw, bh = 0.03, 0.24 + 0.03 * rnd()
                lean = R(16)
                cu = u + math.sin(lean) * bh / 2 + math.cos(lean) * bw / 2 + 0.004
                cy = y0 + math.cos(lean) * bh / 2 + math.sin(lean) * bw / 2
                box(p, cu, cy, front - 0.1, bw, bh, 0.19, tints[(s * 3 + k) % 6], bev=0.0,
                    rot=(0, lean, 0))
                u += bw * math.cos(lean) + bh * math.sin(lean) + 0.006
            else:
                bw = 0.03 + 0.024 * rnd()
                bh = 0.2 + 0.1 * rnd()
                bd = 0.17 + 0.05 * rnd()
                box(p, u + bw / 2, y0 + bh / 2, front - bd / 2, bw, bh, bd,
                    tints[int(rnd() * 6) % 6], bev=0.0)
                u += bw + 0.003
            k += 1
    # Top compartment: box files, a small stack and a pot.
    y0 = shelf_ys[3]
    box(p, 0.2, y0 + 0.14, front - 0.12, 0.09, 0.28, 0.24, "bookBlue", bev=0.004)
    box(p, 0.3, y0 + 0.14, front - 0.12, 0.09, 0.28, 0.24, "bookBlue", bev=0.004)
    box(p, 0.3, y0 + 0.2, front + 0.001, 0.05, 0.03, 0.004, "paperWhite", bev=0.0)
    box(p, 0.2, y0 + 0.2, front + 0.001, 0.05, 0.03, 0.004, "paperWhite", bev=0.0)
    box(p, -0.22, y0 + 0.022, front - 0.11, 0.26, 0.044, 0.2, "bookTan", bev=0.004)
    box(p, -0.22, y0 + 0.06, front - 0.11, 0.22, 0.034, 0.18, "bookRed", bev=0.004, rot=(0, 0, R(5)))
    lathe(p, -0.4, front - 0.12, [(0.045, 0.045, y0), (0.055, 0.055, y0 + 0.09),
                                  (0.047, 0.047, y0 + 0.085)], "potClay", segments=10)
    for i in range(3):
        leaf(p, -0.4 + 0.01 * i, y0 + 0.085, front - 0.12, 0.14 - 0.02 * i, i * 2.2, R(18 + 8 * i),
             twist=0.3, width=0.55)


def m_whiteboard(p):
    W, H = C["WHITEBOARD_W"], C["WHITEBOARD_H"]
    cy = 0.7 + H / 2
    box(p, 0, cy, 0, W, H, 0.04, "boardWhite", bev=0.008)
    box(p, 0, cy + H / 2 + 0.02, 0, W + 0.06, 0.05, 0.055, "legMetal", bev=0.006)
    box(p, 0, cy - H / 2 - 0.02, 0, W + 0.06, 0.05, 0.055, "legMetal", bev=0.006)
    box(p, -(W / 2 + 0.005), cy, 0, 0.05, H - 0.01, 0.055, "legMetal", bev=0.006)
    box(p, W / 2 + 0.005, cy, 0, 0.05, H - 0.01, 0.055, "legMetal", bev=0.006)
    for su in (-1, 1):
        for sy in (-1, 1):
            box(p, su * (W / 2 + 0.005), cy + sy * (H / 2 + 0.02), 0.002, 0.06, 0.06, 0.06,
                "keyDark", bev=0.01)
    # Faint erased writing + a red diagram: the "someone worked here" read.
    decal(p, -0.35, cy + 0.28, 0.023, 0.6, 0.026, "keyDark")
    decal(p, -0.45, cy + 0.16, 0.023, 0.35, 0.026, "keyDark")
    decal(p, -0.3, cy + 0.04, 0.023, 0.45, 0.026, "keyDark")
    decal(p, -0.52, cy - 0.1, 0.023, 0.22, 0.026, "bookBlue")
    decal(p, 0.5, cy + 0.1, 0.023, 0.28, 0.2, "bookRed")
    decal(p, 0.5, cy + 0.1, 0.0245, 0.24, 0.16, "boardWhite")
    # A pinned sheet with a magnet.
    decal(p, 0.68, cy + 0.3, 0.0235, 0.2, 0.27, "paperWhite", rot=(0, R(3), 0))
    cyl(p, 0.68, cy + 0.42, 0.028, 0.018, 0.012, "bookRed", axis="v", verts=10)
    # Marker tray with three markers (bodies + caps) and an eraser.
    box(p, 0, cy - H / 2 - 0.055, 0.05, 1.4, 0.025, 0.1, "legMetal", bev=0.005)
    box(p, 0, cy - H / 2 - 0.035, 0.095, 1.4, 0.02, 0.012, "legMetal", bev=0.003)
    for i, (mu, tint) in enumerate(((-0.4, "keyDark"), (-0.24, "bookRed"), (-0.1, "bookBlue"))):
        cyl(p, mu, cy - H / 2 - 0.029, 0.05, 0.012, 0.1, "boardWhite", axis="u", verts=8)
        cyl(p, mu + 0.062, cy - H / 2 - 0.029, 0.05, 0.013, 0.035, tint, axis="u", verts=8)
    box(p, 0.4, cy - H / 2 - 0.02, 0.05, 0.12, 0.035, 0.055, "panel", bev=0.008)
    decal(p, 0.4, cy - H / 2 - 0.0385, 0.05, 0.115, 0.05, "keyDark", face="y", rot=(R(180), 0, 0))


def m_bed(p):
    W, D, H = C["BED_W"], C["BED_D"], C["BED_H"]
    # Headboard: framed wood with a padded inset panel.
    box(p, 0, 0.62, -(D / 2 - 0.035), W, 1.08, 0.07, "bedFrame", bev=0.02)
    soft_box(p, 0, 0.72, -(D / 2 - 0.08), W - 0.2, 0.6, 0.04, "woodMid", r=0.018, seg=1,
             cuts=1, puff=(0.0, 0.0, 0.012))
    box(p, 0, 1.17, -(D / 2 - 0.035), W + 0.04, 0.04, 0.09, "bedFrame", bev=0.012)
    for su in (-1, 1):
        for sv in (-1, 1):
            box(p, su * (W / 2 - 0.06), 0.095, sv * (D / 2 - 0.07), 0.09, 0.19, 0.09,
                "bedFrame", bev=0.012)
    box(p, 0, 0.27, 0.0, W, 0.16, D - 0.02, "bedFrame", bev=0.015)
    # Mattress (soft, rounded) on the frame.
    top = 0.565
    soft_box(p, 0, 0.455, 0.02, W - 0.08, 0.22, D - 0.14, "mattress", r=0.05, seg=2, cuts=0)
    # Pillows propped against the headboard, one slightly overlapping.
    pillow(p, -0.33, top + 0.1, -(D / 2 - 0.3), 0.6, 0.17, 0.38, "pillow", thin=0.32,
           rot=(R(28), 0, R(2)))
    pillow(p, 0.33, top + 0.09, -(D / 2 - 0.3), 0.6, 0.16, 0.38, "pillow", thin=0.32,
           rot=(R(24), 0, R(-3)))
    # Blanket laid over the lower bed: rolls over the rounded mattress edge,
    # hangs down both sides and over the foot with a soft ripple.
    rr = 0.056
    hw = (W - 0.08) / 2 - 0.05
    v1 = D / 2 - 0.05 - 0.05
    v0 = -0.38
    hang = 0.2
    edge = [0.0, 0.044, 0.088, 0.14, hang]
    us = sorted({-(hw + e) for e in edge} | {hw + e for e in edge} | {0.0})
    vs = [v0, v0 + 0.45, v0 + 0.9, v1 - 0.12] + [v1 + e for e in edge]
    drape(p, "blanket", hw, v0, v1, top + 0.006, rr, hang, hang, 0.03, us, vs,
          wave=0.018, bump=0.0)
    # Turned-down sheet band over the blanket's head edge.
    soft_box(p, 0, top + 0.03, v0 + 0.07, W - 0.02, 0.035, 0.2, "pillow", r=0.016, seg=2,
             cuts=0)


def m_nightstand(p):
    W, H = C["NIGHTSTAND_W"], C["NIGHTSTAND_H"]
    box(p, 0, 0.03, 0, W - 0.08, 0.06, W - 0.08, "woodDark", bev=0.008)
    box(p, 0, (H - 0.03) / 2 + 0.03, 0, W - 0.02, H - 0.06, W - 0.04, "woodDark", bev=0.012)
    box(p, 0, H - 0.015, 0, W, 0.03, W, "woodMid", bev=0.008)
    box(p, 0, 0.43, W / 2 - 0.015, W - 0.1, 0.15, 0.02, "woodMid", bev=0.005)
    cyl(p, 0, 0.43, W / 2 + 0.008, 0.016, 0.026, "chrome", axis="v", verts=10)
    # Open cubby: recessed dark back panel.
    box(p, 0, 0.2, W / 2 - 0.012, W - 0.1, 0.18, 0.015, "slotDark", bev=0.003)
    # Bedside lamp: flared chrome foot, stem, parchment shade; a book.
    lathe(p, -0.04, -0.02, [(0.065, 0.065, H), (0.06, 0.06, H + 0.02), (0.022, 0.022, H + 0.04),
                            (0.014, 0.014, H + 0.06)], "chrome", segments=14)
    cyl(p, -0.04, H + 0.13, -0.02, 0.011, 0.16, "chrome", verts=8)
    lathe(p, -0.04, -0.02, [(0.105, 0.105, H + 0.17), (0.1, 0.1, H + 0.182), (0.068, 0.068, H + 0.3),
                            (0.062, 0.062, H + 0.3)], "shade", segments=18)
    box(p, 0.12, H + 0.018, 0.08, 0.14, 0.036, 0.2, "bookTan", bev=0.004, rot=(0, 0, R(-12)))


def m_wardrobe(p):
    W, D, H = C["WARDROBE_W"], C["WARDROBE_D"], C["WARDROBE_H"]
    box(p, 0, 0.05, 0, W - 0.08, 0.1, D - 0.06, "woodDark", bev=0.008)
    box(p, 0, H / 2 + 0.01, 0, W, H - 0.1, D, "woodDark", bev=0.014)
    # Two-step cornice moulding.
    box(p, 0, H - 0.05, 0, W + 0.02, 0.03, D + 0.01, "woodMid", bev=0.006)
    box(p, 0, H - 0.017, 0, W + 0.06, 0.035, D + 0.04, "woodMid", bev=0.008)
    for su in (-1, 1):
        du = su * 0.3025
        box(p, du, 1.03, D / 2 + 0.008, 0.575, 1.76, 0.022, "woodMid", bev=0.006)
        # Raised panels: long upper, short lower.
        box(p, du, 1.33, D / 2 + 0.022, 0.43, 0.98, 0.01, "woodMid", bev=0.009)
        box(p, du, 0.48, D / 2 + 0.022, 0.43, 0.5, 0.01, "woodMid", bev=0.009)
    box(p, 0, 1.03, D / 2 + 0.016, 0.016, 1.76, 0.012, "slotDark", bev=0.0)
    for su in (-1, 1):
        cyl(p, su * 0.075, 1.1, D / 2 + 0.042, 0.011, 0.3, "chrome", verts=8)
        for sy in (-1, 1):
            box(p, su * 0.075, 1.1 + sy * 0.12, D / 2 + 0.028, 0.014, 0.014, 0.03, "chrome", bev=0.0)


def m_toilet(p):
    W, D, H = C["TOILET_W"], C["TOILET_D"], C["TOILET_H"]
    # Cistern with a soft lid and push button.
    soft_box(p, 0, 0.6, -(D / 2 - 0.1), W, 0.34, 0.2, "porcelain", r=0.03, seg=2, cuts=0)
    soft_box(p, 0, 0.785, -(D / 2 - 0.1), W + 0.02, 0.035, 0.22, "porcelain", r=0.012, seg=2, cuts=0)
    cyl(p, 0.1, 0.806, -(D / 2 - 0.1), 0.026, 0.012, "chrome", verts=14)
    # One continuous porcelain lathe: flared foot, waist, bowl, rolled rim,
    # inner wall down to the water.
    cv = 0.06
    lathe(p, 0, cv, [
        (0.125, 0.16, 0.0), (0.12, 0.152, 0.05), (0.102, 0.128, 0.16), (0.118, 0.15, 0.27),
        (0.17, 0.2, 0.37), (W / 2 - 0.006, 0.226, 0.445), (W / 2 - 0.004, 0.226, 0.47),
        (W / 2 - 0.02, 0.21, 0.49), (0.155, 0.165, 0.485), (0.125, 0.135, 0.43),
        (0.082, 0.09, 0.37),
    ], "porcelain", segments=20)
    cyl(p, 0, 0.372, cv, 0.078, 0.004, "mirror", verts=18)
    # Seat ring on the rim, lid raised against the cistern.
    lathe(p, 0, cv, [(0.2, 0.222, 0.49), (0.198, 0.22, 0.51), (0.15, 0.158, 0.512),
                     (0.148, 0.156, 0.494)], "porcelain", segments=18, closed=True)
    # (A shortened lid keeps the raised pose inside the 0.78 height budget.)
    lathe(p, 0, 0, [(0.178, 0.155, -0.011), (0.183, 0.16, 0.0), (0.178, 0.155, 0.011)],
          "porcelain", segments=18, rot=(R(-99), 0, 0), pivot=(0, 0.663, -0.127))


def m_sink(p):
    W, D, H = C["SINK_W"], C["SINK_D"], C["SINK_H"]
    box(p, 0, 0.04, -0.01, W - 0.1, 0.08, D - 0.08, "slotDark", bev=0.004)
    box(p, 0, 0.41, 0, W - 0.05, 0.66, D - 0.04, "woodDark", bev=0.012)
    box(p, 0, 0.41, D / 2 - 0.012, W - 0.12, 0.56, 0.02, "woodMid", bev=0.005)
    box(p, 0, 0.41, D / 2 - 0.0, W - 0.22, 0.46, 0.01, "woodMid", bev=0.007)
    cyl(p, 0.2, 0.52, D / 2 + 0.008, 0.015, 0.02, "chrome", axis="v", verts=10)
    # Counter slab + vessel basin (recessed interior with a drain).
    soft_box(p, 0, H - 0.10, 0, W, 0.06, D, "porcelain", r=0.014, seg=2, cuts=0)
    bowl(p, 0, 0.02, [
        (0.14, 0.105, H - 0.07), (0.235, 0.17, H - 0.01), (0.25, 0.18, H + 0.018),
        (0.25, 0.18, H + 0.032), (0.232, 0.162, H + 0.038), (0.215, 0.148, H + 0.03),
        (0.185, 0.122, H - 0.015), (0.12, 0.075, H - 0.048),
    ], "porcelain", segments=20)
    cyl(p, 0, H - 0.046, 0.02, 0.019, 0.006, "chrome", verts=12)
    # Gooseneck faucet on a round plinth + a lever.
    fv = -(D / 2 - 0.07)
    cyl(p, 0, H + 0.008, fv, 0.03, 0.016, "chrome", verts=14)
    tube(p, [(0, H + 0.01, fv), (0, H + 0.17, fv), (0, H + 0.24, fv + 0.06),
             (0, H + 0.2, fv + 0.14), (0, H + 0.14, fv + 0.155)],
         0.012, "chrome", seg=6, sub=2, shading="soft")
    box(p, 0.045, H + 0.05, fv, 0.05, 0.012, 0.014, "chrome", bev=0.004, rot=(0, R(-20), 0))
    # Wall mirror with frame + shelf (the original floats these above the piece).
    box(p, 0, 1.6, -(D / 2 - 0.015), 0.72, 0.76, 0.02, "woodDark", bev=0.008)
    box(p, 0, 1.6, -(D / 2 - 0.028), 0.66, 0.7, 0.012, "mirror", bev=0.004)
    box(p, 0, 1.2, -(D / 2 - 0.045), 0.7, 0.025, 0.1, "woodDark", bev=0.005)
    cyl(p, -0.2, 1.25, -(D / 2 - 0.05), 0.022, 0.07, "towel", verts=10)
    cyl(p, -0.14, 1.235, -(D / 2 - 0.05), 0.018, 0.045, "paperWhite", verts=10)
    # Towel rail on the +u flank with a towel folded over it.
    ru = W / 2 + 0.03
    cyl(p, ru, 1.15, 0, 0.01, 0.28, "chrome", axis="v", verts=8)
    ribbon(p, [(ru - 0.022, 0.86), (ru - 0.018, 1.08), (ru - 0.012, 1.15), (ru, 1.163),
               (ru + 0.012, 1.15), (ru + 0.02, 1.08), (ru + 0.03, 0.93)],
           0.012, -0.11, 0.11, "towel", plane="uy", segs=2,
           wave=lambda a, s, y, i: (0.006 * math.sin(a * 30) * max(0, 1.1 - y) * 4, 0.0))


def m_tub(p):
    W, D, H = C["TUB_W"], C["TUB_D"], C["TUB_H"]
    # Rounded-rectangle porcelain shell: apron, rolled rim, sloped inner wall
    # (backrest at the +u end), recessed floor.
    lathe(p, 0, 0, [
        (W / 2 - 0.02, D / 2 - 0.02, 0.06, 0.0), (W / 2, D / 2, 0.07, 0.03),
        (W / 2, D / 2, 0.075, H - 0.03), (W / 2 - 0.004, D / 2 - 0.004, 0.078, H + 0.004),
        (W / 2 - 0.05, D / 2 - 0.05, 0.11, H + 0.012), (W / 2 - 0.08, D / 2 - 0.08, 0.14, H - 0.012),
        (W / 2 - 0.14, D / 2 - 0.12, 0.18, 0.34, -0.03), (W / 2 - 0.3, D / 2 - 0.17, 0.16, 0.17, -0.06),
        (W / 2 - 0.34, D / 2 - 0.2, 0.12, 0.15, -0.07),
    ], "porcelain", segments=24, shape="rrect", shading="weighted")
    # Drain + overflow at the tap end.
    cyl(p, -(W / 2 - 0.3), 0.152, 0, 0.025, 0.006, "chrome", verts=12)
    cyl(p, -(W / 2 - 0.12), 0.4, 0, 0.03, 0.012, "chrome", axis="u", verts=12,
        rot=(0, R(90) - R(25), 0))
    # Wall-end spout arching over the basin + two handles.
    tube(p, [(-(W / 2 - 0.04), H + 0.01, 0.0), (-(W / 2 - 0.04), H + 0.12, 0.0),
             (-(W / 2 - 0.1), H + 0.17, 0.0), (-(W / 2 - 0.16), H + 0.12, 0.0)],
         0.016, "chrome", seg=8, sub=3)
    for sv in (-1, 1):
        cyl(p, -(W / 2 - 0.04), H + 0.035, sv * 0.13, 0.018, 0.05, "chrome", verts=10)
        box(p, -(W / 2 - 0.04), H + 0.065, sv * 0.13, 0.05, 0.012, 0.014, "chrome", bev=0.004)


def m_counter(p):
    W, D, H = C["COUNTER_W"], C["COUNTER_D"], C["COUNTER_H"]
    box(p, 0, 0.05, -0.02, W - 0.08, 0.1, D - 0.1, "slotDark", bev=0.004)
    box(p, 0, 0.47, 0, W, 0.76, D - 0.04, "woodDark", bev=0.01)
    for su in (-1, 1):
        du = su * 0.31
        box(p, du, 0.39, D / 2 - 0.012, 0.58, 0.54, 0.02, "woodMid", bev=0.005)
        box(p, du, 0.765, D / 2 - 0.012, 0.58, 0.13, 0.02, "woodMid", bev=0.005)
        box(p, du, 0.6, D / 2 + 0.012, 0.16, 0.02, 0.02, "chrome", bev=0.004)
        box(p, du, 0.765, D / 2 + 0.012, 0.16, 0.02, 0.02, "chrome", bev=0.004)
    # Bullnose worktop + backsplash.
    soft_box(p, 0, H - 0.02, 0, W + 0.04, 0.04, D, "counterTop", r=0.016, seg=2, cuts=0)
    box(p, 0, H + 0.09, -(D / 2 - 0.015), W + 0.04, 0.18, 0.025, "counterTop", bev=0.006)
    # Cutting board + two canisters.
    box(p, -0.28, H + 0.01, 0.02, 0.34, 0.02, 0.24, "shelfWood", bev=0.006, rot=(0, 0, R(-8)))
    for i, (cu, h) in enumerate(((0.36, 0.17), (0.48, 0.12))):
        lathe(p, cu, -(D / 2 - 0.12), [(0.055, 0.055, H), (0.055, 0.055, H + h),
                                        (0.058, 0.058, H + h + 0.004), (0.058, 0.058, H + h + 0.025),
                                        (0.02, 0.02, H + h + 0.035)], "applianceSteel", segments=12)


def m_stove(p):
    W, D, H = C["STOVE_W"], C["STOVE_D"], C["STOVE_H"]
    box(p, 0, 0.04, -0.02, W - 0.06, 0.08, D - 0.08, "slotDark", bev=0.004)
    box(p, 0, 0.46, 0, W, 0.8, D, "applianceWhite", bev=0.018)
    box(p, 0, H - 0.045, 0, W - 0.03, 0.03, D - 0.03, "applianceSteel", bev=0.006)
    for su in (-1, 1):
        for sv in (-1, 1):
            bu, bv = su * 0.14, sv * 0.14
            cyl(p, bu, H - 0.024, bv, 0.07, 0.014, "burner", verts=14)
            cyl(p, bu, H - 0.013, bv, 0.03, 0.01, "slotDark", verts=10)
            # Cast-iron grate: two crossed bars per burner.
            box(p, bu, H - 0.008, bv, 0.17, 0.014, 0.018, "burner", bev=0.0)
            box(p, bu, H - 0.008, bv, 0.018, 0.014, 0.17, "burner", bev=0.0)
    # Oven: proud door, window, bar handle on standoffs; storage drawer below.
    box(p, 0, 0.47, D / 2 + 0.005, 0.58, 0.46, 0.02, "applianceSteel", bev=0.006)
    box(p, 0, 0.46, D / 2 + 0.017, 0.42, 0.24, 0.008, "burner", bev=0.003)
    cyl(p, 0, 0.66, D / 2 + 0.045, 0.012, 0.48, "chrome", axis="u", verts=8)
    for su in (-1, 1):
        box(p, su * 0.2, 0.66, D / 2 + 0.028, 0.02, 0.02, 0.04, "chrome", bev=0.004)
    box(p, 0, 0.15, D / 2 + 0.004, 0.58, 0.13, 0.02, "applianceWhite", bev=0.006)
    decal(p, 0, 0.19, D / 2 + 0.0145, 0.2, 0.014, "slotDark")
    # Control backsplash with four dials and a clock window.
    box(p, 0, H + 0.12, -(D / 2 - 0.03), W, 0.24, 0.05, "applianceWhite", bev=0.008)
    for i in range(4):
        du = -0.22 + i * 0.1 + (0.06 if i > 1 else 0)
        cyl(p, du, H + 0.13, -(D / 2 - 0.063), 0.022, 0.024, "burner", axis="v", verts=10)
        decal(p, du, H + 0.14, -(D / 2 - 0.0755), 0.005, 0.014, "applianceWhite")
    decal(p, 0.0, H + 0.13, -(D / 2 - 0.0575), 0.09, 0.04, "screen")


def m_fridge(p):
    W, D, H = C["FRIDGE_W"], C["FRIDGE_D"], C["FRIDGE_H"]
    box(p, 0, 0.05, 0, W - 0.06, 0.1, D - 0.06, "slotDark", bev=0.006)
    for i in range(3):
        decal(p, 0, 0.035 + i * 0.025, D / 2 - 0.027, W - 0.14, 0.008, "applianceSteel")
    box(p, 0, H / 2 + 0.04, -0.01, W, H - 0.1, D - 0.02, "applianceWhite", bev=0.022)
    box(p, 0, 1.56, D / 2 - 0.004, W - 0.02, 0.5, 0.03, "applianceWhite", bev=0.014)
    box(p, 0, 0.72, D / 2 - 0.004, W - 0.02, 1.12, 0.03, "applianceWhite", bev=0.014)
    decal(p, 0, 1.295, D / 2 + 0.0115, W - 0.03, 0.014, "slotDark")
    # Handles on standoffs.
    for y, h in ((1.56, 0.3), (0.9, 0.5)):
        cyl(p, -(W / 2 - 0.08), y, D / 2 + 0.045, 0.013, h, "applianceSteel", verts=8)
        for sy in (-1, 1):
            box(p, -(W / 2 - 0.08), y + sy * (h / 2 - 0.03), D / 2 + 0.024, 0.02, 0.02, 0.034,
                "applianceSteel", bev=0.004)
    # Lived-in: a note and a child's drawing under magnets.
    decal(p, 0.12, 1.12, D / 2 + 0.0145, 0.16, 0.2, "paperWhite", rot=(0, R(-4), 0))
    cyl(p, 0.12, 1.2, D / 2 + 0.019, 0.014, 0.008, "bookRed", axis="v", verts=8)
    decal(p, 0.16, 1.66, D / 2 + 0.0145, 0.13, 0.1, "paperWhite", rot=(0, R(5), 0))
    decal(p, 0.155, 1.65, D / 2 + 0.017, 0.07, 0.03, "bookBlue", rot=(0, R(5), 0))
    cyl(p, 0.19, 1.7, D / 2 + 0.019, 0.012, 0.008, "bottleBlue", axis="v", verts=8)


def m_tv(p):
    W, D, H = C["TV_W"], C["TV_D"], C["TV_H"]
    box(p, -(W / 2 - 0.1), 0.06, 0, 0.08, 0.12, D - 0.08, "legMetal", bev=0.008)
    box(p, W / 2 - 0.1, 0.06, 0, 0.08, 0.12, D - 0.08, "legMetal", bev=0.008)
    box(p, 0, 0.31, 0, W, 0.38, D, "woodDark", bev=0.014)
    box(p, 0, 0.495, 0, W + 0.01, 0.02, D + 0.01, "woodMid", bev=0.006)
    for su in (-1, 1):
        box(p, su * 0.47, 0.31, D / 2 + 0.006, 0.46, 0.3, 0.02, "woodMid", bev=0.005)
        cyl(p, su * 0.28, 0.31, D / 2 + 0.024, 0.013, 0.02, "chrome", axis="v", verts=8)
    # Open middle bay with a set-top box and its status LED.
    box(p, 0, 0.31, D / 2 - 0.004, 0.44, 0.3, 0.012, "slotDark", bev=0.003)
    box(p, 0, 0.215, D / 2 - 0.02, 0.3, 0.05, 0.14, "keyDark", bev=0.006)
    decal(p, 0.11, 0.215, D / 2 + 0.0535, 0.012, 0.008, "ledGreen")
    # TV: foot plate, neck, slim panel with a back hump, soundbar.
    soft_box(p, 0, 0.513, -0.05, 0.42, 0.016, 0.22, "tvBlack", r=0.006, seg=1, cuts=0)
    box(p, 0, 0.62, -0.07, 0.07, 0.2, 0.03, "tvBlack", bev=0.008)
    box(p, 0, 1.0, -0.1, 0.8, 0.44, 0.05, "tvBlack", bev=0.02)
    box(p, 0, 1.04, -0.06, 1.24, 0.68, 0.04, "tvBlack", bev=0.012)
    decal(p, 0, 1.045, -0.0375, 1.19, 0.63, "screen")
    soft_box(p, 0, 0.545, 0.13, 0.62, 0.05, 0.075, "keyDark", r=0.018, seg=2, cuts=0)


def m_armchair(p):
    W, H = C["ARMCHAIR_W"], C["ARMCHAIR_H"]
    _upholstered(p, W, W, (0,), 0.15, 0.51)
    # Throw blanket over the left arm, rolling over and down the outside.
    au = -(W / 2 - 0.075)
    top = 0.675
    path = [(au + 0.082, 0.53), (au + 0.086, 0.62), (au + 0.06, top + 0.008), (au, top + 0.02),
            (au - 0.06, top + 0.008), (au - 0.088, 0.61), (au - 0.093, 0.46), (au - 0.098, 0.32)]
    ribbon(p, path, 0.022, -0.22, 0.26, "rug", plane="uy", segs=5,
           wave=lambda a, s, y, i: (-0.012 * math.sin(a * 17 + 0.5) * max(0.0, 0.58 - y) * 3.5, 0.0))


def m_washer(p):
    W, H = C["WASHER_W"], C["WASHER_H"]
    box(p, 0, 0.03, -0.01, W - 0.06, 0.06, W - 0.08, "slotDark", bev=0.004)
    box(p, 0, (H - 0.03) / 2 + 0.03, 0, W, H - 0.06, W, "applianceWhite", bev=0.02)
    box(p, 0, H - 0.015, 0, W - 0.02, 0.03, W - 0.02, "applianceSteel", bev=0.006)
    # Control strip: detergent drawer (left), dial, display, buttons.
    box(p, 0, H - 0.1, W / 2 + 0.004, W - 0.06, 0.1, 0.015, "applianceSteel", bev=0.003)
    box(p, -0.19, H - 0.1, W / 2 + 0.014, 0.16, 0.075, 0.012, "applianceWhite", bev=0.004)
    decal(p, -0.19, H - 0.08, W / 2 + 0.0235, 0.08, 0.012, "slotDark")
    cyl(p, 0.17, H - 0.1, W / 2 + 0.02, 0.028, 0.02, "burner", axis="v", verts=12)
    decal(p, 0.03, H - 0.095, W / 2 + 0.0145, 0.11, 0.035, "screen")
    for i in range(2):
        decal(p, 0.06 + i * 0.03 - 0.03, H - 0.132, W / 2 + 0.0145, 0.02, 0.012, "keyDark")
    # Porthole door: chrome ring, dark glass, handle lug; kick panel seam.
    torus(p, 0, 0.4, W / 2 + 0.01, 0.155, 0.032, "chrome", axis="v", major_seg=20, minor_seg=6)
    cyl(p, 0, 0.4, W / 2 + 0.004, 0.14, 0.02, "burner", axis="v", verts=20)
    sphere(p, 0, 0.4, W / 2 + 0.01, 0.1, "applianceSteel", scale=(1, 1, 0.18), segments=14, rings=6)
    box(p, 0.175, 0.4, W / 2 + 0.03, 0.04, 0.09, 0.03, "applianceSteel", bev=0.01)
    decal(p, 0, 0.12, W / 2 + 0.0035, W - 0.06, 0.012, "slotDark")

# --- Shadow proxies --------------------------------------------------------------
# Ported from src/world/objects/furniture/proxies.js FURNITURE_PROXIES (fitted
# to these GLBs as rendered; see the table there): (u0, u1, v0, v1, y0, y1, t)
# per box, A first. They become occ_A/occ_B markers, so the manifest carries
# them and furniture-proxies.test.js checks the two copies agree.
PROXIES = {
    "desk": [(-0.835, 0.835, -0.425, 0.425, 0.04, 0.78, 0), (-0.51, 0.11, -0.204, -0.116, 0.951, 1.319, 0)],
    "chair": [(-0.246, 0.246, -0.252, 0.237, 0.409, 0.532, 0), (-0.224, 0.224, -0.261, -0.12, 0.562, 0.938, 0)],
    "table": [(-1.1, 1.1, -0.55, 0.55, 0.585, 0.74, 0), (-1.03, 1.03, -0.48, 0.48, 0, 0.585, 7)],
    "cabinet": [(-0.475, 0.475, -0.225, 0.25, 0, 1.858, 0)],
    "copier": [(-0.425, 0.425, -0.35, 0.364, 0, 1.055, 0), (-0.31, 0.31, 0.34, 0.46, 0.596, 0.624, 0)],
    "cooler": [(-0.21, 0.21, -0.21, 0.21, 0, 0.925, 0), (-0.15, 0.15, -0.146, 0.146, 0.925, 1.395, 0)],
    "plant": [(-0.185, 0.185, -0.185, 0.185, 0, 0.38, 0), (-0.2, 0.09, -0.11, 0.09, 0.38, 0.83, 3)],
    "rack": [(-0.45, 0.45, -0.35, 0.368, 0, 1.905, 0)],
    "sofa": [(-0.8, 0.8, -0.377, 0.345, 0.11, 0.67, 0), (-0.64, 0.64, -0.396, 0.007, 0.67, 0.909, 0)],
    "bookshelf": [(-0.595, 0.595, -0.19, 0.19, 0, 1.858, 0)],
    "whiteboard": [(-0.935, 0.935, -0.028, 0.032, 0.65, 1.85, 0), (-0.7, 0.7, 0, 0.101, 0.632, 0.675, 0)],
    "bed": [(-0.783, 0.783, -1.06, 1.072, 0.19, 0.601, 0), (-0.77, 0.77, -1.06, -0.945, 0.08, 1.19, 0)],
    "nightstand": [(-0.25, 0.25, -0.25, 0.25, 0, 0.6, 0), (-0.14, 0.065, -0.111, 0.083, 0.75, 0.88, 0)],
    "wardrobe": [(-0.655, 0.655, -0.33, 0.337, 0, 2.05, 0)],
    "toilet": [(-0.187, 0.187, -0.105, 0.25, 0, 0.512, 0), (-0.235, 0.235, -0.37, -0.105, 0.43, 0.8, 0)],
    "sink": [(-0.375, 0.375, -0.25, 0.255, 0, 0.888, 0), (-0.36, 0.36, -0.255, -0.215, 1.188, 1.98, 0)],
    "tub": [(-0.825, 0.825, -0.375, 0.375, 0, 0.562, 0)],
    "counter": [(-0.645, 0.645, -0.325, 0.325, 0, 0.9, 0), (-0.645, 0.645, -0.325, -0.147, 0.9, 1.08, 0)],
    "stove": [(-0.325, 0.325, -0.325, 0.34, 0, 0.883, 0), (-0.325, 0.325, -0.32, -0.27, 0.883, 1.14, 0)],
    "fridge": [(-0.375, 0.375, -0.36, 0.367, 0, 1.84, 0)],
    "tv": [(-0.73, 0.73, -0.225, 0.241, 0, 0.505, 0), (-0.62, 0.62, -0.125, -0.04, 0.7, 1.38, 0)],
    "armchair": [(-0.46, 0.425, -0.425, 0.395, 0.11, 0.67, 0), (-0.285, 0.285, -0.446, -0.102, 0.67, 0.909, 0)],
    "washer": [(-0.31, 0.31, -0.31, 0.34, 0, 0.85, 0)],
}


def _with_proxies(kind, build):
    """The builder plus its occ_* markers (EMPTYs: never joined or exported)."""
    def run(p):
        build(p)
        for name, (u0, u1, v0, v1, y0, y1, t) in zip(("occ_A", "occ_B"), PROXIES[kind]):
            marker(p, name, (u0 + u1) / 2, (y0 + y1) / 2, (v0 + v1) / 2, u1 - u0, y1 - y0, v1 - v0, t=t)
    return run


def _kind(kind, build, collision, height, overhang=(0.0, 0.0)):
    """collision = rooms/furnish.js PIECE_DIMS (plus the chair/table/desk sizes
    furnish.js places directly); overhang = the audited allowance past it."""
    return dict(kind=kind, kind_key="FURN_" + kind.upper(), cls="B", build=_with_proxies(kind, build),
                collision=collision, overhang=overhang, height=height, tier="large")


# Audit footprint = collision + overhang (+ the driver's 0.14 m); `height` is
# the budget the top may reach (+0.05).
MODELS = [
    _kind("desk", m_desk, (C["DESK_W"], C["DESK_D"]), C["DESK_H"] + 0.6),
    _kind("chair", m_chair, (C["CHAIR_W"], C["CHAIR_W"]), C["CHAIR_H"]),
    _kind("table", m_table, (C["TABLE_W"], C["TABLE_D"]), C["TABLE_H"]),
    _kind("cabinet", m_cabinet, (C["CABINET_W"], C["CABINET_D"]), C["CABINET_H"]),
    _kind("copier", m_copier, (C["COPIER_W"], C["COPIER_D"]), 1.1),
    _kind("cooler", m_cooler, (C["COOLER_W"], C["COOLER_W"]), C["COOLER_H"] + 0.05),
    _kind("plant", m_plant, (C["PLANT_W"], C["PLANT_W"]), C["PLANT_H"]),
    _kind("rack", m_rack, (C["RACK_W"], C["RACK_D"]), C["RACK_H"]),
    _kind("sofa", m_sofa, (C["SOFA_W"], C["SOFA_D"]), C["SOFA_H"]),
    _kind("bookshelf", m_bookshelf, (C["BOOKSHELF_W"], C["BOOKSHELF_D"]), C["BOOKSHELF_H"]),
    _kind("whiteboard", m_whiteboard, (C["WHITEBOARD_W"], C["WHITEBOARD_D"]), 1.86, overhang=(0.06, 0.0)),
    _kind("bed", m_bed, (C["BED_W"], C["BED_D"]), 1.3),
    _kind("nightstand", m_nightstand, (C["NIGHTSTAND_W"], C["NIGHTSTAND_W"]), C["NIGHTSTAND_H"] + 0.32),
    _kind("wardrobe", m_wardrobe, (C["WARDROBE_W"], C["WARDROBE_D"]), C["WARDROBE_H"], overhang=(0.06, 0.0)),
    _kind("toilet", m_toilet, (C["TOILET_W"], C["TOILET_D"]), C["TOILET_H"]),
    _kind("sink", m_sink, (C["SINK_W"], C["SINK_D"]), 2.0, overhang=(0.08, 0.0)),
    _kind("tub", m_tub, (C["TUB_W"], C["TUB_D"]), C["TUB_H"] + 0.25, overhang=(0.06, 0.06)),
    _kind("counter", m_counter, (C["COUNTER_W"], C["COUNTER_D"]), C["COUNTER_H"] + 0.2, overhang=(0.04, 0.0)),
    _kind("stove", m_stove, (C["STOVE_W"], C["STOVE_D"]), C["STOVE_H"] + 0.26),
    _kind("fridge", m_fridge, (C["FRIDGE_W"], C["FRIDGE_D"]), C["FRIDGE_H"]),
    _kind("tv", m_tv, (C["TV_W"], C["TV_D"]), C["TV_H"]),
    _kind("armchair", m_armchair, (C["ARMCHAIR_W"], C["ARMCHAIR_W"]), C["ARMCHAIR_H"]),
    _kind("washer", m_washer, (C["WASHER_W"], C["WASHER_W"]), C["WASHER_H"]),
]
