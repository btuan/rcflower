import { describe, expect, it } from "vitest";
import {
  DEFAULT_YAW_SPRING_PARAMS,
  displayMoodFor,
  droopFor,
  stepYawSpring,
  yawTarget,
  type YawSpringState,
} from "./flowerLiveMath";

const MAX_YAW = (35 * Math.PI) / 180;

describe("yawTarget", () => {
  it("is 0 when the person is centered", () => {
    expect(yawTarget(0.5, false, MAX_YAW)).toBeCloseTo(0);
  });

  it("turns positive (viewer's right) when the person is on the camera's right, unmirrored", () => {
    expect(yawTarget(1, false, MAX_YAW)).toBeCloseTo(MAX_YAW);
    expect(yawTarget(0, false, MAX_YAW)).toBeCloseTo(-MAX_YAW);
  });

  it("flips sign when mirrored", () => {
    expect(yawTarget(1, true, MAX_YAW)).toBeCloseTo(-MAX_YAW);
    expect(yawTarget(0, true, MAX_YAW)).toBeCloseTo(MAX_YAW);
  });

  it("is monotonic in cx", () => {
    const xs = [0, 0.2, 0.4, 0.5, 0.6, 0.8, 1];
    const ys = xs.map((x) => yawTarget(x, false, MAX_YAW));
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1]);
    }
  });

  it("clamps to +-maxYaw even outside 0..1", () => {
    expect(yawTarget(2, false, MAX_YAW)).toBeCloseTo(MAX_YAW);
    expect(yawTarget(-2, false, MAX_YAW)).toBeCloseTo(-MAX_YAW);
  });
});

describe("droopFor", () => {
  const preset = { gravityInfluence: 0.15, stiffness: 40 };

  it("returns the preset unchanged at health = 1 (no droop, no tilt)", () => {
    const d = droopFor(1, preset);
    expect(d.gravityInfluence).toBeCloseTo(preset.gravityInfluence);
    expect(d.stiffness).toBeCloseTo(preset.stiffness);
    expect(d.tiltRad).toBeCloseTo(0);
  });

  it("droops toward the floor values at health = 0", () => {
    const d = droopFor(0, preset);
    expect(d.gravityInfluence).toBeCloseTo(0.45);
    expect(d.stiffness).toBeCloseTo(preset.stiffness * 0.6);
    expect(d.tiltRad).toBeCloseTo((35 * Math.PI) / 180);
  });

  it("gravityInfluence increases and stiffness decreases monotonically as health falls", () => {
    const hs = [1, 0.75, 0.5, 0.25, 0];
    const gis = hs.map((h) => droopFor(h, preset).gravityInfluence);
    const stiffs = hs.map((h) => droopFor(h, preset).stiffness);
    const tilts = hs.map((h) => droopFor(h, preset).tiltRad);
    for (let i = 1; i < hs.length; i++) {
      expect(gis[i]).toBeGreaterThanOrEqual(gis[i - 1]);
      expect(stiffs[i]).toBeLessThanOrEqual(stiffs[i - 1]);
      expect(tilts[i]).toBeGreaterThanOrEqual(tilts[i - 1]);
    }
  });

  it("clamps health outside 0..1", () => {
    expect(droopFor(2, preset)).toEqual(droopFor(1, preset));
    expect(droopFor(-1, preset)).toEqual(droopFor(0, preset));
  });
});

describe("stepYawSpring", () => {
  const params = DEFAULT_YAW_SPRING_PARAMS;

  function simulate(target: number, steps: number, dt: number): YawSpringState[] {
    let state: YawSpringState = { yaw: 0, vel: 0 };
    const history: YawSpringState[] = [state];
    for (let i = 0; i < steps; i++) {
      state = stepYawSpring(state, target, dt, params);
      history.push(state);
    }
    return history;
  }

  it("converges to the target", () => {
    const history = simulate(MAX_YAW, 2000, 1 / 60);
    const last = history[history.length - 1];
    expect(last.yaw).toBeCloseTo(MAX_YAW, 3);
    expect(last.vel).toBeCloseTo(0, 3);
  });

  it("overshoots slightly at damping ratio 0.7", () => {
    const history = simulate(1, 600, 1 / 60);
    const maxYaw = Math.max(...history.map((s) => s.yaw));
    expect(maxYaw).toBeGreaterThan(1);
    // A reasonable overshoot for zeta=0.7, not a wild oscillation.
    expect(maxYaw).toBeLessThan(1.1);
  });

  it("stays put when already at target with zero velocity", () => {
    const state: YawSpringState = { yaw: 0.3, vel: 0 };
    const next = stepYawSpring(state, 0.3, 1 / 60, params);
    expect(next.yaw).toBeCloseTo(0.3, 6);
    expect(next.vel).toBeCloseTo(0, 6);
  });

  it("produces no NaN for dt = 0", () => {
    const state: YawSpringState = { yaw: 0.1, vel: 0.2 };
    const next = stepYawSpring(state, 0.5, 0, params);
    expect(Number.isNaN(next.yaw)).toBe(false);
    expect(Number.isNaN(next.vel)).toBe(false);
  });

  it("snaps and zeroes velocity inside the deadband", () => {
    const almostThere = { yaw: 0.29999, vel: 0.0001 };
    const next = stepYawSpring(almostThere, 0.3, 1 / 60, params);
    expect(next.yaw).toBe(0.3);
    expect(next.vel).toBe(0);
  });
});

describe("displayMoodFor", () => {
  it("maps dead to neutral", () => {
    expect(displayMoodFor("dead")).toBe("neutral");
  });

  it("passes happy, neutral, and sad through unchanged", () => {
    expect(displayMoodFor("happy")).toBe("happy");
    expect(displayMoodFor("neutral")).toBe("neutral");
    expect(displayMoodFor("sad")).toBe("sad");
  });
});
