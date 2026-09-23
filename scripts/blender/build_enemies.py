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
# Husk pale ash). A painted COLOR_0 multiplier (scripts/blender/yr_shading.py)
# adds soft occlusion/floor gradient on top, exactly like the furniture.
#
# Art direction: semi-realistic anime proportions pushed into the uncanny —
# continuous smooth-shaded forms (section lofts, tapered limb sweeps, deformed
# egg skulls) rather than primitive stacks, silhouettes that read in a dark
# corridor, and detail kept to structural edges (lapels, ribs, vertebrae,
# knuckles, the hood lip).
#
# The module is import-safe (no bpy side effects at import): main() wipes the
# factory scene, builds, audits, exports, saves the source blend and renders a
# contact sheet. The interactive MCP session execs this file and calls the
# same functions without save_as_mainfile.

import math
import os
import sys

import bmesh
import bpy
from mathutils import Euler, Vector

SCRIPT = os.path.abspath(__file__)
REPO = os.path.dirname(os.path.dirname(os.path.dirname(SCRIPT)))
if os.path.dirname(SCRIPT) not in sys.path:
    sys.path.insert(0, os.path.dirname(SCRIPT))
import yr_shading  # noqa: E402  (shared painted-shading + GLB compaction)

ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT_DIR = os.path.abspath(ARGV[0]) if len(ARGV) > 0 else os.path.join(REPO, "public", "models", "enemies")
BLEND_OUT = os.path.abspath(ARGV[1]) if len(ARGV) > 1 else os.path.join(REPO, "assets-src", "enemies.blend")
PREVIEW_OUT = os.path.abspath(ARGV[2]) if len(ARGV) > 2 else "/tmp/yr_enemies_preview.png"

SCENE_NAME = "YR_ENEMIES_PREVIEW"
TAU = math.tau
R = math.radians


def srgb(hexval):
    """sRGB hex -> linear RGB tuple (what THREE.Color(hex) decodes to)."""
    def chan(c):
        c = c / 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (chan(hexval >> 16 & 0xFF), chan(hexval >> 8 & 0xFF), chan(hexval & 0xFF))


# --- Palette (linear; entity signature tints mirror render/gbufferMaterials.js) ---
PALETTE = {
    "inkBody": srgb(0x16161C),    # Stalker suit — near-black ink (old entity mat)
    "inkCloth": srgb(0x24242A),   # lapels / buttons catch a trace of lamplight
    "shirtGrey": srgb(0x4A4845),  # dim shirt V + collar: frames the head, never outshines it
    "bonePale": srgb(0xC9C3B2),   # Stalker head/neck/hands — featureless pale oval
    "bloodBody": srgb(0x3A0D0D),  # Pursuer mass — dark blood-red (old pursuer mat)
    "bloodLimb": srgb(0x240707),  # Pursuer limbs/jaw/maw — darker
    "bloodRidge": srgb(0x4E1614),  # Pursuer ribs/vertebrae/knuckles — ridges catch light
    "toothPale": srgb(0x9C9282),  # Pursuer teeth — dim bone, below the eyes' value
    "eyePale": srgb(0xE8E2D0),    # Pursuer eyes — pale pinpoints
    "ashBody": srgb(0x5C5847),    # Husk body — pale ash (old husk mat)
    "ashRidge": srgb(0x716B58),   # exposed ridges: ribs, knees, hood lip
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
    if bpy.context.window:
        bpy.context.window.scene = scene
    COLLECTION = bpy.data.collections.new("YR_ENEMIES")
    scene.collection.children.link(COLLECTION)
    return scene


def mat(key):
    if key in _MATS:
        return _MATS[key]
    m = yr_shading.shaded_material("yr_enemy_" + key, PALETTE[key], metallic=0.0, roughness=0.82)
    _MATS[key] = m
    return m


def activate(obj):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def G(u, y, v):
    """Game frame (u right, y up, v front) -> Blender (x, y, z)."""
    return Vector((u, -v, y))


def make_mesh(parts, name, verts, faces, key, shading="soft", recalc=True,
              location=None, rot=None, face_keys=None):
    """verts: Blender-space. shading: soft (all smooth) | smooth (by angle) | flat.
    face_keys: optional per-face palette key list (multi-material part)."""
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
    if face_keys:
        order = []
        for k in face_keys:
            if k not in order:
                order.append(k)
        for k in order:
            mesh.materials.append(mat(k))
        for poly, k in zip(mesh.polygons, face_keys):
            poly.material_index = order.index(k)
    else:
        mesh.materials.append(mat(key))
    if location is not None:
        obj.location = location
    if rot is not None:
        obj.rotation_euler = rot
    if shading == "soft":
        for polygon in mesh.polygons:
            polygon.use_smooth = True
    elif shading == "smooth":
        activate(obj)
        try:
            bpy.ops.object.shade_smooth_by_angle(angle=0.9)
        except Exception:
            for polygon in mesh.polygons:
                polygon.use_smooth = True
    parts.append(obj)
    return obj


# --- Organic toolkit (game frame: u right, y up, v front) --------------------

def catmull_rows(rows, sub):
    """Catmull-Rom through tuples of floats (every component interpolated)."""
    if sub <= 1 or len(rows) < 2:
        return [tuple(r) for r in rows]
    n = len(rows)
    out = []
    for i in range(n - 1):
        p1, p2 = rows[i], rows[i + 1]
        p0 = rows[i - 1] if i > 0 else tuple(2 * a - b for a, b in zip(p1, p2))
        p3 = rows[i + 2] if i + 2 < n else tuple(2 * a - b for a, b in zip(p2, p1))
        for s in range(sub):
            t = s / sub
            out.append(tuple(
                0.5 * ((2 * b) + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t
                       + (3 * b - a - 3 * c + d) * t * t * t)
                for a, b, c, d in zip(p0, p1, p2, p3)))
    out.append(tuple(rows[-1]))
    return out


def _superellipse(a, sq):
    c, s = math.cos(a), math.sin(a)
    e = 2.0 / sq
    return (math.copysign(abs(c) ** e, c), math.copysign(abs(s) ** e, s))


def _cap_faces(n, ring_count, cap0, cap1):
    faces = []
    for r in range(ring_count - 1):
        for i in range(n):
            j = (i + 1) % n
            faces.append((r * n + i, r * n + j, (r + 1) * n + j, (r + 1) * n + i))
    if cap0:
        faces.append(tuple(reversed(range(n))))
    if cap1:
        faces.append(tuple(range((ring_count - 1) * n, ring_count * n)))
    return faces


def loft_y(parts, sections, key, seg=14, sub=2, caps=(True, True)):
    """Upright body from horizontal sections (y, cu, cv, hw, d_front, d_back, sq):
    half-width hw, front/back half-depths, superellipse squareness sq (2 =
    ellipse, >2 tailored/boxy). Sections are Catmull-Rom smoothed."""
    rows = catmull_rows(sections, sub)
    verts = []
    for y, cu, cv, hw, df, db, sq in rows:
        for k in range(seg):
            x, z = _superellipse(TAU * k / seg, sq)
            verts.append(G(cu + hw * x, y, cv + (df if z > 0 else db) * z))
    return make_mesh(parts, "loft", verts, _cap_faces(seg, len(rows), *caps), key)


def loft_v(parts, sections, key, seg=12, sub=2, caps=(True, True)):
    """Horizontal body (a crawler) from sections (v, cu, cy, hw, h_top, h_bot, sq)."""
    rows = catmull_rows(sections, sub)
    verts = []
    for v, cu, cy, hw, ht, hb, sq in rows:
        for k in range(seg):
            x, z = _superellipse(TAU * k / seg, sq)
            verts.append(G(cu + hw * x, cy + (ht if z > 0 else hb) * z, v))
    return make_mesh(parts, "loft", verts, _cap_faces(seg, len(rows), *caps), key)


def limb(parts, pts, radii, key, seg=8, sub=2, flat=1.0, up=(0.0, 0.0, 1.0),
         caps=(True, True), shading="soft"):
    """Tapered sweep through game-frame points with per-point radii (parallel
    transport frames). `flat` squashes the cross-section along the frame's
    second axis (fingers, blades); `up` seeds the frame orientation."""
    rows = catmull_rows([tuple(p) + (r,) for p, r in zip(pts, radii)], sub)
    P = [G(r[0], r[1], r[2]) for r in rows]
    rad = [r[3] for r in rows]
    n = len(P)
    T = [(P[min(i + 1, n - 1)] - P[max(i - 1, 0)]).normalized() for i in range(n)]
    ref = G(*up)
    if abs(T[0].dot(ref.normalized())) > 0.95:
        ref = Vector((1, 0, 0)) if abs(T[0].x) < 0.9 else Vector((0, 1, 0))
    N = ref - T[0] * ref.dot(T[0])
    N.normalize()
    verts = []
    for i in range(n):
        N = (N - T[i] * N.dot(T[i])).normalized()
        B = T[i].cross(N)
        for k in range(seg):
            a = TAU * k / seg
            verts.append(P[i] + N * (math.cos(a) * rad[i]) + B * (math.sin(a) * rad[i] * flat))
    return make_mesh(parts, "limb", verts, _cap_faces(seg, n, *caps), key, shading=shading)


def egg(parts, center, radii, key, segments=14, rings=10, deform=None, rot=(0, 0, 0)):
    """Ellipsoid (radii = u, y, v half-sizes) sampled on a unit sphere whose
    normalized coordinates (nu, ny, nv) can be displaced by `deform` before
    scaling — skull relief, chin taper, a flattened palm."""
    ru, ry, rv = radii
    rot_m = Euler(rot).to_matrix()
    verts = []

    def emit(nu, ny, nv):
        if deform:
            nu, ny, nv = deform(nu, ny, nv)
        local = G(nu * ru, ny * ry, nv * rv)
        verts.append(rot_m @ local + G(*center))

    emit(0.0, 1.0, 0.0)
    for i in range(1, rings):
        th = math.pi * i / rings
        for j in range(segments):
            ph = TAU * j / segments
            emit(math.sin(th) * math.cos(ph), math.cos(th), math.sin(th) * math.sin(ph))
    emit(0.0, -1.0, 0.0)
    faces = []
    last = len(verts) - 1
    for j in range(segments):
        faces.append((0, 1 + (j + 1) % segments, 1 + j))
    for i in range(rings - 2):
        a = 1 + i * segments
        b = a + segments
        for j in range(segments):
            jj = (j + 1) % segments
            faces.append((a + j, a + jj, b + jj, b + j))
    base = 1 + (rings - 2) * segments
    for j in range(segments):
        faces.append((base + j, base + (j + 1) % segments, last))
    return make_mesh(parts, "egg", verts, faces, key)


def egg_point(center, radii, direction, deform=None, rot=(0, 0, 0)):
    """Game-frame surface point + outward direction of an `egg` along a
    normalized (nu, ny, nv) direction — to seat sockets/teeth ON a skull."""
    d = Vector(direction).normalized()
    nu, ny, nv = d
    if deform:
        nu, ny, nv = deform(nu, ny, nv)
    b = Euler(rot).to_matrix() @ G(nu * radii[0], ny * radii[1], nv * radii[2])
    local = Vector((b.x, b.z, -b.y))
    return Vector(center) + local, local.normalized()


def spike(parts, base, direction, r, length, key, verts=5):
    """Cone from `base` along game-frame `direction` (vertebra, claw, tooth)."""
    d = G(*direction).normalized()
    b = G(*base)
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=0.0, depth=length,
                                    location=b + d * (length / 2))
    o = bpy.context.active_object
    o.rotation_mode = "QUATERNION"
    o.rotation_quaternion = d.to_track_quat("Z", "Y")
    for col in list(o.users_collection):
        col.objects.unlink(o)
    COLLECTION.objects.link(o)
    o.data.materials.append(mat(key))
    activate(o)
    try:
        bpy.ops.object.shade_smooth_by_angle(angle=1.2)
    except Exception:
        pass
    parts.append(o)
    return o


def plate(parts, outline, normals, t_out, t_in, key):
    """Thin closed plate following a surface: outline points (game frame)
    pushed out/in along their normals (lapels, shirt V, tie)."""
    n = len(outline)
    verts = []
    for p, nm in zip(outline, normals):
        verts.append(G(*(Vector(p) + Vector(nm) * t_out)))
    for p, nm in zip(outline, normals):
        verts.append(G(*(Vector(p) - Vector(nm) * t_in)))
    faces = [tuple(range(n)), tuple(reversed(range(n, 2 * n)))]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, n + i, n + j, j))
    return make_mesh(parts, "plate", verts, faces, key, shading="flat")


class Body:
    """Evaluates a loft_y section list as a surface: front point + normal for a
    (u, y) on the torso, so lapels/ribs/buttons sit ON the body."""

    def __init__(self, sections, sub=2):
        self.rows = catmull_rows(sections, sub)

    def section(self, y):
        rows = self.rows
        if y <= rows[0][0]:
            return rows[0]
        for a, b in zip(rows, rows[1:]):
            if a[0] <= y <= b[0]:
                t = (y - a[0]) / max(1e-6, b[0] - a[0])
                return tuple(x + (z - x) * t for x, z in zip(a, b))
        return rows[-1]

    def at(self, ang, y, side=1.0):
        """Point at angle `ang` (0 = +u side, pi/2 = front) on the section at y."""
        _y, cu, cv, hw, df, db, sq = self.section(y)
        x, z = _superellipse(ang, sq)
        d = df if z > 0 else db
        p = Vector((cu + hw * x, y, cv + d * z))
        # Ellipse normal (horizontal) — good enough for trim placement.
        nrm = Vector((x / max(hw, 1e-4), 0.0, z / max(d, 1e-4))).normalized()
        return p, nrm

    def front(self, u, y):
        _y, cu, cv, hw, df, db, sq = self.section(y)
        x = max(-0.999, min(0.999, (u - cu) / hw))
        z = (1 - abs(x) ** sq) ** (1 / sq)
        p = Vector((u, y, cv + df * z))
        nrm = Vector((x / hw, 0.0, z / df)).normalized()
        return p, nrm


# --- The three entities --------------------------------------------------------

def _hand(p, su, wrist, down, fwd, key, finger_len=(0.14, 0.155, 0.145, 0.12),
          palm=(0.018, 0.06, 0.04), spread=0.017, curl=0.018, thumb=True, r0=0.0085):
    """A long-fingered hand hanging from `wrist` along `down` (unit, game
    frame), palm facing the body (-su). Fingers fan along `fwd`."""
    wrist = Vector(wrist)
    down = Vector(down).normalized()
    fwd = Vector(fwd).normalized()
    side = Vector((su, 0.0, 0.0))
    pc = wrist + down * palm[1] * 0.8
    tilt = math.atan2(-down.z, -down.y)
    egg(p, tuple(pc), palm, key, segments=8, rings=6, rot=(tilt, 0, 0))
    base_c = wrist + down * palm[1] * 1.55
    n = len(finger_len)
    for i, L in enumerate(finger_len):
        off = (i - (n - 1) / 2) * spread
        b = base_c + fwd * off
        m = b + down * L * 0.5 + fwd * off * 0.25 - side * curl * 0.35
        t = b + down * L + fwd * off * 0.5 - side * curl
        limb(p, [tuple(b), tuple(m), tuple(t)], [r0, r0 * 0.8, r0 * 0.45], key,
             seg=5, sub=1, caps=(False, True))
    if thumb:
        tb = wrist + down * palm[1] * 0.7 + fwd * palm[2] * 0.9
        tt = tb + down * 0.075 + fwd * 0.03 - side * 0.01
        limb(p, [tuple(tb), tuple((tb + tt) / 2 + fwd * 0.008), tuple(tt)],
             [r0 * 1.05, r0 * 0.85, r0 * 0.5], key, seg=5, sub=1, caps=(False, True))


def m_stalker(p):
    """The Stalker — a ~2.3u faceless figure in a black suit. Too-long neck
    and arms, knees and elbows barely there, a forward hunch that pushes the
    blank pale head ahead of the shoulders: the only thing that catches the
    lamplight."""
    K, CL, SH, PALE = "inkBody", "inkCloth", "shirtGrey", "bonePale"
    # Jacket: tailored superellipse sections, hem flare, pinched waist,
    # hunched upper back rolling the shoulders forward.
    torso = [
        (0.98, 0, 0.00, 0.198, 0.128, 0.122, 2.5),
        (1.06, 0, 0.00, 0.19, 0.12, 0.115, 2.4),
        (1.2, 0, 0.008, 0.165, 0.108, 0.102, 2.3),
        (1.34, 0, 0.02, 0.142, 0.094, 0.092, 2.2),
        (1.5, 0, 0.04, 0.168, 0.108, 0.112, 2.2),
        (1.63, 0, 0.068, 0.205, 0.106, 0.134, 2.4),
        (1.72, 0, 0.094, 0.226, 0.092, 0.124, 2.6),
        (1.775, 0, 0.11, 0.196, 0.078, 0.096, 2.3),
        (1.81, 0, 0.122, 0.09, 0.06, 0.064, 2.0),
    ]
    loft_y(p, torso, K, seg=16, sub=2)
    body = Body(torso)
    # Trousers: long straight legs, a hint of knee, dress shoes.
    for su in (-1, 1):
        limb(p, [(su * 0.094, 1.12, 0.0), (su * 0.094, 0.9, 0.012), (su * 0.092, 0.62, 0.03),
                 (su * 0.089, 0.36, 0.008), (su * 0.087, 0.1, -0.004)],
             [0.086, 0.07, 0.054, 0.052, 0.047], K, seg=10, sub=2)
        # Dress shoe: low pointed toe, raised heel block, flat sole.
        egg(p, (su * 0.09, 0.046, 0.075), (0.045, 0.046, 0.15), K, segments=10, rings=7,
            deform=lambda nu, ny, nv: (nu * (1 - 0.42 * max(0.0, nv) ** 2),
                                       max(-0.92, ny * (1 - 0.55 * max(0.0, nv)) if ny > 0 else ny),
                                       nv))
    # Lapels, shirt V and tie as plates hugging the chest.
    for su in (-1, 1):
        pts2d = [(su * 0.045, 1.795), (su * 0.14, 1.735), (su * 0.118, 1.665), (su * 0.0, 1.36)]
        outline, normals = [], []
        for u, y in pts2d:
            pt, nm = body.front(u, y)
            outline.append(pt)
            normals.append(nm)
        plate(p, outline if su > 0 else list(reversed(outline)),
              normals if su > 0 else list(reversed(normals)), 0.008, 0.004, CL)
    shirt, shirt_n = [], []
    for u, y in ((-0.045, 1.8), (0.045, 1.8), (0.0, 1.37)):
        pt, nm = body.front(u, y)
        shirt.append(pt)
        shirt_n.append(nm)
    plate(p, shirt, shirt_n, 0.004, 0.004, SH)
    tie, tie_n = [], []
    for u, y in ((-0.014, 1.79), (0.014, 1.79), (0.02, 1.52), (0.0, 1.45), (-0.02, 1.52)):
        pt, nm = body.front(u, y)
        tie.append(pt)
        tie_n.append(nm)
    plate(p, tie, tie_n, 0.009, 0.002, K)
    btn, btn_n = body.front(0.0, 1.335)
    limb(p, [tuple(btn - btn_n * 0.004), tuple(btn + btn_n * 0.008)], [0.014, 0.012], CL,
         seg=8, sub=1)
    # Arms: square-ish suit shoulders, sleeves reaching mid-thigh, pale cuffs
    # of wrist, long-fingered hands hanging past the knuckles of the knee.
    for su in (-1, 1):
        egg(p, (su * 0.198, 1.728, 0.1), (0.07, 0.055, 0.07), K, segments=10, rings=6)
        sleeve = [(su * 0.218, 1.725, 0.1), (su * 0.246, 1.52, 0.104), (su * 0.266, 1.3, 0.114),
                  (su * 0.278, 1.08, 0.132), (su * 0.284, 0.9, 0.148)]
        limb(p, sleeve, [0.058, 0.05, 0.043, 0.043, 0.041], K, seg=10, sub=2)
        limb(p, [(su * 0.2835, 0.915, 0.147), (su * 0.2855, 0.885, 0.15)], [0.036, 0.034], SH,
             seg=8, sub=1)  # shirt cuff peeking out of the sleeve
        limb(p, [(su * 0.284, 0.93, 0.145), (su * 0.286, 0.85, 0.152)], [0.023, 0.021], PALE,
             seg=8, sub=1)
        _hand(p, su, (su * 0.287, 0.855, 0.153), (0.01 * su, -1.0, 0.1), (0, 0, 1), PALE,
              finger_len=(0.15, 0.17, 0.16, 0.13), palm=(0.02, 0.066, 0.044), spread=0.02,
              curl=0.022, r0=0.0095)
    # Collar, elongated pale neck craning forward, blank egg head.
    limb(p, [(0, 1.785, 0.12), (0, 1.86, 0.142)], [0.058, 0.05], SH, seg=12, sub=1)
    limb(p, [(0, 1.8, 0.122), (0, 1.93, 0.17), (0, 2.03, 0.205)], [0.043, 0.039, 0.037], PALE,
         seg=10, sub=2)

    def skull(nu, ny, nv):
        # Chin tapers, cranium swells back, faint brow ridge / cheekbones:
        # structure without a single facial feature.
        if ny < 0:
            k = 1 - 0.32 * (-ny) ** 1.5
            nu *= k
            nv *= k
        if nv < 0:
            nv *= 1.08
        front = max(0.0, nv)
        nv += 0.07 * math.exp(-((ny - 0.2) / 0.09) ** 2) * front ** 2 * (1 - 0.6 * nu * nu)
        nv -= 0.035 * math.exp(-((ny - 0.05) / 0.08) ** 2) * math.exp(-((abs(nu) - 0.36) / 0.16) ** 2) * front
        nu += math.copysign(0.04, nu) * math.exp(-((ny + 0.16) / 0.1) ** 2) * math.exp(-((abs(nu) - 0.6) / 0.2) ** 2) * front
        return nu, ny, nv
    egg(p, (0, 2.145, 0.232), (0.079, 0.126, 0.094), PALE, segments=16, rings=12,
        deform=skull, rot=(R(-11), 0, 0))


def m_pursuer(p):
    """The Pursuer ("Crawler") — a starved thing on all fours. A long low
    body with a ridged spine, joints that fold ABOVE its back like a spider's,
    claw-tipped hands, and a skull slung low with a jaw too wide for it."""
    B, L, RG, E, T = "bloodBody", "bloodLimb", "bloodRidge", "eyePale", "toothPale"
    body = [
        (-0.69, 0, 0.645, 0.04, 0.035, 0.035, 2.0),
        (-0.61, 0, 0.665, 0.1, 0.075, 0.07, 2.0),
        (-0.5, 0, 0.67, 0.145, 0.1, 0.095, 2.2),
        (-0.37, 0, 0.64, 0.115, 0.085, 0.075, 2.0),
        (-0.23, 0, 0.605, 0.078, 0.07, 0.058, 2.0),
        (-0.07, 0, 0.6, 0.125, 0.098, 0.115, 2.0),
        (0.09, 0, 0.615, 0.175, 0.122, 0.165, 2.1),
        (0.25, 0, 0.605, 0.162, 0.112, 0.13, 2.1),
        (0.37, 0, 0.565, 0.1, 0.082, 0.082, 2.0),
        (0.43, 0, 0.53, 0.05, 0.05, 0.05, 2.0),
    ]
    loft_v(p, body, B, seg=10, sub=2)
    rows = catmull_rows(body, 4)

    def sec(v):
        for a, b in zip(rows, rows[1:]):
            if a[0] <= v <= b[0]:
                t = (v - a[0]) / (b[0] - a[0])
                return tuple(x + (z - x) * t for x, z in zip(a, b))
        return rows[-1]
    # Spine ridge: vertebrae spikes raking backward, shrinking to the tail.
    for i in range(12):
        v = 0.36 - i * 0.087
        _v, cu, cy, hw, ht, hb, sq = sec(v)
        s = 1.0 - 0.045 * i
        spike(p, (0, cy + ht - 0.012, v), (0, 1.0, -0.45), 0.02 * s, 0.055 * s, RG, verts=5)
    # Ribs: ridges wrapping the starved ribcage from spine to keel.
    for v in (-0.04, 0.06, 0.15, 0.24):
        _v, cu, cy, hw, ht, hb, sq = sec(v)
        for su in (-1, 1):
            pts = []
            for a in (78, 35, -10, -50):
                x, z = _superellipse(R(a), sq)
                h = ht if z > 0 else hb
                pts.append((su * (hw * x + 0.006 * x), cy + h * z + 0.004 * z, v - 0.025 * (78 - a) / 128))
            limb(p, pts, [0.011, 0.013, 0.011, 0.006], RG, seg=4, sub=1)
    # Neck swings down to the low-slung skull.
    limb(p, [(0, 0.56, 0.36), (0, 0.52, 0.47), (0, 0.45, 0.56)], [0.058, 0.05, 0.045], B,
         seg=10, sub=2)

    def cranium(nu, ny, nv):
        front = max(0.0, nv)
        if ny < -0.3:
            ny = -0.3 + (ny + 0.3) * 0.3          # flat palate: the mouth's roof
        elif ny > 0:
            ny *= 0.82                             # low crown
        nu *= 1 - 0.3 * front ** 2                 # narrow snout
        # Heavy brow shelf over the sockets, hollow temples behind it.
        ny += 0.18 * math.exp(-((nv - 0.42) / 0.2) ** 2) * math.exp(-((abs(nu) - 0.48) / 0.26) ** 2) * max(0.0, ny + 0.05)
        nu -= math.copysign(0.08, nu) * math.exp(-((nv + 0.05) / 0.22) ** 2) * math.exp(-((ny - 0.2) / 0.3) ** 2)
        return nu, ny, nv
    skull_c, skull_r, skull_rot = (0, 0.44, 0.645), (0.086, 0.075, 0.172), (R(10), 0, 0)
    egg(p, skull_c, skull_r, B, segments=14, rings=10, deform=cranium, rot=skull_rot)

    # Lower jaw: wider than the skull at the hinges, hanging open.
    def mandible(nu, ny, nv):
        if ny > 0.25:
            ny = 0.25 + (ny - 0.25) * 0.25         # flat bite surface
        nu *= (1 + 0.22 * max(0.0, -nv)) * (1 - 0.38 * max(0.0, nv) ** 2)
        return nu, ny, nv
    jaw_c, jaw_r, jaw_rot = (0, 0.325, 0.66), (0.112, 0.052, 0.165), (R(30), 0, 0)
    egg(p, jaw_c, jaw_r, L, segments=12, rings=7, deform=mandible, rot=jaw_rot)
    # The maw between them: a dark throat filling the gape.
    egg(p, (0, 0.375, 0.655), (0.074, 0.05, 0.14), L, segments=10, rings=5, rot=(R(20), 0, 0))
    # Teeth: a ragged upper row on the palate rim, a lower row on the jaw rim.
    for i, a in enumerate((-1.1, -0.8, -0.52, -0.26, 0.0, 0.26, 0.52, 0.8, 1.1)):
        pt, nrm = egg_point(skull_c, skull_r, (0.95 * math.sin(a), -0.32, 0.95 * math.cos(a)), cranium, skull_rot)
        ln = 0.03 + 0.016 * ((i * 5) % 3)
        spike(p, tuple(pt - nrm * 0.008), (0.1 * math.sin(a), -1.0, 0.15), 0.008, ln, T, verts=4)
    for i, a in enumerate((-1.0, -0.66, -0.33, 0.33, 0.66, 1.0)):
        pt, nrm = egg_point(jaw_c, jaw_r, (0.93 * math.sin(a), 0.3, 0.93 * math.cos(a)), mandible, jaw_rot)
        spike(p, tuple(pt - nrm * 0.006), (0.05 * math.sin(a), 1.0, 0.3), 0.0075,
              0.026 + 0.012 * (i % 2), T, verts=4)
    # Eyes: pale pinpoints at the bottom of dark sockets under the brow.
    for su in (-1, 1):
        pt, nrm = egg_point(skull_c, skull_r, (su * 0.62, 0.34, 0.7), cranium, skull_rot)
        egg(p, tuple(pt - nrm * 0.013), (0.024, 0.017, 0.02), L, segments=6, rings=4)
        egg(p, tuple(pt + nrm * 0.0005), (0.0068, 0.006, 0.0058), E, segments=6, rings=4)
    # The spine ridge continues up the neck and over the crown.
    for k, dv in enumerate((-0.55, -0.2)):
        pt, nrm = egg_point(skull_c, skull_r, (0.0, 1.0, dv), cranium, skull_rot)
        spike(p, tuple(pt - nrm * 0.008), (0, 1.0, -0.5), 0.014 - 0.003 * k, 0.04 - 0.008 * k, RG,
              verts=5)
    for k, (y, v) in enumerate(((0.588, 0.43), (0.56, 0.5))):
        spike(p, (0, y, v), (0, 1.0, -0.4), 0.016, 0.045, RG, verts=5)

    def arm_leg(su, root, joint, wrist, r, key_upper, key_lower, spur_dir):
        rootv, jointv, wristv = Vector(root), Vector(joint), Vector(wrist)
        mid_u = rootv.lerp(jointv, 0.55) + Vector((su * 0.02, 0.04, 0.0))
        limb(p, [root, tuple(mid_u), joint], [r[0], r[1], r[2]], key_upper, seg=8, sub=2)
        mid_l = jointv.lerp(wristv, 0.4) + Vector((su * 0.03, 0.03, 0.0))
        limb(p, [joint, tuple(mid_l), wrist], [r[2] * 0.95, r[3], r[4]], key_lower, seg=6, sub=2)
        egg(p, joint, (r[2] * 1.2, r[2] * 1.25, r[2] * 1.2), RG, segments=6, rings=5)
        spike(p, tuple(jointv + Vector(spur_dir).normalized() * r[2] * 0.6), spur_dir,
              r[2] * 0.55, 0.09, RG, verts=5)

    def claws(su, wrist, fwd_deg, key, lengths=(0.19, 0.23, 0.2), knuckle_h=0.1):
        w = Vector(wrist)
        egg(p, (w.x, w.y - 0.015, w.z), (0.034, 0.024, 0.045), key, segments=6, rings=4)
        for k, (ang, ln) in enumerate(zip((-32, 0, 32), lengths)):
            a = R(fwd_deg + ang)
            d = Vector((su * math.sin(a), 0.0, math.cos(a)))
            b = w + Vector((0, -0.01, 0))
            kn = b + d * (ln * 0.35) + Vector((0, knuckle_h * 0.9, 0))
            tip = b + d * ln
            tip.y = 0.004
            limb(p, [tuple(b), tuple(kn), tuple(tip)], [0.016, 0.014, 0.003], key, seg=5, sub=2,
                 caps=(False, True))
    for su in (-1, 1):
        # Front limbs: elbows rear up above the shoulders, hands splay forward.
        arm_leg(su, (su * 0.12, 0.61, 0.3), (su * 0.4, 1.06, 0.37), (su * 0.49, 0.14, 0.6),
                (0.058, 0.044, 0.04, 0.03, 0.022), B, L, (su * 0.3, 1.0, -0.4))
        claws(su, (su * 0.49, 0.1, 0.62), 12, L)
        # Hind limbs: knees even higher, feet raking back and out.
        arm_leg(su, (su * 0.12, 0.64, -0.5), (su * 0.42, 1.14, -0.42), (su * 0.53, 0.16, -0.6),
                (0.07, 0.05, 0.045, 0.034, 0.024), B, L, (su * 0.25, 1.0, 0.3))
        claws(su, (su * 0.53, 0.1, -0.6), 180 - 50, L, lengths=(0.13, 0.15, 0.12), knuckle_h=0.08)


def hood_head(parts, center, pitch=R(28), roll=R(7)):
    """Open ash cowl around a recessed void. Rings run from the back of the
    hood toward the face opening, roll inward over the lip, then sink into a
    dark concave bowl — the face that isn't there. The crown peaks slightly
    like a drawn hood."""
    segments = 18
    # (half-width, half-height, depth, crown-peak)
    rings = [(0.03, 0.04, -0.105, 0.0), (0.092, 0.125, -0.075, 0.02), (0.122, 0.165, -0.015, 0.03),
             (0.128, 0.172, 0.05, 0.025), (0.113, 0.152, 0.1, 0.012), (0.088, 0.123, 0.128, 0.0),
             (0.074, 0.104, 0.124, 0.0), (0.064, 0.09, 0.085, 0.0), (0.045, 0.062, 0.025, 0.0)]
    rot_m = Euler((pitch, 0, roll)).to_matrix()
    c = G(*center)
    verts = []
    for w, h, front, peak in rings:
        for i in range(segments):
            a = TAU * i / segments
            y = h * math.sin(a) + peak * max(0.0, math.sin(a)) ** 6
            x = w * math.cos(a)
            v = front - 0.18 * y
            verts.append(rot_m @ G(x, y, v) + c)
    verts.append(rot_m @ G(0, 0, -0.01) + c)
    faces = [tuple(reversed(range(segments)))]
    keys = ["ashBody"]
    nr = len(rings)
    for row in range(nr - 1):
        k = "ashBody" if row < 4 else ("ashRidge" if row == 4 or row == 5 else "voidFace")
        for i in range(segments):
            a = row * segments + i
            b = row * segments + (i + 1) % segments
            faces.append((a, b, b + segments, a + segments))
            keys.append(k)
    for i in range(segments):
        faces.append(((nr - 1) * segments + i, (nr - 1) * segments + (i + 1) % segments, len(verts) - 1))
        keys.append("voidFace")
    # Topologically closed (back cap, cowl, lip, void bowl fan), so the normal
    # recalculation orients the whole sack outward — the bowl faces the viewer.
    return make_mesh(parts, "hood", verts, faces, "ashBody", face_keys=keys)


def m_husk(p):
    """The Husk — a ~1.75u emaciated remnant. Shoulders hunched up around a
    bowed hood, ribs and knees pressing through ash skin, arms dangling long
    and thin, a hollow dark void where the face used to be. It only ever
    stands."""
    A, RG = "ashBody", "ashRidge"
    torso = [
        (0.8, 0, 0.0, 0.128, 0.078, 0.08, 2.0),
        (0.9, 0, 0.0, 0.138, 0.08, 0.085, 2.0),
        (1.0, 0, 0.012, 0.084, 0.052, 0.062, 2.0),
        (1.1, 0, 0.022, 0.09, 0.058, 0.07, 2.0),
        (1.2, 0, 0.04, 0.124, 0.082, 0.08, 2.0),
        (1.3, 0, 0.064, 0.136, 0.086, 0.1, 2.0),
        (1.385, 0, 0.094, 0.144, 0.076, 0.112, 2.0),
        (1.445, 0, 0.124, 0.156, 0.062, 0.1, 2.2),
        (1.49, 0, 0.15, 0.08, 0.05, 0.06, 2.0),
    ]
    loft_y(p, torso, A, seg=14, sub=2)
    body = Body(torso)
    # Rib ridges sloping down toward the sternum, a sternum ridge, collarbones.
    # Ribs: thin arcs sloping DOWN toward the sternum (chevrons, not slats).
    for y in (1.17, 1.225, 1.28, 1.335, 1.39):
        for su in (-1, 1):
            pts = []
            for k, ang in enumerate((80, 58, 32, 6)):
                pt, nm = body.at(R(ang) if su > 0 else R(180 - ang), y + 0.02 * k)
                pts.append(tuple(pt + nm * 0.0015))
            limb(p, pts, [0.005, 0.0075, 0.0075, 0.005], RG, seg=4, sub=1)
    st = [tuple(body.front(0, y)[0] + body.front(0, y)[1] * 0.002) for y in (1.43, 1.32, 1.18)]
    limb(p, st, [0.009, 0.009, 0.006], RG, seg=5, sub=1)
    for su in (-1, 1):
        limb(p, [(su * 0.02, 1.47, 0.195), (su * 0.09, 1.478, 0.18), (su * 0.15, 1.472, 0.135)],
             [0.009, 0.01, 0.008], RG, seg=5, sub=1)
    # Spine bumps down the hunched back.
    for i, y in enumerate((1.44, 1.37, 1.3, 1.23, 1.16, 1.09)):
        pt, nm = body.at(R(-90), y)
        spike(p, tuple(pt - nm * 0.01), (0, 0.3, -1.0), 0.016, 0.03, RG, verts=5)
    # Legs: thin, knees pressing forward, long bony feet.
    for su in (-1, 1):
        limb(p, [(su * 0.085, 0.86, -0.01), (su * 0.085, 0.66, 0.01), (su * 0.08, 0.47, 0.045),
                 (su * 0.078, 0.27, 0.02), (su * 0.076, 0.07, -0.005)],
             [0.058, 0.045, 0.04, 0.032, 0.024], A, seg=9, sub=2)
        # Kneecap pressing through the skin (flat, not a doll joint).
        egg(p, (su * 0.08, 0.47, 0.068), (0.026, 0.034, 0.014), RG, segments=8, rings=5)
        egg(p, (su * 0.08, 0.03, 0.07), (0.034, 0.032, 0.115), A, segments=8, rings=5,
            deform=lambda nu, ny, nv: (nu * (1 - 0.35 * max(0.0, nv)),
                                       ny * (1 - 0.5 * max(0.0, nv)) if ny > 0 else ny, nv))
    # Arms: shoulders hiked up by the hood, long dangling limbs, bony elbows.
    for su in (-1, 1):
        # Shoulders hiked up toward the hood and rolled forward.
        egg(p, (su * 0.148, 1.47, 0.125), (0.05, 0.05, 0.05), A, segments=8, rings=6)
        limb(p, [(su * 0.16, 1.455, 0.125), (su * 0.182, 1.28, 0.14), (su * 0.192, 1.12, 0.158),
                 (su * 0.198, 0.97, 0.185), (su * 0.2, 0.84, 0.205)],
             [0.042, 0.033, 0.03, 0.027, 0.02], A, seg=8, sub=2)
        egg(p, (su * 0.194, 1.12, 0.14), (0.02, 0.026, 0.016), RG, segments=8, rings=5)
        _hand(p, su, (su * 0.201, 0.845, 0.207), (0.0, -1.0, 0.12), (0, 0, 1), A,
              finger_len=(0.1, 0.115, 0.105, 0.085), palm=(0.014, 0.045, 0.03), spread=0.013,
              curl=0.03, r0=0.0065)
    # Neck craning forward into the bowed hood.
    limb(p, [(0, 1.47, 0.148), (0, 1.52, 0.2), (0, 1.555, 0.24)], [0.038, 0.034, 0.034], A,
         seg=8, sub=1)
    hood_head(p, (0.0, 1.6, 0.262))


# (builder, footprint budget u x v, height budget) — mirrored by the vitest
# export-contract suite (render/__tests__/enemy-models.test.js).
MODELS = [
    ("stalker", m_stalker, 0.9, 0.9, 2.45),
    ("pursuer", m_pursuer, 1.3, 1.5, 1.35),
    ("husk", m_husk, 0.8, 0.8, 1.9),
]

TOL = 0.1  # small bevel overhang grace; entities have no collision footprint
TRI_BUDGET = 3000
BYTE_BUDGET = 90_000

# Painted-shading tuning per figure: thin limbs want a short occlusion reach;
# eyes stay pure signal colour.
PAINT = {
    "stalker": dict(ao_dist=0.14, grad_floor=0.8, rim=0.03),
    "pursuer": dict(ao_dist=0.16, grad_floor=0.78, rim=0.04),
    "husk": dict(ao_dist=0.14, grad_floor=0.8, rim=0.035),
}


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
        for o in bpy.context.view_layer.objects:
            o.select_set(False)
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
        # Facing +v (Blender -Y): the front half must reach further than the back.
        if -min(ys) <= max(ys):
            raise RuntimeError(f"{name}: front extent does not exceed back extent")

        keys = yr_shading.paint(obj, height=max(zs), keep_bright={"yr_enemy_eyePale"},
                                **PAINT[name])
        culled = yr_shading.cull_hidden(obj)
        triangles = yr_shading.triangle_count(obj)
        yr_shading.audit_triangles(obj, name)
        if triangles > TRI_BUDGET and os.environ.get("YR_NO_BUDGET") != "1":
            raise RuntimeError(f"{name}: {triangles} triangles exceeds the {TRI_BUDGET}-triangle budget")

        path = os.path.join(OUT_DIR, name + ".glb")
        activate(obj)
        _before, size = yr_shading.export_glb(path, sel_kw)
        if size >= BYTE_BUDGET and os.environ.get("YR_NO_BUDGET") != "1":
            raise RuntimeError(f"{name}: {size} bytes exceeds the {BYTE_BUDGET}-byte budget")
        print(f"[yr] {name:<8} {w:.2f}x{d:.2f}x{h:.2f}  tris={triangles:<5} culled={culled:<4} "
              f"shade={keys:<5} {size} B")
        built.append(obj)

    # Line the joined models up for the source blend + contact sheet.
    for obj, x in zip(built, (-1.9, 0.0, 1.9)):
        obj.location = (x, 0, 0)
    return built


def render_preview():
    scene = bpy.data.scenes.get(SCENE_NAME) or bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 900
    scene.render.filepath = PREVIEW_OUT
    scene.world = bpy.data.worlds.new("yr_enemy_world")
    scene.world.use_nodes = True
    bg = scene.world.node_tree.nodes.get("Background")
    bg.inputs[0].default_value = (0.55, 0.54, 0.48, 1.0)  # dim backrooms mustard-grey
    bg.inputs[1].default_value = 0.4

    def light(loc, energy, size, target, color=(1, 1, 1)):
        bpy.ops.object.light_add(type="AREA", location=loc)
        lo = bpy.context.active_object
        lo.data.energy = energy
        lo.data.size = size
        lo.data.color = color
        lo.rotation_euler = (Vector(target) - lo.location).to_track_quat("-Z", "Y").to_euler()
        for col in list(lo.users_collection):
            col.objects.unlink(lo)
        scene.collection.objects.link(lo)
        return lo

    light((1.5, -4.5, 3.6), 650, 4, (0, 0, 1.0), (1.0, 0.95, 0.86))   # warm key
    light((-3.5, 1.5, 2.6), 240, 4, (0, 0, 1.0), (0.78, 0.86, 1.0))   # cool fill
    light((0.5, 3.5, 3.0), 300, 3, (0, 0, 1.2))                         # rim

    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    for col in list(cam.users_collection):
        col.objects.unlink(cam)
    scene.collection.objects.link(cam)
    cam.location = (2.2, -6.6, 1.75)
    target = Vector((0, 0, 1.0))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 5.6
    scene.camera = cam

    # Ground plane for contact shadows.
    mesh = bpy.data.meshes.new("yr_enemy_ground")
    mesh.from_pydata([(-20, -20, -0.005), (20, -20, -0.005), (20, 20, -0.005), (-20, 20, -0.005)],
                     [], [(0, 1, 2, 3)])
    ground = bpy.data.objects.new("yr_enemy_ground", mesh)
    scene.collection.objects.link(ground)
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
    if os.environ.get("YR_SKIP_PREVIEW") != "1":
        render_preview()
    bpy.ops.wm.save_as_mainfile(filepath=BLEND_OUT, check_existing=False)
    print(f"[yr] blend -> {BLEND_OUT}")
    print("[yr] done")


if __name__ == "__main__":
    main()
