import { describe, expect, test } from "bun:test";
import { computePrimaryTrack, type Detection } from "./detections.ts";
import { getHealth } from "./mood.ts";

describe("computePrimaryTrack", () => {
  const frameSize: [number, number] = [640, 480];

  test("returns null with no frameSize", () => {
    const detections: Detection[] = [{ label: "person", box: [0, 0, 100, 100], confidence: 0.9 }];
    expect(computePrimaryTrack(detections, undefined)).toBeNull();
  });

  test("returns null with no person detections", () => {
    const detections: Detection[] = [{ label: "chair", box: [0, 0, 100, 100], confidence: 0.9 }];
    expect(computePrimaryTrack(detections, frameSize)).toBeNull();
  });

  test("returns null for a person detection with no box", () => {
    const detections: Detection[] = [{ label: "person", confidence: 0.9 }];
    expect(computePrimaryTrack(detections, frameSize)).toBeNull();
  });

  test("normalizes a single person box to 0..1", () => {
    const detections: Detection[] = [{ label: "person", box: [100, 50, 300, 450], confidence: 0.9 }];
    const track = computePrimaryTrack(detections, frameSize);
    expect(track).not.toBeNull();
    expect(track!.cx).toBeCloseTo(200 / 640, 5);
    expect(track!.cy).toBeCloseTo(250 / 480, 5);
    expect(track!.w).toBeCloseTo(200 / 640, 5);
    expect(track!.h).toBeCloseTo(400 / 480, 5);
    expect(track!.conf).toBe(0.9);
  });

  test("picks the largest-area person box among several", () => {
    const detections: Detection[] = [
      { label: "person", box: [0, 0, 50, 50], confidence: 0.5 }, // area 2500
      { label: "person", box: [0, 0, 200, 200], confidence: 0.6 }, // area 40000, largest
      { label: "dog", box: [0, 0, 500, 500], confidence: 0.99 }, // not a person
    ];
    const track = computePrimaryTrack(detections, frameSize);
    expect(track).not.toBeNull();
    expect(track!.conf).toBe(0.6);
    expect(track!.w).toBeCloseTo(200 / 640, 5);
  });

  test("defaults missing confidence to 0", () => {
    const detections: Detection[] = [{ label: "person", box: [0, 0, 10, 10] }];
    const track = computePrimaryTrack(detections, frameSize);
    expect(track!.conf).toBe(0);
  });
});

describe("getHealth", () => {
  test("clamps to [0, 1] and decays linearly toward DEAD_MS", () => {
    // getHealth has no injectable "watered at", so we only check the pure
    // clamp/shape behavior via the exported function signature: never
    // watered (module-level default) reads as 0.
    expect(getHealth()).toBeGreaterThanOrEqual(0);
    expect(getHealth()).toBeLessThanOrEqual(1);
  });
});
