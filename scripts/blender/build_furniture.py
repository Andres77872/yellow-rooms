# Yellow Rooms — furniture asset pipeline (Blender 4.x/5.x, background mode).
#
# Builds the 23 collision-real furniture kinds (src/world/rooms/catalog.js) as
# polished low-poly models and exports one GLB per kind for the runtime loader
# (src/render/furnitureModels.js). Re-runnable: dimensions and the part colour
# palette are parsed from the game sources, so tuning constants.js or
# palette.js and re-running this script re-syncs the models.
#
#   blender --background --factory-startup --python scripts/blender/build_furniture.py
#
# Optional positional args after `--`:
#   -- <glbOutDir> <blendOut> <previewPng>
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
# same tolerances.

import math
import os
import re
import sys

import bpy

SCRIPT = os.path.abspath(__file__)
REPO = os.path.dirname(os.path.dirname(os.path.dirname(SCRIPT)))

ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT_DIR = os.path.abspath(ARGV[0]) if len(ARGV) > 0 else os.path.join(REPO, "public", "models", "furniture")
BLEND_OUT = os.path.abspath(ARGV[1]) if len(ARGV) > 1 else os.path.join(REPO, "assets-src", "furniture.blend")
PREVIEW_OUT = os.path.abspath(ARGV[2]) if len(ARGV) > 2 else "/tmp/yr_furniture_preview.png"

TAU = getattr(math, "tau", 2 * math.pi)


# --- Single source of truth: parse the game sources --------------------------

def parse_palette():
    path = os.path.join(REPO, "src", "world", "objects", "furniture", "palette.js")
    src = open(path, encoding="utf-8").read()
    body = re.search(r"FURN_TINT\s*=\s*\{(.*?)\n\}", src, re.S).group(1)
    pal = {}
    for name, r, g, b in re.findall(r"(\w+):\s*\[([\d.]+),\s*([\d.]+),\s*([\d.]+)\]", body):
        pal[name] = (float(r), float(g), float(b))
    if len(pal) < 40:
        raise RuntimeError(f"palette parse failed ({len(pal)} entries)")
    return pal


def parse_constants():
    path = os.path.join(REPO, "src", "world", "constants.js")
    src = open(path, encoding="utf-8").read()
    out = {}
    for name, val in re.findall(r"export const (\w+) = (-?[\d.]+)\s*(?://|\n)", src):
        out[name] = float(val)
    need = ["DESK_W", "DESK_D", "DESK_H", "CHAIR_W", "CHAIR_H", "CHAIR_SEAT_H",
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
            "WASHER_W", "WASHER_H"]
    missing = [n for n in need if n not in out]
    if missing:
        raise RuntimeError(f"constants parse failed, missing: {missing}")
    return out


PAL = parse_palette()
C = parse_constants()

# --- Scene + material plumbing ------------------------------------------------

# Wipe the factory scene (default cube/light/camera).
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
for block in (bpy.data.meshes, bpy.data.curves, bpy.data.cameras, bpy.data.lights):
    for data in list(block):
        block.remove(data)

COLLECTION = bpy.data.collections.new("YR_FURNITURE")
bpy.context.scene.collection.children.link(COLLECTION)

_MATS = {}
METAL_KEYS = {"chrome", "applianceSteel", "legMetal"}


def mat(key):
    if key in _MATS:
        return _MATS[key]
    m = bpy.data.materials.new("yr_" + key)
    m.use_nodes = True
    r, g, b = PAL[key]
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (r, g, b, 1.0)
    if key in METAL_KEYS:
        bsdf.inputs["Metallic"].default_value = 0.85
        bsdf.inputs["Roughness"].default_value = 0.32
    else:
        bsdf.inputs["Metallic"].default_value = 0.0
        bsdf.inputs["Roughness"].default_value = 0.78
    m.diffuse_color = (r, g, b, 1.0)
    _MATS[key] = m
    return m


def activate(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def link(obj):
    # Move from the scene-default collection into ours.
    for col in list(obj.users_collection):
        col.objects.unlink(obj)
    COLLECTION.objects.link(obj)


def finish(obj, key, bev=0.0, smooth=False):
    link(obj)
    obj.data.materials.append(mat(key))
    if bev > 0:
        mod = obj.modifiers.new("bev", "BEVEL")
        mod.width = bev
        # Small chamfers need one ring; upholstery keeps a soft silhouette.
        mod.segments = 2 if bev >= 0.02 else 1
        mod.limit_method = "ANGLE"
        activate(obj)
        bpy.ops.object.modifier_apply(modifier="bev")
        # Smooth bevel strips while weighting the large planar faces: flat
        # polygon normals made every chamfer segment trigger an ink outline.
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
        normals = obj.modifiers.new("weighted_normals", "WEIGHTED_NORMAL")
        normals.keep_sharp = True
        normals.weight = 50
        bpy.ops.object.modifier_apply(modifier=normals.name)
    if smooth:
        activate(obj)
        try:
            bpy.ops.object.shade_smooth_by_angle(angle=0.9)
        except Exception:
            for p in obj.data.polygons:
                p.use_smooth = True
    return obj


# --- Primitive helpers (game frame: u right, y up, v front) -------------------
# Blender mapping: location (u, -v, y); blender box dims (su, sv, sy).

def box(parts, cu, cy, cv, su, sy, sv, key, bev=0.01, rot=None):
    bpy.ops.mesh.primitive_cube_add(location=(cu, -cv, cy))
    o = bpy.context.active_object
    o.scale = (su / 2, sv / 2, sy / 2)
    activate(o)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if rot:
        o.rotation_euler = rot
    finish(o, key, bev=min(bev, su / 2.5, sy / 2.5, sv / 2.5) if bev >= 0.004 else 0.0)
    parts.append(o)
    return o


def cyl(parts, cu, cy, cv, r, h, key, axis="y", bev=0.0, verts=16, smooth=True):
    rot = (0, 0, 0)
    if axis == "v":
        rot = (math.radians(90), 0, 0)
    elif axis == "u":
        rot = (0, math.radians(90), 0)
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=h,
                                        location=(cu, -cv, cy), rotation=rot)
    o = bpy.context.active_object
    finish(o, key, bev=bev, smooth=smooth)
    parts.append(o)
    return o


def cone(parts, cu, cy, cv, r1, r2, h, key, rot=None, verts=16, smooth=True):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r1, radius2=r2, depth=h,
                                    location=(cu, -cv, cy), rotation=rot or (0, 0, 0))
    o = bpy.context.active_object
    finish(o, key, smooth=smooth)
    parts.append(o)
    return o


def sphere(parts, cu, cy, cv, r, key, scale=(1, 1, 1), smooth=True):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8, radius=r,
                                         location=(cu, -cv, cy))
    o = bpy.context.active_object
    o.scale = (scale[0], scale[2], scale[1])
    activate(o)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    finish(o, key, smooth=smooth)
    parts.append(o)
    return o


def torus(parts, cu, cy, cv, major, minor, key, axis="y", smooth=True):
    rot = (math.radians(90), 0, 0) if axis == "v" else (0, 0, 0)
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor,
                                     major_segments=24, minor_segments=6,
                                     location=(cu, -cv, cy), rotation=rot)
    o = bpy.context.active_object
    finish(o, key, smooth=smooth)
    parts.append(o)
    return o


def bowl(parts, cu, cv, profile, key, segments=28):
    """Closed elliptical shell, outer bottom -> rim -> recessed inner floor."""
    vertices = []
    for ru, rv, y in profile:
        for i in range(segments):
            a = i * TAU / segments
            vertices.append((cu + ru * math.cos(a), -cv + rv * math.sin(a), y))
    faces = [tuple(reversed(range(segments)))]
    for ring in range(len(profile) - 1):
        for i in range(segments):
            j = (i + 1) % segments
            faces.append((ring * segments + i, ring * segments + j,
                          (ring + 1) * segments + j, (ring + 1) * segments + i))
    faces.append(tuple(range((len(profile) - 1) * segments, len(profile) * segments)))
    mesh = bpy.data.meshes.new("basin_shell")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new("basin_shell", mesh)
    bpy.context.collection.objects.link(obj)
    finish(obj, key, smooth=True)
    parts.append(obj)
    return obj


def leaf(parts, cu, cy, cv, height, angle, lean):
    """A folded, tapered blade rooted in the soil, with a closed thin back."""
    vertices = []
    for t, half_width in ((0, 0.012), (0.45, 0.035), (0.82, 0.024), (1, 0.001)):
        spread = math.sin(lean) * height * t * t
        for side, fold in ((-1, 0), (0, -0.004), (1, 0), (0, 0.007)):
            u = cu + math.cos(angle) * (spread + fold) - math.sin(angle) * half_width * side
            v = cv + math.sin(angle) * (spread + fold) + math.cos(angle) * half_width * side
            vertices.append((u, -v, cy + height * t))
    faces = [(3, 2, 1, 0)]
    for ring in range(3):
        for i in range(4):
            faces.append((ring * 4 + i, ring * 4 + (i + 1) % 4,
                          (ring + 1) * 4 + (i + 1) % 4, (ring + 1) * 4 + i))
    faces.append((12, 13, 14, 15))
    mesh = bpy.data.meshes.new("snake_plant_leaf")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new("snake_plant_leaf", mesh)
    bpy.context.collection.objects.link(obj)
    finish(obj, "leafGreen")
    parts.append(obj)


# --- The 23 models -------------------------------------------------------------
# Each builder appends parts into `p` (list of objects). Design language follows
# the original box builders (same silhouettes, same palette) upgraded with
# bevels, tapers and curved primitives where the real object is curved.

def m_desk(p):
    W, D, H = C["DESK_W"], C["DESK_D"], C["DESK_H"]
    box(p, 0, H - 0.02, 0, W, 0.04, D, "laminate", bev=0.015)
    box(p, -(W / 2 - 0.04), (H - 0.04) / 2, 0, 0.05, H - 0.04, D - 0.08, "legMetal", bev=0.008)
    box(p, W / 2 - 0.04, (H - 0.04) / 2, 0, 0.05, H - 0.04, D - 0.08, "legMetal", bev=0.008)
    box(p, 0, 0.45, -(D / 2 - 0.07), W - 0.2, 0.38, 0.025, "panel", bev=0.006)
    # Drawer stack (right): case, two proud fronts, bar handles.
    box(p, W / 2 - 0.28, 0.33, 0, 0.42, 0.58, D - 0.12, "panel", bev=0.01)
    box(p, W / 2 - 0.28, 0.46, D / 2 - 0.052, 0.38, 0.18, 0.02, "drawerFace", bev=0.005)
    box(p, W / 2 - 0.28, 0.18, D / 2 - 0.052, 0.38, 0.28, 0.02, "drawerFace", bev=0.005)
    box(p, W / 2 - 0.28, 0.40, D / 2 - 0.05, 0.14, 0.02, 0.03, "legMetal", bev=0.004)
    box(p, W / 2 - 0.28, 0.32, D / 2 - 0.05, 0.14, 0.02, 0.03, "legMetal", bev=0.004)
    # Monitor: bezel + screen face (slight back tilt), stand, foot.
    box(p, -0.18, H + 0.36, -0.13, 0.58, 0.36, 0.025, "keyDark", bev=0.012, rot=(math.radians(6), 0, 0))
    box(p, -0.18, H + 0.36, -0.115, 0.54, 0.32, 0.012, "screen", bev=0.008, rot=(math.radians(6), 0, 0))
    cyl(p, -0.18, H + 0.16, -0.14, 0.02, 0.3, "legMetal")
    cyl(p, -0.18, H + 0.012, -0.12, 0.09, 0.024, "legMetal", verts=24)
    # Keyboard + mouse.
    box(p, -0.05, H + 0.012, 0.15, 0.44, 0.024, 0.16, "keyDark", bev=0.007)
    sphere(p, 0.28, H + 0.022, 0.16, 0.05, "keyDark", scale=(0.7, 0.45, 1.0))
    # Desk lamp (back-left): base, stem, cone shade.
    cyl(p, -(W / 2 - 0.15), H + 0.015, -(D / 2 - 0.13), 0.07, 0.03, "legMetal", verts=24)
    cyl(p, -(W / 2 - 0.15), H + 0.17, -(D / 2 - 0.13), 0.013, 0.28, "legMetal")
    cone(p, -(W / 2 - 0.15), H + 0.34, -(D / 2 - 0.2), 0.075, 0.045, 0.11, "shade",
         rot=(math.radians(35), 0, 0))
    # Papers + mug.
    box(p, -(W / 2 - 0.26), H + 0.015, D / 2 - 0.19, 0.3, 0.03, 0.21, "paperWhite", bev=0.004)
    box(p, -(W / 2 - 0.27), H + 0.04, D / 2 - 0.2, 0.28, 0.012, 0.2, "paperWhite",
        bev=0.003, rot=(0, 0, math.radians(6)))
    cyl(p, 0.42, H + 0.045, 0.2, 0.035, 0.09, "potClay", verts=16)


def m_chair(p):
    W, H, SEAT = C["CHAIR_W"], C["CHAIR_H"], C["CHAIR_SEAT_H"]
    box(p, 0, SEAT + 0.045, 0, W - 0.06, 0.09, W - 0.05, "fabric", bev=0.032)
    # Back with a slight rearward lean and a lumbar pad.
    lean = math.radians(-7)
    box(p, 0, (H + SEAT) / 2 + 0.06, -(W / 2 - 0.05), W - 0.09, H - SEAT - 0.04, 0.08,
        "fabric", bev=0.028, rot=(lean, 0, 0))
    box(p, 0, SEAT + 0.22, -(W / 2 - 0.09), W - 0.2, 0.14, 0.06, "fabric", bev=0.02, rot=(lean, 0, 0))
    # Gas lift + shroud.
    cyl(p, 0, SEAT / 2 + 0.02, 0, 0.026, SEAT - 0.06, "legMetal")
    cone(p, 0, 0.16, 0, 0.055, 0.035, 0.14, "keyDark")
    # Five-star base: radial legs + caster balls.
    for i in range(5):
        a = i * TAU / 5 + 0.31
        cu, cv = 0.14 * math.cos(a), 0.14 * math.sin(a)
        box(p, cu, 0.075, cv, 0.26, 0.035, 0.055, "legMetal", bev=0.01, rot=(0, 0, -a))
        sphere(p, 0.26 * math.cos(a), 0.02805, 0.26 * math.sin(a), 0.033, "keyDark", scale=(1, 0.85, 1))


def m_table(p):
    W, D, H = C["TABLE_W"], C["TABLE_D"], C["TABLE_H"]
    box(p, 0, H - 0.025, 0, W, 0.05, D, "laminate", bev=0.018)
    box(p, 0, H - 0.11, D / 2 - 0.07, W - 0.3, 0.1, 0.04, "panel", bev=0.006)
    box(p, 0, H - 0.11, -(D / 2 - 0.07), W - 0.3, 0.1, 0.04, "panel", bev=0.006)
    box(p, W / 2 - 0.12, H - 0.11, 0, 0.04, 0.1, D - 0.2, "panel", bev=0.006)
    box(p, -(W / 2 - 0.12), H - 0.11, 0, 0.04, 0.1, D - 0.2, "panel", bev=0.006)
    for su in (-1, 1):
        for sv in (-1, 1):
            cone(p, su * (W / 2 - 0.12), (H - 0.05) / 2, sv * (D / 2 - 0.12),
                 0.055, 0.038, H - 0.05, "legMetal")
    cyl(p, -0.55, H + 0.004, 0, 0.055, 0.014, "keyDark", verts=24)
    cyl(p, 0.55, H + 0.004, 0, 0.055, 0.014, "keyDark", verts=24)


def m_cabinet(p):
    W, D, H = C["CABINET_W"], C["CABINET_D"], C["CABINET_H"]
    box(p, 0, 0.05, 0, W - 0.06, 0.1, D - 0.04, "legMetal", bev=0.008)
    box(p, 0, (H + 0.1) / 2 + 0.0, 0, W, H - 0.1, D, "cabinetPaint", bev=0.014)
    box(p, -0.2275, 0.97, D / 2 + 0.008, 0.435, 1.6, 0.022, "panel", bev=0.006)
    box(p, 0.2275, 0.97, D / 2 + 0.008, 0.435, 1.6, 0.022, "panel", bev=0.006)
    box(p, -0.05, 0.97, D / 2 + 0.026, 0.025, 0.2, 0.02, "legMetal", bev=0.004)
    box(p, 0.05, 0.97, D / 2 + 0.026, 0.025, 0.2, 0.02, "legMetal", bev=0.004)
    box(p, -0.2275, 1.52, D / 2 + 0.022, 0.18, 0.06, 0.012, "slotDark", bev=0.003)
    box(p, 0.2275, 1.52, D / 2 + 0.022, 0.18, 0.06, 0.012, "slotDark", bev=0.003)
    box(p, 0, H - 0.004, 0, W - 0.02, 0.024, D - 0.02, "panel", bev=0.006)


def m_copier(p):
    W, D, H = C["COPIER_W"], C["COPIER_D"], C["COPIER_H"]
    box(p, 0, 0.47, 0, W, 0.94, D, "copierBody", bev=0.025)
    box(p, 0, 0.055, D / 2 - 0.02, W - 0.14, 0.11, 0.05, "slotDark", bev=0.006)
    box(p, 0, H - 0.065, -0.02, W - 0.06, 0.09, D - 0.08, "panel", bev=0.012)
    box(p, 0, H + 0.02, -(D / 2 - 0.09), W - 0.2, 0.06, 0.16, "panel", bev=0.008)
    # Output slot + pulled tray with a printed stack.
    box(p, 0, 0.63, D / 2 + 0.006, 0.65, 0.08, 0.02, "slotDark")
    box(p, 0, 0.32, D / 2 + 0.05, 0.68, 0.025, 0.14, "drawerFace", bev=0.004)
    box(p, 0, 0.36, D / 2 + 0.05, 0.6, 0.05, 0.11, "paperWhite", bev=0.003)
    box(p, W / 2 - 0.1, H + 0.005, 0.12, 0.14, 0.03, 0.2, "keyDark", bev=0.005)
    for i in range(3):
        box(p, -W / 2 - 0.002, 0.35 + i * 0.16, 0, 0.012, 0.08, D - 0.3, "slotDark")


def m_cooler(p):
    W, H = C["COOLER_W"], C["COOLER_H"]
    box(p, 0, 0.44, 0, W, 0.88, W, "coolerWhite", bev=0.035)
    box(p, 0, 0.62, W / 2 + 0.03, 0.2, 0.03, 0.09, "slotDark", bev=0.004)
    for su in (-1, 1):
        box(p, su * 0.065, 0.74, W / 2 + 0.02, 0.05, 0.045, 0.06, "legMetal", bev=0.006)
        cyl(p, su * 0.065, 0.7, W / 2 + 0.045, 0.011, 0.035, "legMetal", verts=12)
    cyl(p, 0, 0.9, 0, 0.13, 0.045, "coolerWhite", verts=24)
    # The water bottle: shoulder sphere + body + neck + cap.
    cyl(p, 0, 1.1, 0, 0.15, 0.34, "bottleBlue", verts=24)
    sphere(p, 0, 1.27, 0, 0.15, "bottleBlue", scale=(1, 0.55, 1))
    cyl(p, 0, 1.33, 0, 0.055, 0.1, "bottleBlue", verts=16)
    cyl(p, 0, 1.375, 0, 0.045, 0.028, "coolerWhite", verts=16)
    # Cup dispenser on the flank (slight overhang, as the original).
    cyl(p, W / 2 + 0.03, 0.68, 0.04, 0.036, 0.3, "coolerWhite", verts=16)
    cyl(p, W / 2 + 0.03, 0.52, 0.04, 0.03, 0.025, "slotDark", verts=12)


def m_plant(p):
    # Snake plant: tapered pot + a rosette of stiff blades.
    cone(p, 0, 0.17, 0, 0.155, 0.19, 0.34, "potClay", verts=24)
    cyl(p, 0, 0.36, 0, 0.2, 0.05, "potClay", verts=24)
    cyl(p, 0, 0.385, 0, 0.175, 0.025, "soil", verts=24)
    blades = [
        (0.0, 0.0, 0.7, 2), (0.05, 0.04, 0.62, 9), (-0.05, 0.03, 0.56, 14),
        (0.04, -0.05, 0.5, 18), (-0.04, -0.04, 0.45, 22), (0.09, -0.01, 0.4, 26),
        (-0.09, 0.01, 0.36, 30),
    ]
    for i, (bu, bv, h, tilt) in enumerate(blades):
        a = i * 2.4  # golden-ish spread
        leaf(p, bu, 0.395, bv, h, a, math.radians(tilt))


def m_rack(p):
    W, D, H = C["RACK_W"], C["RACK_D"], C["RACK_H"]
    box(p, 0, 0.05, 0, W - 0.06, 0.1, D - 0.04, "legMetal", bev=0.008)
    box(p, 0, H / 2 + 0.04, 0, W, H - 0.08, D, "rackDark", bev=0.012)
    box(p, 0, H / 2 + 0.04, D / 2 + 0.004, W - 0.1, H - 0.2, 0.02, "rackFace", bev=0.004)
    for su in (-1, 1):
        box(p, su * (W / 2 - 0.07), H / 2 + 0.04, D / 2 + 0.012, 0.035, H - 0.2, 0.014, "legMetal")
    # Six server units with vent lines; status LEDs on a deterministic pattern.
    for i in range(6):
        y = 0.32 + i * 0.27
        box(p, 0, y, D / 2 + 0.012, W - 0.22, 0.21, 0.012, "slotDark")
        box(p, -0.3, y + 0.05, D / 2 + 0.02, 0.035, 0.02, 0.008, "ledGreen")
        box(p, -0.24, y + 0.05, D / 2 + 0.02, 0.035, 0.02, 0.008,
            "bookRed" if i == 3 else "ledGreen")
    box(p, 0, H - 0.005, 0, W - 0.16, 0.02, D - 0.16, "slotDark", bev=0.004)


def m_sofa(p):
    W, D, H = C["SOFA_W"], C["SOFA_D"], C["SOFA_H"]
    for su in (-1, 1):
        for sv in (-1, 1):
            cone(p, su * (W / 2 - 0.09), 0.055, sv * (D / 2 - 0.09), 0.032, 0.024, 0.11, "woodDark", verts=12)
    box(p, 0, 0.26, 0, W - 0.16, 0.3, D - 0.1, "sofa", bev=0.045)
    box(p, -(W / 2 - 0.08), 0.52, 0, 0.16, 0.66, D, "sofa", bev=0.05)
    box(p, W / 2 - 0.08, 0.52, 0, 0.16, 0.66, D, "sofa", bev=0.05)
    box(p, 0, 0.64, -(D / 2 - 0.09), W - 0.16, 0.56, 0.18, "sofa", bev=0.05, rot=(math.radians(-5), 0, 0))
    box(p, -(W / 4 - 0.06), 0.46, 0.03, W / 2 - 0.2, 0.17, D - 0.28, "sofaCushion", bev=0.05)
    box(p, W / 4 - 0.06, 0.46, 0.03, W / 2 - 0.2, 0.17, D - 0.28, "sofaCushion", bev=0.05)
    box(p, -(W / 4 - 0.06), 0.68, -(D / 2 - 0.2), W / 2 - 0.2, 0.36, 0.15, "sofaCushion",
        bev=0.045, rot=(math.radians(-6), 0, 0))
    box(p, W / 4 - 0.06, 0.68, -(D / 2 - 0.2), W / 2 - 0.2, 0.36, 0.15, "sofaCushion",
        bev=0.045, rot=(math.radians(-6), 0, 0))


def m_bookshelf(p):
    W, D, H = C["BOOKSHELF_W"], C["BOOKSHELF_D"], C["BOOKSHELF_H"]
    box(p, -(W / 2 - 0.02), H / 2, 0, 0.04, H, D, "shelfWood", bev=0.006)
    box(p, W / 2 - 0.02, H / 2, 0, 0.04, H, D, "shelfWood", bev=0.006)
    box(p, 0, H / 2, -(D / 2 - 0.015), W - 0.08, H - 0.06, 0.03, "panel", bev=0.003)
    box(p, 0, 0.045, 0, W - 0.06, 0.09, D - 0.02, "shelfWood", bev=0.006)
    box(p, 0, H + 0.005, 0, W + 0.04, 0.05, D + 0.03, "shelfWood", bev=0.008)
    book_tints = ["bookRed", "bookBlue", "bookTan", "paperWhite"]
    for s in range(3):
        y = 0.32 + s * 0.38
        box(p, 0, y, 0, W - 0.08, 0.03, D - 0.05, "shelfWood", bev=0.004)
        # A run of individual books: varied heights, one horizontal stack gap.
        u = -(W / 2 - 0.12)
        k = 0
        while u < W / 2 - 0.16:
            w = 0.032 + 0.008 * ((s * 7 + k * 3) % 3)
            if (s + k) % 5 == 4:  # horizontal stack instead of a standing book
                box(p, u + 0.06, y + 0.035, 0, 0.16, 0.04, 0.2, book_tints[(s + k) % 4], bev=0.003)
                box(p, u + 0.06, y + 0.075, 0, 0.15, 0.032, 0.19, book_tints[(s + k + 2) % 4], bev=0.003)
                u += 0.17
            else:
                h = 0.22 + 0.05 * ((s * 5 + k * 7) % 3)
                box(p, u + w / 2, y + 0.015 + h / 2, 0, w, h, 0.2, book_tints[(s + k) % 4], bev=0.002)
                u += w + 0.004
            k += 1
    box(p, 0, 1.46, 0, W - 0.08, 0.03, D - 0.05, "shelfWood", bev=0.004)
    box(p, 0.12, 1.5, 0, 0.26, 0.05, 0.2, "bookTan", bev=0.004)
    box(p, 0.12, 1.545, 0, 0.22, 0.04, 0.17, "bookRed", bev=0.004)
    box(p, -0.26, 1.52, 0, 0.24, 0.09, 0.19, "paperWhite", bev=0.004)


def m_whiteboard(p):
    W, H = C["WHITEBOARD_W"], C["WHITEBOARD_H"]
    cy = 0.7 + H / 2
    box(p, 0, cy, 0, W, H, 0.04, "boardWhite", bev=0.008)
    box(p, 0, cy + H / 2 + 0.02, 0, W + 0.06, 0.05, 0.055, "legMetal", bev=0.006)
    box(p, 0, cy - H / 2 - 0.02, 0, W + 0.06, 0.05, 0.055, "legMetal", bev=0.006)
    box(p, -(W / 2 + 0.005), cy, 0, 0.05, H - 0.01, 0.055, "legMetal", bev=0.006)
    box(p, W / 2 + 0.005, cy, 0, 0.05, H - 0.01, 0.055, "legMetal", bev=0.006)
    # Faint erased writing + a red diagram: the "someone worked here" read.
    box(p, -0.35, cy + 0.28, 0.022, 0.6, 0.028, 0.004, "keyDark")
    box(p, -0.45, cy + 0.16, 0.022, 0.35, 0.028, 0.004, "keyDark")
    box(p, -0.3, cy + 0.04, 0.022, 0.45, 0.028, 0.004, "keyDark")
    box(p, 0.5, cy + 0.1, 0.022, 0.28, 0.2, 0.004, "bookRed")
    box(p, 0, cy - H / 2 - 0.055, 0.05, 1.4, 0.03, 0.1, "legMetal", bev=0.005)
    cyl(p, -0.35, cy - H / 2 - 0.02, 0.06, 0.013, 0.13, "keyDark", axis="u", verts=10)
    cyl(p, -0.18, cy - H / 2 - 0.02, 0.06, 0.013, 0.13, "bookRed", axis="u", verts=10)
    box(p, 0.4, cy - H / 2 - 0.015, 0.06, 0.1, 0.045, 0.06, "panel", bev=0.006)


def m_bed(p):
    W, D, H = C["BED_W"], C["BED_D"], C["BED_H"]
    box(p, 0, 0.62, -(D / 2 - 0.035), W, 1.08, 0.07, "bedFrame", bev=0.02)
    box(p, 0, 0.66, -(D / 2 - 0.075), W - 0.18, 0.82, 0.03, "woodMid", bev=0.01)
    for su in (-1, 1):
        for sv in (-1, 1):
            box(p, su * (W / 2 - 0.06), 0.095, sv * (D / 2 - 0.07), 0.09, 0.19, 0.09, "bedFrame", bev=0.012)
    box(p, 0, 0.27, 0, W, 0.16, D, "bedFrame", bev=0.015)
    box(p, 0, 0.45, 0.02, W - 0.08, 0.22, D - 0.14, "mattress", bev=0.05)
    # Blanket across the foot, draping over the foot edge.
    box(p, 0, 0.565, 0.5, W - 0.06, 0.06, 1.0, "blanket", bev=0.02)
    box(p, 0, 0.48, D / 2 - 0.09, W - 0.06, 0.22, 0.05, "blanket", bev=0.015)
    box(p, -0.35, 0.6, -0.68, 0.56, 0.13, 0.36, "pillow", bev=0.055)
    box(p, 0.35, 0.6, -0.68, 0.56, 0.13, 0.36, "pillow", bev=0.055)


def m_nightstand(p):
    W, H = C["NIGHTSTAND_W"], C["NIGHTSTAND_H"]
    box(p, 0, 0.03, 0, W - 0.08, 0.06, W - 0.08, "woodDark", bev=0.008)
    box(p, 0, H / 2 + 0.03, 0, W, H - 0.06, W - 0.04, "woodDark", bev=0.012)
    box(p, 0, 0.43, W / 2 - 0.015, W - 0.1, 0.15, 0.02, "woodMid", bev=0.005)
    sphere(p, 0, 0.43, W / 2 + 0.015, 0.018, "chrome")
    box(p, 0, 0.22, W / 2 - 0.012, W - 0.1, 0.14, 0.015, "slotDark", bev=0.003)
    # Bedside lamp: chrome stem, parchment shade.
    cyl(p, 0, H + 0.015, 0, 0.06, 0.03, "chrome", verts=20)
    cyl(p, 0, H + 0.11, 0, 0.012, 0.16, "chrome", verts=10)
    cone(p, 0, H + 0.24, 0, 0.1, 0.065, 0.12, "shade", verts=20)


def m_wardrobe(p):
    W, D, H = C["WARDROBE_W"], C["WARDROBE_D"], C["WARDROBE_H"]
    box(p, 0, 0.05, 0, W - 0.08, 0.1, D - 0.06, "woodDark", bev=0.008)
    box(p, 0, H / 2 + 0.02, 0, W, H - 0.1, D, "woodDark", bev=0.014)
    box(p, 0, H - 0.02, 0, W + 0.06, 0.07, D + 0.04, "woodMid", bev=0.008)
    box(p, -0.3025, 1.03, D / 2 + 0.008, 0.575, 1.76, 0.022, "woodMid", bev=0.006)
    box(p, 0.3025, 1.03, D / 2 + 0.008, 0.575, 1.76, 0.022, "woodMid", bev=0.006)
    box(p, 0, 1.03, D / 2 + 0.016, 0.016, 1.76, 0.012, "slotDark")
    cyl(p, -0.075, 1.1, D / 2 + 0.035, 0.012, 0.3, "chrome", verts=10)
    cyl(p, 0.075, 1.1, D / 2 + 0.035, 0.012, 0.3, "chrome", verts=10)


def m_toilet(p):
    W, D, H = C["TOILET_W"], C["TOILET_D"], C["TOILET_H"]
    box(p, 0, 0.6, -(D / 2 - 0.1), W, 0.34, 0.2, "porcelain", bev=0.025)
    box(p, 0, 0.78, -(D / 2 - 0.1), W + 0.02, 0.035, 0.22, "porcelain", bev=0.01)
    cyl(p, 0.12, 0.81, -(D / 2 - 0.1), 0.024, 0.016, "chrome", verts=14)
    cone(p, 0, 0.16, 0.02, 0.17, 0.14, 0.32, "porcelain", verts=24)
    bowl(p, 0, 0.06, [
        (0.13, 0.15, 0.30), (W / 2, 0.225, 0.47),
        (W / 2 - 0.015, 0.21, 0.51), (0.145, 0.155, 0.51),
        (0.12, 0.13, 0.44), (0.075, 0.085, 0.36),
    ], "porcelain")
    cyl(p, 0, 0.368, 0.06, 0.075, 0.012, "mirror", verts=20)
    # Lid raised against the tank.
    box(p, 0, 0.62, -(D / 2 - 0.22), W - 0.04, 0.42, 0.05, "porcelain",
        bev=0.02, rot=(math.radians(-12), 0, 0))


def m_sink(p):
    W, D, H = C["SINK_W"], C["SINK_D"], C["SINK_H"]
    box(p, 0, 0.37, 0, W - 0.05, 0.74, D - 0.04, "woodDark", bev=0.012)
    box(p, 0, 0.39, D / 2 - 0.012, W - 0.12, 0.6, 0.02, "woodMid", bev=0.005)
    sphere(p, 0.18, 0.5, D / 2 + 0.012, 0.016, "chrome")
    # Vessel basin sits above the counter: the old inset was entirely hidden
    # inside a solid slab, so the sink rendered as a flat porcelain block.
    box(p, 0, H - 0.10, 0, W, 0.06, D, "porcelain", bev=0.012)
    bowl(p, 0, 0.02, [
        (0.14, 0.105, H - 0.07), (0.25, 0.18, H + 0.018),
        (0.25, 0.18, H + 0.035), (0.218, 0.15, H + 0.035),
        (0.19, 0.125, H - 0.015), (0.12, 0.075, H - 0.048),
    ], "porcelain")
    cyl(p, 0, H - 0.039, 0.02, 0.019, 0.012, "chrome", verts=12)
    # Faucet: riser, spout, downturned nozzle.
    cyl(p, 0, H + 0.1, -(D / 2 - 0.08), 0.02, 0.2, "chrome", verts=12)
    cyl(p, 0, H + 0.2, -(D / 2 - 0.16), 0.015, 0.16, "chrome", axis="v", verts=12)
    cyl(p, 0, H + 0.17, -(D / 2 - 0.235), 0.012, 0.05, "chrome", verts=10)
    # Wall mirror + shelf (the original floats these above the piece).
    box(p, 0, 1.6, -(D / 2 - 0.015), 0.72, 0.76, 0.02, "woodDark", bev=0.008)
    box(p, 0, 1.6, -(D / 2 - 0.028), 0.66, 0.7, 0.012, "mirror", bev=0.004)
    box(p, 0, 1.2, -(D / 2 - 0.04), 0.7, 0.03, 0.09, "woodDark", bev=0.004)
    # Towel rail on the +u flank.
    cyl(p, W / 2 + 0.03, 1.15, 0, 0.011, 0.26, "chrome", axis="v", verts=10)
    box(p, W / 2 + 0.02, 0.98, 0, 0.02, 0.3, 0.22, "towel", bev=0.006)


def m_tub(p):
    W, D, H = C["TUB_W"], C["TUB_D"], C["TUB_H"]
    # A recessed interior with actual side walls; no coplanar water/rim slab.
    box(p, 0, 0.065, 0, W - 0.08, 0.13, D - 0.08, "porcelain", bev=0.025)
    for side in (-1, 1):
        box(p, 0, (H + 0.1) / 2, side * (D / 2 - 0.055),
            W, H - 0.1, 0.11, "porcelain", bev=0.025)
        box(p, side * (W / 2 - 0.055), (H + 0.1) / 2, 0,
            0.11, H - 0.1, D - 0.16, "porcelain", bev=0.025)
        box(p, 0, H - 0.015, side * (D / 2 - 0.035),
            W + 0.06, 0.05, 0.13, "porcelain", bev=0.018)
        box(p, side * (W / 2 - 0.035), H - 0.015, 0,
            0.13, 0.05, D - 0.15, "porcelain", bev=0.018)
    box(p, 0, 0.14, 0, W - 0.18, 0.035, D - 0.18, "porcelain", bev=0.014)
    cyl(p, -(W / 2 - 0.26), 0.164, 0, 0.025, 0.012, "chrome", verts=12)
    # Tap pair at the wall-end corner.
    cyl(p, -(W / 2 - 0.12), H + 0.1, -(D / 2 - 0.1), 0.017, 0.18, "chrome", verts=12)
    cyl(p, -(W / 2 - 0.12), H + 0.17, -(D / 2 - 0.17), 0.013, 0.14, "chrome", axis="v", verts=12)


def m_counter(p):
    W, D, H = C["COUNTER_W"], C["COUNTER_D"], C["COUNTER_H"]
    box(p, 0, 0.05, 0, W - 0.08, 0.1, D - 0.06, "legMetal", bev=0.006)
    box(p, 0, 0.47, 0, W, 0.76, D - 0.04, "woodDark", bev=0.01)
    box(p, -0.31, 0.44, D / 2 - 0.012, 0.56, 0.58, 0.02, "woodMid", bev=0.005)
    box(p, 0.31, 0.44, D / 2 - 0.012, 0.56, 0.58, 0.02, "woodMid", bev=0.005)
    box(p, -0.31, 0.7, D / 2 + 0.012, 0.14, 0.022, 0.02, "chrome", bev=0.004)
    box(p, 0.31, 0.7, D / 2 + 0.012, 0.14, 0.022, 0.02, "chrome", bev=0.004)
    box(p, 0, H - 0.03, 0, W + 0.04, 0.06, D, "counterTop", bev=0.012)
    box(p, 0, H + 0.09, -(D / 2 - 0.015), W + 0.04, 0.2, 0.025, "counterTop", bev=0.006)


def m_stove(p):
    W, D, H = C["STOVE_W"], C["STOVE_D"], C["STOVE_H"]
    box(p, 0, 0.42, 0, W, 0.84, D, "applianceWhite", bev=0.018)
    box(p, 0, H - 0.045, 0, W - 0.03, 0.03, D - 0.03, "applianceSteel", bev=0.006)
    for su in (-1, 1):
        for sv in (-1, 1):
            cyl(p, su * 0.14, H - 0.022, sv * 0.14, 0.068, 0.016, "burner", verts=20, smooth=False)
            cyl(p, su * 0.14, H - 0.012, sv * 0.14, 0.028, 0.012, "slotDark", verts=14, smooth=False)
    # Oven: proud door, window, bar handle.
    box(p, 0, 0.4, D / 2 + 0.005, 0.56, 0.42, 0.02, "applianceSteel", bev=0.006)
    box(p, 0, 0.42, D / 2 + 0.017, 0.42, 0.24, 0.012, "burner", bev=0.003)
    cyl(p, 0, 0.65, D / 2 + 0.03, 0.012, 0.5, "chrome", axis="u", verts=10)
    # Control backsplash with dials.
    box(p, 0, H + 0.12, -(D / 2 - 0.03), W, 0.24, 0.05, "applianceWhite", bev=0.008)
    for i in range(3):
        cyl(p, -0.14 + i * 0.14, H + 0.13, -(D / 2 - 0.055), 0.02, 0.02, "burner",
            axis="v", verts=12, smooth=False)


def m_fridge(p):
    W, D, H = C["FRIDGE_W"], C["FRIDGE_D"], C["FRIDGE_H"]
    box(p, 0, 0.05, 0, W - 0.06, 0.1, D - 0.06, "slotDark", bev=0.006)
    box(p, 0, H / 2 + 0.04, 0, W, H - 0.1, D, "applianceWhite", bev=0.022)
    box(p, 0, 1.56, D / 2 + 0.008, W - 0.04, 0.5, 0.025, "applianceWhite", bev=0.012)
    box(p, 0, 0.72, D / 2 + 0.008, W - 0.04, 1.12, 0.025, "applianceWhite", bev=0.012)
    box(p, 0, 1.29, D / 2 + 0.016, W - 0.06, 0.022, 0.02, "slotDark")
    cyl(p, -(W / 2 - 0.08), 1.56, D / 2 + 0.035, 0.013, 0.3, "applianceSteel", verts=10)
    cyl(p, -(W / 2 - 0.08), 0.85, D / 2 + 0.035, 0.013, 0.5, "applianceSteel", verts=10)


def m_tv(p):
    W, D, H = C["TV_W"], C["TV_D"], C["TV_H"]
    box(p, -(W / 2 - 0.1), 0.06, 0, 0.08, 0.12, D - 0.08, "legMetal", bev=0.008)
    box(p, W / 2 - 0.1, 0.06, 0, 0.08, 0.12, D - 0.08, "legMetal", bev=0.008)
    box(p, 0, 0.31, 0, W, 0.38, D, "woodDark", bev=0.014)
    box(p, -0.35, 0.31, D / 2 + 0.006, 0.66, 0.28, 0.02, "woodMid", bev=0.005)
    box(p, 0.35, 0.31, D / 2 + 0.006, 0.66, 0.28, 0.02, "woodMid", bev=0.005)
    sphere(p, -0.12, 0.31, D / 2 + 0.02, 0.014, "chrome")
    sphere(p, 0.12, 0.31, D / 2 + 0.02, 0.014, "chrome")
    box(p, 0, 0.64, -0.05, 0.32, 0.3, 0.2, "tvBlack", bev=0.01)
    box(p, 0, 1.04, -0.06, 1.22, 0.66, 0.05, "tvBlack", bev=0.014)
    box(p, 0, 1.04, -0.032, 1.14, 0.58, 0.012, "screen", bev=0.006)


def m_armchair(p):
    W, H = C["ARMCHAIR_W"], C["ARMCHAIR_H"]
    for su in (-1, 1):
        for sv in (-1, 1):
            cone(p, su * (W / 2 - 0.08), 0.06, sv * (W / 2 - 0.08), 0.03, 0.022, 0.12, "woodDark", verts=12)
    box(p, 0, 0.27, 0, W - 0.14, 0.3, W - 0.1, "sofa", bev=0.045)
    box(p, -(W / 2 - 0.075), 0.52, 0, 0.15, 0.6, W - 0.02, "sofa", bev=0.05)
    box(p, W / 2 - 0.075, 0.52, 0, 0.15, 0.6, W - 0.02, "sofa", bev=0.05)
    box(p, 0, 0.62, -(W / 2 - 0.09), W - 0.14, 0.6, 0.16, "sofa", bev=0.05, rot=(math.radians(-6), 0, 0))
    box(p, 0, 0.47, 0.02, W - 0.3, 0.16, W - 0.26, "sofaCushion", bev=0.045)
    # Throw blanket over the left arm, draping down the outside.
    box(p, -(W / 2 - 0.075), 0.83, 0.02, 0.17, 0.03, 0.62, "rug", bev=0.01)
    box(p, -(W / 2 + 0.005), 0.66, 0.02, 0.025, 0.32, 0.52, "rug", bev=0.008)


def m_washer(p):
    W, H = C["WASHER_W"], C["WASHER_H"]
    box(p, 0, (H - 0.03) / 2, 0, W, H - 0.03, W, "applianceWhite", bev=0.02)
    box(p, 0, H - 0.015, 0, W - 0.02, 0.03, W - 0.02, "applianceSteel", bev=0.006)
    box(p, 0, H - 0.1, W / 2 + 0.004, W - 0.08, 0.1, 0.015, "applianceSteel", bev=0.003)
    cyl(p, -0.17, H - 0.1, W / 2 + 0.016, 0.026, 0.02, "burner", axis="v", verts=14, smooth=False)
    box(p, 0.05, H - 0.1, W / 2 + 0.014, 0.1, 0.03, 0.012, "keyDark")
    torus(p, 0, 0.4, W / 2 + 0.005, 0.15, 0.034, "chrome", axis="v")
    cyl(p, 0, 0.4, W / 2, 0.148, 0.02, "burner", axis="v", verts=24)


MODELS = [
    ("desk", m_desk, C["DESK_W"], C["DESK_D"], C["DESK_H"] + 0.6),
    ("chair", m_chair, C["CHAIR_W"], C["CHAIR_W"], C["CHAIR_H"]),
    ("table", m_table, C["TABLE_W"], C["TABLE_D"], C["TABLE_H"]),
    ("cabinet", m_cabinet, C["CABINET_W"], C["CABINET_D"], C["CABINET_H"]),
    ("copier", m_copier, C["COPIER_W"], C["COPIER_D"], 1.1),
    ("cooler", m_cooler, C["COOLER_W"], C["COOLER_W"], C["COOLER_H"] + 0.05),
    ("plant", m_plant, C["PLANT_W"], C["PLANT_W"], C["PLANT_H"]),
    ("rack", m_rack, C["RACK_W"], C["RACK_D"], C["RACK_H"]),
    ("sofa", m_sofa, C["SOFA_W"], C["SOFA_D"], C["SOFA_H"]),
    ("bookshelf", m_bookshelf, C["BOOKSHELF_W"], C["BOOKSHELF_D"], C["BOOKSHELF_H"]),
    ("whiteboard", m_whiteboard, C["WHITEBOARD_W"] + 0.06, C["WHITEBOARD_D"], 1.86),
    ("bed", m_bed, C["BED_W"], C["BED_D"], 1.3),
    ("nightstand", m_nightstand, C["NIGHTSTAND_W"], C["NIGHTSTAND_W"], C["NIGHTSTAND_H"] + 0.32),
    ("wardrobe", m_wardrobe, C["WARDROBE_W"] + 0.06, C["WARDROBE_D"], C["WARDROBE_H"]),
    ("toilet", m_toilet, C["TOILET_W"], C["TOILET_D"], C["TOILET_H"]),
    ("sink", m_sink, C["SINK_W"] + 0.08, C["SINK_D"], 2.0),
    ("tub", m_tub, C["TUB_W"] + 0.06, C["TUB_D"] + 0.06, C["TUB_H"] + 0.25),
    ("counter", m_counter, C["COUNTER_W"] + 0.04, C["COUNTER_D"], C["COUNTER_H"] + 0.2),
    ("stove", m_stove, C["STOVE_W"], C["STOVE_D"], C["STOVE_H"] + 0.26),
    ("fridge", m_fridge, C["FRIDGE_W"], C["FRIDGE_D"], C["FRIDGE_H"]),
    ("tv", m_tv, C["TV_W"], C["TV_D"], C["TV_H"]),
    ("armchair", m_armchair, C["ARMCHAIR_W"], C["ARMCHAIR_W"], C["ARMCHAIR_H"]),
    ("washer", m_washer, C["WASHER_W"], C["WASHER_W"], C["WASHER_H"]),
]

# Horizontal tolerance beyond the collision footprint (matches the original
# box models' rim/cornice/tray overhangs; collision is a 2D AABB sweep).
TOL = 0.14


def gltf_selection_kwargs():
    props = bpy.ops.export_scene.gltf.get_rna_type().properties
    for ident in ("use_selection", "export_selected_objects", "use_visible"):
        if ident in props:
            return {ident: True}
    return {}


def build_all():
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(BLEND_OUT), exist_ok=True)
    sel_kw = gltf_selection_kwargs()
    built = []
    for name, fn, ew, ed, eh in MODELS:
        parts = []
        fn(parts)
        for o in parts:
            o.select_set(True)
        bpy.context.view_layer.objects.active = parts[0]
        # Bake every part transform into its mesh BEFORE joining: join keeps
        # the active object's (non-zero) transform otherwise, leaving the GLB
        # geometry offset from the origin and a compensating node translation.
        # The loader and the collision contract both want origin-at-floor.
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        bpy.ops.object.join()
        obj = bpy.context.view_layer.objects.active
        obj.location = (0, 0, 0)
        obj.name = "furn_" + name
        obj.data.name = "mesh_" + name

        # Footprint/height audit against the collision contract.
        bb = [obj.matrix_world @ v.co for v in obj.data.vertices]
        # matrix_world is identity here (built at origin), but keep it honest.
        xs = [v.x for v in bb]
        ys = [v.y for v in bb]
        zs = [v.z for v in bb]
        w = max(xs) - min(xs)
        d = max(ys) - min(ys)
        h = max(zs) - min(zs)
        if w > ew + TOL or d > ed + TOL:
            raise RuntimeError(f"{name}: footprint {w:.3f}x{d:.3f} exceeds {ew:.3f}x{ed:.3f}+tol")
        if max(zs) > eh + 0.05:
            raise RuntimeError(f"{name}: top {max(zs):.3f} exceeds {eh:.3f}")
        if min(zs) < -0.005:
            raise RuntimeError(f"{name}: dips below floor ({min(zs):.3f})")

        path = os.path.join(OUT_DIR, name + ".glb")
        activate(obj)
        bpy.ops.export_scene.gltf(
            filepath=path,
            export_format="GLB",
            export_apply=True,
            export_animations=False,
            export_cameras=False,
            export_lights=False,
            export_skins=False,
            export_morph=False,
            export_texcoords=False,
            export_normals=True,
            export_materials="EXPORT",
            **sel_kw,
        )
        kb = os.path.getsize(path) / 1024
        print(f"[yr] {name:<11} {w:.2f}x{d:.2f}x{h:.2f}  verts={len(obj.data.vertices):<5} {kb:.0f} KiB")
        built.append(obj)

    # Lay the joined models out in a grid for the source blend + preview.
    cols = 6
    for i, obj in enumerate(built):
        obj.location = ((i % cols) * 2.6, -(i // cols) * 3.8, 0)
    return built


def render_preview():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 24
    scene.render.resolution_x = 1800
    scene.render.resolution_y = 1350
    scene.render.filepath = PREVIEW_OUT
    scene.world = bpy.data.worlds.new("yr_world")
    scene.world.use_nodes = True
    bg = scene.world.node_tree.nodes.get("Background")
    bg.inputs[0].default_value = (0.75, 0.73, 0.68, 1.0)
    bg.inputs[1].default_value = 0.35

    bpy.ops.object.light_add(type="AREA", location=(6.5, -8, 9))
    key = bpy.context.active_object
    key.data.energy = 850
    key.data.shape = "DISK"
    key.data.size = 6
    key.rotation_euler = (math.radians(25), math.radians(15), math.radians(20))
    bpy.ops.object.light_add(type="AREA", location=(0, 4, 5))
    fill = bpy.context.active_object
    fill.data.energy = 320
    fill.data.size = 5
    fill.rotation_euler = (math.radians(60), 0, math.radians(160))

    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    target = None
    from mathutils import Vector
    target = Vector((6.5, -5.6, 0.8))
    cam.location = (8.5, -25, 23)
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 18.5
    scene.camera = cam

    # Ground plane for contact shadows.
    bpy.ops.mesh.primitive_plane_add(size=60, location=(6.5, -5.6, -0.01))
    ground = bpy.context.active_object
    gm = bpy.data.materials.new("yr_ground")
    gm.use_nodes = True
    gm.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (0.32, 0.3, 0.27, 1)
    ground.data.materials.append(gm)

    bpy.ops.render.render(write_still=True)
    print(f"[yr] preview -> {PREVIEW_OUT}")


# Avoid overwriting tracked artist backups on a deterministic rebuild.
bpy.context.preferences.filepaths.save_version = 0
build_all()
bpy.ops.wm.save_as_mainfile(filepath=BLEND_OUT, check_existing=False)
print(f"[yr] blend -> {BLEND_OUT}")
render_preview()
print("[yr] done")
