"""Bake the ANIMATION.md spring model onto the rig and render mp4 clips.

    blender -b -P tools/flower/simulate.py -- --out /path/dir [--clip bounce_soft ...]

Each clip = preset + physics tunables + a motion profile (how the "pot" moves).
The armature root follows the motion; bones react to the inertial load with the
damped angular springs described in tools/flower/ANIMATION.md.
"""
import argparse
import math
import os
import random
import shutil
import subprocess
import sys

import bpy
from mathutils import Euler, Quaternion, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ns = {"__name__": "flower_mod", "__file__": os.path.join(HERE, "build_flower.py")}
exec(compile(open(ns["__file__"]).read(), ns["__file__"], "exec"), ns)
build_flower, preset = ns["build_flower"], ns["preset"]

FPS = 30

PHYSICS = dict(
    gravity=9.8, gravityInfluence=0.15,
    stiffness=40.0, stiffnessFalloff=0.7,
    damping=0.55,
    mass=1.0, massFalloff=0.6,
    flexMax=math.radians(25), flexMaxPetal=math.radians(40), flexMaxLeaf=math.radians(35),
    shakeGain=0.08, shakeSmoothing=0.2,
    wind=0.3, windSpeed=0.6, petalFlutter=0.5,
    gravityScale=20.0,      # unit fudge: static tilt at gravityInfluence=0.35 -> ~15 deg base bend
    bounceToBend=0.6,       # vertical shock -> forward buckle of the stem (0 = pure physics)
    petalShakeGain=4.0,     # petals/leaves are far lighter than the stem: react more to shocks
    substeps=4,
)


# ---------------------------------------------------------------- motion profiles
def m_bounce(t, amp=0.5):
    """Pot hops up and lands: a half-sine hop, then a small damped settle."""
    if t < 0.3:
        return Vector((0, 0, amp * math.sin(math.pi * t / 0.3)))
    tt = t - 0.3
    return Vector((0, 0, -0.06 * amp * math.exp(-6 * tt) * math.sin(2 * math.pi * 4 * tt)))


def m_jerk(t, dist=0.9):
    """Pot is yanked sideways (world X) and stops dead."""
    if t < 0.1:
        return Vector((0, 0, 0))
    u = min(1.0, (t - 0.1) / 0.18)
    return Vector((dist * (u * u * (3 - 2 * u)), 0, 0))


def m_shake(t):
    """Three quick lateral shakes."""
    if 0.1 < t < 0.85:
        return Vector((0.25 * math.sin(2 * math.pi * 4 * (t - 0.1)), 0, 0))
    return Vector((0, 0, 0))


def m_still(t):
    return Vector((0, 0, 0))


CLIPS = {
    # name: (preset, physics overrides, motion fn, gravity dir fn or None, duration s)
    "bounce_soft": ("neutral", dict(stiffness=25, damping=0.3), m_bounce, None, 2.5),
    "bounce_stiff": ("neutral", dict(stiffness=70, damping=0.7), m_bounce, None, 2.5),
    "jerk_soft": ("neutral", dict(stiffness=25, damping=0.3), m_jerk, None, 2.5),
    "jerk_stiff": ("neutral", dict(stiffness=70, damping=0.7), m_jerk, None, 2.5),
    "jerk_happy": ("happy", dict(stiffness=35, damping=0.35, petalFlutter=0.9), m_jerk, None, 2.5),
    "jerk_sad": ("sad", dict(stiffness=25, damping=0.8, gravityInfluence=0.3), m_jerk, None, 2.5),
    "shake": ("neutral", dict(), m_shake, None, 2.5),
    "tilt": ("neutral", dict(gravityInfluence=0.35), m_still,
             lambda t: Euler((0, math.radians(45 * math.sin(math.pi * min(1, t / 1.2) / 2)), 0)).to_matrix() @ Vector((0, 0, -1)), 2.5),
    "idle_wind": ("neutral", dict(wind=0.6), m_still, None, 3.0),
}


# ---------------------------------------------------------------- simulation
class BoneState:
    def __init__(self, k, c, I, lever, flex):
        self.k, self.c, self.I, self.lever, self.flex = k, c, I, lever, flex
        self.theta = Vector((0, 0, 0))
        self.omega = Vector((0, 0, 0))


def setup_states(arm, phys):
    states = {}
    for pb in arm.pose.bones:
        name = pb.name
        depth = 0
        p = pb
        while p.parent:
            depth += 1
            p = p.parent
        if name.startswith("stem"):
            i = int(name.split(".")[1])
            k = phys["stiffness"] * phys["stiffnessFalloff"] ** i
            I = phys["mass"] * phys["massFalloff"] ** i
            flex = phys["flexMax"]
        elif name == "head":
            k = phys["stiffness"] * phys["stiffnessFalloff"] ** 6
            I = phys["mass"] * phys["massFalloff"] ** 6
            flex = phys["flexMax"]
        elif name.startswith("petal"):
            j = ord(name[-1]) - 97
            k = phys["stiffness"] * 0.25 * phys["stiffnessFalloff"] ** j
            I = phys["mass"] * 0.05 * phys["massFalloff"] ** j
            flex = phys["flexMaxPetal"]
        else:  # leaf
            j = ord(name[-1]) - 97
            k = phys["stiffness"] * 0.3 * phys["stiffnessFalloff"] ** j
            I = phys["mass"] * 0.08 * phys["massFalloff"] ** j
            flex = phys["flexMaxLeaf"]
        c = 2 * math.sqrt(k * I) * phys["damping"]
        lever = pb.length * 0.5 * I  # torque ~ m * g * lever
        states[name] = BoneState(k, c, I, lever, flex)
        pb.rotation_mode = "QUATERNION"
        pb.rotation_quaternion = Quaternion()
    return states


def wind_torque(name, t, phys, rng_phase):
    ph = rng_phase[name]
    w = phys["wind"]
    f = phys["windSpeed"]
    base = Vector((math.sin(2 * math.pi * f * t + ph), 0, math.cos(2 * math.pi * f * 0.7 * t + ph * 1.3))) * w * 0.02
    if name.startswith("petal") and name.endswith(".b"):
        base += Vector((math.sin(2 * math.pi * 3.1 * t + ph * 2), 0, 0)) * phys["petalFlutter"] * 0.02
    if name.startswith("stem"):
        base *= 0.3
    return base


def simulate(arm, phys, motion, gdir, duration, seed=3):
    rng = random.Random(seed)
    states = setup_states(arm, phys)
    rng_phase = {n: rng.random() * 6.28 for n in states}
    nframes = int(duration * FPS)
    dt = 1.0 / FPS / phys["substeps"]
    a_filt = Vector((0, 0, 0))
    # rest world orientation of each bone (bind pose), used to bring loads into bone space
    bpy.context.view_layer.update()
    rest_q = {pb.name: (arm.matrix_world @ pb.bone.matrix_local).to_quaternion() for pb in arm.pose.bones}

    prev = [motion(0.0), motion(0.0)]
    for f in range(nframes + 1):
        t = f / FPS
        pos = motion(t)
        # finite-difference acceleration of the pot (world), m/s^2 in scene units ~ metres
        acc = (pos - 2 * prev[0] + prev[1]) * (FPS * FPS)
        prev = [pos, prev[0]]
        arm.location = pos
        arm.keyframe_insert("location", frame=f)
        g_world = (gdir(t) if gdir else Vector((0, 0, -1))) * phys["gravity"] * phys["gravityInfluence"] * phys["gravityScale"]
        for _ in range(phys["substeps"]):
            a_filt = a_filt.lerp(acc, 1 - phys["shakeSmoothing"])
            shock = -a_filt * phys["shakeGain"] * 10
            # vertical shock buckles the stem forward (toward +X, the lean direction)
            shock_stem = shock + Vector((shock.z * phys["bounceToBend"], 0, 0))
            for name, s in states.items():
                q = rest_q[name]
                is_stem = name.startswith("stem") or name == "head"
                load_world = g_world + (shock_stem if is_stem else shock * phys["petalShakeGain"])
                load = q.inverted() @ load_world
                # torque axis = boneY x load  ->  (load.z, 0, -load.x) in bone space
                torque = Vector((load.z, 0, -load.x)) * s.lever
                torque += wind_torque(name, t, phys, rng_phase)
                torque -= s.theta * s.k
                torque -= s.omega * s.c
                s.omega += torque * (dt / s.I)
                s.theta += s.omega * dt
                if s.theta.length > s.flex:
                    s.theta.normalize()
                    s.theta *= s.flex
        for name, s in states.items():
            pb = arm.pose.bones[name]
            ang = s.theta.length
            pb.rotation_quaternion = Quaternion(s.theta.normalized(), ang) if ang > 1e-6 else Quaternion()
            pb.keyframe_insert("rotation_quaternion", frame=f)
    return nframes


# ---------------------------------------------------------------- render
def setup_scene(out_path, nframes):
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x = sc.render.resolution_y = 512
    sc.render.fps = FPS
    sc.frame_start, sc.frame_end = 0, nframes
    sc.render.image_settings.file_format = "PNG"
    sc.render.filepath = out_path  # frame directory prefix; encoded with ffmpeg afterwards
    sc.view_settings.view_transform = "Standard"
    sc.eevee.taa_render_samples = 16
    sc.render.film_transparent = False

    if "Cam" not in bpy.data.objects:
        cam_data = bpy.data.cameras.new("Cam")
        cam_data.type = "ORTHO"
        cam_data.ortho_scale = 6.4
        cam = bpy.data.objects.new("Cam", cam_data)
        sc.collection.objects.link(cam)
        cam.rotation_euler = Euler((math.radians(72), 0, 0))
        d = 12.0
        cam.location = (0.4, -d * math.sin(math.radians(72)), 1.9 + d * math.cos(math.radians(72)))
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
        bg.inputs[0].default_value = (1, 1, 1, 1)
        bg.inputs[1].default_value = 1.0
        # ground shadow catcher-ish plane
        bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, 0))
        plane = bpy.context.active_object
        plane.name = "Ground"
        m = bpy.data.materials.new("Ground")
        m.use_nodes = True
        m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (1, 1, 1, 1)
        plane.data.materials.append(m)


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "..", "..", "assets", "flower", "anim"))
    ap.add_argument("--clip", nargs="*", default=None)
    a = ap.parse_args(argv)
    os.makedirs(a.out, exist_ok=True)
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for name in (a.clip or CLIPS):
        pre, over, motion, gdir, dur = CLIPS[name]
        phys = dict(PHYSICS, **over)
        arm = build_flower(preset(pre, name="Flower"))
        nframes = simulate(arm, phys, motion, gdir, dur)
        frames_dir = os.path.join(a.out, "frames_" + name)
        os.makedirs(frames_dir, exist_ok=True)
        setup_scene(os.path.join(frames_dir, "f_"), nframes)
        bpy.ops.render.render(animation=True)
        mp4 = os.path.join(a.out, name + ".mp4")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS),
                        "-i", os.path.join(frames_dir, "f_%04d.png"),
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", mp4], check=True)
        shutil.rmtree(frames_dir)
        print("rendered", mp4)
        ns["clear_flower"]("Flower")


if __name__ == "__main__":
    main(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
