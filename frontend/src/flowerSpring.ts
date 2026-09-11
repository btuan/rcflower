/**
 * Damped angular-spring rig driver for the flower GLBs built by
 * tools/flower/build_flower.py. Mirrors tools/flower/simulate.py and the spec in
 * tools/flower/ANIMATION.md: every bone is a spring back to its bind pose, loaded
 * by gravity, by the inertial reaction to device acceleration, and by wind noise.
 *
 * Frames: the GLB is Y-up with the flower facing +Z. A phone in portrait has
 * X right, Y up, Z out of the screen, so device vectors map 1:1 onto flower space.
 */
import { Bone, Object3D, Quaternion, Vector3 } from "three";

export type Physics = {
  gravity: number;
  gravityInfluence: number;
  gravityScale: number;
  stiffness: number;
  stiffnessFalloff: number;
  damping: number;
  mass: number;
  massFalloff: number;
  flexMax: number;
  flexMaxPetal: number;
  flexMaxLeaf: number;
  shakeGain: number;
  shakeSmoothing: number;
  bounceToBend: number;
  petalShakeGain: number;
  wind: number;
  windSpeed: number;
  petalFlutter: number;
  substeps: number;
  /** Petal shedding: filtered |acceleration| (m/s^2) above which hold decays. */
  shedThreshold: number;
  /** Hold lost per second per m/s^2 above threshold. 0 disables shedding. */
  shedRate: number;
  /** Hold regained per second while calm. */
  shedRecover: number;
  /** Gravity on shed petals as a fraction of g. Small = they float. */
  petalFloatGravity: number;
  /** Air drag on shed petals (per second). Higher = lazier drift. */
  petalFloatDrag: number;
  /** Amplitude of the sideways flutter that keeps shed petals wandering. */
  petalFloatSway: number;
};

export const DEFAULT_PHYSICS: Physics = {
  gravity: 9.8,
  gravityInfluence: 0.15,
  gravityScale: 20,
  stiffness: 40,
  stiffnessFalloff: 0.7,
  damping: 0.55,
  mass: 1,
  massFalloff: 0.6,
  flexMax: (25 * Math.PI) / 180,
  flexMaxPetal: (40 * Math.PI) / 180,
  flexMaxLeaf: (35 * Math.PI) / 180,
  shakeGain: 0.08,
  shakeSmoothing: 0.2,
  bounceToBend: 0.6,
  petalShakeGain: 4,
  wind: 0.3,
  windSpeed: 0.6,
  petalFlutter: 0.5,
  substeps: 2,
  shedThreshold: 25,
  shedRate: 0.05,
  shedRecover: 0.15,
  petalFloatGravity: 0.02,
  petalFloatDrag: 1.2,
  petalFloatSway: 0.6,
};

export const PRESET_PHYSICS: Record<string, Partial<Physics>> = {
  neutral: {},
  happy: { damping: 0.35, petalFlutter: 0.9 },
  sad: { stiffness: 25, damping: 0.8, gravityInfluence: 0.3, shedThreshold: 15 },
  dead: { stiffness: 15, damping: 1.0, wind: 0, shedThreshold: 8 },
};

type BoneKind = "stem" | "head" | "petal" | "leaf";

type BoneState = {
  bone: Bone;
  kind: BoneKind;
  /** Index along its chain (stem segment, or a/b for blades). */
  index: number;
  bind: Quaternion;
  /** Bind-pose world rotation, used to bring world loads into bone space. */
  restWorldInv: Quaternion;
  theta: Vector3;
  omega: Vector3;
  k: number;
  c: number;
  inertia: number;
  lever: number;
  flex: number;
  phase: number;
};

type Petal = {
  id: string;
  root: Bone; // petal.NN.a
  parent: Object3D;
  bindPos: Vector3;
  bindQuat: Quaternion;
  hold: number;
  shed: boolean;
  vel: Vector3;
  spin: Vector3;
  phase: number;
};

const _q = new Quaternion();
const _v = new Vector3();
const _load = new Vector3();
const _torque = new Vector3();
const _axis = new Vector3();

// Blender names bones "stem.00", "petal.03.a"; three's GLTFLoader strips the
// dots (PropertyBinding.sanitizeNodeName), so accept both spellings.
const RE_STEM = /^stem\.?(\d+)$/;
const RE_BLADE = /^(petal|leaf)\.?(\d+)\.?([ab])$/;

function classify(name: string): { kind: BoneKind; index: number } | null {
  if (name === "head") return { kind: "head", index: 6 };
  const m = RE_STEM.exec(name);
  if (m) return { kind: "stem", index: Number(m[1]) };
  const b = RE_BLADE.exec(name);
  if (b) return { kind: b[1] as "petal" | "leaf", index: b[3] === "a" ? 0 : 1 };
  return null;
}

export class FlowerSpring {
  physics: Physics;
  private states: BoneState[] = [];
  private petals: Petal[] = [];
  private aFilt = new Vector3();
  private time = 0;
  /** Gravity direction in flower space (unit vector). Default straight down. */
  down = new Vector3(0, -1, 0);
  /** Latest device acceleration, gravity removed, flower space (m/s^2). */
  accel = new Vector3();
  private impulse = new Vector3();
  private impulseTtl = 0;

  constructor(root: Object3D, physics: Physics = DEFAULT_PHYSICS) {
    this.physics = { ...physics };
    root.updateMatrixWorld(true);
    let seed = 1;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    root.traverse((o) => {
      if (!(o instanceof Bone)) return;
      const c = classify(o.name);
      if (!c) return;
      const restWorld = o.getWorldQuaternion(new Quaternion());
      const length = o.children.find((ch) => ch instanceof Bone)?.position.length() ?? 0.3;
      this.states.push({
        bone: o,
        kind: c.kind,
        index: c.index,
        bind: o.quaternion.clone(),
        restWorldInv: restWorld.invert(),
        theta: new Vector3(),
        omega: new Vector3(),
        k: 1,
        c: 1,
        inertia: 1,
        lever: length * 0.5,
        flex: 1,
        phase: rand() * Math.PI * 2,
      });
      if (c.kind === "petal" && c.index === 0 && o.parent) {
        this.petals.push({
          id: o.name,
          root: o,
          parent: o.parent,
          bindPos: o.position.clone(),
          bindQuat: o.quaternion.clone(),
          hold: 0.2 + 0.8 * rand(), // stagger so petals go one at a time
          shed: false,
          vel: new Vector3(),
          spin: new Vector3(),
          phase: rand() * Math.PI * 2,
        });
      }
    });
    this.retune();
  }

  /** Recompute per-bone spring constants from `physics`. Call after editing it. */
  retune() {
    const p = this.physics;
    for (const s of this.states) {
      let k: number, inertia: number, flex: number;
      switch (s.kind) {
        case "stem":
        case "head":
          k = p.stiffness * p.stiffnessFalloff ** s.index;
          inertia = p.mass * p.massFalloff ** s.index;
          flex = p.flexMax;
          break;
        case "petal":
          k = p.stiffness * 0.25 * p.stiffnessFalloff ** s.index;
          inertia = p.mass * 0.05 * p.massFalloff ** s.index;
          flex = p.flexMaxPetal;
          break;
        case "leaf":
          k = p.stiffness * 0.3 * p.stiffnessFalloff ** s.index;
          inertia = p.mass * 0.08 * p.massFalloff ** s.index;
          flex = p.flexMaxLeaf;
          break;
      }
      s.k = k;
      s.inertia = inertia;
      s.c = 2 * Math.sqrt(k * inertia) * p.damping;
      s.flex = flex;
      s.lever = (s.bone.children.find((ch) => ch instanceof Bone)?.position.length() ?? 0.3) * 0.5 * inertia;
    }
  }

  /** Synthetic shock (m/s^2 in flower space) held for `seconds`. For desktop testing. */
  kick(accel: Vector3, seconds = 0.12) {
    this.impulse.copy(accel);
    this.impulseTtl = seconds;
  }

  get petalsShed() {
    return this.petals.filter((p) => p.shed).length;
  }

  get petalCount() {
    return this.petals.length;
  }

  /** Reattach every shed petal. */
  resetPetals() {
    for (const pt of this.petals) {
      pt.hold = 0.2 + 0.8 * Math.random();
      if (!pt.shed) continue;
      pt.parent.add(pt.root);
      pt.root.position.copy(pt.bindPos);
      pt.root.quaternion.copy(pt.bindQuat);
      pt.root.visible = true;
      pt.shed = false;
    }
  }

  step(dtRaw: number) {
    const p = this.physics;
    const dt = Math.min(dtRaw, 1 / 20);
    const sub = dt / p.substeps;
    this.time += dt;

    const a = _v.copy(this.accel);
    if (this.impulseTtl > 0) {
      a.add(this.impulse);
      this.impulseTtl -= dt;
    }
    for (let i = 0; i < p.substeps; i++) {
      this.aFilt.lerp(a, 1 - p.shakeSmoothing);
      // g_world + shock, with the vertical-shock -> forward-buckle fudge on the stem
      const shockX = -this.aFilt.x * p.shakeGain * 10;
      const shockY = -this.aFilt.y * p.shakeGain * 10;
      const shockZ = -this.aFilt.z * p.shakeGain * 10;
      const gScale = p.gravity * p.gravityInfluence * p.gravityScale;
      for (const s of this.states) {
        const isStem = s.kind === "stem" || s.kind === "head";
        const gain = isStem ? 1 : p.petalShakeGain;
        _load.set(
          this.down.x * gScale + shockX * gain + (isStem ? shockY * p.bounceToBend : 0),
          this.down.y * gScale + shockY * gain,
          this.down.z * gScale + shockZ * gain,
        );
        _load.applyQuaternion(s.restWorldInv);
        // torque axis = boneY x load -> (load.z, 0, -load.x) in bone space
        _torque.set(_load.z, 0, -_load.x).multiplyScalar(s.lever);
        this.addWind(s, _torque);
        _torque.addScaledVector(s.theta, -s.k);
        _torque.addScaledVector(s.omega, -s.c);
        s.omega.addScaledVector(_torque, sub / s.inertia);
        s.theta.addScaledVector(s.omega, sub);
        const len = s.theta.length();
        if (len > s.flex) s.theta.multiplyScalar(s.flex / len);
      }
    }
    for (const s of this.states) {
      const ang = s.theta.length();
      if (ang > 1e-6) {
        _axis.copy(s.theta).divideScalar(ang);
        _q.setFromAxisAngle(_axis, ang);
        s.bone.quaternion.copy(s.bind).multiply(_q);
      } else {
        s.bone.quaternion.copy(s.bind);
      }
    }
    this.updateShedding(dt);
  }

  private addWind(s: BoneState, out: Vector3) {
    const p = this.physics;
    if (p.wind <= 0 && p.petalFlutter <= 0) return;
    const t = this.time;
    const f = p.windSpeed;
    let wx = Math.sin(2 * Math.PI * f * t + s.phase) * p.wind * 0.02;
    let wz = Math.cos(2 * Math.PI * f * 0.7 * t + s.phase * 1.3) * p.wind * 0.02;
    if (s.kind === "petal" && s.index === 1) {
      wx += Math.sin(2 * Math.PI * 3.1 * t + s.phase * 2) * p.petalFlutter * 0.02;
    }
    if (s.kind === "stem") {
      wx *= 0.3;
      wz *= 0.3;
    }
    out.x += wx;
    out.z += wz;
  }

  private updateShedding(dt: number) {
    const p = this.physics;
    const over = Math.max(0, this.aFilt.length() - p.shedThreshold);
    for (const pt of this.petals) {
      if (pt.shed) {
        this.floatPetal(pt, dt);
        continue;
      }
      if (p.shedRate <= 0) continue;
      pt.hold += (over > 0 ? -over * p.shedRate : p.shedRecover) * dt;
      pt.hold = Math.min(1, pt.hold);
      if (pt.hold <= 0) this.shed(pt);
    }
  }

  /** Shed petals drift like paper: weak gravity, drag, a wandering flutter,
   *  the device's own shocks, and a soft floor at the base of the stem. */
  private floatPetal(pt: Petal, dt: number) {
    const p = this.physics;
    const t = this.time;
    const pos = pt.root.position;
    pt.vel.y -= 9.8 * p.petalFloatGravity * dt;
    // flutter: slow figure-eight wander plus a faster side-to-side rock
    pt.vel.x += (Math.sin(0.9 * t + pt.phase) + 0.5 * Math.sin(2.7 * t + pt.phase * 2)) * p.petalFloatSway * dt;
    pt.vel.z += Math.cos(0.7 * t + pt.phase * 1.7) * p.petalFloatSway * 0.5 * dt;
    pt.vel.y += Math.abs(Math.sin(1.6 * t + pt.phase)) * p.petalFloatSway * 0.55 * dt; // lift on the rock, ~balances gravity
    // the phone's motion pushes loose petals around too
    pt.vel.addScaledVector(this.aFilt, -0.02 * dt);
    pt.vel.multiplyScalar(Math.max(0, 1 - p.petalFloatDrag * dt));
    pos.addScaledVector(pt.vel, dt);
    // soft floor at the base of the stem, soft walls a little beyond the frame
    if (pos.y < 0.1) {
      pos.y = 0.1;
      pt.vel.y = Math.abs(pt.vel.y) * 0.3;
      pt.vel.x *= 0.8;
      pt.vel.z *= 0.8;
    }
    if (pos.y > 5.5) pt.vel.y -= 2 * dt;
    if (Math.abs(pos.x) > 3.2) pt.vel.x -= Math.sign(pos.x) * 2 * dt;
    if (Math.abs(pos.z) > 1.5) pt.vel.z -= Math.sign(pos.z) * 2 * dt;
    // tumble, slowing with drag
    pt.spin.multiplyScalar(Math.max(0, 1 - 0.8 * dt));
    const w = pt.spin.length();
    if (w > 1e-4) {
      _q.setFromAxisAngle(_axis.copy(pt.spin).divideScalar(w), w * dt);
      pt.root.quaternion.premultiply(_q);
    }
  }

  private shed(pt: Petal) {
    pt.shed = true;
    // keep the world transform while moving the bone under the scene root
    const scene = this.sceneRoot(pt.root);
    scene.attach(pt.root);
    // launch away from the head along the petal's own direction, plus the shock
    const dir = new Vector3(0, 1, 0).applyQuaternion(pt.root.getWorldQuaternion(new Quaternion()));
    pt.vel.copy(dir).multiplyScalar(1.0).addScaledVector(this.aFilt, -0.04);
    pt.spin.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(5);
  }

  private sceneRoot(o: Object3D): Object3D {
    let r = o;
    while (r.parent) r = r.parent;
    return r;
  }
}
