import { describe, expect, it } from "vitest";
import { frameToCanvas, pointToCanvas } from "./detectionViewMath";

describe("frameToCanvas", () => {
  it("scales a box proportionally when canvas is a scaled-down frame", () => {
    const box = frameToCanvas([0, 0, 640, 480], [640, 480], [320, 240]);
    expect(box).toEqual([0, 0, 320, 240]);
  });

  it("scales axes independently when aspect ratios differ", () => {
    const box = frameToCanvas([100, 200, 300, 400], [1000, 1000], [500, 250]);
    expect(box).toEqual([50, 50, 150, 100]);
  });

  it("is the identity when canvas size equals frame size", () => {
    const box = frameToCanvas([10, 20, 30, 40], [320, 240], [320, 240]);
    expect(box).toEqual([10, 20, 30, 40]);
  });

  it("returns a zero box when frame size is degenerate", () => {
    expect(frameToCanvas([1, 2, 3, 4], [0, 0], [320, 240])).toEqual([0, 0, 0, 0]);
  });
});

describe("pointToCanvas", () => {
  it("scales a point proportionally", () => {
    expect(pointToCanvas([320, 240], [640, 480], [320, 240])).toEqual([160, 120]);
  });

  it("returns a zero point when frame size is degenerate", () => {
    expect(pointToCanvas([5, 5], [0, 10], [320, 240])).toEqual([0, 0]);
  });
});
