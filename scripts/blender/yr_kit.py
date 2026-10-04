# Yellow Rooms — shared Blender builder kit: the primitive helpers every asset
# pipeline (packs/*.py through build_pack.py, build_enemies.py, POCs) builds
# with, plus scene, palette, marker and export plumbing.
#
# Import-safe: no bpy side effects at import. A build calls
# use(collection, mat_fn) once per scene, then the helpers link new objects
# into that collection and resolve palette keys through mat_fn. Interactive
# sessions cache modules: call use() again on every build (and
# importlib.reload(yr_kit) after editing this file).
#
# Frame contract (src/world/objects/furniture/frame.js): primitives take game
# coordinates (u right, y up, v toward the front); Blender gets (u, -v, y), so
# the glTF export (+Y up) faces +Z, the facing=0 direction.
#
# The primitives' signatures and bodies are frozen: the committed GLBs are
# byte-identical rebuilds of them, so a change here rewrites every asset.

import math
import os
import re

import bmesh
import bpy
from mathutils import Vector

__all__ = [
    # context + scene
    "TAU", "R", "use", "mat", "wipe_factory_scene", "new_collection",
    "palette_materials", "gltf_selection_kwargs",
    # game-source parsing
    "parse_js_consts", "parse_js_rgb_table",
    # primitives
    "activate", "link", "weighted_normals", "smooth_by_angle", "finish", "make_mesh", "G",
    "box", "decal", "cyl", "cone", "sphere", "torus", "soft_box", "pillow", "lathe", "bowl",
    "catmull", "tube", "ribbon", "drape", "leaf", "lcg",
    # build markers + contact sheet
    "marker", "layout_grid", "contact_sheet",
]

TAU = math.tau
R = math.radians


class _Ctx:
    collection = None
    mat = None


_ctx = _Ctx()


def use(collection, mat_fn):
    """Route every helper's new objects into `collection` and resolve palette
    keys through `mat_fn(key) -> Material`."""
    _ctx.collection = collection
    _ctx.mat = mat_fn


def mat(key):
    return _ctx.mat(key)


def wipe_factory_scene():
    """Delete the factory startup's cube/light/camera and their datablocks."""
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.curves, bpy.data.cameras, bpy.data.lights):
        for data in list(block):
            block.remove(data)


def new_collection(name):
    col = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(col)
    return col


def palette_materials(palette, prefix="yr_"):
    """palette: key -> (linear rgb, metallic, roughness). Returns a cached
    mat_fn(key) creating `<prefix><key>` painted materials on first use (the
    runtime resolves surfaces by that name: src/render/surfaces.js)."""
    import yr_shading
    cache = {}

    def mat_fn(key):
        if key not in cache:
            rgb, metal, rough = palette[key]
            cache[key] = yr_shading.shaded_material(prefix + key, rgb, metallic=metal, roughness=rough)
        return cache[key]
    return mat_fn


def gltf_selection_kwargs():
    """The exporter's "selected objects only" flag, whatever this Blender calls it."""
    props = bpy.ops.export_scene.gltf.get_rna_type().properties
    for ident in ("use_selection", "export_selected_objects", "use_visible"):
        if ident in props:
            return {ident: True}
    return {}


# --- Game-source parsing (the JS sources stay the single source of truth) -----

def parse_js_consts(path, need=()):
    """`export const NAME = <number>` literals of a JS module -> {NAME: float}.
    Raises when any name in `need` is missing (an expression, not a literal)."""
    src = open(path, encoding="utf-8").read()
    out = {}
    for name, val in re.findall(r"export const (\w+) = (-?[\d.]+)\s*(?://|\n)", src):
        out[name] = float(val)
    missing = [n for n in need if n not in out]
    if missing:
        raise RuntimeError(f"constants parse failed ({os.path.basename(path)}), missing: {missing}")
    return out


def parse_js_rgb_table(path, const_name, min_entries=1):
    """`const_name = { key: [r, g, b], ... }` (unsigned decimal literals) -> {key: (r, g, b)}."""
    src = open(path, encoding="utf-8").read()
    found = re.search(const_name + r"\s*=\s*\{(.*?)\n\}", src, re.S)
    table = {}
    if found:
        for name, r, g, b in re.findall(r"(\w+):\s*\[([\d.]+),\s*([\d.]+),\s*([\d.]+)\]", found.group(1)):
            table[name] = (float(r), float(g), float(b))
    if len(table) < min_entries:
        raise RuntimeError(f"{const_name} parse failed ({len(table)} entries)")
    return table


# --- Primitive plumbing -----------------------------------------------------------

def activate(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def link(obj):
    # Move from the scene-default collection into ours.
    for col in list(obj.users_collection):
        col.objects.unlink(obj)
    _ctx.collection.objects.link(obj)


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
    _ctx.collection.objects.link(obj)
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


def _uv_sphere(segments, rings, r):
    """Blender's UV-sphere layout (same vertex set as primitive_uv_sphere_add)
    built from explicit lists: the operator's face/loop order is not stable
    run to run on Blender 5.2, which reorders GLB indices."""
    verts = [(0.0, 0.0, r)]
    for k in range(1, rings):
        th = math.pi * k / rings
        for j in range(segments):
            ph = -math.pi / 2 + TAU * j / segments
            verts.append((r * math.sin(th) * math.cos(ph), r * math.sin(th) * math.sin(ph), r * math.cos(th)))
    bot = len(verts)
    verts.append((0.0, 0.0, -r))
    S = segments
    faces = [(0, 1 + j, 1 + (j + 1) % S) for j in range(S)]
    for k in range(rings - 2):
        a, b = 1 + k * S, 1 + (k + 1) * S
        faces += [(a + j, b + j, b + (j + 1) % S, a + (j + 1) % S) for j in range(S)]
    a = 1 + (rings - 2) * S
    faces += [(a + j, bot, a + (j + 1) % S) for j in range(S)]
    return verts, faces


def sphere(parts, cu, cy, cv, r, key, scale=(1, 1, 1), smooth=True, segments=12, rings=8):
    verts, faces = _uv_sphere(segments, rings, r)
    verts = [(x * scale[0], y * scale[2], z * scale[1]) for x, y, z in verts]
    mesh = bpy.data.meshes.new("Sphere")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(mesh)
    bm.free()
    o = bpy.data.objects.new("Sphere", mesh)
    bpy.context.scene.collection.objects.link(o)
    o.location = (cu, -cv, cy)
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
    _ctx.collection.objects.link(obj)
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
    _ctx.collection.objects.link(obj)
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


def leaf(parts, cu, cy, cv, height, angle, lean, twist=0.4, width=1.0, arch=1.6, key="leafGreen"):
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
    make_mesh(parts, "snake_plant_leaf", vertices, faces, key, shading="smooth")


def lcg(seed):
    """Deterministic pseudo-random stream (stable rebuilds)."""
    state = [seed & 0x7FFFFFFF]

    def nxt():
        state[0] = (1103515245 * state[0] + 12345) & 0x7FFFFFFF
        return state[0] / 0x7FFFFFFF
    return nxt


# --- Build markers ------------------------------------------------------------------

def marker(parts, name, cu, cy, cv, su=0.0, sy=0.0, sv=0.0, **props):
    """Named EMPTY in game frame. With a size it is an axis-aligned box
    (CUBE display, half-extents in its scale): `col_<n>` collision boxes and
    `occ_<A|B>` shadow proxies (prop `t` = transmission eighths). Without one
    it is a point: `socket_<type>_<n>` with string props (`yrSocket=type`, ...)
    exported as glTF node extras. build_pack.py reads boxes into the manifest
    and never exports them; sockets ship in the GLB."""
    e = bpy.data.objects.new(name, None)
    _ctx.collection.objects.link(e)
    e.empty_display_type = "CUBE" if su else "PLAIN_AXES"
    e.location = (cu, -cv, cy)
    if su:
        e.scale = (su / 2, sv / 2, sy / 2)
    for k, v in props.items():
        e[k] = v
    parts.append(e)
    return e


# --- Contact sheet ------------------------------------------------------------------

def layout_grid(objs, cols=6, spacing=(2.6, 3.8)):
    """Lay built objects out in rows (Blender x right, -y down the sheet) for
    the source .blend and the contact sheet. Call after export."""
    for i, obj in enumerate(objs):
        obj.location = ((i % cols) * spacing[0], -(i // cols) * spacing[1], 0)


def contact_sheet(objs, path, cols=6, spacing=(2.6, 3.8), samples=32, res=(2400, 1800)):
    """Cycles render of `objs` (already laid out by layout_grid) under a warm
    key, a fill and an ortho camera framed on the grid, over a ground plane."""
    import yr_shading
    rows = max(1, -(-len(objs) // cols))
    span_x = (min(len(objs), cols) - 1) * spacing[0]
    span_y = (rows - 1) * spacing[1]
    target = Vector((span_x / 2, -span_y / 2, 0.8))
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.filepath = path
    scene.world = bpy.data.worlds.new("yr_world")
    bg = yr_shading.ensure_nodes(scene.world).nodes.get("Background")
    bg.inputs[0].default_value = (0.75, 0.73, 0.68, 1.0)
    bg.inputs[1].default_value = 0.35

    bpy.ops.object.light_add(type="AREA", location=target + Vector((0, -2.4, 8.2)))
    key = bpy.context.active_object
    key.data.energy = 850
    key.data.shape = "DISK"
    key.data.size = 6
    key.rotation_euler = (R(25), R(15), R(20))
    bpy.ops.object.light_add(type="AREA", location=target + Vector((-6.5, 9.6, 4.2)))
    fill = bpy.context.active_object
    fill.data.energy = 320
    fill.data.size = 5
    fill.rotation_euler = (R(60), 0, R(160))

    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    cam.location = target + Vector((2.0, -19.4, 22.2))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = max(span_x, span_y) + 5.5
    scene.camera = cam

    # Ground plane for contact shadows.
    bpy.ops.mesh.primitive_plane_add(size=60, location=(target.x, target.y, -0.01))
    ground = bpy.context.active_object
    gm = bpy.data.materials.new("yr_ground")
    yr_shading.ensure_nodes(gm).nodes.get("Principled BSDF").inputs["Base Color"].default_value = (0.32, 0.3, 0.27, 1)
    ground.data.materials.append(gm)

    bpy.ops.render.render(write_still=True)
    print(f"[yr] preview -> {path}")
