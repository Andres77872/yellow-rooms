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
    "bonePale": srgb(0xC9C3B2),   # Stalker head/hands — featureless pale oval
    "bloodBody": srgb(0x3A0D0D),  # Pursuer mass — dark blood-red (old pursuer mat)
    "bloodLimb": srgb(0x240707),  # Pursuer limbs/jaw — darker
    "eyePale": srgb(0xE8E2D0),    # Pursuer eyes — pale pinpoints
    "ashBody": srgb(0x5C5847),    # Husk body — pale ash (old husk mat)
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
    for name in list(_MATS):
        m = bpy.data.materials.get(name)
        if m is not None:
            bpy.data.materials.remove(m)
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


def cyl(parts, cu, cy, cv, r, h, key, axis="y", verts=16, smooth=True):
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


def sphere(parts, cu, cy, cv, r, key, scale=(1, 1, 1), rot=None, smooth=True):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=12, radius=r,
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


def bone(parts, u1, y1, v1, u2, y2, v2, r, key, verts=14, smooth=True):
    """Cylinder stretched between two game-frame points — angled limbs."""
    a = Vector((u1, -v1, y1))
    b = Vector((u2, -v2, y2))
    d = b - a
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=d.length,
                                        location=(a + b) / 2)
    o = bpy.context.active_object
    o.rotation_mode = "QUATERNION"
    o.rotation_quaternion = d.to_track_quat("Z", "Y")
    finish(o, key, smooth=smooth)
    parts.append(o)
    return o


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
        cyl(p, su * 0.11, 0.53, 0.0, 0.075, 1.0, K)                      # leg
        box(p, su * 0.11, 0.035, 0.06, 0.12, 0.07, 0.26, K, bev=0.015)   # foot
        bone(p, su * 0.24, 1.72, 0.01, su * 0.26, 1.38, 0.02, 0.055, K)  # upper arm
        bone(p, su * 0.26, 1.38, 0.02, su * 0.27, 1.02, 0.05, 0.048, K)  # forearm
        box(p, su * 0.27, 0.90, 0.06, 0.07, 0.24, 0.10, PALE, bev=0.02)  # hand
    box(p, 0, 1.10, 0.0, 0.30, 0.20, 0.18, K, bev=0.03)                  # hips
    box(p, 0, 1.47, 0.01, 0.34, 0.66, 0.20, K, bev=0.05,
        rot=(math.radians(4), 0, 0))                                     # torso (slight hunch)
    box(p, 0, 1.76, 0.0, 0.48, 0.13, 0.20, K, bev=0.04,
        rot=(math.radians(4), 0, 0))                                     # shoulders
    cyl(p, 0, 1.86, 0.02, 0.05, 0.16, K)                                 # neck
    sphere(p, 0, 2.10, 0.05, 0.145, PALE, scale=(0.92, 1.38, 1.0),
           rot=(math.radians(6), 0, 0))                                  # blank oval head


def m_pursuer(p):
    """The Pursuer ("Crawler") — a low broad knuckle-walker. Hips ride higher
    than the shoulders; pale eyes sit low on the forward-thrust head."""
    B, L, E = "bloodBody", "bloodLimb", "eyePale"
    for su in (-1, 1):
        bone(p, su * 0.33, 0.55, 0.30, su * 0.44, 0.30, 0.42, 0.07, B)   # upper arm
        bone(p, su * 0.44, 0.30, 0.42, su * 0.44, 0.08, 0.34, 0.06, L)   # forearm
        box(p, su * 0.44, 0.06, 0.34, 0.17, 0.12, 0.22, L, bev=0.03)     # knuckle fist
        bone(p, su * 0.26, 0.68, -0.30, su * 0.30, 0.34, -0.52, 0.075, B)  # thigh
        bone(p, su * 0.30, 0.34, -0.52, su * 0.30, 0.08, -0.34, 0.055, L)  # shin
        box(p, su * 0.30, 0.045, -0.28, 0.14, 0.09, 0.26, L, bev=0.02)   # hind foot
        sphere(p, su * 0.095, 0.53, 0.76, 0.028, E)                      # eye (pinpoint)
    box(p, 0, 0.52, 0.30, 0.62, 0.36, 0.42, B, bev=0.06)                 # shoulders/chest
    box(p, 0, 0.72, -0.28, 0.50, 0.30, 0.40, B, bev=0.06)                # raised hips
    box(p, 0, 0.66, 0.0, 0.50, 0.24, 0.70, B, bev=0.05,
        rot=(math.radians(-12), 0, 0))                                   # saddle
    for i, cv in enumerate((0.15, -0.05, -0.25)):
        cone(p, 0, 0.86 + 0.05 * i, cv, 0.05, 0.008, 0.14, L,
             rot=(math.radians(-15), 0, 0))                              # spine spikes
    sphere(p, 0, 0.46, 0.64, 0.17, B, scale=(1.05, 0.85, 1.15))          # head
    box(p, 0, 0.30, 0.74, 0.26, 0.11, 0.26, L, bev=0.03)                 # jaw/muzzle


def m_husk(p):
    """The Husk — a ~1.75u frail standing remnant. Head bowed, arms dangling,
    a hollow dark void where the face used to be. It only ever stands."""
    A, V = "ashBody", "voidFace"
    for su in (-1, 1):
        cyl(p, su * 0.09, 0.42, 0.0, 0.055, 0.78, A)                     # leg
        box(p, su * 0.09, 0.03, 0.05, 0.10, 0.06, 0.22, A, bev=0.012)    # foot
        bone(p, su * 0.20, 1.42, 0.02, su * 0.215, 1.12, 0.05, 0.045, A)  # upper arm
        bone(p, su * 0.215, 1.12, 0.05, su * 0.225, 0.86, 0.06, 0.038, A)  # forearm
        box(p, su * 0.225, 0.76, 0.07, 0.055, 0.16, 0.075, A, bev=0.015)  # hand
    box(p, 0, 0.88, 0.0, 0.24, 0.16, 0.14, A, bev=0.02)                  # hips
    box(p, 0, 1.18, 0.01, 0.26, 0.52, 0.15, A, bev=0.03,
        rot=(math.radians(7), 0, 0))                                     # torso (slumped)
    box(p, 0, 1.44, 0.02, 0.36, 0.10, 0.14, A, bev=0.03,
        rot=(math.radians(10), 0, 0))                                    # shoulders
    cyl(p, 0, 1.50, 0.04, 0.042, 0.10, A)                                # neck
    sphere(p, 0, 1.60, 0.09, 0.125, A, scale=(0.9, 1.15, 0.95),
           rot=(math.radians(24), 0, 0))                                 # bowed head
    sphere(p, 0, 1.585, 0.185, 0.075, V, scale=(0.72, 0.95, 0.42),
           rot=(math.radians(24), 0, 0))                                 # hollow face


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
            export_texcoords=True,
            export_normals=True,
            export_materials="EXPORT",
            **sel_kw,
        )
        kb = os.path.getsize(path) / 1024
        print(f"[yr] {name:<8} {w:.2f}x{d:.2f}x{h:.2f}  verts={len(obj.data.vertices):<5} {kb:.0f} KiB")
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
    bpy.ops.wm.save_as_mainfile(filepath=BLEND_OUT, check_existing=False)
    print(f"[yr] blend -> {BLEND_OUT}")
    render_preview()
    print("[yr] done")


if __name__ == "__main__":
    main()
