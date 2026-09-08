import { describe, expect, it } from "vitest";
import {
  DEFAULT_TWIST_OPTIONS,
  initialTwistState,
  step,
  type TwistEvent,
  type TwistOptions,
  type TwistState,
} from "./twistMachine";

/**
 * Synthetic device-orientation generator.
 *
 * With gamma held at 90deg, upInDevice(beta, gamma) always has u.z === 0
 * (perfectly "facing") and beta = 90 + theta produces roll === theta
 * exactly (see derivation in twistMachine.ts's docstring / this file's
 * comments). `tipDeg` pulls gamma away from 90 to introduce a controlled
 * amount of "facing" drift (u.z != 0), simulating the phone tipping
 * forward as a real pour would.
 */
function sampleAt(theta: number, t: number, tipDeg = 0) {
  return { beta: 90 + theta, gamma: 90 - tipDeg, t };
}

function run(
  thetas: Array<{ theta: number; t: number; tipDeg?: number }>,
  options: Partial<TwistOptions> = {},
) {
  let state: TwistState = initialTwistState;
  const events: TwistEvent[] = [];
  const phases: TwistState["phase"][] = [];
  for (const { theta, t, tipDeg } of thetas) {
    const result = step(state, sampleAt(theta, t, tipDeg), options);
    state = result.state;
    events.push(...result.events);
    phases.push(state.phase);
  }
  return { state, events, phases };
}

/** theta ramp from `from` to `to` over `ms`, one sample per `stepMs`. */
function ramp(
  from: number,
  to: number,
  ms: number,
  stepMs = 16,
  tipFrom = 0,
  tipTo = 0,
) {
  const out: Array<{ theta: number; t: number; tipDeg: number }> = [];
  const n = Math.max(1, Math.round(ms / stepMs));
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    out.push({
      theta: from + (to - from) * f,
      t: i * stepMs,
      tipDeg: tipFrom + (tipTo - tipFrom) * f,
    });
  }
  return out;
}

describe("twistMachine.step", () => {
  it("fires a normal pour: arm -> twist -> fire -> untwist", () => {
    const samples = [
      ...ramp(0, 0, 200), // sit upright for a bit to arm
      ...ramp(0, 80, 800), // twist CCW past fireRoll (60)
      ...ramp(80, 0, 800), // twist back
    ];
    const { events, phases } = run(samples);

    expect(phases).toContain("armed");
    expect(phases).toContain("fired");
    expect(events.filter((e) => e === "twist")).toHaveLength(1);
    expect(events.filter((e) => e === "untwist")).toHaveLength(1);
    expect(events).not.toContain("cancel");
  });

  it("survives a forward tip mid-pour (does not cancel the pour)", () => {
    const samples = [
      ...ramp(0, 0, 100), // arm perfectly facing
      // Twist to fire while still perfectly facing.
      ...ramp(0, 70, 300),
      // Now tip forward substantially while continuing to hold the pour.
      // |u.z| during this segment comfortably exceeds the old single
      // 0.35 threshold, which used to spuriously cancel the pour.
      ...ramp(70, 70, 400, 16, 0, 40),
      // Twist back to stop, still tipped somewhat.
      ...ramp(70, 0, 400, 16, 40, 40),
    ];
    const { events } = run(samples);

    expect(events.filter((e) => e === "twist")).toHaveLength(1);
    expect(events).not.toContain("cancel");
    expect(events.filter((e) => e === "untwist")).toHaveLength(1);
  });

  it("cancels a genuine mid-pour pose loss (fired -> facing lost)", () => {
    const samples = [
      ...ramp(0, 0, 100),
      ...ramp(0, 70, 300), // fires
      // Tip so far forward it exceeds even the lenient fireFacing (0.7).
      ...ramp(70, 70, 200, 16, 0, 80),
    ];
    const { events } = run(samples);

    expect(events.filter((e) => e === "twist")).toHaveLength(1);
    expect(events.filter((e) => e === "cancel")).toHaveLength(1);
    expect(events).not.toContain("untwist");
  });

  it("holding upright for 5s produces zero cancel/pour callbacks", () => {
    // This is the regression test for the spurious-POST bug: sitting
    // facing-and-upright (armed) for a long time used to trip the
    // `now - armedAt > maxMs` branch repeatedly and fire onCancel every
    // ~1.5s. It must now stay silent indefinitely.
    const samples = ramp(0, 0, 5000, 20);
    const { events, state } = run(samples);

    expect(events).toHaveLength(0);
    expect(state.phase).toBe("armed");
  });

  it("idle (not facing/upright) for a long time also produces no events", () => {
    const samples = ramp(90, 90, 5000, 20); // roll 90deg, well past armRoll
    const { events, state } = run(samples);

    expect(events).toHaveLength(0);
    expect(state.phase).toBe("idle");
  });

  it("abandoning an armed twist before firing resets silently (no cancel)", () => {
    const samples = [
      ...ramp(0, 0, 100),
      ...ramp(0, 30, 300), // twist partway, not enough to fire
      ...ramp(30, 0, 300), // let it settle back down without firing
    ];
    const { events } = run(samples);
    expect(events).not.toContain("cancel");
  });

  it("handles roll sweeping through +-180 without spurious events or NaN", () => {
    const samples = ramp(170, 190, 2000, 16); // roll crosses the wrap boundary
    const { events, state } = run(samples);

    expect(events).toHaveLength(0);
    expect(Number.isFinite(state.accum)).toBe(true);
    expect(Number.isFinite(state.progress)).toBe(true);
    expect(state.phase).toBe("idle"); // roll here is always >> armRoll
  });

  it("computes small per-step deltas across the wrap boundary (no 360deg spikes)", () => {
    let state: TwistState = initialTwistState;
    const samples = ramp(175, 185, 500, 10);
    let maxJump = 0;
    let prevAccum = 0;
    for (const s of samples) {
      const result = step(state, sampleAt(s.theta, s.t, s.tipDeg));
      state = result.state;
      maxJump = Math.max(maxJump, Math.abs(state.accum - prevAccum));
      prevAccum = state.accum;
    }
    // A shortestDelta-on-smoothed-signal bug would spike by ~180-360deg
    // near the wrap; a correct wrap-free delta stays tiny per 10ms step.
    expect(maxJump).toBeLessThan(20);
  });

  it("direction: cw twist does not fire by default (ccw only)", () => {
    const samples = [...ramp(0, 0, 100), ...ramp(0, -80, 800)];
    const { events } = run(samples);
    expect(events).not.toContain("twist");
  });

  it("direction: cw option fires on a clockwise twist", () => {
    const samples = [...ramp(0, 0, 100), ...ramp(0, -80, 800)];
    const { events } = run(samples, { direction: "cw" });
    expect(events.filter((e) => e === "twist")).toHaveLength(1);
  });

  it("direction: either fires on twists in either direction", () => {
    const ccw = run([...ramp(0, 0, 100), ...ramp(0, 80, 800)], {
      direction: "either",
    });
    const cw = run([...ramp(0, 0, 100), ...ramp(0, -80, 800)], {
      direction: "either",
    });
    expect(ccw.events.filter((e) => e === "twist")).toHaveLength(1);
    expect(cw.events.filter((e) => e === "twist")).toHaveLength(1);
  });

  it("uses the documented defaults", () => {
    expect(DEFAULT_TWIST_OPTIONS.armRoll).toBe(20);
    expect(DEFAULT_TWIST_OPTIONS.fireRoll).toBe(60);
    expect(DEFAULT_TWIST_OPTIONS.resetRoll).toBe(25);
    expect(DEFAULT_TWIST_OPTIONS.direction).toBe("ccw");
  });
});
