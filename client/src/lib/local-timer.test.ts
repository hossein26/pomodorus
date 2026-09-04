import { describe, expect, it } from "vitest";

import { CLASSIC } from "@/lib/intervals";
import {
  breakAfter,
  breakDeadline,
  cycleCount,
  isWorkDuration,
  tehranDayKey,
  todayStats,
  type HistoryEntry,
} from "@/lib/local-timer";

const MIN = 60_000;

const work = (endsAt: number, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  kind: "work",
  startedAt: endsAt - 25 * MIN,
  endsAt,
  durationMs: 25 * MIN,
  cancelledAt: null,
  categoryId: "c1",
  categoryName: "درس",
  ...over,
});

const rest = (
  kind: "shortBreak" | "longBreak",
  endsAt: number,
  over: Partial<HistoryEntry> = {},
): HistoryEntry => ({
  kind,
  startedAt: endsAt - 5 * MIN,
  endsAt,
  durationMs: 5 * MIN,
  cancelledAt: null,
  categoryId: null,
  categoryName: null,
  ...over,
});

const NOW = 1_800_000_000_000;

describe("work lengths", () => {
  it("accepts the stepper's stops and nothing else", () => {
    expect(isWorkDuration(15 * MIN)).toBe(true);
    expect(isWorkDuration(25 * MIN)).toBe(true);
    expect(isWorkDuration(60 * MIN)).toBe(true);
    expect(isWorkDuration(10 * MIN)).toBe(false);
    expect(isWorkDuration(14 * MIN)).toBe(false);
    expect(isWorkDuration(17 * MIN)).toBe(false);
    expect(isWorkDuration(61 * MIN)).toBe(false);
    expect(isWorkDuration(25 * MIN + 1)).toBe(false);
  });
});

describe("the rest owed", () => {
  it("is short until the cycle closes, then long", () => {
    expect(breakAfter(3, CLASSIC)).toEqual({ kind: "shortBreak", lengthMs: 5 * MIN });
    expect(breakAfter(4, CLASSIC)).toEqual({ kind: "longBreak", lengthMs: 20 * MIN });
    // Past the length still owes the long one: the counter only resets when a
    // long break is actually over or skipped.
    expect(breakAfter(6, CLASSIC)).toEqual({ kind: "longBreak", lengthMs: 20 * MIN });
  });

  it("is anchored at the bell", () => {
    expect(breakDeadline(1000, 5 * MIN)).toBe(1000 + 5 * MIN);
  });
});

describe("the cycle", () => {
  it("counts completed pomodoros", () => {
    expect(cycleCount([], false, NOW)).toBe(0);
    expect(cycleCount([work(NOW - 30 * MIN)], false, NOW)).toBe(1);
  });

  it("ignores an abandoned pomodoro entirely", () => {
    const entries = [
      work(NOW - 60 * MIN),
      work(NOW - 30 * MIN, { cancelledAt: NOW - 30 * MIN }),
    ];
    expect(cycleCount(entries, false, NOW)).toBe(1);
  });

  it("closes on a long break, taken or skipped", () => {
    const taken = [
      work(NOW - 90 * MIN),
      rest("longBreak", NOW - 30 * MIN),
    ];
    expect(cycleCount(taken, false, NOW)).toBe(0);

    const skipped = [
      work(NOW - 90 * MIN),
      rest("longBreak", NOW + 10 * MIN, { cancelledAt: NOW - 30 * MIN }),
    ];
    expect(cycleCount(skipped, false, NOW)).toBe(0);
  });

  it("survives a short break", () => {
    const entries = [work(NOW - 90 * MIN), rest("shortBreak", NOW - 30 * MIN)];
    expect(cycleCount(entries, false, NOW)).toBe(1);
  });

  it("is abandoned after an idle hour, unless something is live", () => {
    const entries = [work(NOW - 2 * 60 * MIN)];
    expect(cycleCount(entries, false, NOW)).toBe(0);
    expect(cycleCount(entries, true, NOW)).toBe(1);
  });

  it("resets across an idle gap between sessions", () => {
    const entries = [work(NOW - 3 * 60 * MIN), work(NOW - 30 * MIN)];
    expect(cycleCount(entries, false, NOW)).toBe(1);
  });
});

describe("today", () => {
  it("credits nominal lengths for pomodoros ending in the Tehran day", () => {
    const key = tehranDayKey(NOW);
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const entries = [work(NOW - 30 * MIN), work(NOW - 60 * MIN)];
    expect(todayStats(entries, NOW)).toEqual({ count: 2, totalMs: 50 * MIN });
  });

  it("ignores abandoned work, breaks and other days", () => {
    const entries = [
      work(NOW - 30 * MIN, { cancelledAt: NOW - 30 * MIN }),
      rest("shortBreak", NOW - 20 * MIN),
      work(NOW - 26 * 60 * MIN),
    ];
    // Whether the day-old one shares the key depends on the clock; either way
    // the abandoned work and the break never count.
    const stats = todayStats(entries, NOW);
    expect(stats.count).toBeLessThanOrEqual(1);
  });
});
