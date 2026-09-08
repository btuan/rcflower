import { DEG, upInDevice } from "./orientation";

export type TwistPhase = "idle" | "armed" | "fired";

export type TwistDirection = "ccw" | "cw" | "either";

export type TwistEvent = "twist" | "untwist" | "cancel";

export type TwistSample = { beta: number; gamma: number; t: number };

export type TwistOptions = {
  armRoll: number;
  /** Strict |u.z| threshold required to arm and to stay armed. */
  armFacing: number;
  /**
   * Lenient |u.z| threshold used once a pour is in progress ("fired"),
   * since pouring naturally tips the can/phone forward. Should be >=
   * armFacing. Hysteresis: strict to arm, lenient to keep pouring.
   */
  fireFacing: number;
  fireRoll: number;
  resetRoll: number;
  /**
   * If the gesture sits armed-but-idle this long without making
   * progress, the accumulator is quietly reset (no callback, no phase
   * change) rather than cancelling the gesture. See twistMachine.step.
   */
  maxMs: number;
  /** EMA smoothing factor applied to the per-event roll delta (0..1]. */
  smoothing: number;
  /** Which twist direction(s) count as "pouring". Default "ccw". */
  direction: TwistDirection;
};

export const DEFAULT_TWIST_OPTIONS: TwistOptions = {
  armRoll: 20,
  armFacing: 0.35,
  fireFacing: 0.7,
  fireRoll: 60,
  resetRoll: 25,
  maxMs: 1500,
  smoothing: 0.2,
  direction: "ccw",
};

export type TwistState = {
  phase: TwistPhase;
  /** Accumulated effective roll (degrees), sign-normalized per `direction`. */
  accum: number;
  progress: number;
  armedAt: number;
  /** Last raw (unsmoothed) gravity x/y, used to compute wrap-free deltas. */
  prevVec: { x: number; y: number } | null;
  /** Smoothed per-event delta (EMA), degrees. */
  smoothedDelta: number;
  /** Locked twist sign once direction === "either" and motion starts. */
  dirSign: number;
};

export const initialTwistState: TwistState = {
  phase: "idle",
  accum: 0,
  progress: 0,
  armedAt: 0,
  prevVec: null,
  smoothedDelta: 0,
  dirSign: 0,
};

export type StepResult = { state: TwistState; events: TwistEvent[] };

/**
 * Signed angle (degrees) from vector a to vector b about the z axis,
 * via atan2(cross, dot). This is wrap-free by construction (atan2's
 * range is (-180, 180]), unlike diffing two already-wrapped absolute
 * angles near +-180.
 */
function signedAngleBetween(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  // Our roll convention is atan2(x, y) (args swapped relative to the
  // usual atan2(y, x)), which measures angle clockwise from the y-axis
  // rather than the standard CCW-from-x-axis convention. So the sign of
  // the textbook 2D cross product (a.x*b.y - a.y*b.x) is inverted
  // relative to what we want here; swap the terms to match.
  const cross = a.y * b.x - a.x * b.y;
  const dot = a.x * b.x + a.y * b.y;
  return Math.atan2(cross, dot) / DEG;
}

/**
 * Pure state-machine step for the twist-to-pour gesture. No DOM, no React
 * — takes a device orientation sample and the previous state, returns the
 * next state plus any events fired.
 *
 * Roll math: `upInDevice` gives Earth's up vector in DEVICE coordinates
 * (beta/gamma are device-frame regardless of screen orientation, so this
 * does not need to change when we lock/counter-rotate the screen — see
 * useLockPortrait.tsx). Roll about the screen normal is derived from the
 * (x, y) projection of that up vector. Rather than smoothing that raw
 * vector and then computing an absolute angle (unstable near +-180 and
 * near "flat", and prone to shortestDelta spikes on the smoothed signal),
 * we compute the signed angle *between consecutive raw vectors* each
 * event (wrap-free by construction), smooth that small delta with an
 * EMA, and accumulate the smoothed deltas into `accum`.
 */
export function step(
  state: TwistState,
  sample: TwistSample,
  options: Partial<TwistOptions> = {},
): StepResult {
  const opts = { ...DEFAULT_TWIST_OPTIONS, ...options };
  const events: TwistEvent[] = [];

  const u = upInDevice(sample.beta, sample.gamma);
  const vec = { x: u.x, y: u.y };

  const prevVec = state.prevVec ?? vec;
  const rawDelta = signedAngleBetween(prevVec, vec);
  const smoothedDelta =
    state.smoothedDelta + opts.smoothing * (rawDelta - state.smoothedDelta);

  // Absolute roll, used only for the arm/reset thresholds (which check
  // "near zero", far from the +-180 wrap boundary, so wrap-around is not
  // a concern here).
  const roll = Math.atan2(vec.x, vec.y) / DEG;

  const facingStrict = Math.abs(u.z) < opts.armFacing;
  const facingLenient = Math.abs(u.z) < opts.fireFacing;

  let { phase, accum, armedAt, dirSign } = state;

  const applyDelta = (delta: number) => {
    if (opts.direction === "cw") return -delta;
    if (opts.direction === "either") {
      if (dirSign === 0 && Math.abs(delta) > 0.01) {
        dirSign = Math.sign(delta);
      }
      return dirSign === 0 ? delta : delta * dirSign;
    }
    return delta; // ccw (default): positive delta already means CCW.
  };

  switch (phase) {
    case "idle": {
      if (facingStrict && Math.abs(roll) < opts.armRoll) {
        accum = 0;
        dirSign = 0;
        armedAt = sample.t;
        phase = "armed";
      }
      break;
    }

    case "armed": {
      accum += applyDelta(smoothedDelta);
      if (accum > opts.fireRoll) {
        phase = "fired";
        events.push("twist");
      } else if (!facingStrict || accum < -opts.resetRoll) {
        // Abandoned before a pour ever started: silently reset, no
        // callback. A spurious/no-op cancel here previously fired a
        // watering POST every time the phone sat idle-upright.
        accum = 0;
        dirSign = 0;
        phase = "idle";
      } else if (sample.t - armedAt > opts.maxMs) {
        // No progress for a while: just reset the accumulator and stay
        // armed (quietly re-arm), rather than cancelling the gesture.
        accum = 0;
        dirSign = 0;
        armedAt = sample.t;
      }
      break;
    }

    case "fired": {
      accum += applyDelta(smoothedDelta);
      if (!facingLenient) {
        // A pour really was in progress, so this is a genuine cancel.
        accum = 0;
        dirSign = 0;
        phase = "idle";
        events.push("cancel");
      } else if (accum < opts.resetRoll) {
        accum = 0;
        dirSign = 0;
        phase = "idle";
        events.push("untwist");
      }
      break;
    }
  }

  const progress = Math.max(0, Math.min(1, accum / opts.fireRoll));

  return {
    state: {
      phase,
      accum,
      progress,
      armedAt,
      prevVec: vec,
      smoothedDelta,
      dirSign,
    },
    events,
  };
}
