# Yellow Rooms — furniture asset pipeline, legacy entry point.
#
# The 23 furniture models live in packs/furniture.py and build through the
# generic pack driver (build_pack.py), which also writes
# public/models/furniture/manifest.json. This shim keeps the old command and
# its positional arguments working; both produce the same files:
#
#   blender --background --factory-startup --python scripts/blender/build_furniture.py
#   blender --background --factory-startup --python scripts/blender/build_pack.py -- furniture
#
# Optional positional args after `--`:
#   -- <glbOutDir> <blendOut> <previewPng>
# The source .blend is opt-in (Blender never writes it byte-identically):
# pass <blendOut>, or set YR_SAVE_BLEND=1 for assets-src/furniture.blend.
# `-` skips a positional slot (e.g. `-- <glbOutDir> - <previewPng>`).
# YR_SKIP_PREVIEW=1 skips the Cycles contact sheet.

import os
import sys

sys.dont_write_bytecode = True  # no scripts/blender/__pycache__ in the tree
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_pack  # noqa: E402

ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
args = ["furniture"]
for flag, value in zip(("--out", "--blend", "--preview"), ARGV):
    if value != "-":
        args += [flag, value]
build_pack.run(args)
