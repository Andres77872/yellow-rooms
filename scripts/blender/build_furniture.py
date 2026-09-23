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
#
# Art direction ("anime semi-realistic" backgrounds): clean readable shapes,
# soft upholstery/porcelain/cloth where the real object is soft or curved,
# detail concentrated at structural edges (mouldings, seams, handles, trays),
# and a painted per-vertex value pass (yr_shading.paint -> COLOR_0) instead of
# texture noise.

import math
import os
import re
import sys

import bmesh
import bpy
from mathutils import Vector

SCRIPT = os.path.abspath(__file__)
REPO = os.path.dirname(os.path.dirname(os.path.dirname(SCRIPT)))
sys.path.insert(0, os.path.dirname(SCRIPT))
import yr_shading  # noqa: E402  (shared painted-shading + GLB compaction)

ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT_DIR = os.path.abspath(ARGV[0]) if len(ARGV) > 0 else os.path.join(REPO, "public", "models", "furniture")
BLEND_OUT = os.path.abspath(ARGV[1]) if len(ARGV) > 1 else os.path.join(REPO, "assets-src", "furniture.blend")
PREVIEW_OUT = os.path.abspath(ARGV[2]) if len(ARGV) > 2 else "/tmp/yr_furniture_preview.png"

TAU = getattr(math, "tau", 2 * math.pi)
R = math.radians


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
    metal = key in METAL_KEYS
    m = yr_shading.shaded_material("yr_" + key, PAL[key],
                                   metallic=0.85 if metal else 0.0,
                                   roughness=0.32 if metal else 0.78)
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


def weighted_normals(obj):
    """Smooth everything, but let large planar faces dominate the vertex
    normals: bevel strips / lathe corners shade softly while flat panels stay
    flat, and tiny chamfer segments never trigger the Sobel ink outline."""
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    activate(obj)
    normals = obj.modifiers.new("weighted_normals", "WEIGHTED_NORMAL")
    normals.keep_sharp = True
    normals.weight = 50
    bpy.ops.object.modifier_apply(modifier=normals.name)


def smooth_by_angle(obj, angle=0.9):
    activate(obj)
    try:
        bpy.ops.object.shade_smooth_by_angle(angle=angle)
    except Exception:
        for p in obj.data.polygons:
            p.use_smooth = True


def finish(obj, key, bev=0.0, smooth=False, seg=None, soft=False):
    link(obj)
    obj.data.materials.append(mat(key))
    if bev > 0:
        mod = obj.modifiers.new("bev", "BEVEL")
        mod.width = bev
        # Small chamfers need one ring; upholstery keeps a soft silhouette.
        mod.segments = seg if seg else (2 if bev >= 0.02 else 1)
        mod.limit_method = "ANGLE"
        activate(obj)
        bpy.ops.object.modifier_apply(modifier="bev")
        if soft:
            for polygon in obj.data.polygons:
                polygon.use_smooth = True
        else:
            weighted_normals(obj)
    elif soft:
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
    if smooth:
        smooth_by_angle(obj)
    return obj


def make_mesh(p, name, verts, faces, key, shading="smooth", recalc=True,
              location=None, rot=None):
    """verts are Blender-space tuples. shading: smooth | soft | weighted | flat."""
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(v) for v in verts], [], faces)
    mesh.update()
    if recalc:
        bm = bmesh.new()
        bm.from_mesh(mesh)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        bm.to_mesh(mesh)
        bm.free()
    obj = bpy.data.objects.new(name, mesh)
    COLLECTION.objects.link(obj)
    obj.data.materials.append(mat(key))
    if location is not None:
        obj.location = location
    if rot is not None:
        obj.rotation_euler = rot
    if shading == "smooth":
        smooth_by_angle(obj)
    elif shading == "soft":
        for polygon in mesh.polygons:
            polygon.use_smooth = True
    elif shading == "weighted":
        weighted_normals(obj)
    p.append(obj)
    return obj


def G(u, y, v):
    """Game frame (u right, y up, v front) -> Blender (x, y, z)."""
    return Vector((u, -v, y))


# --- Primitive helpers (game frame: u right, y up, v front) -------------------
# Blender mapping: location (u, -v, y); blender box dims (su, sv, sy).

def box(parts, cu, cy, cv, su, sy, sv, key, bev=0.01, rot=None, seg=None):
    bpy.ops.mesh.primitive_cube_add(location=(cu, -cv, cy))
    o = bpy.context.active_object
    o.scale = (su / 2, sv / 2, sy / 2)
    activate(o)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if rot:
        o.rotation_euler = rot
    finish(o, key, bev=min(bev, su / 2.5, sy / 2.5, sv / 2.5) if bev >= 0.004 else 0.0, seg=seg)
    parts.append(o)
    return o


def decal(parts, cu, cy, cv, sa, sb, key, face="v", rot=None):
    """Paper-thin surface detail as ONE quad (4 vertices) instead of a 24-vertex
    slab: labels, notes, screens, key fields, strokes, seams. face: v (front,
    sa x sb = width x height), y (up, width x depth) or u / -u (side,
    depth x height). Place it 2-4 mm proud of the surface it sits on."""
    a, b = sa / 2, sb / 2
    if face == "v":
        verts = [(-a, 0, -b), (a, 0, -b), (a, 0, b), (-a, 0, b)]
    elif face == "y":
        verts = [(-a, -b, 0), (a, -b, 0), (a, b, 0), (-a, b, 0)]
    elif face == "u":
        verts = [(0, -a, -b), (0, a, -b), (0, a, b), (0, -a, b)]
    else:  # "-u"
        verts = [(0, -a, b), (0, a, b), (0, a, -b), (0, -a, -b)]
    return make_mesh(parts, "decal", verts, [(0, 1, 2, 3)], key, shading="flat",
                     recalc=False, location=G(cu, cy, cv), rot=rot)


def cyl(parts, cu, cy, cv, r, h, key, axis="y", bev=0.0, verts=16, smooth=True, rot=None):
    if rot is None:
        rot = (0, 0, 0)
        if axis == "v":
            rot = (R(90), 0, 0)
        elif axis == "u":
            rot = (0, R(90), 0)
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


def sphere(parts, cu, cy, cv, r, key, scale=(1, 1, 1), smooth=True, segments=12, rings=8):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, radius=r,
                                         location=(cu, -cv, cy))
    o = bpy.context.active_object
    o.scale = (scale[0], scale[2], scale[1])
    activate(o)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    finish(o, key, smooth=smooth)
    parts.append(o)
    return o


def torus(parts, cu, cy, cv, major, minor, key, axis="y", smooth=True, major_seg=24, minor_seg=6):
    rot = (R(90), 0, 0) if axis == "v" else (0, 0, 0)
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor,
                                     major_segments=major_seg, minor_segments=minor_seg,
                                     location=(cu, -cv, cy), rotation=rot)
    o = bpy.context.active_object
    finish(o, key, smooth=smooth)
    parts.append(o)
    return o


def soft_box(parts, cu, cy, cv, su, sy, sv, key, r=0.03, seg=2, cuts=1,
             puff=(0.0, 0.0, 0.0), sag=0.0, bend=0.0, taper=0.0, rot=None):
    """Upholstery block: a subdivided box whose faces bulge (`puff` = u, y, v
    bulge in metres at each face centre), whose top dips (`sag`), optionally
    curved around the sitter (`bend`: edges pulled toward +v) and narrowed
    toward the top (`taper`); then a rounded bevel and fully smooth normals."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=2.0)
    if cuts:
        bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=cuts, use_grid_fill=True)
    pu, py, pv = puff
    for vert in bm.verts:
        x, yy, z = vert.co          # Blender cube: x=u, yy=-v, z=up, in [-1, 1]
        vn = -yy
        U = x * su / 2 + pu * x * (1 - vn * vn) * (1 - z * z)
        V = vn * sv / 2 + pv * vn * (1 - x * x) * (1 - z * z)
        Y = z * sy / 2 + py * z * (1 - x * x) * (1 - vn * vn)
        if sag and z > 0:
            Y -= sag * z * (1 - x * x) * (1 - vn * vn)
        if taper:
            U *= 1 - taper * (z + 1) / 2
        if bend:
            V += bend * x * x
        vert.co = (U, -V, Y)
    mesh = bpy.data.meshes.new("soft_box")
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new("soft_box", mesh)
    COLLECTION.objects.link(obj)
    obj.location = (cu, -cv, cy)
    if rot:
        obj.rotation_euler = rot
    finish(obj, key, bev=min(r, su / 2.2, sy / 2.2, sv / 2.2), seg=seg, soft=True)
    parts.append(obj)
    return obj


def pillow(parts, cu, cy, cv, su, sy, sv, key, cuts=2, thin=0.3, rot=None):
    """Classic stuffed pillow: thick centre, seams pinched thin at the rim."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=2.0)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=cuts, use_grid_fill=True)
    for vert in bm.verts:
        x, yy, z = vert.co
        k = math.sqrt(max(0.0, 1 - 0.92 * x * x)) * math.sqrt(max(0.0, 1 - 0.92 * yy * yy))
        z *= thin + (1 - thin) * k
        x2 = x * (1 - 0.1 * yy * yy)
        y2 = yy * (1 - 0.1 * x * x)
        vert.co = (x2 * su / 2, y2 * sv / 2, z * sy / 2)
    mesh = bpy.data.meshes.new("pillow")
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new("pillow", mesh)
    COLLECTION.objects.link(obj)
    obj.location = (cu, -cv, cy)
    if rot:
        obj.rotation_euler = rot
    finish(obj, key, soft=True)
    parts.append(obj)
    return obj


def _ring(shape, segments):
    """Ring points (du, dv) for a lathe profile entry."""
    if shape[0] == "rrect":
        _, hu, hv, r = shape
        r = max(0.004, min(r, hu - 1e-3, hv - 1e-3))
        nc = max(1, segments // 4 - 1)
        pts = []
        for q, (cx, cy) in enumerate(((hu - r, hv - r), (-(hu - r), hv - r),
                                      (-(hu - r), -(hv - r)), (hu - r, -(hv - r)))):
            for k in range(nc + 1):
                a = (q + k / nc) * (math.pi / 2)
                pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
        return pts
    _, ru, rv = shape
    return [(ru * math.cos(i * TAU / segments), rv * math.sin(i * TAU / segments)) for i in range(segments)]


def lathe(parts, cu, cv, profile, key, segments=24, shape="ellipse", closed=False,
          cap_bottom=True, cap_top=True, shading="smooth", rot=None, pivot=None):
    """Surface of revolution through elliptical (ru, rv, y[, du, dv]) or
    rounded-rectangle (hu, hv, r, y[, du, dv]) rings. `closed` wraps the last
    ring back to the first (a torus-like seat ring). With `pivot` (game
    coords) the profile is LOCAL to the pivot and the object is rotated by
    `rot` about it (a raised toilet lid)."""
    vertices = []
    n = None
    for entry in profile:
        if shape == "rrect":
            hu, hv, r, y = entry[:4]
            extra = entry[4:]
            ring = _ring(("rrect", hu, hv, r), segments)
        else:
            ru, rv, y = entry[:3]
            extra = entry[3:]
            ring = _ring(("ellipse", ru, rv), segments)
        du = extra[0] if len(extra) > 0 else 0.0
        dv = extra[1] if len(extra) > 1 else 0.0
        n = len(ring)
        for a, b in ring:
            vertices.append(G(cu + du + a, y, cv + dv + b))
    rings = len(profile)
    faces = []
    for ring in range(rings - 1 + (1 if closed else 0)):
        r0 = ring % rings
        r1 = (ring + 1) % rings
        for i in range(n):
            j = (i + 1) % n
            faces.append((r0 * n + i, r0 * n + j, r1 * n + j, r1 * n + i))
    if not closed:
        if cap_bottom:
            faces.append(tuple(reversed(range(n))))
        if cap_top:
            faces.append(tuple(range((rings - 1) * n, rings * n)))
    loc = G(*pivot) if pivot else None
    return make_mesh(parts, "lathe", vertices, faces, key, shading=shading,
                     location=loc, rot=rot)


def bowl(parts, cu, cv, profile, key, segments=28):
    """Closed elliptical shell, outer bottom -> rim -> recessed inner floor."""
    return lathe(parts, cu, cv, profile, key, segments=segments)


def catmull(points, sub):
    out = []
    n = len(points)
    for i in range(n - 1):
        p0 = points[i - 1] if i > 0 else points[i] * 2 - points[i + 1]
        p1, p2 = points[i], points[i + 1]
        p3 = points[i + 2] if i + 2 < n else points[i + 1] * 2 - points[i]
        for s in range(sub):
            t = s / sub
            out.append(0.5 * ((2 * p1) + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                              + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t))
    out.append(points[-1])
    return out


def tube(parts, pts, r, key, seg=8, radii=None, sub=1, shading="soft"):
    """Swept circle along game-frame points (parallel-transport frames)."""
    P = [G(*q) for q in pts]
    rad = list(radii) if radii else [r] * len(P)
    if sub > 1:
        P = catmull(P, sub)
        rv = [Vector((x, 0, 0)) for x in rad]
        rad = [v.x for v in catmull(rv, sub)]
    n = len(P)
    T = [(P[min(i + 1, n - 1)] - P[max(i - 1, 0)]).normalized() for i in range(n)]
    ref = Vector((0, 0, 1)) if abs(T[0].z) < 0.9 else Vector((1, 0, 0))
    N = T[0].cross(ref).normalized()
    verts = []
    for i in range(n):
        N = (N - T[i] * N.dot(T[i])).normalized()
        B = T[i].cross(N)
        for k in range(seg):
            a = TAU * k / seg
            verts.append(P[i] + N * (math.cos(a) * rad[i]) + B * (math.sin(a) * rad[i]))
    faces = []
    for i in range(n - 1):
        for k in range(seg):
            j = (k + 1) % seg
            faces.append((i * seg + k, i * seg + j, (i + 1) * seg + j, (i + 1) * seg + k))
    faces.append(tuple(reversed(range(seg))))
    faces.append(tuple(range((n - 1) * seg, n * seg)))
    return make_mesh(parts, "tube", verts, faces, key, shading=shading)


def ribbon(parts, path, t, a0, a1, key, plane="uy", segs=1, wave=None):
    """A thick cloth strip: 2D `path` [(s, y)] in the u-y (plane='uy', swept
    along v from a0 to a1) or v-y plane (swept along u), offset +-t/2.
    `wave(a, s, y, i)` may return an (ds, dy) ripple per vertex."""
    n = len(path)
    offs = []
    for i in range(n):
        s0, y0 = path[max(i - 1, 0)]
        s1, y1 = path[min(i + 1, n - 1)]
        L = math.hypot(s1 - s0, y1 - y0) or 1.0
        offs.append((-(y1 - y0) / L, (s1 - s0) / L))
    outer = [(s + nx * t / 2, y + ny * t / 2) for (s, y), (nx, ny) in zip(path, offs)]
    inner = [(s - nx * t / 2, y - ny * t / 2) for (s, y), (nx, ny) in zip(path, offs)]
    loop = outer + list(reversed(inner))
    m = len(loop)
    verts = []
    for k in range(segs + 1):
        a = a0 + (a1 - a0) * k / segs
        for j, (s, y) in enumerate(loop):
            i = j if j < n else m - 1 - j
            ds, dy = wave(a, s, y, i) if wave else (0.0, 0.0)
            verts.append(G(s + ds, y + dy, a) if plane == "uy" else G(a, y + dy, s + ds))
    faces = []
    for k in range(segs):
        for j in range(m):
            jj = (j + 1) % m
            faces.append((k * m + j, k * m + jj, (k + 1) * m + jj, (k + 1) * m + j))
    for k in (0, segs):
        for i in range(n - 1):
            faces.append((k * m + i, k * m + i + 1, k * m + (m - 2 - i), k * m + (m - 1 - i)))
    return make_mesh(parts, "ribbon", verts, faces, key, shading="soft")


def drape(parts, key, hw, v0, v1, top, rr, hang_side, hang_foot, thick,
          us, vs, uc=0.0, wave=0.0, bump=0.0):
    """Cloth laid over a box top [uc-hw, uc+hw] x [v0, v1] at `top`: it rolls
    over the rounded edges (radius rr) and hangs `hang_side` down both u sides
    and `hang_foot` over the +v end. `us`/`vs` are the unrolled grid samples;
    the surface is thickened (solidify) into a closed slab."""
    arc = math.pi * rr / 2
    flare = 0.25  # hanging cloth kicks outward a little as it falls

    def fold(d):
        if d <= 0:
            return 0.0, 0.0
        if d <= arc:
            a = d / rr
            return rr * math.sin(a), rr * (1 - math.cos(a))
        return rr + flare * (d - arc), rr + (d - arc)

    verts = []
    for sv in vs:
        for su in us:
            du = max(0.0, abs(su) - hw)
            dv = max(0.0, sv - v1)
            lu, drop_u = fold(du)
            lv, drop_v = fold(dv)
            u = uc + math.copysign(min(abs(su), hw) + lu, su)
            v = min(sv, v1) + lv
            # Corners hang by the deeper drop plus a share of the other, so
            # the cloth keeps falling (no two grid points collapse together).
            hang = max(drop_u, drop_v) + 0.4 * min(drop_u, drop_v)
            y = top - hang
            if wave and hang > rr:
                k = min(1.0, (hang - rr) / max(hang_side, hang_foot))
                if du > 0 and dv <= 0:
                    u += math.copysign(wave * k * (0.5 + 0.5 * math.sin(sv * 13.0 + 0.6)), su)
                elif dv > 0 and du <= 0:
                    v += wave * k * (0.5 + 0.5 * math.sin(su * 11.0 + 1.3))
                else:
                    u += math.copysign(wave * k * 0.6, su)
                    v += wave * k * 0.6
            if bump and du <= 0 and dv <= 0:
                y += bump * math.sin(su * 5.1 + 0.7) * math.sin((sv - v0) * 3.3 + 0.4)
            verts.append(G(u, y, v))
    nu = len(us)
    faces = []
    for j in range(len(vs) - 1):
        for i in range(nu - 1):
            faces.append((j * nu + i, (j + 1) * nu + i, (j + 1) * nu + i + 1, j * nu + i + 1))
    obj = make_mesh(parts, "drape", verts, faces, key, shading="soft", recalc=False)
    mid = obj.data.polygons[len(obj.data.polygons) // 2 - (nu - 1) // 2]
    if mid.normal.z < 0:
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
        bm.to_mesh(obj.data)
        bm.free()
    solid = obj.modifiers.new("solid", "SOLIDIFY")
    solid.thickness = thick
    solid.offset = 1.0
    solid.use_even_offset = False  # even offset spikes on the folded corners
    solid.use_rim = True
    activate(obj)
    bpy.ops.object.modifier_apply(modifier=solid.name)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def leaf(parts, cu, cy, cv, height, angle, lean, twist=0.4, width=1.0, arch=1.6):
    """Snake-plant blade: tapered, keeled (V section), arching and twisting
    as it rises, closed thin back, rooted in the soil."""
    profile = ((0.0, 0.013), (0.18, 0.028), (0.45, 0.038), (0.72, 0.031),
               (0.9, 0.016), (1.0, 0.0015))
    vertices = []
    for t, half_width in profile:
        half_width *= width
        spread = math.sin(lean) * height * (t ** arch)
        tw = twist * t
        ca, sa = math.cos(angle), math.sin(angle)
        for side, fold in ((-1, 0.0), (0, -0.007), (1, 0.0), (0, 0.011 * (1 - 0.7 * t))):
            # Width axis twists about the blade's rising spine.
            wx = -sa * math.cos(tw) - ca * math.sin(tw)
            wv = ca * math.cos(tw) - sa * math.sin(tw)
            nx = ca * math.cos(tw) - sa * math.sin(tw)
            nv = sa * math.cos(tw) + ca * math.sin(tw)
            u = cu + ca * spread + wx * half_width * side + nx * fold
            v = cv + sa * spread + wv * half_width * side + nv * fold
            vertices.append(G(u, cy + height * t * (1 - 0.18 * math.sin(lean) * t), v))
    faces = [(3, 2, 1, 0)]
    rings = len(profile)
    for ring in range(rings - 1):
        for i in range(4):
            faces.append((ring * 4 + i, ring * 4 + (i + 1) % 4,
                          (ring + 1) * 4 + (i + 1) % 4, (ring + 1) * 4 + i))
    last = (rings - 1) * 4
    faces.append((last, last + 1, last + 2, last + 3))
    make_mesh(parts, "snake_plant_leaf", vertices, faces, "leafGreen", shading="smooth")


def lcg(seed):
    """Deterministic pseudo-random stream (stable rebuilds)."""
    state = [seed & 0x7FFFFFFF]

    def nxt():
        state[0] = (1103515245 * state[0] + 12345) & 0x7FFFFFFF
        return state[0] / 0x7FFFFFFF
    return nxt


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
TOL_CENTER = 0.11  # the vitest contract allows 0.12 off-centre

# Transfer/triangle budgets mirrored by src/render/__tests__/furniture-models.test.js.
BUDGET_BYTES = 650_000
BUDGET_TRIS = 20_000


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
    total_bytes = total_tris = 0
    for name, fn, ew, ed, eh in MODELS:
        parts = []
        fn(parts)
        bpy.ops.object.select_all(action="DESELECT")
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
        if abs(max(xs) + min(xs)) / 2 > TOL_CENTER or abs(max(ys) + min(ys)) / 2 > TOL_CENTER:
            raise RuntimeError(f"{name}: footprint off-centre")
        if max(zs) > eh + 0.05:
            raise RuntimeError(f"{name}: top {max(zs):.3f} exceeds {eh:.3f}")
        if min(zs) < -0.005:
            raise RuntimeError(f"{name}: dips below floor ({min(zs):.3f})")

        # Painted vertex shading (COLOR_0 multiplier): floor gradient, soft
        # cavity/contact occlusion, warm catch-light on convex top edges.
        # Computed on the closed parts, THEN never-visible faces are culled.
        keys = yr_shading.paint(obj, height=max(zs), keep_bright={"yr_ledGreen"})
        culled = yr_shading.cull_hidden(obj)
        tris = yr_shading.triangle_count(obj)
        yr_shading.audit_triangles(obj, name)

        path = os.path.join(OUT_DIR, name + ".glb")
        activate(obj)
        _before, after = yr_shading.export_glb(path, sel_kw)
        total_bytes += after
        total_tris += tris
        print(f"[yr] {name:<11} {w:.2f}x{d:.2f}x{h:.2f}  tris={tris:<5} culled={culled:<4} "
              f"verts={len(obj.data.vertices):<5} shade={keys:<5} {after} B")
        built.append(obj)
    print(f"[yr] TOTAL furniture: {total_tris} triangles, {total_bytes} bytes "
          f"(budget {BUDGET_TRIS} / {BUDGET_BYTES})")
    if total_tris >= BUDGET_TRIS or total_bytes >= BUDGET_BYTES:
        raise RuntimeError("furniture set exceeds its triangle/byte budget")

    # Lay the joined models out in a grid for the source blend + preview.
    cols = 6
    for i, obj in enumerate(built):
        obj.location = ((i % cols) * 2.6, -(i // cols) * 3.8, 0)
    return built


def render_preview():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 32
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 2400
    scene.render.resolution_y = 1800
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
    key.rotation_euler = (R(25), R(15), R(20))
    bpy.ops.object.light_add(type="AREA", location=(0, 4, 5))
    fill = bpy.context.active_object
    fill.data.energy = 320
    fill.data.size = 5
    fill.rotation_euler = (R(60), 0, R(160))

    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
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
if os.environ.get("YR_SKIP_PREVIEW") != "1":
    render_preview()
print("[yr] done")
