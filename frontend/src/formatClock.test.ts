import { describe, expect, it } from "vitest";
import { formatClock } from "./formatClock";

describe("formatClock", () => {
  it("formats midnight as 00:00:00.000", () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    expect(formatClock(d.getTime())).toBe("00:00:00.000");
  });

  it("pads hours, minutes, seconds, and milliseconds", () => {
    const d = new Date();
    d.setHours(1, 2, 3, 4);
    expect(formatClock(d.getTime())).toBe("01:02:03.004");
  });

  it("uses 24h time (no am/pm rollover) for an afternoon hour", () => {
    const d = new Date();
    d.setHours(13, 5, 9, 250);
    expect(formatClock(d.getTime())).toBe("13:05:09.250");
  });

  it("rolls milliseconds up to 999 without overflow", () => {
    const d = new Date();
    d.setHours(23, 59, 59, 999);
    expect(formatClock(d.getTime())).toBe("23:59:59.999");
  });
});
