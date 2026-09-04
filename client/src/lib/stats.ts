/**
 * Your own record: focus time per Tehran day, read off this device's history.
 *
 * There is nobody to ask — the days are already over and do not change while
 * you look at them, so they are aggregated synchronously from storage. The
 * chart shapes are the same ones the public profile used to draw, because the
 * line does not care where its columns came from.
 */

import { KEYS, read } from "@/lib/local-store";
import { tehranDayKey, type HistoryEntry } from "@/lib/local-timer";

/**
 * One row of a day's detail.
 *
 * `name` is null for work recorded against no task at all. Everything here is
 * yours, so there is no masking and no private bucket — only the nameless row.
 */
export type DayTask = {
  kind: "task" | "private" | "none";
  name: string | null;
  totalMs: number;
};

/** One column: a Tehran day, what was credited in it, and what of. */
export type ChartDay = {
  /** `YYYY-MM-DD` in Tehran. A day is a name, not an instant. */
  day: string;
  totalMs: number;
  /** Largest first, and empty on a day with nothing in it. */
  tasks: DayTask[];
};

/** The three presets. There is no custom picker, by design. */
export const RANGES = [7, 30, 90] as const;
export type Range = (typeof RANGES)[number];
export const DEFAULT_RANGE: Range = 7;

const isHistoryEntry = (v: unknown): v is HistoryEntry => {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    (e.kind === "work" || e.kind === "shortBreak" || e.kind === "longBreak") &&
    typeof e.startedAt === "number" &&
    typeof e.endsAt === "number" &&
    typeof e.durationMs === "number" &&
    (e.cancelledAt === null || typeof e.cancelledAt === "number") &&
    (e.categoryId === null || typeof e.categoryId === "string") &&
    (e.categoryName === null || typeof e.categoryName === "string")
  );
};

const isHistory = (v: unknown): v is HistoryEntry[] =>
  Array.isArray(v) && v.every(isHistoryEntry);

function loadHistory(): HistoryEntry[] {
  return read(KEYS.history, isHistory) ?? [];
}

/**
 * The range ending today, oldest first and zero-filled: a week off is a flat
 * line, and drawing it is the whole reason the days are zero-filled. Work is
 * credited at its nominal end, at its full nominal length.
 */
export function buildDays(range: Range, at = Date.now()): ChartDay[] {
  const entries = loadHistory();
  const byDay = new Map<string, { totalMs: number; tasks: Map<string, number> }>();

  for (const e of entries) {
    if (e.kind !== "work" || e.cancelledAt !== null) continue;
    if (e.endsAt > at) continue;
    const key = tehranDayKey(e.endsAt);
    let day = byDay.get(key);
    if (!day) {
      day = { totalMs: 0, tasks: new Map() };
      byDay.set(key, day);
    }
    day.totalMs += e.durationMs;
    const name = e.categoryName ?? "";
    day.tasks.set(name, (day.tasks.get(name) ?? 0) + e.durationMs);
  }

  const todayKey = tehranDayKey(at);
  const days: ChartDay[] = [];
  for (let back = range - 1; back >= 0; back--) {
    const key = shiftDay(todayKey, -back);
    const found = byDay.get(key);
    const tasks: DayTask[] =
      found === undefined
        ? []
        : [...found.tasks.entries()]
            .map(([name, totalMs]) => ({
              kind: (name === "" ? "none" : "task") as DayTask["kind"],
              name: name === "" ? null : name,
              totalMs,
            }))
            .sort((a, b) => b.totalMs - a.totalMs || (a.name ?? "").localeCompare(b.name ?? ""));
    days.push({ day: key, totalMs: found?.totalMs ?? 0, tasks });
  }
  return days;
}

/** Whether anything has ever been credited, on any day. */
export function everFocused(at = Date.now()): boolean {
  void at;
  return loadHistory().some((e) => e.kind === "work" && e.cancelledAt === null);
}

/** Which day the chart marks, and the detail docked below it. */
export type Selection = {
  /** Always a day in the range, so the chart has something to mark. */
  day: string;
  /**
   * The day's detail, or undefined when the marked day is empty. The chart is
   * zero-filled, so a flat stretch can still be pointed at — and such a day
   * gets no panel at all rather than ۰:۰۰ over an empty list.
   */
  detail: ChartDay | undefined;
};

/**
 * The day being shown: the one being pointed at, or the most recent one with
 * anything in it.
 *
 * Null when no day in the range has any focus time — a week off is a flat line
 * and nothing more, with no marker on it and nothing docked below.
 */
export function selectDay(days: ChartDay[], pointed: string | null): Selection | null {
  const latest = lastDayWithFocus(days);
  if (latest === undefined) return null;

  // Pointing wins while it lands inside the range; otherwise the panel rests
  // on the most recent day that has data, which is what the page opens on.
  const day =
    pointed !== null && days.some((column) => column.day === pointed)
      ? pointed
      : latest.day;

  const marked = days.find((column) => column.day === day);
  return { day, detail: marked !== undefined && marked.totalMs > 0 ? marked : undefined };
}

/** The most recent day carrying focus time. `days` is oldest first. */
function lastDayWithFocus(days: ChartDay[]): ChartDay | undefined {
  for (let i = days.length - 1; i >= 0; i--) {
    const day = days[i];
    if (day !== undefined && day.totalMs > 0) return day;
  }
  return undefined;
}

/** A Tehran day key shifted by whole days, via noon UTC which is unambiguous. */
function shiftDay(key: string, by: number): string {
  const at = new Date(`${key}T12:00:00Z`).getTime() + by * 86_400_000;
  return tehranDayKey(at);
}
