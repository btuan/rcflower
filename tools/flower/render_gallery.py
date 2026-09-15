"""Render parameter sweeps of the flower to PNGs (headless Eevee).

    blender -b -P tools/flower/render_gallery.py -- --out /path/to/dir [--sweep petal_count ...]

Writes one PNG per variant (<sweep>_<value>.png) plus a JSON manifest; stitch
contact sheets with tools/flower/contact_sheet.py.
"""
import argparse
import json
import math
import os
import sys

import bpy
from mathutils import Euler

HERE = os.path.dirname(os.path.abspath(__file__))
ns = {"__name__": "flower_mod", "__file__": os.path.join(HERE, "build_flower.py")}
exec(compile(open(ns["__file__"]).read(), ns["__file__"], "exec"), ns)
build_flower, preset, clear_flower = ns["build_flower"], ns["preset"], ns["clear_flower"]

# name -> (base preset, list of values)
SWEEPS = {
    "preset": ("neutral", ["neutral", "happy", "sad", "dead"]),
    "petal_count": ("neutral", [4, 5, 6, 8, 10, 13]),
    "petal_width": ("neutral", [0.2, 0.3, 0.42, 0.55, 0.7]),
    "petal_curl": ("neutral", [-0.5, -0.25, 0.0, 0.18, 0.4, 0.7]),
    "petal_droop": ("neutral", [-20, 0, 15, 35, 55, 75]),
    "petal_twist": ("neutral", [0, 8, 20, 40, 70]),
    "petal_notch": ("neutral", [0.0, 0.07, 0.15, 0.3]),
    "center_size": ("neutral", [0.15, 0.25, 0.36, 0.5, 0.65]),
    "head_tilt": ("neutral", [-20, 0, 30, 60, 90]),
    "stem_bend": ("neutral", [0, 30, 60, 90, 125, 160]),
    "stem_lean": ("neutral", [-25, 0, 8, 25, 45]),
    "leaf_angle": ("neutral", [10, 30, 45, 70, 100]),
    "leaf_count": ("neutral", [0, 1, 2, 4, 6]),
    "petal_jitter": ("neutral", [0.0, 0.08, 0.2, 0.4, 0.7]),
    "palette": ("neutral", ["fresh", "wilted", "dead"]),
    # texture
    "petal_veins": ("neutral", [0.0, 0.3, 0.6, 1.0]),
    "petal_vein_count": ("neutral", [1, 3, 5, 9]),
    "petal_ruffle": ("neutral", [0.0, 0.2, 0.4, 0.8]),
    "petal_ruffle_freq": ("neutral", [1, 2, 3, 6]),
    "stem_hair": ("neutral", [0.0, 0.3, 0.7, 1.0]),
    "stem_knobble": ("neutral", [0.0, 0.3, 0.7, 1.0]),
    "stem_ribs": ("neutral", [0, 4, 6, 10]),
    "leaf_serration": ("neutral", [0.0, 0.3, 0.7, 1.0]),
    "leaf_veins": ("neutral", [0.0, 0.4, 0.8, 1.0]),
}

SWEEP_EXTRA = {  # per-sweep overrides that make the effect legible
    "leaf_count": dict(leaf_positions=(0.25, 0.4, 0.55, 0.7, 0.85, 0.95)),
    "stem_bend": dict(head_tilt=0.0, stem_bend_start=0.5),
    "petal_veins": dict(head_tilt=60.0),
    "petal_vein_count": dict(head_tilt=60.0, petal_veins=0.8),
    "petal_ruffle": dict(head_tilt=45.0),
    "petal_ruffle_freq": dict(head_tilt=45.0, petal_ruffle=0.5),
    "stem_hair": dict(stem_radius=0.09),
    "stem_knobble": dict(stem_radius=0.09),
    "stem_ribs": dict(stem_radius=0.09, stem_knobble=0.3),
    "leaf_serration": dict(leaf_width=0.3, leaf_length=1.1, leaf_angle=60.0),
    "leaf_veins": dict(leaf_width=0.3, leaf_length=1.1, leaf_angle=60.0),
}


def setup_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x = sc.render.resolution_y = 512
    sc.render.film_transparent = True
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    sc.view_settings.view_transform = "Standard"
    sc.eevee.taa_render_samples = 16

    cam_data = bpy.data.cameras.new("Cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = 4.6
    cam = bpy.data.objects.new("Cam", cam_data)
    sc.collection.objects.link(cam)
    cam.rotation_euler = Euler((math.radians(72), 0, 0))
    cam.location = (0, -12, 1.6 + 12 * math.cos(math.radians(72)) / math.sin(math.radians(72)) * 0)  # aim at z~1.6
    # put camera on the line through (0,0,1.6) along its view axis
    d = 12.0
    cam.location = (0, -d * math.sin(math.radians(72)), 1.6 + d * math.cos(math.radians(72)))
    sc.camera = cam

    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.data.energy = 3.0
    sun.data.angle = math.radians(20)
    sun.rotation_euler = Euler((math.radians(50), math.radians(-15), math.radians(-30)))
    sc.collection.objects.link(sun)
    world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    sc.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (1, 1, 1, 1)
        bg.inputs[1].default_value = 0.6


def render_variant(base, key, value, path):
    extra = dict(SWEEP_EXTRA.get(key, {}))
    if key == "preset":
        base = value
    else:
        extra[key] = value
    root = build_flower(preset(base, name="Flower", **extra))
    # centre horizontally on the flower head when the stem leans/bends
    bpy.context.view_layer.update()
    head = bpy.data.objects["Flower.Head"]
    hx = head.matrix_world.translation.x
    root.location.x = -hx * 0.5
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    clear_flower("Flower")


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "..", "..", "assets", "flower", "gallery"))
    ap.add_argument("--sweep", nargs="*", default=None, help="subset of sweeps (default: all)")
    a = ap.parse_args(argv)
    os.makedirs(a.out, exist_ok=True)
    setup_scene()
    manifest = {}
    for key in (a.sweep or SWEEPS):
        base, values = SWEEPS[key]
        manifest[key] = []
        for v in values:
            fname = f"{key}_{str(v).replace('-', 'm')}.png"
            render_variant(base, key, v, os.path.join(a.out, fname))
            manifest[key].append({"value": v, "file": fname})
            print("rendered", fname)
    with open(os.path.join(a.out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)


if __name__ == "__main__":
    main(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
