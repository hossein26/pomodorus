import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { CLASSIC, validIntervals, type Intervals } from "@/lib/intervals";
import { LocalError } from "@/lib/errors";
import {
  breakAfter,
  breakDeadline,
  cycleCount,
  isWorkDuration,
  todayStats,
  HISTORY_CAP,
  type HistoryEntry,
  type Kind,
} from "@/lib/local-timer";
import { KEYS, read, write } from "@/lib/local-store";
import { serverNow } from "@/lib/server-clock";
import type { Category } from "@/lib/categories";

export type { Kind };

export type Session = {
  id: string;
  kind: Kind;
  categoryId: string | null;
  categoryName: string | null;
  /** Absolute epoch milliseconds, always — never "seconds remaining". */
  startedAt: number;
  /** When the bell rings. */
  endsAt: number;
  /** The nominal length, which is what gets credited. */
  durationMs: number;
  /**
   * When the rest this pomodoro owes runs out. Null on a break, which owes
   * nothing.
   *
   * An instant rather than a length, because the break is anchored at the
   * nominal end: every second of ringing is a second of it already spent, so
   * this is fixed the moment the bell goes and the answer to "is there any
   * left?" is just the clock.
   */
  breakEndsAt: number | null;
  /**
   * What "another one" resumes, on a break: the task the pomodoro before it
   * was on, and the length it ran for.
   */
  resumeCategoryId: string | null;
  resumeDurationMs: number | null;
  /**
   * The break lengths this pomodoro recorded when it started. Editing the
   * rests mid-session cannot change what it already owes — only which of the
   * two it owes, because the cycle belongs to the settings rather than to the
   * session. Null on a break, which owes nothing.
   */
  breakSnapshot: { shortMs: number; longMs: number } | null;
};

/**
 * How far into the cycle you are.
 *
 * Derived from the finished sessions on every read, so it cannot be lost.
 * How *long* a cycle is belongs to the intervals: it is a setting, and one
 * number held in two places is one number that can be read wrong.
 */
export type Cycle = { count: number };

/**
 * How the Tehran day has gone so far: pomodoros credited since midnight there,
 * and what they were worth.
 *
 * `undefined` until storage has been read, which is the whole of the rule that
 * only a confirmed total may call the day empty.
 */
export type Today = { count: number; totalMs: number };

export type SessionValue = {
  /**
   * `null` means there is no timer; `undefined` means the answer has not
   * arrived yet, and the two are not the same thing to a screen that must not
   * flash a start button at somebody who is mid-pomodoro.
   */
  session: Session | null | undefined;
  cycle: Cycle;
  /**
   * What a break is worth, and how long a cycle is. They ride with the timer
   * state because they are part of what the timer is.
   */
  intervals: Intervals;
  /**
   * The day so far, or `undefined` while it is unknown. The start screen
   * reserves the row either way, so this being unknown costs no layout shift
   * and never renders as an empty day.
   */
  today: Today | undefined;
  start: (categoryId: string, durationMs: number) => Promise<Session | null>;
  /** Abandon a pomodoro, or skip a break: the same fact, one call. */
  cancel: (id: string) => Promise<void>;
  /** Acknowledge a bell, and receive whatever the timer became. */
  confirm: (id: string) => Promise<Session | null>;
  /** Edit the intervals. All three, always — there is nothing to merge. */
  save: (intervals: Intervals) => Promise<void>;
  reload: () => Promise<void>;
};

/** Whether a session is one of the two kinds of rest. */
export function isBreak(session: Session): boolean {
  return session.kind !== "work";
}

/**
 * Whether confirming a ringing pomodoro right now still buys a break.
 *
 * The break was anchored at the nominal end before anybody was late, so this
 * is the ring racing a fixed instant — and the button's label follows it
 * second by second without asking anybody again.
 */
export function breakSurvives(session: Session, now: number): boolean {
  return session.breakEndsAt !== null && now < session.breakEndsAt;
}

/**
 * Whether a session's bell has gone.
 *
 * Derived, never stored: before its end a session is running, after its end
 * and unacknowledged it is ringing. That is the whole of it — which is why a
 * window that was asleep through the bell rings the moment it wakes, and why
 * nothing has to be scheduled for it to.
 */
export function isRinging(session: Session, now: number): boolean {
  return now >= session.endsAt;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * The live session, as this device has it.
 *
 * There is exactly one, and it is a stored fact rather than anything ticking
 * — so this holds the facts and every screen derives the rest. It sits above
 * the route because the bell does: a session that ends while you are reading
 * the stats still has to reach you.
 */
export function useSession(): SessionValue {
  const value = use(SessionContext);
  if (!value) throw new Error("useSession must be used inside <SessionProvider>");
  return value;
}

export function SessionProvider({
  children,
  value,
}: {
  children: ReactNode;
  value?: SessionValue;
}) {
  const fetched = useLocalSession(value !== undefined);
  return <SessionContext value={value ?? fetched}>{children}</SessionContext>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

function isSession(v: unknown): v is Session {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === "string" &&
    (v.kind === "work" || v.kind === "shortBreak" || v.kind === "longBreak") &&
    (v.categoryId === null || typeof v.categoryId === "string") &&
    (v.categoryName === null || typeof v.categoryName === "string") &&
    typeof v.startedAt === "number" &&
    typeof v.endsAt === "number" &&
    typeof v.durationMs === "number" &&
    (v.breakEndsAt === null || typeof v.breakEndsAt === "number") &&
    (v.resumeCategoryId === null || typeof v.resumeCategoryId === "string") &&
    (v.resumeDurationMs === null || typeof v.resumeDurationMs === "number") &&
    (v.breakSnapshot === null ||
      (isRecord(v.breakSnapshot) &&
        typeof v.breakSnapshot.shortMs === "number" &&
        typeof v.breakSnapshot.longMs === "number"))
  );
}

function isLiveValue(v: unknown): v is Session | null {
  return v === null || isSession(v);
}

function isHistoryEntry(v: unknown): v is HistoryEntry {
  if (!isRecord(v)) return false;
  return (
    (v.kind === "work" || v.kind === "shortBreak" || v.kind === "longBreak") &&
    typeof v.startedAt === "number" &&
    typeof v.endsAt === "number" &&
    typeof v.durationMs === "number" &&
    (v.cancelledAt === null || typeof v.cancelledAt === "number") &&
    (v.categoryId === null || typeof v.categoryId === "string") &&
    (v.categoryName === null || typeof v.categoryName === "string")
  );
}

function isHistory(v: unknown): v is HistoryEntry[] {
  return Array.isArray(v) && v.every(isHistoryEntry);
}

function isIntervals(v: unknown): v is Intervals {
  if (!isRecord(v)) return false;
  return (
    typeof v.shortBreakMs === "number" &&
    typeof v.longBreakMs === "number" &&
    typeof v.perCycle === "number"
  );
}

const isCategoryRecord = (v: unknown): v is Category =>
  isRecord(v) && typeof v.id === "string" && typeof v.name === "string";

function loadLive(): Session | null {
  return read(KEYS.live, isLiveValue) ?? null;
}

function loadHistory(): HistoryEntry[] {
  return read(KEYS.history, isHistory) ?? [];
}

function loadIntervals(): Intervals {
  const stored = read(KEYS.intervals, isIntervals);
  return stored && validIntervals(stored) ? stored : CLASSIC;
}

function loadCategoryName(id: string): string | null {
  const raw = read(KEYS.categories, (v): v is Category[] =>
    Array.isArray(v) && v.every(isCategoryRecord),
  );
  return raw?.find((c) => c.id === id)?.name ?? null;
}

function pushHistory(history: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  const next = [...history, entry];
  return next.length > HISTORY_CAP ? next.slice(next.length - HISTORY_CAP) : next;
}

function toEntry(session: Session, cancelledAt: number | null): HistoryEntry {
  return {
    kind: session.kind,
    startedAt: session.startedAt,
    endsAt: session.endsAt,
    durationMs: session.durationMs,
    cancelledAt,
    categoryId: session.categoryId,
    categoryName: session.categoryName,
  };
}

function useLocalSession(disabled: boolean): SessionValue {
  const [session, setSession] = useState<Session | null>(() => loadLive());
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const [intervals, setIntervals] = useState<Intervals>(() => loadIntervals());

  const reload = useCallback(async () => {
    setSession(loadLive());
    setHistory(loadHistory());
    setIntervals(loadIntervals());
  }, []);

  // Another window (or the menu bar) may have moved the timer: storage is the
  // truth, and re-reading it is what makes the answer arrive without a reload.
  useEffect(() => {
    if (disabled) return;
    const refresh = () => void reload().catch(() => {});
    const onStorage = (event: StorageEvent) => {
      if (
        event.key === KEYS.live ||
        event.key === KEYS.history ||
        event.key === KEYS.intervals
      ) {
        refresh();
      }
    };
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [disabled, reload]);

  const cycle = useMemo<Cycle>(
    () => ({ count: cycleCount(history, session !== null, serverNow()) }),
    [history, session],
  );
  const today = useMemo<Today>(
    () => todayStats(history, serverNow()),
    [history],
  );

  const persist = useCallback(
    (live: Session | null, entries: HistoryEntry[], next: Intervals) => {
      write(KEYS.live, live);
      write(KEYS.history, entries);
      write(KEYS.intervals, next);
      setSession(live);
      setHistory(entries);
      setIntervals(next);
    },
    [],
  );

  const start = useCallback(
    async (categoryId: string, durationMs: number) => {
      if (!isWorkDuration(durationMs)) throw new LocalError("bad_duration");
      const live = loadLive();
      // Asking to start while one is live answers with the live one, so a
      // double click — or a second window — opens into the running timer
      // rather than beginning a second one.
      if (live !== null) {
        setSession(live);
        return live;
      }
      const categoryName = loadCategoryName(categoryId);
      if (categoryName === null) throw new LocalError("category_not_found");
      const now = serverNow();
      const stored = loadHistory();
      const storedIntervals = loadIntervals();
      const completed = cycleCount(stored, true, now) + 1;
      const { lengthMs } = breakAfter(completed, storedIntervals);
      const next: Session = {
        id: crypto.randomUUID(),
        kind: "work",
        categoryId,
        categoryName,
        startedAt: now,
        endsAt: now + durationMs,
        durationMs,
        breakEndsAt: now + durationMs + lengthMs,
        resumeCategoryId: null,
        resumeDurationMs: null,
        breakSnapshot: {
          shortMs: storedIntervals.shortBreakMs,
          longMs: storedIntervals.longBreakMs,
        },
      };
      persist(next, stored, storedIntervals);
      return next;
    },
    [persist],
  );

  // Abandoning a pomodoro and skipping a break are the same fact: this session
  // is over and was not seen through.
  const cancel = useCallback(
    async (id: string) => {
      const live = loadLive();
      if (live === null || live.id !== id) throw new LocalError("session_not_found");
      // A bell that has gone means credited work, which cannot be retracted.
      if (isRinging(live, serverNow())) throw new LocalError("not_cancellable");
      const stored = loadHistory();
      persist(null, pushHistory(stored, toEntry(live, serverNow())), loadIntervals());
    },
    [persist],
  );

  // The one deliberate tap that ends a ring. A pomodoro's leaves the break it
  // earned running; a break's leaves an idle timer, because whether to go
  // round again is a question and not a default.
  const confirm = useCallback(
    async (id: string) => {
      const live = loadLive();
      if (live === null || live.id !== id) throw new LocalError("session_not_found");
      const now = serverNow();
      if (!isRinging(live, now)) throw new LocalError("nothing_ringing");
      const stored = loadHistory();
      const current = loadIntervals();

      if (isBreak(live)) {
        persist(null, pushHistory(stored, toEntry(live, null)), current);
        return null;
      }

      // Work is credited at its nominal end, at its full nominal length —
      // nothing here changes the record. The break's kind is decided now, from
      // the current count, because the cycle belongs to the settings; its
      // length is the snapshot the pomodoro recorded when it started, so
      // editing the rests mid-session cannot change what is owed.
      const completed = cycleCount(stored, false, now) + 1;
      const { kind } = breakAfter(completed, current);
      const snapshot = live.breakSnapshot ?? {
        shortMs: current.shortBreakMs,
        longMs: current.longBreakMs,
      };
      const lengthMs = kind === "longBreak" ? snapshot.longMs : snapshot.shortMs;
      const deadline = breakDeadline(live.endsAt, lengthMs);
      const entries = pushHistory(stored, toEntry(live, null));
      // Ringing past the deadline leaves none of the break to start at all.
      if (now >= deadline) {
        persist(null, entries, current);
        return null;
      }
      const rest: Session = {
        id: crypto.randomUUID(),
        kind,
        categoryId: null,
        categoryName: null,
        startedAt: live.endsAt,
        endsAt: deadline,
        durationMs: deadline - live.endsAt,
        breakEndsAt: null,
        resumeCategoryId: live.categoryId,
        resumeDurationMs: live.durationMs,
        breakSnapshot: null,
      };
      persist(rest, entries, current);
      return rest;
    },
    [persist],
  );

  // Sent whole. This edit can change what a session already on screen is
  // heading for: a shorter cycle can turn the rest the running pomodoro owes
  // into the long one — which the ring screen recomputes from the same facts.
  const save = useCallback(
    async (next: Intervals) => {
      if (!validIntervals(next)) throw new LocalError("bad_interval");
      const live = loadLive();
      const stored = loadHistory();
      if (live !== null && !isBreak(live) && live.breakSnapshot !== null) {
        const completed = cycleCount(stored, true, serverNow()) + 1;
        const { kind } = breakAfter(completed, next);
        const lengthMs =
          kind === "longBreak" ? live.breakSnapshot.longMs : live.breakSnapshot.shortMs;
        const owed: Session = { ...live, breakEndsAt: live.endsAt + lengthMs };
        persist(owed, stored, next);
        return;
      }
      persist(live, stored, next);
    },
    [persist],
  );

  return { session, cycle, intervals, today, start, cancel, confirm, save, reload };
}
