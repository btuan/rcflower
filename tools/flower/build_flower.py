"""Parametric toon flower builder for Blender.

Builds the whole flower (petals, center, stem, leaves) from a single parameter
dict so the mood variants (neutral/happy/sad/dead) are just different numbers.

Usage (headless):
    blender -b -P tools/flower/build_flower.py -- --preset sad
    blender -b -P tools/flower/build_flower.py -- --export          # all presets -> assets/flower/*.glb
    blender -b -P tools/flower/build_flower.py -- --preset dead --export

Usage (inside Blender / MCP):
    exec(open("tools/flower/build_flower.py").read())
    build_flower(preset("sad", petal_count=9))
"""
import json
import math
import os
import random
import sys

import bpy
import bmesh
from mathutils import Matrix, Vector

# --------------------------------------------------------------------------
# Colours (sampled from assets/Flower*_768x768.png), sRGB 0-255
# --------------------------------------------------------------------------
def _c(r, g, b):
    """sRGB byte triple -> linear RGBA for Blender."""
    def lin(v):
        v /= 255.0
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    return (lin(r), lin(g), lin(b), 1.0)


PALETTES = {
    "fresh": dict(
        petal=_c(224, 168, 32), petal_stripe=_c(200, 120, 16), petal_edge=_c(240, 184, 56),
        center=_c(176, 72, 0), center_hi=_c(210, 110, 20),
        stem_dark=_c(80, 128, 24), stem_light=_c(192, 200, 48),
        leaf_dark=_c(72, 120, 16), leaf_light=_c(136, 168, 32),
    ),
    "wilted": dict(
        petal=_c(226, 160, 30), petal_stripe=_c(160, 96, 0), petal_edge=_c(236, 178, 50),
        center=_c(160, 80, 8), center_hi=_c(190, 110, 30),
        stem_dark=_c(96, 96, 16), stem_light=_c(150, 150, 56),
        leaf_dark=_c(104, 104, 24), leaf_light=_c(140, 140, 40),
    ),
    "dead": dict(
        petal=_c(200, 136, 48), petal_stripe=_c(128, 64, 0), petal_edge=_c(214, 156, 70),
        center=_c(120, 60, 0), center_hi=_c(150, 85, 15),
        stem_dark=_c(64, 64, 0), stem_light=_c(100, 100, 20),
        leaf_dark=_c(64, 64, 8), leaf_light=_c(96, 96, 16),
    ),
}

# --------------------------------------------------------------------------
# Parameters
# --------------------------------------------------------------------------
DEFAULTS = dict(
    name="Flower",
    seed=1,
    palette="fresh",
    # -- petals --
    petal_count=8,
    petal_length=1.1,
    petal_width=0.42,       # half-width at widest point (units of petal_length)
    petal_curl=0.18,        # tip lifts up (+) or hangs down (-), fraction of length
    petal_cup=0.12,         # cross-section curvature (edges lift)
    petal_twist=8.0,        # degrees of twist base->tip
    petal_droop=15.0,       # degrees each petal tilts down from the head plane
    petal_notch=0.07,       # scallop depth at the tip (0 = plain rounded tip)
    petal_jitter=0.08,      # random per-petal variation (0..1)
    petal_thickness=0.03,
    petal_stripe_width=0.18,  # fraction of half-width covered by the dark midrib stripe
    # -- petal texture --
    petal_veins=0.5,        # strength of the fanning vein lines (colour + shallow groove), 0 = flat
    petal_vein_count=5,
    petal_ruffle=0.35,      # wavy edge amplitude (fraction of width)
    petal_ruffle_freq=3.0,  # waves along the petal length
    petal_res=(28, 24),     # mesh resolution (along, across); veins need ~24 across
    # -- center --
    center_size=0.36,       # radius
    center_height=0.55,     # squash factor (1 = sphere)
    center_bump=0.06,       # random bumpiness
    # -- head --
    head_tilt=30.0,         # degrees, head face rotated toward the viewer (-Y)
    head_droop=0.0,         # degrees, head hangs down relative to stem tip tangent
    head_roll=0.0,          # degrees around the stem axis
    # -- stem --
    stem_height=2.8,        # arc length
    stem_radius=0.055,
    stem_lean=8.0,          # degrees, gradual lean of the whole stem (in the XZ plane)
    stem_bend=0.0,          # degrees, extra bend concentrated near the top (sad droop)
    stem_bend_start=0.55,   # fraction of stem where the bend starts
    stem_taper=0.75,        # radius at top / radius at base
    stem_yaw=0.0,           # rotate whole plant about Z
    stem_segments=48,
    stem_sides=12,
    # -- stem texture --
    stem_hair=0.0,          # hair density, 0 = smooth, 1 = fuzzy (small fins along the stem)
    stem_hair_length=0.09,
    stem_hair_tilt=35.0,    # degrees hairs lean toward the tip
    stem_knobble=0.0,       # radius noise (0..1), gives a knobbly/ribbed stem
    stem_ribs=0,            # count of lengthwise ribs (0 = round)
    # -- leaves --
    leaf_count=2,
    leaf_positions=(0.32, 0.5),  # fractions along stem; cycled if leaf_count is larger
    leaf_length=0.9,
    leaf_width=0.2,
    leaf_angle=45.0,        # degrees from stem tangent
    leaf_curl=0.1,
    leaf_twist=0.0,
    leaf_thickness=0.02,
    leaf_detached=False,    # dead: leaves lie on the ground next to the stem
    leaf_side_alternate=True,
    # -- leaf texture --
    leaf_veins=0.6,         # midrib + side-vein strength
    leaf_vein_count=6,      # side veins per side
    leaf_serration=0.0,     # toothy edge depth (0..1)
    leaf_serration_freq=9.0,
    leaf_ruffle=0.15,
    leaf_res=(24, 16),
    # -- rig (for runtime animation, see tools/flower/ANIMATION.md) --
    rig=True,               # build an armature + skin weights; the armature becomes the root object
    stem_bones=6,           # bones along the stem chain
    petal_bones=2,          # bones per petal (base -> tip)
    leaf_bones=2,
)


def preset(preset_name, **overrides):
    p = dict(DEFAULTS)
    p.update(PRESETS[preset_name])
    p["name"] = f"Flower_{preset_name}"
    p.update(overrides)
    return p


PRESETS = {
    "neutral": dict(),
    "happy": dict(
        palette="fresh",
        petal_curl=0.32, petal_droop=6.0, petal_cup=0.15, petal_width=0.46,
        head_tilt=40.0, stem_lean=4.0, stem_height=3.0,
        leaf_angle=50.0, leaf_curl=0.28, center_size=0.34,
    ),
    "sad": dict(
        palette="wilted",
        petal_curl=-0.35, petal_droop=62.0, petal_cup=0.05, petal_twist=4.0,
        petal_width=0.36, petal_length=0.9, petal_jitter=0.12,
        head_tilt=0.0, head_droop=25.0, stem_yaw=180.0,
        stem_height=3.0, stem_lean=12.0, stem_bend=125.0, stem_bend_start=0.5,
        leaf_angle=20.0, leaf_curl=-0.15, leaf_positions=(0.3, 0.42),
    ),
    "dead": dict(
        palette="dead",
        petal_count=7, petal_curl=-0.15, petal_droop=45.0, petal_cup=0.0,
        petal_width=0.3, petal_length=0.8, petal_jitter=0.2, petal_twist=15.0,
        head_tilt=0.0, head_droop=-35.0, stem_yaw=180.0,
        # stem collapses over so the head rests on the ground (tip z ~ 0.4)
        stem_height=2.4, stem_lean=30.0, stem_bend=125.0, stem_bend_start=0.05,
        leaf_count=2, leaf_detached=True, leaf_length=0.55, leaf_width=0.18,
        leaf_curl=0.1, center_size=0.26,
    ),
}


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def smoothstep(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def lerp(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(4))


def clear_flower(name):
    for o in list(bpy.data.objects):
        if o.name == name or o.name.startswith(name + "."):
            bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials):
        for d in list(coll):
            if d.users == 0 and d.name.startswith(name):
                coll.remove(d)


def toon_material(name):
    """Flat-ish material driven by vertex colours; exports cleanly to glTF."""
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    col = nt.nodes.new("ShaderNodeVertexColor")
    col.layer_name = "Col"
    bsdf.inputs["Roughness"].default_value = 1.0
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.0
    nt.links.new(col.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat


def grid_mesh(name, nu, nv, pos_fn, col_fn, mat, wrap_v=False):
    """Build a quad grid. pos_fn(u,v)->Vector, col_fn(u,v)->RGBA. u,v in [0,1]."""
    bm = bmesh.new()
    verts = []
    ncols = nv if wrap_v else nv + 1
    for i in range(nu + 1):
        u = i / nu
        row = []
        for j in range(ncols):
            v = j / nv
            row.append(bm.verts.new(pos_fn(u, v)))
        verts.append(row)
    bm.verts.ensure_lookup_table()
    for i in range(nu):
        for j in range(nv):
            j2 = (j + 1) % ncols
            try:
                bm.faces.new((verts[i][j], verts[i][j2], verts[i + 1][j2], verts[i + 1][j]))
            except ValueError:
                pass  # degenerate quad (e.g. pinched tip)
    bm.faces.ensure_lookup_table()
    layer = bm.loops.layers.float_color.new("Col")
    for i in range(nu + 1):
        for j in range(ncols):
            verts[i][j].index = i * ncols + j
    cols = {}
    for i in range(nu + 1):
        for j in range(ncols):
            cols[i * ncols + j] = col_fn(i / nu, j / nv)
    for f in bm.faces:
        for lp in f.loops:
            lp[layer] = cols[lp.vert.index]
    bm.normal_update()
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    me.color_attributes.active_color_index = 0
    me.color_attributes.render_color_index = 0
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def add_solidify(ob, thickness):
    m = ob.modifiers.new("Solidify", "SOLIDIFY")
    m.thickness = thickness
    m.offset = 0.0


# --------------------------------------------------------------------------
# Parts
# --------------------------------------------------------------------------
def make_blade(name, length, width, curl, cup, twist_deg, notch, mat, dark, light, edge,
               stripe_w, thickness, nu=14, nv=8, pointy=False, rng=None,
               veins=0.0, vein_count=5, ruffle=0.0, ruffle_freq=3.0,
               serration=0.0, serration_freq=9.0, phase=0.0):
    """A petal or leaf. Local frame: base at origin, +Y along length, +Z is 'up'.

    Texture: `veins` draws vein lines in vertex colour and cuts a shallow groove
    into the surface (petals: fan from the base; leaves/pointy: midrib + side
    veins). `ruffle` waves the edges up/down along the length, `serration`
    notches the outline like a toothed leaf.
    """
    twist = math.radians(twist_deg)

    def vein_field(t, s):
        """0..1 line mask for veins at (t, s)."""
        if veins <= 0 or vein_count <= 0:
            return 0.0
        wv = 0.07
        m = 0.0
        if pointy:
            # midrib
            m = math.exp(-(s / (wv * 1.6)) ** 2)
            # side veins leaving the midrib at an angle, spaced along t
            for k in range(1, vein_count + 1):
                t0 = 0.08 + 0.8 * (k - 0.5) / vein_count
                # vein path: s grows linearly as t advances past t0
                sv = (t - t0) * 2.8
                if 0 < sv < 1.2:
                    m = max(m, math.exp(-((abs(s) - sv) / wv) ** 2) * (1 - sv / 1.2) * 0.8)
        else:
            for k in range(vein_count):
                sk = ((k + 0.5) / vein_count * 2 - 1) * 0.9
                # veins fan out: start near s=0 at the base, reach sk near the tip
                sv = sk * smoothstep(t / 0.85)
                m = max(m, math.exp(-((s - sv) / wv) ** 2))
            m *= smoothstep((0.92 - t) / 0.15)
        return m

    def shape(t):
        if pointy:
            return math.sin(math.pi * t ** 0.8) ** 0.7
        # rounded lobe: narrow base, widest ~2/3 out, elliptical round tip
        x = (t - 0.6) / 0.6
        body = math.sqrt(max(0.0, 1 - x * x))
        y = max(0.0, (t - 0.72) / 0.28)
        tip = math.sqrt(max(0.0, 1 - y * y))
        return max(body * tip, 0.12 * smoothstep(t / 0.05))

    def pos(u, v):
        t, s = u, v * 2 - 1
        w = width * shape(t)
        if serration:
            w *= 1 - serration * 0.35 * abs(math.sin(serration_freq * math.pi * t)) ** 3 * smoothstep(t / 0.15)
        # scalloped tip: a shallow central notch between two lobes
        tipcut = notch * smoothstep((t - 0.6) / 0.4) * math.cos(math.pi * s / 2) ** 2 if notch else 0.0
        x = s * w
        y = length * (t - tipcut)
        z = curl * length * t * t + cup * width * s * s
        if ruffle:
            z += ruffle * width * 0.6 * abs(s) ** 2.5 * math.sin(ruffle_freq * math.pi * t + phase + 2.0 * s)
        if veins:
            z -= veins * width * 0.04 * vein_field(t, s)
        a = twist * t
        x, z = x * math.cos(a) - z * math.sin(a), x * math.sin(a) + z * math.cos(a)
        return Vector((x, y, z))

    def col(u, v):
        s = abs(v * 2 - 1)
        stripe = smoothstep((stripe_w - s) / 0.08 + 0.5) * smoothstep((0.85 - u) / 0.2)
        c = lerp(light, dark, stripe)
        # lighter, slightly translucent-looking tip/edge
        c = lerp(c, edge, 0.5 * smoothstep((s - 0.6) / 0.4) * (1 - stripe))
        if veins:
            c = lerp(c, dark, 0.7 * veins * vein_field(u, v * 2 - 1))
        return c

    ob = grid_mesh(name, nu, nv, pos, col, mat)
    ob["blade_length"] = length
    add_solidify(ob, thickness)
    return ob



def make_center(name, radius, height, bump, mat, base, hi, rng):
    def pos(u, v):
        th = u * math.pi * 0.62  # only the upper cap
        ph = v * 2 * math.pi
        r = radius * (1 + bump * (rng.random() - 0.5) * 2)
        return Vector((r * math.sin(th) * math.cos(ph),
                       r * math.sin(th) * math.sin(ph),
                       r * math.cos(th) * height))

    def col(u, v):
        n = math.sin(v * 2 * math.pi * 5) * math.sin(u * math.pi * 4)
        return lerp(base, hi, 0.5 + 0.5 * n)

    ob = grid_mesh(name, 8, 20, pos, col, mat, wrap_v=True)
    return ob


def stem_frames(p):
    """Integrate the stem centreline. Returns list of (pos, tangent, normal, binormal)."""
    n = p["stem_segments"]
    lean = math.radians(p["stem_lean"])
    bend = math.radians(p["stem_bend"])
    bs = p["stem_bend_start"]
    pos = Vector((0, 0, 0))
    frames = []
    ds = p["stem_height"] / n
    for i in range(n + 1):
        t = i / n
        th = lean * t + bend * smoothstep((t - bs) / max(1e-6, 1 - bs))
        T = Vector((math.sin(th), 0, math.cos(th)))
        N = Vector((math.cos(th), 0, -math.sin(th)))
        B = Vector((0, 1, 0))
        frames.append((pos.copy(), T, N, B))
        if i < n:
            # midpoint rule for a smoother arc
            th2 = lean * (t + 0.5 / n) + bend * smoothstep((t + 0.5 / n - bs) / max(1e-6, 1 - bs))
            pos = pos + Vector((math.sin(th2), 0, math.cos(th2))) * ds
    return frames


def make_stem(name, p, frames, mat, dark, light):
    n = p["stem_segments"]
    sides = p["stem_sides"]
    r0 = p["stem_radius"]
    light_dir = Vector((-0.6, -0.6, 0.5)).normalized()

    knob, ribs = p["stem_knobble"], p["stem_ribs"]
    rng = random.Random(p["seed"] + 7)
    noise = [rng.random() * 2 - 1 for _ in range(n + 2)]

    def radius(u, a):
        r = r0 * (1 - (1 - p["stem_taper"]) * u)
        if knob:
            i = u * n
            k = int(i)
            f = i - k
            nz = noise[k] * (1 - f) + noise[min(k + 1, n + 1)] * f
            r *= 1 + 0.35 * knob * nz
        if ribs:
            r *= 1 + 0.12 * math.cos(ribs * a)
        return r

    def pos(u, v):
        i = round(u * n)
        P, T, N, B = frames[i]
        a = v * 2 * math.pi
        return P + (N * math.cos(a) + B * math.sin(a)) * radius(u, a)

    def col(u, v):
        i = round(u * n)
        P, T, N, B = frames[i]
        a = v * 2 * math.pi
        nrm = N * math.cos(a) + B * math.sin(a)
        k = smoothstep((nrm.dot(light_dir) - 0.15) / 0.5)
        return lerp(dark, light, k)

    ob = grid_mesh(name, n, sides, pos, col, mat, wrap_v=True)
    ob["stem_cols"] = sides
    if p["stem_hair"] > 0:
        make_hairs(name + ".Hairs", p, frames, radius, mat, light, rng).parent = ob
    return ob


def make_hairs(name, p, frames, radius, mat, colour, rng):
    """Tiny triangular fins scattered over the stem surface (exports as plain geometry)."""
    n = p["stem_segments"]
    count = int(p["stem_hair"] * 900 * p["stem_height"] / 3.0)
    hl = p["stem_hair_length"]
    tilt = math.radians(p["stem_hair_tilt"])
    bm = bmesh.new()
    layer = bm.loops.layers.float_color.new("Col")
    ulayer = bm.verts.layers.float.new("stem_u")
    for _ in range(count):
        u = rng.random() * 0.97
        a = rng.random() * 2 * math.pi
        i = int(u * n)
        P, T, N, B = frames[i]
        nrm = N * math.cos(a) + B * math.sin(a)
        tan = N * -math.sin(a) + B * math.cos(a)
        base = P + nrm * radius(u, a) * 0.97
        L = hl * (0.6 + 0.8 * rng.random())
        d = (nrm * math.cos(tilt) + T * math.sin(tilt)).normalized()
        bw = hl * 0.12
        v0 = bm.verts.new(base + tan * bw)
        v1 = bm.verts.new(base - tan * bw)
        v2 = bm.verts.new(base + d * L)
        for vv in (v0, v1, v2):
            vv[ulayer] = u
        f = bm.faces.new((v0, v1, v2))
        for lp in f.loops:
            lp[layer] = colour
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    me.color_attributes.active_color_index = 0
    me.color_attributes.render_color_index = 0
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def frame_matrix(P, T, N, B):
    """Matrix whose local +Y is T (along stem), +Z is N, +X is B."""
    m = Matrix((
        (B.x, T.x, N.x, P.x),
        (B.y, T.y, N.y, P.y),
        (B.z, T.z, N.z, P.z),
        (0, 0, 0, 1),
    ))
    return m


# --------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------
def build_flower(p):
    p = dict(DEFAULTS, **p)
    name = p["name"]
    rng = random.Random(p["seed"])
    pal = PALETTES[p["palette"]]
    clear_flower(name)

    root = bpy.data.objects.new(name, None)
    root.empty_display_type = "PLAIN_AXES"
    bpy.context.collection.objects.link(root)
    root.rotation_euler = (0, 0, math.radians(p["stem_yaw"]))

    m_petal = toon_material(f"{name}.Petal")
    m_center = toon_material(f"{name}.Center")
    m_stem = toon_material(f"{name}.Stem")
    m_leaf = toon_material(f"{name}.Leaf")

    frames = stem_frames(p)

    # -- stem --
    stem = make_stem(f"{name}.Stem", p, frames, m_stem, pal["stem_dark"], pal["stem_light"])
    stem.parent = root

    # -- head --
    P, T, N, B = frames[-1]
    head = bpy.data.objects.new(f"{name}.Head", None)
    head.empty_display_type = "SPHERE"
    head.empty_display_size = 0.2
    bpy.context.collection.objects.link(head)
    head.parent = root
    # head local: +Z along stem tip tangent (petals radiate in XY)
    m = frame_matrix(P, T, N, B) @ Matrix.Rotation(math.radians(-90), 4, "X")
    # after the -90 X rotation: local X = B (world Y), local Y = -N, local Z = T
    m = m @ Matrix.Rotation(math.radians(p["head_droop"]), 4, "X")      # tip over in the stem's bend plane
    m = m @ Matrix.Rotation(math.radians(-p["head_tilt"]), 4, "Y")      # face toward -Y (the viewer)
    m = m @ Matrix.Rotation(math.radians(p["head_roll"]), 4, "Z")
    head.matrix_basis = m

    # -- petals --
    jit = p["petal_jitter"]
    for i in range(p["petal_count"]):
        j = lambda: 1 + jit * (rng.random() * 2 - 1)
        petal = make_blade(
            f"{name}.Petal.{i:02d}",
            p["petal_length"] * j(), p["petal_width"] * p["petal_length"] * j(),
            p["petal_curl"] * j(), p["petal_cup"], p["petal_twist"] * (rng.random() * 2 - 1 if jit else 1),
            p["petal_notch"], m_petal,
            pal["petal_stripe"], pal["petal"], pal["petal_edge"],
            p["petal_stripe_width"], p["petal_thickness"], rng=rng,
            nu=p["petal_res"][0], nv=p["petal_res"][1],
            veins=p["petal_veins"], vein_count=p["petal_vein_count"],
            ruffle=p["petal_ruffle"], ruffle_freq=p["petal_ruffle_freq"],
            phase=rng.random() * 6.28,
        )
        petal.parent = head
        petal["kind"] = "petal"
        ang = 2 * math.pi * i / p["petal_count"] + jit * 0.3 * (rng.random() - 0.5)
        droop = math.radians(p["petal_droop"] * j())
        petal.matrix_basis = (
            Matrix.Rotation(ang, 4, "Z")
            @ Matrix.Translation((0, p["center_size"] * 0.55, 0))
            @ Matrix.Rotation(droop, 4, "X")
        )

    center = make_center(f"{name}.Center", p["center_size"], p["center_height"], p["center_bump"],
                         m_center, pal["center"], pal["center_hi"], rng)
    center.parent = head
    center.matrix_basis = Matrix.Translation((0, 0, 0.02))

    # -- leaves --
    positions = list(p["leaf_positions"]) or [0.4]
    for i in range(p["leaf_count"]):
        f = positions[i % len(positions)]
        side = -1 if (p["leaf_side_alternate"] and i % 2) else 1
        leaf = make_blade(
            f"{name}.Leaf.{i:02d}",
            p["leaf_length"], p["leaf_width"], p["leaf_curl"], 0.05, p["leaf_twist"], 0.0,
            m_leaf, pal["leaf_light"], pal["leaf_dark"], pal["leaf_light"],
            0.08, p["leaf_thickness"], pointy=True, rng=rng,
            nu=p["leaf_res"][0], nv=p["leaf_res"][1],
            veins=p["leaf_veins"], vein_count=p["leaf_vein_count"],
            ruffle=p["leaf_ruffle"], serration=p["leaf_serration"],
            serration_freq=p["leaf_serration_freq"], phase=rng.random() * 6.28,
        )
        leaf.parent = root
        leaf["kind"] = "leaf"
        leaf["stem_u"] = -1.0 if p["leaf_detached"] else f
        if p["leaf_detached"]:
            # lie flat on the ground near the base of the stem
            gx = 0.6 + 0.9 * i + rng.random() * 0.3
            gy = side * (0.5 + rng.random() * 0.4)
            leaf.matrix_basis = (
                Matrix.Translation((gx, gy, 0.02))
                @ Matrix.Rotation(rng.random() * math.pi * 2, 4, "Z")
            )
        else:
            k = round(f * p["stem_segments"])
            P, T, N, B = frames[k]
            r = p["stem_radius"] * (1 - (1 - p["stem_taper"]) * f)
            leaf.matrix_basis = (
                frame_matrix(P, T, N, B)
                @ Matrix.Rotation(side * math.radians(p["leaf_angle"]), 4, "X")   # tilt away from the stem in the N/T plane
                @ Matrix.Rotation(side * math.radians(90), 4, "Y")                # blade faces the viewer (-Y)
                @ Matrix.Translation((0, r * 0.5, 0))
            )
    if p["rig"]:
        root = build_rig(root, head, frames, p)
    root["flower_params"] = json.dumps({k: v for k, v in p.items() if k != "name"})
    return root


# --------------------------------------------------------------------------
# Rig
# --------------------------------------------------------------------------
def _bake_world(ob):
    """Bake the object's world transform into its mesh data."""
    mw = ob.matrix_world.copy()
    ob.data.transform(mw)
    ob.parent = None
    ob.matrix_world = Matrix.Identity(4)
    return mw


def build_rig(root, head, frames, p):
    """Replace the empties with an armature: a stem chain, a head bone, and short
    chains for every petal and leaf. Meshes are baked to world space, skinned
    with smooth weights, and parented to the armature, which takes over the
    root's name so callers/export keep working."""
    name = root.name
    bpy.context.view_layer.update()
    meshes = [o for o in bpy.data.objects if o.name.startswith(name + ".") and o.type == "MESH"]
    world = {o: _bake_world(o) for o in meshes}
    head_mw = head.matrix_world.copy()

    arm_data = bpy.data.armatures.new(name + ".Armature")
    arm = bpy.data.objects.new(name + "__rig", arm_data)
    bpy.context.collection.objects.link(arm)
    arm.matrix_world = root.matrix_world.copy()
    inv = arm.matrix_world.inverted()
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm_data.edit_bones

    def bone(bname, hp, tp, parent=None, roll_vec=None, connect=False):
        b = eb.new(bname)
        b.head, b.tail = inv @ hp, inv @ tp
        if parent is not None:
            b.parent = parent
            b.use_connect = connect
        if roll_vec is not None:
            b.align_roll((inv.to_3x3() @ roll_vec).normalized())
        return b

    # stem chain
    n, k = p["stem_segments"], p["stem_bones"]
    stem_bones = []
    for i in range(k):
        a, c = frames[round(i * n / k)], frames[round((i + 1) * n / k)]
        stem_bones.append(bone(f"stem.{i:02d}", a[0], c[0], stem_bones[-1] if i else None,
                               roll_vec=a[2], connect=bool(i)))
    tipP, tipT = frames[-1][0], frames[-1][1]
    head_bone = bone("head", tipP, tipP + tipT * p["center_size"], stem_bones[-1], roll_vec=frames[-1][2], connect=True)

    chains = {}  # mesh -> list of bone names (base->tip)
    for o in meshes:
        kind = o.get("kind")
        if kind not in ("petal", "leaf"):
            continue
        mw = world[o]
        L = o["blade_length"]
        nb = p["petal_bones"] if kind == "petal" else p["leaf_bones"]
        if kind == "petal":
            parent = head_bone
        else:
            u = o["stem_u"]
            parent = None if u < 0 else stem_bones[min(k - 1, int(u * k))]
        pts = [mw @ Vector((0, L * j / nb, 0)) for j in range(nb + 1)]
        up = (mw.to_3x3() @ Vector((0, 0, 1))).normalized()
        names = []
        for j in range(nb):
            bname = f"{o.name[len(name) + 1:].lower()}.{chr(97 + j)}"
            parent = bone(bname, pts[j], pts[j + 1], parent, roll_vec=up, connect=j > 0)
            names.append(bname)
        chains[o] = names
    bpy.ops.object.mode_set(mode="OBJECT")

    # weights
    def tri_weights(t, count):
        """Smooth partition of unity over `count` bones for t in [0,1]."""
        w = [max(0.0, 1 - abs(t * count - (j + 0.5))) for j in range(count)]
        w[0] = max(w[0], 1 - t * count if t * count < 0.5 else 0)
        w[-1] = max(w[-1], t * count - (count - 0.5) if t * count > count - 0.5 else 0)
        tot = sum(w) or 1.0
        return [x / tot for x in w]

    for o in meshes:
        me = o.data
        groups = {}
        def add(vi, bname, w):
            if w <= 1e-4:
                return
            g = groups.get(bname)
            if g is None:
                g = groups[bname] = o.vertex_groups.new(name=bname)
            g.add([vi], w, "REPLACE")
        if o in chains:
            L, names = o["blade_length"], chains[o]
            mw_inv = world[o].inverted()
            for v in me.vertices:
                t = max(0.0, min(1.0, (mw_inv @ v.co).y / L))
                for bname, w in zip(names, tri_weights(t, len(names))):
                    add(v.index, bname, w)
        elif o.name.endswith(".Stem"):
            cols = o["stem_cols"]
            for v in me.vertices:
                u = (v.index // cols) / n
                for j, w in enumerate(tri_weights(u, k)):
                    add(v.index, f"stem.{j:02d}", w)
        elif o.name.endswith(".Hairs"):
            ul = me.attributes["stem_u"].data
            for v in me.vertices:
                for j, w in enumerate(tri_weights(ul[v.index].value, k)):
                    add(v.index, f"stem.{j:02d}", w)
        else:  # center, anything else on the head
            for v in me.vertices:
                add(v.index, "head", 1.0)
        mod = o.modifiers.new("Armature", "ARMATURE")
        mod.object = arm
        o.parent = arm

    # the armature becomes the root
    for o in (head, root):
        bpy.data.objects.remove(o, do_unlink=True)
    arm.name = name
    return arm


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------
def export_flower(root, filepath):
    bpy.ops.object.select_all(action="DESELECT")
    objs = [root] + [o for o in bpy.data.objects if o.name.startswith(root.name + ".")]
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = root
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=filepath,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_animations=False,
        export_extras=True,
        export_skins=True,
        export_all_influences=False,
    )
    return filepath


def _repo_root():
    return os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


def main(argv):
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--preset", choices=sorted(PRESETS), default=None,
                    help="build one preset (default: all when exporting, neutral otherwise)")
    ap.add_argument("--export", action="store_true", help="write glTF binary per preset into assets/flower/")
    ap.add_argument("--out", default=os.path.join(_repo_root(), "assets", "flower"))
    ap.add_argument("--clear", action="store_true", help="delete every other object in the scene first")
    args = ap.parse_args(argv)

    if args.clear:
        for o in list(bpy.data.objects):
            bpy.data.objects.remove(o, do_unlink=True)

    names = [args.preset] if args.preset else (sorted(PRESETS) if args.export else ["neutral"])
    for n in names:
        root = build_flower(preset(n))
        if args.export:
            path = export_flower(root, os.path.join(args.out, f"flower_{n}.glb"))
            print(f"exported {path}")


if __name__ == "__main__":
    if "--" in sys.argv:
        main(sys.argv[sys.argv.index("--") + 1:])
    elif bpy.app.background:
        main([])
