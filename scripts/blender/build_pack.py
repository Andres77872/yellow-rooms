"""Yellow Rooms — generic Blender pack builder (one pack per Blender process).

    blender --background --factory-startup --python scripts/blender/build_pack.py -- \\
        <pack> [--out DIR] [--blend PATH] [--preview PATH] [--no-preview] [--no-budget]
    npm run build:pack -- <pack> [...]

Builds every kind of `scripts/blender/packs/<pack>.py`, audits it against its
class contract, exports one GLB per kind into `--out` (default
`public/models/<pack>/`) and writes `manifest.json` there (schema v1). Run one
pack per process: materials are named `yr_<key>`, and a second pack defining
the same key would export as `yr_<key>.001`, which the runtime's by-name
surface lookup (src/render/surfaces.js) would miss.

Options:
  --out DIR       GLB + manifest directory.
  --blend PATH    also save the source scene (markers kept). YR_SAVE_BLEND=1
                  saves assets-src/<pack>.blend. Never byte-reproducible, so
                  it is opt-in and the GLBs are the shipped artefact.
  --preview PATH  Cycles contact sheet path (default /tmp/yr_<pack>_preview.png);
                  --no-preview or YR_SKIP_PREVIEW=1 skips the render.
  --no-budget     skip the per-kind and pack budget checks (iterating only).

Pack spec module (`packs/<pack>.py`; import-safe: no bpy operations at import)
------------------------------------------------------------------------------
    from yr_kit import *          # primitives (box, cyl, decal, lathe, ...), R, TAU, lcg, marker

    NODE_PREFIX = "<pack>_"       # glTF node = NODE_PREFIX + kind ("furn_" for furniture)
    PALETTE = {"hoseRed": ((0.55, 0.08, 0.06), 0.0, 0.6), ...}
                                  # key -> (linear rgb, metallic, roughness); material
                                  # "yr_<key>". Reuse furniture keys (legMetal, chrome,
                                  # laminate, screen, ledGreen, fabric, ...) where they fit;
                                  # a new key's surface goes in the pack's data module
                                  # (src/world/props/packs/<pack>.js `surfaces`).
    KEEP_BRIGHT = {"ledGreen"}    # optional: palette keys the painted pass leaves at 1.0
                                  # (screens, cue lights, bare bulbs)
    BUDGET = dict(tris=20_000, bytes=650_000)   # optional pack totals (strict <)

    def m_standpipe(p):           # builders append parts to `p`, game frame (u, y, v),
        box(p, 0, 0.6, 0, 0.7, 1.0, 0.25, "hoseRed", bev=0.012)   # front toward +v
        marker(p, "col_0", 0, 0.55, 0, 0.7, 1.1, 0.25)            # collision box
        marker(p, "occ_A", 0, 0.6, 0, 0.7, 1.0, 0.25, t=0)        # shadow proxy (<= 2)
        marker(p, "socket_use_0", 0, 1.0, 0.2, yrSocket="use")    # point socket (exported)

    MODELS = [dict(
        kind="standpipe",         # file stem: <kind>.glb
        build=m_standpipe,
        kind_key="PROP_STANDPIPE",  # registry key (src/world/props/packs/<pack>.js), FURN_* for furniture
        cls="B",                  # B prop | C large prop | D edge kit | E fixture
        dims=(0.80, 0.30),        # collision footprint (w, d) m; `collision=` is an alias
        height=2.05,              # height budget m (top may reach height + 0.05)
        tier="detailed",          # simple 300/15 KB | detailed 800/30 KB | large 2000/80 KB |
                                  # module 5000/200 KB; or explicit tris=..., bytes=...
        overhang=(0.0, 0.0),      # optional extra visual allowance past dims
        floor_z=0.0,              # optional: lowest z the model may reach (class D kits that
                                  # hang below their origin pass their min z)
        floor_cull=True,          # optional: cull down-facing faces on floor_z
        footprint_cells=[[0, 0]], # optional (required non-empty for C): claimed CELL=3 cells
        anchor="center",          # optional: center (default) | edge (default for D) | min_corner
    )]

Markers are EMPTYs from `yr_kit.marker()`; they are never joined into the
mesh. `col_<n>` / `occ_<A|B>` boxes (axis-aligned: no rotation) go to the
manifest's `colliders` / `proxies` and are removed (kept with --blend);
`socket_<type>_<n>` points need a string `yrSocket` prop, are parented to the
model and exported as glTF node extras (export_extras turns on only for kinds
with sockets). Without `col_*` markers a centre-anchored kind gets one
collider: its dims from floor_z to height.

Class audits (failures raise): every class — footprint <= dims + overhang +
0.14, top <= height + 0.05, min y >= floor_z - 0.005, no degenerate
triangles, node named NODE_PREFIX + kind, every GLB material in PALETTE,
<= 2 occ_* with t in 0..7 and tops <= 2.1; centring <= 0.11 on u and v
(center anchor) or u only (edge). B: floor_z 0 (min y >= -0.005), height
<= 2.1 (OCC_MAX_H) and dims half-extents < 1.2 (the collision scan reach). C: >= 1 col_* and every
collider inside its footprint cells. D: anchored at the edge midpoint.
E: >= 1 socket with a string yrSocket. A material missing from the runtime
surface table only warns.

Determinism: same Blender + same sources -> byte-identical GLBs and manifest
(fixed key order, kinds in spec order, floats rounded to 4 decimals, no -0.0).
"""

import argparse
import hashlib
import importlib
import json
import math
import os
import re
import struct
import sys
import traceback

import bpy

sys.dont_write_bytecode = True  # no scripts/blender/__pycache__ in the tree
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import yr_kit  # noqa: E402
import yr_shading  # noqa: E402

SCHEMA = 1
CELL = 3.0           # src/world/constants.js CELL
TOL = 0.14           # footprint allowance past dims + overhang
TOL_CENTER = 0.11    # the vitest contract allows 0.12 off-centre
TOL_TOP = 0.05
MIN_Y = -0.005
OCC_MAX_H = 2.1      # occupancy texture height (src/world/lightGrid/gridSpec.js)
REACH = 1.2          # player/collision.js scans r + 1.2: half-extents stay below it
TIERS = {
    "simple": (300, 15_000),
    "detailed": (800, 30_000),
    "large": (2_000, 80_000),
    "module": (5_000, 200_000),
}
DEFAULT_BUDGET = dict(tris=20_000, bytes=650_000)
CLASSES = ("B", "C", "D", "E")
ANCHORS = ("center", "edge", "min_corner")
KIND_KEYS = {"kind", "build", "kind_key", "cls", "dims", "collision", "height", "tier", "tris",
             "bytes", "overhang", "floor_z", "floor_cull", "footprint_cells", "anchor"}
MARKER_RE = re.compile(r"^(col_\w+|occ_[AB]|socket_[a-z][a-zA-Z0-9]*_\d+)$")


def parse_args(argv):
    ap = argparse.ArgumentParser(prog="build_pack.py", description="Build one Blender asset pack.")
    ap.add_argument("pack", help="spec module name under scripts/blender/packs/")
    ap.add_argument("--out", help="output directory (default public/models/<pack>/)")
    ap.add_argument("--blend", help="also save the source .blend here")
    ap.add_argument("--preview", help="contact sheet path (default /tmp/yr_<pack>_preview.png)")
    ap.add_argument("--no-preview", action="store_true", help="skip the contact sheet")
    ap.add_argument("--no-budget", action="store_true", help="skip budget checks")
    args = ap.parse_args(argv)
    args.out = os.path.abspath(args.out) if args.out else os.path.join(REPO, "public", "models", args.pack)
    if args.blend:
        args.blend = os.path.abspath(args.blend)
    elif os.environ.get("YR_SAVE_BLEND") == "1":
        args.blend = os.path.join(REPO, "assets-src", args.pack + ".blend")
    if args.no_preview or os.environ.get("YR_SKIP_PREVIEW") == "1":
        args.preview = None
    else:
        args.preview = os.path.abspath(args.preview) if args.preview else f"/tmp/yr_{args.pack}_preview.png"
    return args


def r4(x):
    # + 0.0 turns a rounded -0.0 into 0.0 (stable manifest text).
    return round(float(x), 4) + 0.0


# --- Spec normalisation -------------------------------------------------------------

def kind_settings(m):
    name = m.get("kind", "?")
    unknown = sorted(set(m) - KIND_KEYS)
    if unknown:
        raise RuntimeError(f"{name}: unknown spec keys {unknown}")
    dims = m.get("collision", m.get("dims"))
    if dims is None or "height" not in m or "build" not in m:
        raise RuntimeError(f"{name}: a kind needs kind, build, dims (or collision) and height")
    cls = m.get("cls", "B")
    if cls not in CLASSES:
        raise RuntimeError(f"{name}: class {cls!r} is not one of {CLASSES}")
    tier = TIERS.get(m.get("tier"), (None, None))
    if m.get("tier") is not None and tier[0] is None:
        raise RuntimeError(f"{name}: tier {m['tier']!r} is not one of {sorted(TIERS)}")
    tris, nbytes = m.get("tris", tier[0]), m.get("bytes", tier[1])
    if tris is None or nbytes is None:
        raise RuntimeError(f"{name}: give a tier or explicit tris= and bytes= budgets")
    anchor = m.get("anchor", "edge" if cls == "D" else "center")
    if anchor not in ANCHORS:
        raise RuntimeError(f"{name}: anchor {anchor!r} is not one of {ANCHORS}")
    key = m.get("kind_key")
    if key is not None and not re.match(r"^[A-Z][A-Z0-9_]*$", key):
        raise RuntimeError(f"{name}: kind_key {key!r} must look like PROP_X / FURN_X")
    if not re.match(r"^[a-z][a-z0-9_]*$", name):
        raise RuntimeError(f"{name!r}: kind must be a lower_snake file stem")
    return dict(kind=name, kind_key=key, cls=cls, build=m["build"],
                collision=(float(dims[0]), float(dims[1])),
                overhang=tuple(float(x) for x in m.get("overhang", (0.0, 0.0))),
                height=float(m["height"]), tris=int(tris), bytes=int(nbytes),
                floor_z=float(m.get("floor_z", 0.0)), floor_cull=bool(m.get("floor_cull", True)),
                footprint_cells=[[int(c[0]), int(c[1])] for c in m.get("footprint_cells", [[0, 0]])],
                anchor=anchor)


# --- Markers -------------------------------------------------------------------------

def marker_box(e, name):
    """CUBE empty spanning +-scale around its location (Blender frame) ->
    game-frame AABB. Boxes are axis-aligned: rotation is an error."""
    if any(abs(a) > 1e-9 for a in e.rotation_euler) or e.parent is not None:
        raise RuntimeError(f"{name}: marker {e.name} must be unrotated and unparented (AABB)")
    (x, y, z), (sx, sy, sz) = e.location, e.scale
    return dict(u0=r4(x - abs(sx)), u1=r4(x + abs(sx)), v0=r4(-y - abs(sy)), v1=r4(-y + abs(sy)),
                y0=r4(z - abs(sz)), y1=r4(z + abs(sz)))


def _prop_value(v):
    if hasattr(v, "to_list"):
        v = v.to_list()
    if isinstance(v, float):
        return r4(v)
    if isinstance(v, (list, tuple)):
        return [_prop_value(x) for x in v]
    return v


def socket_record(e):
    rec = dict(name=e.name, at=[r4(e.location.x), r4(e.location.z), r4(-e.location.y)])
    for k in sorted(e.keys()):
        if not k.startswith("_"):
            rec[k] = _prop_value(e[k])
    return rec


# --- GLB readback -----------------------------------------------------------------------

def glb_stats(path):
    """Bounds (game frame = glTF frame), triangles, bytes, material names and
    sha256 of the written GLB: the manifest describes the file, not the scene
    (a culled-away part drops its primitive and material)."""
    raw = open(path, "rb").read()
    jlen = struct.unpack_from("<I", raw, 12)[0]
    js = json.loads(raw[20:20 + jlen])
    mn, mx, tris = [math.inf] * 3, [-math.inf] * 3, 0
    for mesh in js["meshes"]:
        for prim in mesh["primitives"]:
            acc = js["accessors"][prim["attributes"]["POSITION"]]
            mn = [min(a, b) for a, b in zip(mn, acc["min"])]
            mx = [max(a, b) for a, b in zip(mx, acc["max"])]
            tris += js["accessors"][prim["indices"]]["count"] // 3
    return dict(min=mn, max=mx, tris=tris, bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest(),
                materials=[m["name"] for m in js.get("materials", [])])


def surface_names(pack):
    """yr_* names the runtime knows (base table + the pack's data module)."""
    names = set()
    for path in (os.path.join(REPO, "src", "render", "surfaces.js"),
                 os.path.join(REPO, "src", "world", "props", "packs", pack + ".js")):
        if os.path.exists(path):
            names.update(re.findall(r"\byr_\w+", open(path, encoding="utf-8").read()))
    return names


def generator_info():
    try:
        import io_scene_gltf2
        exporter = ".".join(str(n) for n in io_scene_gltf2.bl_info["version"])
    except Exception:  # exporter moved or renamed: the GLB's asset.generator still says
        exporter = "unknown"
    build_hash = bpy.app.build_hash
    if isinstance(build_hash, bytes):
        build_hash = build_hash.decode("ascii", "replace")
    return dict(blender=bpy.app.version_string, blenderHash=build_hash, exporter=exporter,
                script="build_pack.py")


# --- Contract audits ----------------------------------------------------------------------

def _cell_origin(anchor):
    # Where cell [0, 0]'s min corner sits relative to the kind's origin; cells
    # extend toward +u / +v (edge kits: into the room in front of the wall).
    return {"center": (-CELL / 2, -CELL / 2), "edge": (-CELL / 2, 0.0), "min_corner": (0.0, 0.0)}[anchor]


def _inside_cells(box, cells, anchor):
    ou, ov = _cell_origin(anchor)

    def covered(u, v):
        return any(ou + i * CELL - 1e-4 <= u <= ou + (i + 1) * CELL + 1e-4 and
                   ov + j * CELL - 1e-4 <= v <= ov + (j + 1) * CELL + 1e-4 for i, j in cells)

    nu = max(1, math.ceil((box["u1"] - box["u0"]) / (CELL / 2)))
    nv = max(1, math.ceil((box["v1"] - box["v0"]) / (CELL / 2)))
    return all(covered(box["u0"] + (box["u1"] - box["u0"]) * a / nu, box["v0"] + (box["v1"] - box["v0"]) * b / nv)
               for a in range(nu + 1) for b in range(nv + 1))


def audit_shape(k, obj):
    """Footprint / centring / top / floor checks on the joined mesh, before
    culling (vertices in Blender frame: x = u, y = -v, z = up)."""
    name = k["kind"]
    xs = [v.co.x for v in obj.data.vertices]
    ys = [v.co.y for v in obj.data.vertices]
    zs = [v.co.z for v in obj.data.vertices]
    w, d = max(xs) - min(xs), max(ys) - min(ys)
    aw, ad = k["collision"][0] + k["overhang"][0], k["collision"][1] + k["overhang"][1]
    if w > aw + TOL or d > ad + TOL:
        raise RuntimeError(f"{name}: footprint {w:.3f}x{d:.3f} exceeds {aw:.3f}x{ad:.3f}+tol")
    # Centred on the claimed cells (the origin for a one-cell kind).
    ou, ov = _cell_origin(k["anchor"])
    cells = k["footprint_cells"] or [[0, 0]]
    mid_u = ou + CELL * (min(c[0] for c in cells) + max(c[0] for c in cells) + 1) / 2
    mid_v = ov + CELL * (min(c[1] for c in cells) + max(c[1] for c in cells) + 1) / 2
    off_u = abs((max(xs) + min(xs)) / 2 - mid_u)
    off_v = abs(-(max(ys) + min(ys)) / 2 - mid_v)
    if k["anchor"] == "center" and (off_u > TOL_CENTER or off_v > TOL_CENTER):
        raise RuntimeError(f"{name}: footprint off-centre ({off_u:.3f}, {off_v:.3f})")
    if k["anchor"] == "edge" and off_u > TOL_CENTER:
        raise RuntimeError(f"{name}: edge kit off-centre along u ({off_u:.3f})")
    if max(zs) > k["height"] + TOL_TOP:
        raise RuntimeError(f"{name}: top {max(zs):.3f} exceeds {k['height']:.3f}")
    if min(zs) < k["floor_z"] + MIN_Y:
        raise RuntimeError(f"{name}: dips below floor_z {k['floor_z']:.3f} ({min(zs):.3f})")
    return w, d, max(zs) - min(zs), zs


def audit_class(k, colliders, proxies, sockets):
    name, cls = k["kind"], k["cls"]
    cw, cd = k["collision"]
    if cls == "B":
        # §4.4: a prop stands on the floor (min y >= -0.005); only D may sink.
        if k["floor_z"] != 0.0:
            raise RuntimeError(f"{name}: class B sits on the floor; floor_z must be 0 (got {k['floor_z']:.3f})")
        if k["height"] > OCC_MAX_H:
            raise RuntimeError(f"{name}: class B height {k['height']:.3f} exceeds {OCC_MAX_H} (use class C)")
        if cw / 2 >= REACH or cd / 2 >= REACH:
            raise RuntimeError(f"{name}: class B half-extents {cw / 2:.3f}x{cd / 2:.3f} reach {REACH} m")
    # The runtime proxy table holds at most two boxes per kind (proxies.js).
    if len(proxies) > 2:
        raise RuntimeError(f"{name}: {len(proxies)} occ_* markers (at most occ_A, occ_B)")
    for p in proxies:
        if not (isinstance(p["t"], int) and 0 <= p["t"] <= 7):
            raise RuntimeError(f"{name}: {p['name']} t={p['t']!r} must be an integer 0..7")
        if p["y1"] > OCC_MAX_H + 1e-4:
            raise RuntimeError(f"{name}: {p['name']} top {p['y1']} exceeds OCC_MAX_H {OCC_MAX_H}")
    if cls == "C":
        if not colliders:
            raise RuntimeError(f"{name}: class C needs at least one col_* marker")
        if not k["footprint_cells"]:
            raise RuntimeError(f"{name}: class C needs footprint_cells")
        for c in colliders:
            if not _inside_cells(c, k["footprint_cells"], k["anchor"]):
                raise RuntimeError(f"{name}: collider {c} leaves its footprint cells {k['footprint_cells']}")
    if cls == "E" and not any(isinstance(s.get("yrSocket"), str) for s in sockets):
        raise RuntimeError(f"{name}: class E needs a socket_<type>_<n> marker with a string yrSocket")
    for s in sockets:
        if not isinstance(s.get("yrSocket"), str):
            raise RuntimeError(f"{name}: {s['name']} needs a string yrSocket prop")


# --- Driver -----------------------------------------------------------------------------------

def build_kind(spec, k, out_dir, sel_kw, keep_markers):
    name = k["kind"]
    parts = []
    k["build"](parts)
    markers = [o for o in parts if o.type == "EMPTY"]
    meshes = [o for o in parts if o.type == "MESH"]
    if not meshes:
        raise RuntimeError(f"{name}: the builder made no mesh parts")
    for e in markers:
        if not MARKER_RE.match(e.name):
            raise RuntimeError(f"{name}: marker {e.name!r} is not col_<n>, occ_A/occ_B or socket_<type>_<n>")
    # Bake every part transform into its mesh BEFORE joining: join keeps the
    # active object's (non-zero) transform otherwise, leaving the GLB geometry
    # offset from the origin and a compensating node translation. The loader
    # and the collision contract both want origin-at-floor. Markers stay out.
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.location = (0, 0, 0)
    obj.name = spec.NODE_PREFIX + name
    obj.data.name = "mesh_" + name
    if obj.name != spec.NODE_PREFIX + name:
        raise RuntimeError(f"{name}: node name taken ({obj.name}); one pack per Blender process")

    w, d, h, zs = audit_shape(k, obj)
    colliders = [marker_box(e, name) for e in markers if e.name.startswith("col_")]
    proxies = [dict(name=e.name, **marker_box(e, name), t=e.get("t", 0))
               for e in sorted((e for e in markers if e.name.startswith("occ_")), key=lambda e: e.name)]
    sockets = [e for e in markers if e.name.startswith("socket_")]
    socket_recs = [socket_record(e) for e in sockets]
    audit_class(k, colliders, proxies, socket_recs)
    if not colliders and k["anchor"] == "center":
        cw, cd = k["collision"]
        colliders = [dict(u0=r4(-cw / 2), u1=r4(cw / 2), v0=r4(-cd / 2), v1=r4(cd / 2),
                          y0=r4(k["floor_z"]), y1=r4(k["height"]))]

    # Painted vertex shading (COLOR_0 multiplier): floor gradient, soft
    # cavity/contact occlusion, warm catch-light on convex top edges.
    # Computed on the closed parts, THEN never-visible faces are culled.
    fz = k["floor_z"]
    keys = yr_shading.paint(obj, height=max(zs) - fz, keep_bright={"yr_" + b for b in spec.KEEP_BRIGHT},
                            floor_z=fz)
    culled = yr_shading.cull_hidden(obj, floor=k["floor_cull"], floor_z=fz)
    yr_shading.audit_triangles(obj, name)

    for e in sockets:
        e.parent = obj  # obj sits at identity: no parent-inverse correction needed
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    for e in sockets:
        e.select_set(True)
    bpy.context.view_layer.objects.active = obj
    path = os.path.join(out_dir, name + ".glb")
    # export_extras also exports custom props on meshes/materials: only kinds
    # with sockets turn it on (and builders keep custom props on markers).
    yr_shading.export_glb(path, sel_kw, extra={"export_extras": True} if sockets else None)

    st = glb_stats(path)
    palette_names = {"yr_" + key for key in spec.PALETTE}
    stray = [m for m in st["materials"] if m not in palette_names]
    if stray:
        raise RuntimeError(f"{name}: materials {stray} are not in the pack PALETTE (one pack per process)")
    # Markers that stay in the scene (sockets, and every marker with --blend)
    # take a kind-qualified name, so the next kind's "occ_A" / "socket_use_0"
    # keeps its exact name instead of becoming "occ_A.001".
    for e in markers:
        if e.name.startswith("socket_") or keep_markers:
            e.parent = obj
            e.name = f"{name}/{e.name}"
        else:
            bpy.data.objects.remove(e)
    print(f"[yr] {name:<11} {w:.2f}x{d:.2f}x{h:.2f}  tris={st['tris']:<5} culled={culled:<4} "
          f"verts={len(obj.data.vertices):<5} shade={keys:<5} {st['bytes']} B")
    record = {
        "kind": name,
        "kindKey": k["kind_key"],
        "file": name + ".glb",
        "class": k["cls"],
        "collision": {"w": r4(k["collision"][0]), "d": r4(k["collision"][1])},
        "overhang": {"w": r4(k["overhang"][0]), "d": r4(k["overhang"][1])},
        "heightBudget": r4(k["height"]),
        "floorZ": r4(fz),
        "footprintCells": k["footprint_cells"],
        "anchor": k["anchor"],
        "budget": {"tris": k["tris"], "bytes": k["bytes"]},
        "bounds": {"min": [r4(x) for x in st["min"]], "max": [r4(x) for x in st["max"]]},
        "tris": st["tris"],
        "bytes": st["bytes"],
        "materials": st["materials"],
        "sockets": socket_recs,
        "colliders": colliders,
        "proxies": proxies,
        "sha256": st["sha256"],
    }
    return obj, record


def main(argv=None):
    if argv is None:
        argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    args = parse_args(argv)
    spec = importlib.import_module("packs." + args.pack)
    for attr in ("NODE_PREFIX", "PALETTE", "MODELS"):
        if not hasattr(spec, attr):
            raise RuntimeError(f"packs/{args.pack}.py: missing {attr}")
    if not spec.NODE_PREFIX.endswith("_"):
        raise RuntimeError(f"packs/{args.pack}.py: NODE_PREFIX must end with '_'")
    spec.KEEP_BRIGHT = set(getattr(spec, "KEEP_BRIGHT", ()))
    missing = sorted(spec.KEEP_BRIGHT - set(spec.PALETTE))
    if missing:
        raise RuntimeError(f"packs/{args.pack}.py: KEEP_BRIGHT keys {missing} are not in PALETTE")
    budget = dict(getattr(spec, "BUDGET", DEFAULT_BUDGET))
    kinds = [kind_settings(m) for m in spec.MODELS]
    dupes = sorted({k["kind"] for k in kinds if [x["kind"] for x in kinds].count(k["kind"]) > 1})
    if dupes:
        raise RuntimeError(f"packs/{args.pack}.py: duplicate kinds {dupes}")

    yr_kit.wipe_factory_scene()
    collection = yr_kit.new_collection("YR_" + args.pack.upper())
    yr_kit.use(collection, yr_kit.palette_materials(spec.PALETTE))
    os.makedirs(args.out, exist_ok=True)
    sel_kw = yr_kit.gltf_selection_kwargs()
    known = surface_names(args.pack)

    built, records = [], []
    for k in kinds:
        obj, rec = build_kind(spec, k, args.out, sel_kw, keep_markers=bool(args.blend))
        if not args.no_budget and (rec["tris"] > k["tris"] or rec["bytes"] > k["bytes"]):
            raise RuntimeError(f"{k['kind']}: {rec['tris']} tris / {rec['bytes']} B over its budget "
                               f"{k['tris']} / {k['bytes']}")
        for m in rec["materials"]:
            if m not in known:
                print(f"[yr] WARNING {k['kind']}: material {m} has no runtime surface entry "
                      f"(src/render/surfaces.js or the pack's data module)")
        built.append(obj)
        records.append(rec)
    tot_tris = sum(r["tris"] for r in records)
    tot_bytes = sum(r["bytes"] for r in records)
    print(f"[yr] TOTAL {args.pack}: {tot_tris} triangles, {tot_bytes} bytes "
          f"(budget {budget['tris']} / {budget['bytes']})")
    if not args.no_budget and (tot_tris >= budget["tris"] or tot_bytes >= budget["bytes"]):
        raise RuntimeError(f"{args.pack} set exceeds its triangle/byte budget")

    stale = sorted(f for f in os.listdir(args.out)
                   if f.endswith(".glb") and f not in {r["file"] for r in records})
    if stale:
        print(f"[yr] WARNING stale GLBs in {args.out} (not in the spec; delete them): {stale}")
    manifest = {
        "schema": SCHEMA,
        "pack": args.pack,
        "generator": generator_info(),
        "budget": {"tris": budget["tris"], "bytes": budget["bytes"]},
        "totals": {"tris": tot_tris, "bytes": tot_bytes},
        "kinds": records,
    }
    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"[yr] manifest -> {os.path.join(args.out, 'manifest.json')}")

    yr_kit.layout_grid(built)
    if args.blend:
        # Never write .blend1 backups next to the source scene.
        bpy.context.preferences.filepaths.save_version = 0
        os.makedirs(os.path.dirname(args.blend), exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=args.blend, check_existing=False)
        print(f"[yr] blend -> {args.blend}")
    if args.preview:
        yr_kit.contact_sheet(built, args.preview)
    print("[yr] done")
    return manifest


def run(argv=None):
    """main() with a failing exit status: Blender exits 0 when a --python
    script raises, which would hide a failed audit from npm and CI."""
    try:
        return main(argv)
    except Exception:
        traceback.print_exc()
        sys.stdout.flush()
        sys.exit(1)


if __name__ == "__main__":
    run()
