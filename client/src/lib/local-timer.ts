/**
 * The pomodoro's rules, with no I/O in sight.
 *
 * A port of the timer domain the server used to own, now running on the
 * device because there is no server any more. Everything here is a pure
 * function of stored facts plus an instant, so the whole timer is exercised
 * by moving a clock rather than by waiting.
 *
 * The semantics are unchanged: one live session, derived running/ringing
 * state, work credited at its nominal end, the break anchored at the bell so
 * ring time eats it, and the cycle walked out of the sessions themselves.
 */

import type { Intervals } from "@/lib/intervals";

// The band a work session may be drawn from, and the step it moves in. This is
// the technique staying recognisably the technique: a "pomodoro" of four
// minutes or four hours is not one.
export const MIN_WORK_MS = 15 * 60_000;
export const MAX_WORK_MS = 60 * 60_000;
export const WORK_STEP_MS = 5 * 60_000;

/** How long a timer may sit still before the cycle it was in is abandoned. */
export const IDLE_RESET_MS = 60 * 60_000;

/** How many finished sessions are kept for the cycle and the stats. */
export const HISTORY_CAP = 500;

export type Kind = "work" | "shortBreak" | "longBreak";

/**
 * A finished session, as the cycle counter and the stats see it: when it was
 * meant to run, and whether it was abandoned. Confirmation is deliberately
 * absent — a bell acknowledged late is the same fact as one acknowledged
 * instantly, and the ring in between is idleness rather than activity.
 */
export type HistoryEntry = {
  kind: Kind;
  startedAt: number;
  endsAt: number;
  /** The nominal length, which is what gets credited. */
  durationMs: number;
  /** Set when abandoned: a cancelled pomodoro, or a skipped break. */
  cancelledAt: number | null;
  categoryId: string | null;
  categoryName: string | null;
};

/** Whether a requested length is one the app offers. */
export function isWorkDuration(ms: number): boolean {
  return (
    Number.isInteger(ms) &&
    ms >= MIN_WORK_MS &&
    ms <= MAX_WORK_MS &&
    (ms - MIN_WORK_MS) % WORK_STEP_MS === 0
  );
}

/**
 * The rest owed for a pomodoro, given how many have been completed in the
 * cycle it closed — itself included — and the intervals that govern it.
 *
 * The count is compared with `>=` rather than `==` so that a cycle that ran
 * past its length still offers the long break: the counter only goes back to
 * zero when a long break is actually finished or skipped.
 */
export function breakAfter(
  completed: number,
  intervals: Intervals,
): { kind: Kind; lengthMs: number } {
  if (completed >= intervals.perCycle) {
    return { kind: "longBreak", lengthMs: intervals.longBreakMs };
  }
  return { kind: "shortBreak", lengthMs: intervals.shortBreakMs };
}

/**
 * The instant a pomodoro's owed rest runs out.
 *
 * The whole of the ring-time rule in one line: the break is anchored at the
 * bell, so this is fixed the moment the pomodoro ends and does not move
 * however late the bell is answered. Ringing for ten seconds spends ten
 * seconds of the break; ringing past this instant leaves none of it.
 */
export function breakDeadline(bell: number, lengthMs: number): number {
  return bell + lengthMs;
}

/**
 * How far into the cycle you are at `now`.
 *
 * Walked out of the finished sessions in order of when they started. Two
 * things end a cycle: a long break, once it is over — taken or skipped,
 * because declining the rest still closes the set — and an hour with nothing
 * running, measured from a session's nominal end. An abandoned pomodoro counts
 * for nothing at all.
 *
 * `live` is whether something is running right now. While it is, the idleness
 * that would otherwise reset the cycle is not idleness yet.
 */
export function cycleCount(
  entries: HistoryEntry[],
  live: boolean,
  now: number,
): number {
  const ordered = [...entries].sort((a, b) => a.startedAt - b.startedAt);
  let count = 0;
  // The last thing that happened: a nominal end, or the moment a break was
  // skipped. Never a confirmation.
  let last = 0;

  for (const s of ordered) {
    if (s.cancelledAt !== null && s.kind === "work") continue;
    const over = s.endsAt <= now;

    if (s.kind === "work") {
      // Checked on the way in, because an hour of doing nothing is only
      // visible from the far side of it.
      if (count > 0 && last !== 0 && s.startedAt - last > IDLE_RESET_MS) {
        count = 0;
      }
      if (!over) continue;
      count++;
      last = s.endsAt;
    } else if (s.cancelledAt !== null) {
      // A skipped break.
      if (s.kind === "longBreak") count = 0;
      last = s.cancelledAt;
    } else if (over) {
      // The cycle closes when the long break is over, not when somebody gets
      // round to acknowledging it.
      if (s.kind === "longBreak") count = 0;
      last = s.endsAt;
    }
    // A break still running contributes nothing yet.
  }

  // And the idleness that is still running: a cycle abandoned an hour ago is
  // abandoned now, whether or not anything has been started since.
  if (!live && count > 0 && last !== 0 && now - last > IDLE_RESET_MS) {
    count = 0;
  }
  return count;
}

/** A `YYYY-MM-DD` key for the Tehran day holding this instant. */
export function tehranDayKey(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);
}

/**
 * How the Tehran day has gone so far: pomodoros credited since midnight there,
 * and what they were worth. Work is credited at its nominal end, at its full
 * nominal length.
 */
export function todayStats(
  entries: HistoryEntry[],
  now: number,
): { count: number; totalMs: number } {
  const key = tehranDayKey(now);
  let count = 0;
  let totalMs = 0;
  for (const s of entries) {
    if (s.kind !== "work" || s.cancelledAt !== null) continue;
    if (s.endsAt > now) continue;
    if (tehranDayKey(s.endsAt) !== key) continue;
    count++;
    totalMs += s.durationMs;
  }
  return { count, totalMs };
}
