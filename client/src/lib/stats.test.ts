import { beforeEach, describe, expect, it } from "vitest";

import { KEYS } from "@/lib/local-store";
import type { HistoryEntry } from "@/lib/local-timer";
import {
  buildDays,
  everFocused,
  selectDay,
} from "@/lib/stats";

const MIN = 60_000;
const NOW = 1_800_000_000_000;

const work = (endsAt: number, name: string | null = "درس"): HistoryEntry => ({
  kind: "work",
  startedAt: endsAt - 25 * MIN,
  endsAt,
  durationMs: 25 * MIN,
  cancelledAt: null,
  categoryId: "c1",
  categoryName: name,
});

function seedHistory(entries: HistoryEntry[]) {
  localStorage.setItem(KEYS.history, JSON.stringify(entries));
}

beforeEach(() => {
  localStorage.clear();
});

describe("the record", () => {
  it("zero-fills the range ending today", () => {
    seedHistory([]);
    const days = buildDays(7, NOW);
    expect(days).toHaveLength(7);
    expect(days.every((d) => d.totalMs === 0 && d.tasks.length === 0)).toBe(true);
    // Oldest first.
    expect(days[0]!.day < days[6]!.day).toBe(true);
  });

  it("aggregates what was credited, largest task first", () => {
    seedHistory([
      work(NOW - 30 * MIN, "ریاضی"),
      work(NOW - 60 * MIN, "درس"),
      work(NOW - 90 * MIN, "درس"),
    ]);
    const days = buildDays(7, NOW);
    const today = days[days.length - 1]!;
    expect(today.totalMs).toBe(75 * MIN);
    expect(today.tasks.map((t) => t.name)).toEqual(["درس", "ریاضی"]);
  });

  it("ignores abandoned work and breaks", () => {
    seedHistory([
      { ...work(NOW - 30 * MIN), cancelledAt: NOW - 30 * MIN },
      {
        kind: "shortBreak",
        startedAt: NOW - 40 * MIN,
        endsAt: NOW - 35 * MIN,
        durationMs: 5 * MIN,
        cancelledAt: null,
        categoryId: null,
        categoryName: null,
      },
    ]);
    const days = buildDays(7, NOW);
    expect(days[days.length - 1]!.totalMs).toBe(0);
  });

  it("knows whether anything was ever credited", () => {
    seedHistory([]);
    expect(everFocused()).toBe(false);
    seedHistory([work(NOW - 30 * MIN)]);
    expect(everFocused()).toBe(true);
  });
});

describe("selecting a day", () => {
  it("opens on the most recent day with anything in it", () => {
    seedHistory([work(NOW - 30 * MIN)]);
    const days = buildDays(7, NOW);
    const selected = selectDay(days, null);
    expect(selected?.detail?.totalMs).toBe(25 * MIN);
  });

  it("lets pointing win while it lands inside the range", () => {
    seedHistory([work(NOW - 30 * MIN), work(NOW - 26 * 60 * MIN)]);
    const days = buildDays(7, NOW);
    const older = days[days.length - 2]!.day;
    expect(selectDay(days, older)?.day).toBe(older);
  });

  it("falls back to the latest when pointing leaves the range", () => {
    seedHistory([work(NOW - 30 * MIN)]);
    const days = buildDays(7, NOW);
    const selected = selectDay(days, "1300-01-01");
    expect(selected?.detail?.totalMs).toBe(25 * MIN);
  });

  it("marks nothing when the whole range is flat", () => {
    seedHistory([]);
    expect(selectDay(buildDays(7, NOW), null)).toBeNull();
  });
});
