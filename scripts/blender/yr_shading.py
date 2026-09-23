# Yellow Rooms — shared "painted" vertex shading + GLB compaction for the
# Blender asset pipelines (build_furniture.py, build_enemies.py).
#
# Anime background painters shade props with soft value gradients rather than
# texture detail: a little darker toward the floor, a cool cavity tone where
# parts meet, a faint warm catch-light along convex top edges. We fake that
# per vertex and store it as a COLOR_0 multiplier; the runtime bake
# (src/render/furnitureModels.js bakeFurnitureGeometry) multiplies it with the
# material baseColorFactor, so the part palette stays the single colour source.
#
# The game already runs SSAO, so the baked occlusion is deliberately gentle
# (multiplier ~0.74..1.0): it adds painted form, never crushes to black.
#
# Import-safe helper module (no bpy side effects at import).

import json
import math
import struct

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

SHADE_ATTR = "yr_shade"


# --- Materials -------------------------------------------------------------------

def shaded_material(name, rgb, metallic=0.0, roughness=0.78):
    """Principled material whose Base Color = ColorAttribute x constant.

    That exact node pattern (Mix/MULTIPLY, factor 1) is what the glTF exporter
    recognizes as `baseColorFactor` + `COLOR_0`, and Cycles/EEVEE show the
    painted shading in the source .blend and the contact sheet.
    """
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    # Closed meshes: single-sided export (smaller JSON, correct semantics).
    m.use_backface_culling = True
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    attr = nodes.new("ShaderNodeVertexColor")
    attr.layer_name = SHADE_ATTR
    attr.location = (-520, 260)
    mix = nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.location = (-260, 260)
    mix.inputs["Factor"].default_value = 1.0
    mix.inputs[7].default_value = (rgb[0], rgb[1], rgb[2], 1.0)  # B_Color
    links.new(attr.outputs["Color"], mix.inputs[6])               # A_Color
    links.new(mix.outputs[2], bsdf.inputs["Base Color"])          # Result
    m.diffuse_color = (rgb[0], rgb[1], rgb[2], 1.0)
    return m


# --- Painted vertex shading ---------------------------------------------------------

def _radical_inverse(i):
    bits = 0.0
    f = 0.5
    while i:
        bits += f * (i & 1)
        i >>= 1
        f *= 0.5
    return bits


def _hemisphere(n):
    """Deterministic cosine-weighted hemisphere (Hammersley), z = normal."""
    dirs = []
    for i in range(n):
        u = (i + 0.5) / n
        phi = math.tau * _radical_inverse(i + 1)
        r = math.sqrt(u)
        dirs.append((r * math.cos(phi), r * math.sin(phi), math.sqrt(max(0.0, 1.0 - u))))
    return dirs


def _smoothstep(e0, e1, x):
    t = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def paint(obj, height=None, ao_dist=0.3, ao_floor=0.74, ao_gamma=1.0,
          grad_floor=0.84, grad_span=0.85, rim=0.035, rays=48, floor_weight=0.5,
          min_value=0.64, cool=(0.10, 0.04), warm=(0.012, 0.035), keep_bright=()):
    """Bake the painted multiplier into a CORNER float color attribute.

    obj        joined mesh at the identity transform, Blender Z-up, floor z=0.
    height     model height for the vertical gradient (defaults to its bbox).
    ao_dist    occlusion search radius in metres (plus a virtual floor at z=0).
    ao_floor   multiplier at full occlusion (remapped AO range ao_floor..1).
    grad_floor multiplier at the floor end of the vertical gradient.
    grad_span  fraction of the height over which the gradient reaches 1.
    rim        lift for convex up-facing bevel/shoulder normals (the painted
               top-edge catch light); flat faces sit at 1 - rim.
    floor_weight  share of occlusion the virtual floor contributes: the game's
               SSAO already grounds every piece, so the bake only hints at it.
    min_value  floor of the final multiplier (never crush toward black).
    cool/warm  (red, green) cut in shadow; (green, blue) cut on the rim, so
               cavities read slightly cool and catch-lights slightly warm.
    keep_bright material names left at 1.0 (LEDs, eyes: pure signal colours).

    Values are keyed per (vertex, corner normal): corners that already share
    a vertex AND normal get the same colour, so the exporter never has to
    split extra vertices for the colour attribute.
    """
    mesh = obj.data
    verts = [v.co.copy() for v in mesh.vertices]
    polys = [tuple(p.vertices) for p in mesh.polygons]
    bvh = BVHTree.FromPolygons(verts, polys, all_triangles=False)
    if height is None:
        height = max((v.z for v in verts), default=1.0)
    height = max(height, 1e-3)
    zmin = 0.0  # the floor contract: origin on the floor (wall pieces float above it)

    corner_normals = [Vector(cn.vector) for cn in mesh.corner_normals]
    bright_idx = {i for i, m in enumerate(mesh.materials) if m and m.name in keep_bright}
    loop_poly = [0] * len(mesh.loops)
    for p in mesh.polygons:
        for li in p.loop_indices:
            loop_poly[li] = p.index

    hemi = _hemisphere(rays)
    cache = {}
    colors = np.ones((len(mesh.loops), 4), dtype=np.float32)
    eps = 0.0025
    for li, loop in enumerate(mesh.loops):
        if mesh.polygons[loop_poly[li]].material_index in bright_idx:
            continue
        vi = loop.vertex_index
        n = corner_normals[li]
        key = (vi, round(n.x, 3), round(n.y, 3), round(n.z, 3))
        rgb = cache.get(key)
        if rgb is None:
            rgb = _shade_point(bvh, verts[vi], n, hemi, eps, ao_dist, ao_floor, ao_gamma,
                               height, zmin, grad_floor, grad_span, rim, cool, warm,
                               floor_weight, min_value)
            cache[key] = rgb
        colors[li, 0:3] = rgb

    attr = mesh.color_attributes.get(SHADE_ATTR)
    if attr is not None:
        mesh.color_attributes.remove(attr)
    attr = mesh.color_attributes.new(SHADE_ATTR, "FLOAT_COLOR", "CORNER")
    attr.data.foreach_set("color", colors.ravel())
    mesh.color_attributes.active_color = attr
    mesh.color_attributes.render_color_index = mesh.color_attributes.find(SHADE_ATTR)
    return len(cache)


def _shade_point(bvh, p, n, hemi, eps, dist, ao_floor, gamma, height, zmin,
                 grad_floor, grad_span, rim, cool, warm, floor_weight, min_value):
    if n.length < 1e-6:
        n = Vector((0, 0, 1))
    n = n.normalized()
    a = Vector((1, 0, 0)) if abs(n.x) < 0.9 else Vector((0, 1, 0))
    t = a.cross(n).normalized()
    b = n.cross(t)
    origin = p + n * eps
    occl = 0.0
    for dx, dy, dz in hemi:
        d = t * dx + b * dy + n * dz
        hit = dist
        weight = 1.0
        loc, hn, _i, hd = bvh.ray_cast(origin, d, dist)
        if loc is not None:
            # Starting inside another part (a leg sunk into a top): the ray
            # meets a back face. Treat it as contact — fully occluded.
            hit = 0.0 if hn.dot(d) > 0 else hd
        if d.z < -1e-4 and origin.z > zmin - 1e-4:
            tf = (origin.z - zmin) / -d.z
            if tf < hit:
                hit, weight = tf, floor_weight
        if hit < dist:
            f = hit / dist
            occl += weight * (1.0 - f) * (1.0 - f)
    ao = 1.0 - occl / len(hemi)
    ao_m = ao_floor + (1.0 - ao_floor) * (ao ** gamma)

    h = (p.z - zmin) / (height * grad_span)
    g = grad_floor + (1.0 - grad_floor) * _smoothstep(0.0, 1.0, h)

    # Catch light on convex top edges: bevel strips / shoulders whose normal
    # sits between up and sideways. Flat tops and walls both stay at 1 - rim.
    up = max(0.0, n.z)
    lift = math.sin(math.pi * min(1.0, up / 0.95)) if 0.05 < up < 0.95 else 0.0
    e = (1.0 - rim) + rim * lift

    m = max(min_value, min(1.0, ao_m * g * e))
    dark = 1.0 - m
    r = m * (1.0 - cool[0] * dark)
    gg = m * (1.0 - cool[1] * dark) * (1.0 - warm[0] * lift)
    bb = m * (1.0 - warm[1] * lift)
    return (r, gg, bb)


# --- Hidden-face culling ----------------------------------------------------------------

def _buried(bvh, p, n, eps=0.003, probes=((0, 0, 1), (0.7, 0, 0.7), (-0.7, 0, 0.7),
                                          (0, 0.7, 0.7), (0, -0.7, 0.7))):
    """True when a point just off the surface sits inside another closed part
    (every probe ray meets a back face) or under the floor."""
    if n.length < 1e-6:
        return False
    n = n.normalized()
    a = Vector((1, 0, 0)) if abs(n.x) < 0.9 else Vector((0, 1, 0))
    t = a.cross(n).normalized()
    b = n.cross(t)
    origin = p + n * eps
    if origin.z < -1e-4:
        return True
    for dx, dy, dz in probes:
        d = (t * dx + b * dy + n * dz).normalized()
        loc, hn, _i, _d = bvh.ray_cast(origin, d, 4.0)
        if loc is None or hn.dot(d) <= 0:
            return False
    return True


def cull_hidden(obj):
    """Delete faces nobody can ever see: faces lying on the floor facing down,
    and faces whose corners, edge midpoints and centre are all sunk inside
    another part (book bottoms on shelves, leg tops inside table tops, joint
    spheres inside limbs). Run AFTER paint() so occlusion saw closed parts.
    Returns the number of faces removed."""
    mesh = obj.data
    verts = [v.co.copy() for v in mesh.vertices]
    polys = [tuple(p.vertices) for p in mesh.polygons]
    bvh = BVHTree.FromPolygons(verts, polys, all_triangles=False)
    doomed = []
    for poly in mesh.polygons:
        n = poly.normal
        pts = [verts[i] for i in poly.vertices]
        if n.z < -0.95 and max(p.z for p in pts) < 0.003:
            doomed.append(poly.index)
            continue
        probes = pts + [(pts[i] + pts[(i + 1) % len(pts)]) / 2 for i in range(len(pts))]
        probes.append(poly.center)
        # Pull probes slightly toward the centre so contact edges shared with
        # a visible neighbour face do not count as buried by accident.
        c = poly.center
        if all(_buried(bvh, c + (q - c) * 0.96, n) for q in probes):
            doomed.append(poly.index)
    if not doomed:
        return 0
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.faces[i] for i in doomed], context="FACES")
    loose = [v for v in bm.verts if not v.link_faces]
    if loose:
        bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    return len(doomed)


# --- GLB compaction ---------------------------------------------------------------------

_GLB_MAGIC = 0x46546C67
_JSON = 0x4E4F534A
_BIN = 0x004E4942
_COMP = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
_NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def _read_accessor(js, binchunk, acc):
    view = js["bufferViews"][acc["bufferView"]]
    dtype = np.dtype(_COMP[acc["componentType"]])
    ncomp = _NCOMP[acc["type"]]
    start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = view.get("byteStride", 0) or dtype.itemsize * ncomp
    if stride != dtype.itemsize * ncomp:
        raise RuntimeError("interleaved accessor not supported by compact_glb")
    arr = np.frombuffer(binchunk, dtype=dtype, count=acc["count"] * ncomp, offset=start)
    arr = arr.reshape(acc["count"], ncomp).astype(np.float64)
    if acc.get("normalized"):
        arr /= float(np.iinfo(dtype).max)
    return arr


def _short_floats(obj, table):
    if isinstance(obj, float):
        key = "@@yrf%d@@" % len(table)
        f32 = np.float32(obj)
        text = np.format_float_positional(f32, unique=True, trim="-")
        if float(np.float32(float(text))) != float(f32):  # paranoia: exact f32 round-trip
            text = repr(float(f32))
        table[key] = text
        return key
    if isinstance(obj, dict):
        return {k: _short_floats(v, table) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_short_floats(v, table) for v in obj]
    return obj


def compact_glb(path):
    """Repack COLOR_0 as normalized UNSIGNED_BYTE VEC4 (4 B/vertex instead of
    the exporter's 12 B float VEC3 / 8 B ushort VEC4) and print every JSON
    float as its shortest exact float32 literal. Returns (before, after)."""
    raw = open(path, "rb").read()
    magic, _ver, _length = struct.unpack_from("<III", raw, 0)
    if magic != _GLB_MAGIC:
        raise RuntimeError(f"{path}: not a GLB")
    jlen, jtype = struct.unpack_from("<II", raw, 12)
    assert jtype == _JSON
    js = json.loads(raw[20:20 + jlen])
    off = 20 + jlen
    blen, btype = struct.unpack_from("<II", raw, off)
    assert btype == _BIN
    binchunk = raw[off + 8: off + 8 + blen]

    views = js["bufferViews"]
    view_users = {}
    for ai, acc in enumerate(js["accessors"]):
        view_users.setdefault(acc.get("bufferView"), []).append(ai)
    replaced = {}
    for mesh in js["meshes"]:
        for prim in mesh["primitives"]:
            ai = prim["attributes"].get("COLOR_0")
            if ai is None:
                continue
            acc = js["accessors"][ai]
            if acc["componentType"] == 5121 and acc["type"] == "VEC4":
                continue
            vi = acc["bufferView"]
            if len(view_users[vi]) != 1:
                raise RuntimeError("COLOR_0 shares a bufferView; cannot repack in place")
            data = _read_accessor(js, binchunk, acc)
            out = np.full((acc["count"], 4), 255, dtype=np.uint8)
            out[:, :3] = np.clip(np.rint(np.clip(data[:, :3], 0.0, 1.0) * 255.0), 0, 255)
            replaced[vi] = out.tobytes()
            acc["componentType"] = 5121
            acc["type"] = "VEC4"
            acc["normalized"] = True
            acc.pop("byteOffset", None)
            acc.pop("min", None)
            acc.pop("max", None)

    blob = bytearray()
    for vi, view in enumerate(views):
        if vi in replaced:
            chunk = replaced[vi]
            view.pop("byteStride", None)
        else:
            s = view.get("byteOffset", 0)
            chunk = binchunk[s:s + view["byteLength"]]
        while len(blob) % 4:
            blob.append(0)
        view["byteOffset"] = len(blob)
        view["byteLength"] = len(chunk)
        view.pop("target", None)  # optional hint; loaders infer it from usage
        blob.extend(chunk)
    while len(blob) % 4:
        blob.append(0)
    js["buffers"][0]["byteLength"] = len(blob)

    table = {}
    text = json.dumps(_short_floats(js, table), separators=(",", ":"), ensure_ascii=False)
    for key, lit in table.items():
        text = text.replace('"%s"' % key, lit)
    jbytes = bytearray(text.encode("utf-8"))
    while len(jbytes) % 4:
        jbytes.append(0x20)
    total = 12 + 8 + len(jbytes) + 8 + len(blob)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", _GLB_MAGIC, 2, total))
        f.write(struct.pack("<II", len(jbytes), _JSON))
        f.write(jbytes)
        f.write(struct.pack("<II", len(blob), _BIN))
        f.write(blob)
    return len(raw), total


def export_glb(path, sel_kw, extra=None):
    """Shared glTF export settings for both pipelines (+ compaction)."""
    kwargs = dict(
        filepath=path,
        export_format="GLB",
        export_apply=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_skins=False,
        export_morph=False,
        # Flat part colours: UV seams would only duplicate vertices.
        export_texcoords=False,
        export_normals=True,
        export_materials="EXPORT",
        # COLOR_0 = the painted multiplier the materials multiply in.
        export_vertex_color="MATERIAL",
        export_all_vertex_colors=False,
        export_active_vertex_color_when_no_material=False,
    )
    kwargs.update(sel_kw)
    if extra:
        kwargs.update(extra)
    bpy.ops.export_scene.gltf(**kwargs)
    return compact_glb(path)


def audit_triangles(obj, name, min_area=1e-9):
    """Fail the build on zero-area triangles (the vitest contract rejects
    them: they have no usable face normal for winding/outline checks)."""
    mesh = obj.data
    mesh.calc_loop_triangles()
    bad = [t.index for t in mesh.loop_triangles if t.area < min_area]
    if bad:
        raise RuntimeError(f"{name}: {len(bad)} degenerate triangles (e.g. #{bad[0]})")


def triangle_count(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)
