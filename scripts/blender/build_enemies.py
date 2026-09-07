# Yellow Rooms — enemy asset pipeline (Blender 4.x/5.x, background mode).
#
# Builds the three entity models (Stalker, Pursuer/"Crawler", Husk) as
# low-poly figures and exports one GLB per entity for the runtime loader
# (src/render/enemyModels.js). Replaces the procedural capsule silhouettes
# (render/geometries.js) which remain the load-failure fallback.
#
#   blender --background --factory-startup --python scripts/blender/build_enemies.py
#
# Optional positional args after `--`:
#   -- <glbOutDir> <blendOut> <previewPng>
#
# Frame contract (same as the furniture pipeline):
#   game local frame: u = width (x), v = depth (front toward +v), y = up,
#   origin at the footprint centre on the FLOOR (entities stand at y=0).
#   In Blender (Z-up, glTF +Y-up export) we build at (x=u, y=-v, z=y), so the
#   exported model faces glTF +Z — the direction entities face at rotation.y=0.
#
# Colour contract: every part carries a material whose base color becomes the
# baked per-vertex part tint at load time (same bake as the furniture GLBs);
# the shared `entityModel` G-buffer material multiplies them by white, so the
# palette below IS the in-game albedo. Entity signature colors match the old
# capsule materials (world/entity ink: Stalker near-black, Pursuer blood-red,
# Husk pale ash).
#
# The module is import-safe (no bpy side effects at import): main() wipes the
# factory scene, builds, audits, exports, saves the source blend and renders a
# contact sheet. The interactive MCP session execs this file and calls the
# same functions without save_as_mainfile.

import math
import os
import sys

import bpy
from mathutils import Vector

SCRIPT = os.path.abspath(__file__)
REPO = os.path.dirname(os.path.dirname(os.path.dirname(SCRIPT)))

ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT_DIR = os.path.abspath(ARGV[0]) if len(ARGV) > 0 else os.path.join(REPO, "public", "models", "enemies")
BLEND_OUT = os.path.abspath(ARGV[1]) if len(ARGV) > 1 else os.path.join(REPO, "assets-src", "enemies.blend")
PREVIEW_OUT = os.path.abspath(ARGV[2]) if len(ARGV) > 2 else "/tmp/yr_enemies_preview.png"

SCENE_NAME = "YR_ENEMIES_PREVIEW"


def srgb(hexval):
    """sRGB hex -> linear RGB tuple (what THREE.Color(hex) decodes to)."""
    def chan(c):
        c = c / 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (chan(hexval >> 16 & 0xFF), chan(hexval >> 8 & 0xFF), chan(hexval & 0xFF))


# --- Palette (linear; entity signature tints mirror render/gbufferMaterials.js) ---
PALETTE = {
    "inkBody": srgb(0x16161C),    # Stalker body — near-black ink (old entity mat)
    "inkCloth": srgb(0x24242A),   # lapels / seams catch a trace of lamplight
    "bonePale": srgb(0xC9C3B2),   # Stalker head/hands — featureless pale oval
    "bloodBody": srgb(0x3A0D0D),  # Pursuer mass — dark blood-red (old pursuer mat)
    "bloodLimb": srgb(0x240707),  # Pursuer limbs/jaw — darker
    "eyePale": srgb(0xE8E2D0),    # Pursuer eyes — pale pinpoints
    "ashBody": srgb(0x5C5847),    # Husk body — pale ash (old husk mat)
    "ashRidge": srgb(0x716B58),   # exposed ridges around the hollow face
    "voidFace": srgb(0x0F0F0A),   # Husk face — hollow void
}

# --- Scene + material plumbing ------------------------------------------------

COLLECTION = None
_MATS = {}


def reset_data():
    """Drop everything a previous build created (idempotent re-runs)."""
    global _MATS
    old = bpy.data.scenes.get(SCENE_NAME)
    if old is not None:
        bpy.data.scenes.remove(old)
    for coll_name in ("YR_ENEMIES",):
        coll = bpy.data.collections.get(coll_name)
        if coll is not None:
            bpy.data.collections.remove(coll)
    for obj in [o for o in bpy.data.objects if o.name.startswith("enemy_")]:
        bpy.data.objects.remove(obj)
    for mesh in [m for m in bpy.data.meshes if m.name.startswith("mesh_")]:
        bpy.data.meshes.remove(mesh)
    for material in list(bpy.data.materials):
        if material.name.startswith("yr_enemy_"):
            bpy.data.materials.remove(material)
    _MATS = {}


def make_scene():
    """Fresh preview scene + build collection; never touches other scenes."""
    global COLLECTION
    scene = bpy.data.scenes.new(SCENE_NAME)
    bpy.context.window.scene = scene if bpy.context.window else scene
    COLLECTION = bpy.data.collections.new("YR_ENEMIES")
    scene.collection.children.link(COLLECTION)
    return scene


def mat(key):
    if key in _MATS:
        return _MATS[key]
    m = bpy.data.materials.new("yr_enemy_" + key)
    m.use_nodes = True
    r, g, b = PALETTE[key]
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (r, g, b, 1.0)
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = 0.82
    m.diffuse_color = (r, g, b, 1.0)
    _MATS[key] = m
    return m


def activate(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def link(obj):
    for col in list(obj.users_collection):
        col.objects.unlink(obj)
    COLLECTION.objects.link(obj)


def finish(obj, key, bev=0.0, smooth=False):
    link(obj)
    obj.data.materials.append(mat(key))
    if bev > 0:
        mod = obj.modifiers.new("bev", "BEVEL")
        mod.width = bev
        mod.segments = 2
        mod.limit_method = "ANGLE"
        activate(obj)
        bpy.ops.object.modifier_apply(modifier="bev")
    if smooth:
        activate(obj)
        try:
            bpy.ops.object.shade_smooth_by_angle(angle=0.9)
        except Exception:
            for p in obj.data.polygons:
                p.use_smooth = True
    return obj


# --- Primitive helpers (game frame: u right, y up, v front) -------------------
# Blender mapping: location (u, -v, y); the model's front (+v) is Blender -Y,
# which the glTF exporter turns into +Z — the entity rotation.y=0 facing.

def box(parts, cu, cy, cv, su, sy, sv, key, bev=0.01, rot=None):
    bpy.ops.mesh.primitive_cube_add(location=(cu, -cv, cy))
    o = bpy.context.active_object
    o.scale = (su / 2, sv / 2, sy / 2)
    activate(o)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if rot:
        o.rotation_euler = rot
    finish(o, key, bev=min(bev, su / 2.5, sy / 2.5, sv / 2.5))
    parts.append(o)
    return o


def cyl(parts, cu, cy, cv, r, h, key, axis="y", verts=12, smooth=True):
    rot = (0, 0, 0)
    if axis == "v":
        rot = (math.radians(90), 0, 0)
    elif axis == "u":
        rot = (0, math.radians(90), 0)
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=h,
                                        location=(cu, -cv, cy), rotation=rot)
    o = bpy.context.active_object
    finish(o, key, smooth=smooth)
    parts.append(o)
    return o


def cone(parts, cu, cy, cv, r1, r2, h, key, rot=None, verts=12, smooth=True):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r1, radius2=r2, depth=h,
                                    location=(cu, -cv, cy), rotation=rot or (0, 0, 0))
    o = bpy.context.active_object
    finish(o, key, smooth=smooth)
    parts.append(o)
    return o


def sphere(parts, cu, cy, cv, r, key, scale=(1, 1, 1), rot=None, smooth=True,
           segments=12, rings=8):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, radius=r,
                                         location=(cu, -cv, cy))
    o = bpy.context.active_object
    o.scale = (scale[0], scale[2], scale[1])
    activate(o)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if rot:
        o.rotation_euler = rot
    finish(o, key, smooth=smooth)
    parts.append(o)
    return o


def bone(parts, u1, y1, v1, u2, y2, v2, r, key, verts=10, smooth=True, taper=0.8):
    """Tapered limb between two game-frame points, thickest at the first."""
    a = Vector((u1, -v1, y1))
    b = Vector((u2, -v2, y2))
    d = b - a
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r * taper,
                                    depth=d.length, location=(a + b) / 2)
    o = bpy.context.active_object
    o.rotation_mode = "QUATERNION"
    o.rotation_quaternion = d.to_track_quat("Z", "Y")
    finish(o, key, smooth=smooth)
    parts.append(o)
    return o


def torso(parts, rings, key, segments=12):
    """Continuous elliptical sections (height, half-width, half-depth, front).

    Sharing the sections gives a curved silhouette without intersecting boxes
    or subdivision. End caps stay inside the pelvis/neck connections.
    """
    vertices = []
    for y, width, depth, front in rings:
        for i in range(segments):
            a = math.tau * i / segments
            vertices.append((width * math.cos(a), -front + depth * math.sin(a), y))
    faces = [tuple(reversed(range(segments)))]
    for row in range(len(rings) - 1):
        for i in range(segments):
            a = row * segments + i
            b = row * segments + (i + 1) % segments
            faces.append((a, b, b + segments, a + segments))
    faces.append(tuple((len(rings) - 1) * segments + i for i in range(segments)))
    mesh = bpy.data.meshes.new("enemy_torso")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new("enemy_torso", mesh)
    COLLECTION.objects.link(obj)
    finish(obj, key, smooth=True)
    parts.append(obj)
    return obj


def hollow_head(parts):
    """Open ash skull with a dark concave face, rather than a floating dot.

    Rings run from the back of the head toward the viewer, then turn inward
    at the lip. The dark bowl is physically recessed behind that lip.
    """
    segments = 16
    vertices = []
    # half-width, half-height, front depth
    rings = [(0.025, 0.04, -0.08), (0.105, 0.15, -0.025),
             (0.117, 0.157, 0.05), (0.084, 0.112, 0.115),
             (0.072, 0.098, 0.116), (0.055, 0.073, 0.069)]
    for width, height, front in rings:
        for i in range(segments):
            a = math.tau * i / segments
            # Bowed forward; a slight sideways lean breaks mannequin symmetry.
            y = height * math.sin(a)
            x = width * math.cos(a) - y * 0.08
            v = front - y * 0.24
            vertices.append((x, -(0.085 + v), 1.60 + y))
    vertices.append((0, -(0.085 + 0.05), 1.60))
    faces = [tuple(reversed(range(segments)))]
    for row in range(len(rings) - 1):
        for i in range(segments):
            a = row * segments + i
            b = row * segments + (i + 1) % segments
            faces.append((a, b, b + segments, a + segments))
    for i in range(segments):
        faces.append(((len(rings) - 1) * segments + i,
                      (len(rings) - 1) * segments + (i + 1) % segments,
                      len(vertices) - 1))
    mesh = bpy.data.meshes.new("enemy_hollow_head")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new("enemy_hollow_head", mesh)
    COLLECTION.objects.link(obj)
    finish(obj, "ashBody", smooth=True)
    mesh.materials.append(mat("ashRidge"))
    mesh.materials.append(mat("voidFace"))
    for polygon in mesh.polygons:
        # Lip ring gets the ash highlight; the inward wall and bowl are dark.
        if polygon.index >= 1 + 4 * segments:
            polygon.material_index = 2
        elif polygon.index >= 1 + 3 * segments:
            polygon.material_index = 1
    parts.append(obj)


# --- The three entities --------------------------------------------------------
# Design language: emaciated low-poly figures built from boxes/cylinders/
# spheres, flat ink palettes, no facial features except where their absence
# IS the feature (Stalker's blank oval, Husk's hollow void, Pursuer's eyes).
# All parts in the game frame (u, y, v); front = +v.

def m_stalker(p):
    """The Stalker — a ~2.3u faceless tall figure. Long arms hang past the
    hips; the pale oval head is the only thing that catches lamplight."""
    K, PALE = "inkBody", "bonePale"
    for su in (-1, 1):
        bone(p, su * 0.11, 1.05, 0.0, su * 0.11, 0.05, 0.0, 0.076, K)  # tapered leg
        box(p, su * 0.11, 0.035, 0.06, 0.12, 0.07, 0.26, K, bev=0.015)   # foot
        sphere(p, su * 0.215, 1.735, 0.01, 0.075, K, rings=6)            # attached shoulder
        bone(p, su * 0.23, 1.73, 0.01, su * 0.26, 1.36, 0.02, 0.06, K)
        sphere(p, su * 0.26, 1.36, 0.02, 0.045, K, segments=8, rings=6)
        bone(p, su * 0.26, 1.37, 0.02, su * 0.28, 1.00, 0.055, 0.048, K)
        sphere(p, su * 0.28, 0.955, 0.06, 0.046, PALE, scale=(0.8, 1.65, 0.65), rings=6)
        # Two broad finger silhouettes survive the game's outline and fog.
        for finger in (-1, 1):
            bone(p, su * 0.28 + finger * 0.017, 0.92, 0.06,
                 su * 0.285 + finger * 0.020, 0.79 + 0.025 * finger, 0.07,
                 0.014, PALE, verts=6, taper=0.55)
        bone(p, su * 0.265, 0.975, 0.075, su * 0.245, 0.91, 0.095,
             0.015, PALE, verts=6)                                     # thumb
        bone(p, su * 0.065, 1.79, 0.105, su * 0.027, 1.49, 0.124,
             0.018, "inkCloth", verts=6)                               # narrow lapel
    torso(p, [(1.01, 0.19, 0.115, 0.0), (1.19, 0.19, 0.115, 0.0),
              (1.36, 0.125, 0.095, 0.018), (1.65, 0.20, 0.12, 0.015),
              (1.77, 0.23, 0.095, 0.0), (1.82, 0.07, 0.065, 0.015)], K)
    cyl(p, 0, 1.86, 0.02, 0.05, 0.16, K)                                 # neck
    sphere(p, 0, 2.10, 0.05, 0.145, PALE, scale=(0.92, 1.38, 1.0),
           rot=(math.radians(6), 0, 0))                                  # blank oval head


def m_pursuer(p):
    """The Pursuer ("Crawler") — a low broad knuckle-walker. Hips ride higher
    than the shoulders; pale eyes sit low on the forward-thrust head."""
    B, L, E = "bloodBody", "bloodLimb", "eyePale"
    for su in (-1, 1):
        sphere(p, su * 0.285, 0.56, 0.26, 0.12, B, scale=(1, 1.12, 1.22))
        bone(p, su * 0.33, 0.55, 0.30, su * 0.44, 0.30, 0.42, 0.07, B)   # upper arm
        sphere(p, su * 0.44, 0.30, 0.42, 0.058, L, segments=8, rings=6)
        bone(p, su * 0.44, 0.30, 0.42, su * 0.44, 0.08, 0.34, 0.06, L)   # forearm
        box(p, su * 0.44, 0.06, 0.34, 0.17, 0.12, 0.22, L, bev=0.03)     # knuckle fist
        for finger in (-1, 1):
            bone(p, su * 0.44 + finger * 0.043, 0.045, 0.41,
                 su * 0.44 + finger * 0.05, 0.02, 0.50, 0.027, L, verts=6, taper=0.3)
        bone(p, su * 0.26, 0.68, -0.30, su * 0.30, 0.34, -0.52, 0.075, B)  # thigh
        sphere(p, su * 0.30, 0.34, -0.52, 0.060, L, segments=8, rings=6)
        bone(p, su * 0.30, 0.34, -0.52, su * 0.30, 0.08, -0.34, 0.055, L)  # shin
        box(p, su * 0.30, 0.045, -0.28, 0.14, 0.09, 0.26, L, bev=0.02)   # hind foot
        sphere(p, su * 0.095, 0.53, 0.771, 0.039, L, scale=(1.3, 0.85, 0.65), segments=8, rings=6)
        sphere(p, su * 0.095, 0.53, 0.790, 0.020, E, scale=(1.05, 0.7, 0.6), segments=8, rings=6)
    sphere(p, 0, 0.55, 0.25, 0.30, B, scale=(1.0, 0.8, 0.85))           # barrel chest
    sphere(p, 0, 0.72, -0.25, 0.27, B, scale=(1.0, 0.68, 1.0))          # raised haunches
    sphere(p, 0, 0.70, -0.02, 0.28, B, scale=(0.90, 0.64, 1.5),
           rot=(math.radians(-12), 0, 0))                              # continuous hunched back
    for i, cv in enumerate((0.15, -0.05, -0.25)):
        cone(p, 0, 0.86 + 0.05 * i, cv, 0.05, 0.008, 0.14, L,
             rot=(math.radians(-15), 0, 0))                              # spine spikes
    sphere(p, 0, 0.46, 0.64, 0.17, B, scale=(1.05, 0.85, 1.15))          # head
    sphere(p, 0, 0.41, 0.56, 0.11, L, scale=(1.0, 0.85, 1.2))          # throat joins head to chest
    sphere(p, 0, 0.335, 0.725, 0.125, L, scale=(1.1, 0.43, 1.0))        # connected jaw


def m_husk(p):
    """The Husk — a ~1.75u frail standing remnant. Head bowed, arms dangling,
    a hollow dark void where the face used to be. It only ever stands."""
    A = "ashBody"
    for su in (-1, 1):
        bone(p, su * 0.09, 0.84, 0.0, su * 0.09, 0.035, 0.0, 0.055, A)
        box(p, su * 0.09, 0.03, 0.05, 0.10, 0.06, 0.22, A, bev=0.012)    # foot
        sphere(p, su * 0.175, 1.425, 0.02, 0.06, A, segments=8, rings=6)
        bone(p, su * 0.20, 1.42, 0.02, su * 0.215, 1.12, 0.05, 0.045, A)  # upper arm
        sphere(p, su * 0.215, 1.12, 0.05, 0.035, "ashRidge", segments=8, rings=6)
        bone(p, su * 0.215, 1.12, 0.05, su * 0.225, 0.86, 0.06, 0.038, A)  # forearm
        sphere(p, su * 0.225, 0.82, 0.07, 0.032, A, scale=(0.8, 1.6, 0.7), segments=8, rings=6)
        for finger in (-1, 1):
            bone(p, su * 0.225 + finger * 0.012, 0.79, 0.07,
                 su * 0.23 + finger * 0.015, 0.69 + finger * 0.013, 0.09,
                 0.01, "ashRidge", verts=6, taper=0.6)
        for y in (1.24, 1.31, 1.38):
            bone(p, su * 0.025, y, 0.117, su * 0.11, y + 0.018, 0.076,
                 0.014, "ashRidge", verts=6)                           # subtle rib ridges
    torso(p, [(0.81, 0.15, 0.09, 0.0), (0.95, 0.15, 0.09, 0.0),
              (1.1, 0.085, 0.055, 0.025), (1.35, 0.135, 0.085, 0.035),
              (1.435, 0.18, 0.065, 0.018), (1.49, 0.055, 0.045, 0.035)], A)
    cyl(p, 0, 1.50, 0.04, 0.042, 0.10, A)                                # neck
    hollow_head(p)


# (builder, footprint budget u x v, height budget) — mirrored by the vitest
# export-contract suite (render/__tests__/enemy-models.test.js).
MODELS = [
    ("stalker", m_stalker, 0.9, 0.9, 2.45),
    ("pursuer", m_pursuer, 1.3, 1.5, 1.35),
    ("husk", m_husk, 0.8, 0.8, 1.9),
]

TOL = 0.1  # small bevel overhang grace; entities have no collision footprint


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
        bpy.ops.object.select_all(action="DESELECT")
        for o in parts:
            o.select_set(True)
        bpy.context.view_layer.objects.active = parts[0]
        # Bake part transforms into the meshes BEFORE joining (same contract as
        # the furniture pipeline: origin at the footprint centre on the floor).
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        bpy.ops.object.join()
        obj = bpy.context.view_layer.objects.active
        obj.location = (0, 0, 0)
        obj.name = "enemy_" + name
        obj.data.name = "mesh_" + name

        # Footprint/height audit against the design budget.
        bb = [obj.matrix_world @ v.co for v in obj.data.vertices]
        xs = [v.x for v in bb]
        ys = [v.y for v in bb]
        zs = [v.z for v in bb]
        w = max(xs) - min(xs)
        d = max(ys) - min(ys)
        h = max(zs) - min(zs)
        if w > ew + TOL or d > ed + TOL:
            raise RuntimeError(f"{name}: footprint {w:.3f}x{d:.3f} exceeds {ew:.3f}x{ed:.3f}+tol")
        if h > eh + 0.05:
            raise RuntimeError(f"{name}: height {h:.3f} exceeds {eh:.3f}")
        if min(zs) < -0.005:
            raise RuntimeError(f"{name}: dips below floor ({min(zs):.3f})")
        obj.data.calc_loop_triangles()
        triangles = len(obj.data.loop_triangles)
        if triangles > 3000:
            raise RuntimeError(f"{name}: {triangles} triangles exceeds the 3000-triangle budget")

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
            # These figures use flat part colors; UV seams duplicate vertices
            # and the G-buffer never samples a texture for enemy materials.
            export_texcoords=False,
            export_normals=True,
            export_materials="EXPORT",
            **sel_kw,
        )
        kb = os.path.getsize(path) / 1024
        print(f"[yr] {name:<8} {w:.2f}x{d:.2f}x{h:.2f}  tris={triangles:<5} {kb:.0f} KiB")
        built.append(obj)

    # Line the joined models up for the source blend + contact sheet.
    for obj, x in zip(built, (-2.2, 0.0, 2.2)):
        obj.location = (x, 0, 0)
    return built


def render_preview():
    scene = bpy.data.scenes.get(SCENE_NAME) or bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT" if hasattr(bpy.types, "EEVEE_NEXT") or "BLENDER_EEVEE_NEXT" in {
        e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items
    } else "BLENDER_EEVEE"
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    scene.render.filepath = PREVIEW_OUT
    scene.world = bpy.data.worlds.new("yr_enemy_world")
    scene.world.use_nodes = True
    bg = scene.world.node_tree.nodes.get("Background")
    bg.inputs[0].default_value = (0.55, 0.54, 0.48, 1.0)  # dim backrooms mustard-grey
    bg.inputs[1].default_value = 0.4

    bpy.ops.object.light_add(type="AREA", location=(0, -4.5, 3.4))
    key = bpy.context.active_object
    key.data.energy = 700
    key.data.shape = "RECTANGLE"
    key.data.size = 5
    key.rotation_euler = (math.radians(28), 0, 0)
    bpy.ops.object.light_add(type="AREA", location=(-3, 2, 2.4))
    fill = bpy.context.active_object
    fill.data.energy = 260
    fill.data.size = 4
    fill.rotation_euler = (math.radians(65), 0, math.radians(150))

    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    cam.location = (0.4, -7.2, 1.9)
    target = Vector((0, 0, 1.0))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 6.2
    scene.camera = cam

    # Ground plane for contact shadows.
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, -0.01))
    ground = bpy.context.active_object
    gm = bpy.data.materials.new("yr_enemy_ground")
    gm.use_nodes = True
    gm.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (0.3, 0.28, 0.24, 1)
    ground.data.materials.append(gm)

    bpy.ops.render.render(write_still=True, scene=scene.name)
    print(f"[yr] preview -> {PREVIEW_OUT}")


def main():
    # Headless factory startup: wipe the default cube/light/camera scene first.
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.curves, bpy.data.cameras, bpy.data.lights):
        for data in list(block):
            block.remove(data)
    reset_data()
    make_scene()
    build_all()
    # Source assets are reproducible: don't leave Blender backup files in git.
    bpy.context.preferences.filepaths.save_version = 0
    render_preview()
    bpy.ops.wm.save_as_mainfile(filepath=BLEND_OUT, check_existing=False)
    print(f"[yr] blend -> {BLEND_OUT}")
    print("[yr] done")


if __name__ == "__main__":
    main()
