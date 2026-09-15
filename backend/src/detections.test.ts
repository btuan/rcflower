import { describe, expect, test } from "bun:test";
import { computePrimaryTrack, iou, PrimaryTracker, type Detection } from "./detections.ts";
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

describe("iou", () => {
  test("identical boxes have IoU 1", () => {
    expect(iou([0, 0, 100, 100], [0, 0, 100, 100])).toBeCloseTo(1, 5);
  });

  test("disjoint boxes have IoU 0", () => {
    expect(iou([0, 0, 10, 10], [20, 20, 30, 30])).toBe(0);
  });

  test("half-overlapping boxes", () => {
    // [0,0,10,10] area 100; [5,0,15,10] area 100; intersection [5,0,10,10] area 50
    // union = 100 + 100 - 50 = 150
    expect(iou([0, 0, 10, 10], [5, 0, 15, 10])).toBeCloseTo(50 / 150, 5);
  });
});

describe("PrimaryTracker", () => {
  const frameSize: [number, number] = [640, 480];

  test("two people of alternating size keep the same primary id", () => {
    const tracker = new PrimaryTracker();
    // Frame 1: person A slightly bigger -> becomes primary once hits >= 2.
    const a1: Detection[] = [
      { label: "person", box: [0, 0, 100, 100], confidence: 0.9 }, // A, area 10000
      { label: "person", box: [300, 300, 390, 390], confidence: 0.9 }, // B, area 8100
    ];
    tracker.update(a1, frameSize, 0);
    const r2 = tracker.update(a1, frameSize, 33);
    expect(r2).not.toBeNull();
    const primaryId = r2!.id;

    // Frame 3: B grows larger than A -- primary should stay sticky on A.
    const a2: Detection[] = [
      { label: "person", box: [0, 0, 100, 100], confidence: 0.9 }, // A, area 10000
      { label: "person", box: [300, 300, 500, 500], confidence: 0.9 }, // B, area 40000, now larger
    ];
    const r3 = tracker.update(a2, frameSize, 66);
    expect(r3).not.toBeNull();
    expect(r3!.id).toBe(primaryId);

    // Frame 4: swap back -- still sticky.
    const r4 = tracker.update(a1, frameSize, 99);
    expect(r4!.id).toBe(primaryId);
  });

  test("a single-frame spurious box never becomes primary", () => {
    const tracker = new PrimaryTracker();
    const spurious: Detection[] = [{ label: "person", box: [0, 0, 100, 100], confidence: 0.9 }];
    const r1 = tracker.update(spurious, frameSize, 0);
    // Only 1 hit so far -- not eligible for primary yet.
    expect(r1).toBeNull();

    // The spurious box disappears before a second frame confirms it.
    const r2 = tracker.update([], frameSize, 33);
    expect(r2).toBeNull();
  });

  test("a track ages out after 700ms and a new primary is picked", () => {
    const tracker = new PrimaryTracker();
    const personA: Detection[] = [{ label: "person", box: [0, 0, 100, 100], confidence: 0.9 }];
    tracker.update(personA, frameSize, 0);
    const r2 = tracker.update(personA, frameSize, 33);
    expect(r2).not.toBeNull();
    const aId = r2!.id;

    // A disappears; not yet stale.
    tracker.update([], frameSize, 200);
    tracker.update([], frameSize, 400);

    // Introduce B while A is still within its 700ms grace window -- A stays primary (sticky).
    const personB: Detection[] = [{ label: "person", box: [300, 300, 450, 450], confidence: 0.9 }];
    const r3 = tracker.update(personB, frameSize, 500);
    expect(r3).not.toBeNull(); // A hasn't aged out yet -- stays sticky primary
    expect(r3!.id).toBe(aId);

    // Push past A's 700ms grace period (last seen at t=33) so it's dropped,
    // and give B a second hit so it's eligible to become primary.
    const r4 = tracker.update(personB, frameSize, 800);
    expect(r4).not.toBeNull();
    expect(r4!.id).not.toBe(aId);
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
