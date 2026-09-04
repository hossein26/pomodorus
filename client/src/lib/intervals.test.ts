import { describe, expect, it } from "vitest";

import { CLASSIC, validIntervals } from "@/lib/intervals";

const MIN = 60_000;

describe("intervals", () => {
  it("accepts the classic technique", () => {
    expect(validIntervals(CLASSIC)).toBe(true);
  });

  it("refuses anything outside the bands", () => {
    expect(validIntervals({ ...CLASSIC, shortBreakMs: 2 * MIN })).toBe(false);
    expect(validIntervals({ ...CLASSIC, shortBreakMs: 16 * MIN })).toBe(false);
    expect(validIntervals({ ...CLASSIC, longBreakMs: 5 * MIN })).toBe(false);
    expect(validIntervals({ ...CLASSIC, longBreakMs: 40 * MIN })).toBe(false);
    // Off the step: the long break moves in fives.
    expect(validIntervals({ ...CLASSIC, longBreakMs: 12 * MIN })).toBe(false);
    expect(validIntervals({ ...CLASSIC, perCycle: 1 })).toBe(false);
    expect(validIntervals({ ...CLASSIC, perCycle: 7 })).toBe(false);
  });
});
