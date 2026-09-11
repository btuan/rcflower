# Flower liveness: gravity + flex spec

The exported `assets/flower/flower_<preset>.glb` files are skinned. Mood presets are
**rest poses** (sad is bent because its stem geometry is bent); liveness is a runtime
layer that rotates bones *away* from rest and springs back. Nothing here is baked into
the file, so shaking, tilting, bouncing and wind all come from the same simulation.

## Rig (in every GLB)

| Bone(s)            | Count            | Parent        | Local axes                                  |
| ------------------ | ---------------- | ------------- | ------------------------------------------- |
| `stem.00..05`      | `stem_bones`     | chain         | +Y along the stem, +Z = stem bend-plane normal side |
| `head`             | 1                | last stem     | +Y along the stem tip tangent (petals radiate around it) |
| `petal.NN.a/.b`    | `petal_bones` ea | head / prev   | +Y base→tip, +Z = petal "up" (toward viewer when open) |
| `leaf.NN.a/.b`     | `leaf_bones` ea  | nearest stem  | +Y base→tip, +Z = leaf face normal          |

Weights are smooth triangular blends between neighbouring bones, so rotating one bone
bends the mesh rather than kinking it. Every root node carries `extras.flower_params`,
the full parameter dict used to build it (useful for per-preset tuning at runtime).

## Physical model

Treat every bone as a **damped angular spring** attached to its parent. Per bone `b`:

```
θ_b        current deflection from rest (a small rotation, store as a 2-vector: bend about local X and local Z)
ω_b        angular velocity
rest       identity (the glTF bind pose already encodes the mood)

torque_b = lever_b × (g_eff + a_shake)        # gravity + inertial load, projected perpendicular to the bone
           + wind_b(t)
           - k_b * θ_b                          # stiffness (restoring)
           - c_b * ω_b                          # damping
ω_b += torque_b / I_b * dt
θ_b += ω_b * dt
θ_b  = clamp(|θ_b|, flex_max_b)                 # plants don't fold; clamp the magnitude, keep direction
```

`g_eff` is Earth's up vector in *flower* space, i.e. `-upInDevice(beta, gamma)` from
`frontend/src/orientation.ts` transformed into the model frame. `a_shake` is the
device linear acceleration from `devicemotion.acceleration` (already gravity-free), low-pass
filtered and negated: moving the phone right makes the flower lag left. Lever length and
mass scale with bone position (tip bones are light and floppy, base bones heavy and stiff).

The bend axis for `torque` is `bone_Y × load`, so the head always swings toward
whatever direction "down" currently is. Rotation is applied as
`quaternion = bindRotation * axisAngle(axis_local, |θ|)`.

## Parameters (proposed defaults)

| Name             | Default | Meaning |
| ---------------- | ------- | ------- |
| `gravity`        | 9.8     | magnitude of `g_eff`; 0 = weightless, negative = "helium" bounce up |
| `gravityInfluence` | 0.15  | scales how much static tilt bends the plant (1 = physically limp) |
| `stiffness`      | 40      | base-bone `k`; each bone up the chain multiplies by `stiffnessFalloff` |
| `stiffnessFalloff` | 0.7   | per-bone multiplier toward the tip (tip bones softer) |
| `damping`        | 0.55    | fraction of critical damping; <1 gives the after-shake wobble |
| `mass`           | 1.0     | base-bone inertia; falloff 0.6 per bone |
| `flexMax`        | 25°     | per-bone clamp on deflection (stem); petals 40°, leaves 35° |
| `shakeGain`      | 0.08    | rad per (m/s²) of device acceleration |
| `shakeSmoothing` | 0.2     | one-pole low-pass on acceleration (0 = raw, 1 = frozen) |
| `wind`           | 0.3     | amplitude of a slow 1/f noise torque on petals and leaves |
| `windSpeed`      | 0.6     | Hz-ish of the noise |
| `petalFlutter`   | 0.5     | extra high-frequency wind on `petal.*.b` only |
| `bounceImpulse`  | 2.0     | angular impulse injected into `stem.00` on a tap / drop event |
| `substeps`       | 2       | simulation steps per frame (stability with high stiffness) |
| `gravityScale`   | 20      | unit fudge so `gravityInfluence` 0.35 at 45° tilt gives ~15° base bend |
| `bounceToBend`   | 0.6     | vertical shock -> forward buckle of the stem; pure physics gives nothing on an upright stem and looks dead |
| `petalShakeGain` | 4       | petals/leaves are far lighter than the stem, so shocks hit them harder |
| `shedThreshold`  | 25 m/s² | filtered |acceleration| above which petal "hold" decays |
| `shedRate`       | 0.05    | hold lost per second per m/s² over threshold; holds start staggered 0.2–1.0 so petals go one at a time |
| `petalFloatGravity` | 0.02 | gravity on shed petals as a fraction of g; the flutter lift roughly balances it so they hover |
| `petalFloatDrag` | 1.2     | air drag on shed petals |
| `petalFloatSway` | 0.6     | wandering flutter amplitude; shed petals also get pushed by device shocks and are kept in frame by soft walls and a floor at the stem base |
| `shedRecover`    | 0.15    | hold regained per second while calm |

Per-preset overrides: `sad` → `stiffness 25, damping 0.8, gravityInfluence 0.3`
(limp, no bounce); `dead` → `stiffness 15, damping 1.0, wind 0` (hangs, doesn't sway);
`happy` → `damping 0.35, petalFlutter 0.9` (springy, lots of after-wobble).

## Inputs → effects

- **Tilt phone** (`deviceorientation`): `g_eff` rotates; the stem leans and the head
  droops toward the new down. Static, no oscillation once settled.
- **Shake / move** (`devicemotion.acceleration`): impulse torque on every bone with
  falloff up the chain, so the base moves first and petals follow a few frames later.
  That lag is the "lifelike" part; keep `damping < 1` so it overshoots once or twice.
- **Bounce** (tap, or the person walking into frame): call `impulse(vector)` on the
  base bone; propagates through the chain naturally.
- **Idle**: wind noise only, so the flower is never perfectly still.

## Runtime sketch (three.js)

```ts
const { scene } = await new GLTFLoader().loadAsync("/flower_neutral.glb");
const bones = new Map(); scene.traverse(o => { if (o.isBone) bones.set(o.name, o); });
const chain = ["stem.00","stem.01","stem.02","stem.03","stem.04","stem.05","head"];
for (const b of bones.values()) b.userData.bind = b.quaternion.clone();

function step(dt, gDevice, aDevice) {
  for (const [name, b] of bones) {
    const s = state.get(name);           // {theta: Vector2, omega: Vector2, k, c, I, lever, flexMax}
    const load = gDevice.clone().multiplyScalar(cfg.gravity * cfg.gravityInfluence)
                  .add(aDevice.clone().multiplyScalar(-cfg.shakeGain));
    const loadLocal = load.applyQuaternion(b.getWorldQuaternion(q).invert());
    const torque = new Vector2(loadLocal.z, -loadLocal.x).multiplyScalar(s.lever); // Y×load
    torque.add(windTorque(name, t)).addScaledVector(s.theta, -s.k).addScaledVector(s.omega, -s.c);
    s.omega.addScaledVector(torque, dt / s.I);
    s.theta.addScaledVector(s.omega, dt);
    if (s.theta.length() > s.flexMax) s.theta.setLength(s.flexMax);
    b.quaternion.copy(b.userData.bind).multiply(
      new Quaternion().setFromAxisAngle(new Vector3(s.theta.x, 0, s.theta.y).normalize(), s.theta.length()));
  }
}
```

Cost: 27 bones × 2 substeps, trivially cheap on the Pi's browser client (the phone).

## Petal shedding (implemented)

Vigorous shaking shakes petals loose. Each petal keeps a "hold" that decays while the
filtered |acceleration| exceeds `shedThreshold` and recovers slowly when calm. At zero,
the petal's root bone (`petal.NN.a`) is re-parented from `head` to the scene with its
world transform kept, launched along its own direction, and then floats: weak gravity,
drag, a wandering flutter, pushes from the phone's motion, a floor at the stem base and
soft walls just outside the frame. The stem base itself never moves. `resetPetals()` regrows. Sad and dead shed at lower thresholds.

## Runtime (implemented)

`frontend/src/flowerSpring.ts` is the model; `frontend/src/FlowerShake.tsx` is the
`/flower-shake` page (three.js, orientation + motion hooks, sliders, desktop test
buttons). Note three's GLTFLoader strips dots from node names (`stem.00` -> `stem00`).

## Open decisions

1. **One geometry, four poses** vs four GLBs: mood transitions (happy → sad) would be
   far nicer as bone-pose interpolation on a single mesh. That needs the builder to
   export one neutral mesh plus per-mood pose data instead of re-meshing per preset.
   Worth doing if moods change while the user watches.
2. **Vertex-shader alternative**: a stem-bend + petal-flutter in a custom shader with no
   skeleton is cheaper still but much less expressive; not recommended.
