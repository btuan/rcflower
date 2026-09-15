/**
 * Pure helpers for the /live page (frontend/src/FlowerLive.tsx). Kept
 * side-effect free so they can be unit tested without a DOM or three.js.
 */
import type { Physics } from "./flowerSpring";

export type Mood = "neutral" | "happy" | "sad" | "dead";

/**
 * The mood used to pick the GLB / PRESET_PHYSICS. Swapping into the `dead`
 * model reads as jarring on /live, so `dead` renders as the `neutral` model
 * at max droop (health is 0 when dead anyway, which already drives the
 * droop path to full droop). Only happy/neutral/sad swap models. The real
 * mood is still shown in the `?debug=1` overlay.
 */
export function displayMoodFor(mood: Mood): Mood {
  return mood === "dead" ? "neutral" : mood;
}

/**
 * Target yaw (radians) for the flower's root rotation, driven by a tracked
 * person's horizontal position in the camera frame (`cx`, 0..1, 0 = left
 * edge of the camera image).
 *
 * By default (mirror=false) a person on the camera's right (cx > 0.5) turns
 * the flower to the viewer's right, i.e. a positive yaw. `?mirror=1` flips
 * this for setups where the camera faces the same way as the display.
 */
export function yawTarget(cx: number, mirror: boolean, maxYaw: number): number {
  const sign = mirror ? -1 : 1;
  const t = (cx - 0.5) * 2 * sign;
  return Math.max(-maxYaw, Math.min(maxYaw, t * maxYaw));
}

export type YawSpringState = { yaw: number; vel: number };

export type YawSpringParams = {
  /** Spring stiffness (rad/s^2 per rad of error). */
  k: number;
  /** Velocity damping coefficient (1/s). */
  c: number;
};

/**
 * Damped-spring integrator for the flower's yaw follow. Slightly
 * under-damped (see DEFAULT_YAW_SPRING_PARAMS) so a person moving across
 * frame produces a smooth turn with a small settle, not a snap.
 *
 * A tiny deadband snaps to the target (and zeroes velocity) once the flower
 * is essentially there and barely moving, to avoid perpetual micro-jitter
 * from floating point noise.
 */
const YAW_DEADBAND_RAD = (0.5 * Math.PI) / 180;
const YAW_DEADBAND_VEL = 0.01; // rad/s

export function stepYawSpring(
  state: YawSpringState,
  target: number,
  dt: number,
  params: YawSpringParams,
): YawSpringState {
  const error = target - state.yaw;
  if (Math.abs(error) < YAW_DEADBAND_RAD && Math.abs(state.vel) < YAW_DEADBAND_VEL) {
    return { yaw: target, vel: 0 };
  }
  if (dt <= 0) return { yaw: state.yaw, vel: state.vel };
  const accel = params.k * error - params.c * state.vel;
  const vel = state.vel + accel * dt;
  const yaw = state.yaw + vel * dt;
  return { yaw, vel };
}

/** Natural period ~0.9s, damping ratio ~0.7 (slightly under-damped). */
export const DEFAULT_YAW_SPRING_PARAMS: YawSpringParams = (() => {
  const period = 0.9; // seconds
  const zeta = 0.7;
  const omegaN = (2 * Math.PI) / period;
  return { k: omegaN * omegaN, c: 2 * zeta * omegaN };
})();

export type Droop = {
  gravityInfluence: number;
  stiffness: number;
  tiltRad: number;
};

/** Health floor: how limp the flower gets by health === 0. */
const DROOP_MIN_GRAVITY_INFLUENCE = 0.45;
const DROOP_MIN_STIFFNESS_FRAC = 0.6;
const DROOP_MAX_TILT_RAD = (35 * Math.PI) / 180;

/**
 * Continuous droop derived from `health` (0..1, 1 = just watered) layered
 * on top of a mood preset. At health 1 this returns the preset's own
 * values unchanged; as health falls to 0, gravityInfluence rises toward
 * ~0.45, stiffness falls toward ~60% of the preset value, and tiltRad
 * (how far the spring's `down` vector leans away from straight down)
 * grows toward ~35°.
 */
export function droopFor(health: number, preset: Pick<Physics, "gravityInfluence" | "stiffness">): Droop {
  const h = Math.max(0, Math.min(1, health));
  const droop = 1 - h;
  const gravityInfluence =
    preset.gravityInfluence + (DROOP_MIN_GRAVITY_INFLUENCE - preset.gravityInfluence) * droop;
  const stiffness = preset.stiffness * (1 - (1 - DROOP_MIN_STIFFNESS_FRAC) * droop);
  const tiltRad = DROOP_MAX_TILT_RAD * droop;
  return { gravityInfluence, stiffness, tiltRad };
}
