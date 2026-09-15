import { describe, expect, it } from "vitest";
import { droopFor, yawTarget } from "./flowerLiveMath";

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
