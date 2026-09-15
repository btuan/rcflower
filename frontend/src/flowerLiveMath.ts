/**
 * Pure helpers for the /live page (frontend/src/FlowerLive.tsx). Kept
 * side-effect free so they can be unit tested without a DOM or three.js.
 */
import type { Physics } from "./flowerSpring";

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
