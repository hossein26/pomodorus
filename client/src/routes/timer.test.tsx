import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { copy, t } from "@/lib/copy";
import { faClock, faDigits, faElapsed } from "@/lib/format";
import { CLASSIC, type Intervals } from "@/lib/intervals";
import { KEYS } from "@/lib/local-store";
import type { HistoryEntry } from "@/lib/local-timer";
import { noteServerTime } from "@/lib/server-clock";
import type { Category } from "@/lib/categories";
import type { Session } from "@/lib/session";
import { TimerRoute } from "@/routes/timer";
import { renderAt } from "@/test/render";

const NOW = 1_800_000_000_000;
const CATEGORY: Category = { id: "c1", name: "درس", isPublic: true };

const SHORT_BREAK = 5 * 60_000;

const workSession = (over: Partial<Session> = {}): Session => {
  const endsAt = over.endsAt ?? NOW + 25 * 60_000;
  return {
    id: "s1",
    kind: "work",
    categoryId: CATEGORY.id,
    categoryName: CATEGORY.name,
    startedAt: NOW,
    durationMs: 25 * 60_000,
    // The rest it owes, anchored at its own end: the ring is spent out of it,
    // so this instant does not move however late the bell is answered.
    breakEndsAt: endsAt + SHORT_BREAK,
    resumeCategoryId: null,
    resumeDurationMs: null,
    breakSnapshot: { shortMs: SHORT_BREAK, longMs: 20 * 60_000 },
    ...over,
    endsAt,
  };
};

/**
 * The break a pomodoro handed over: it *began* at that pomodoro's nominal
 * end, which is why a break started after a two-minute ring has two minutes
 * already gone.
 */
const breakSession = (over: Partial<Session> = {}): Session => ({
  id: "b1",
  kind: "shortBreak",
  categoryId: null,
  categoryName: null,
  startedAt: NOW,
  endsAt: NOW + SHORT_BREAK,
  durationMs: SHORT_BREAK,
  breakEndsAt: null,
  // What "another one" resumes, read off the pomodoro this break followed.
  resumeCategoryId: CATEGORY.id,
  resumeDurationMs: 25 * 60_000,
  breakSnapshot: null,
  ...over,
});

/** A finished pomodoro, as the history keeps it. */
const doneWork = (endsAt: number): HistoryEntry => ({
  kind: "work",
  startedAt: endsAt - 25 * 60_000,
  endsAt,
  durationMs: 25 * 60_000,
  cancelledAt: null,
  categoryId: CATEGORY.id,
  categoryName: CATEGORY.name,
});

/**
 * The seam is storage. The route is fed stored facts and the assertion is
 * what is on screen — the same shape a real window would be in.
 */
function seed({
  categories = [CATEGORY],
  live = null as Session | null,
  history = [] as HistoryEntry[],
  intervals = CLASSIC,
}: {
  categories?: Category[];
  live?: Session | null;
  history?: HistoryEntry[];
  intervals?: Intervals;
} = {}) {
  localStorage.setItem(KEYS.categories, JSON.stringify(categories));
  localStorage.setItem(KEYS.live, JSON.stringify(live));
  localStorage.setItem(KEYS.history, JSON.stringify(history));
  localStorage.setItem(KEYS.intervals, JSON.stringify(intervals));
}

function storedLive(): Session | null {
  const raw = localStorage.getItem(KEYS.live);
  return raw ? (JSON.parse(raw) as Session | null) : null;
}

function storedIntervals(): Intervals {
  return JSON.parse(localStorage.getItem(KEYS.intervals) ?? "null") as Intervals;
}

const renderTimer = () => renderAt(<TimerRoute />);

beforeEach(() => {
  // Anchor the clock where the fixtures are, so a countdown is a statement
  // about a fixed instant rather than about when the suite happened to run.
  noteServerTime(NOW, performance.now());
});

/** Nothing can be started without a task, so most tests begin by picking one. */
async function pickTask(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("combobox"));
  await user.click(await screen.findByText(CATEGORY.name));
}

describe("the start screen", () => {
  it("offers the stepper at its default and the picked task", async () => {
    seed();
    renderTimer();

    expect(await screen.findByText(faClock(25 * 60_000))).toBeTruthy();
    expect(
      screen.getByRole("button", { name: copy.timer.start }),
    ).toBeTruthy();
  });

  it("cannot start without a task", async () => {
    seed({ categories: [] });
    renderTimer();

    const button = await screen.findByRole("button", { name: copy.timer.start });
    expect(button.getAttribute("disabled")).not.toBeNull();
  });

  it("cannot start on a task that has been deleted since it was picked", async () => {
    // The remembered id is a preference and the list is the truth; a stale
    // one has to fall back rather than be started on.
    localStorage.setItem("pomodorus.category", JSON.stringify("gone"));
    seed();
    renderTimer();

    const button = await screen.findByRole("button", { name: copy.timer.start });
    expect(button.getAttribute("disabled")).not.toBeNull();
  });

  it("walks the range in five-minute steps", async () => {
    seed();
    renderTimer();
    const user = userEvent.setup();

    await screen.findByText(faClock(25 * 60_000));
    await user.click(screen.getByRole("button", { name: /۳۰/ }));
    expect(screen.getByText(faClock(30 * 60_000))).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /۲۵/ }));
    expect(screen.getByText(faClock(25 * 60_000))).toBeTruthy();
  });

  it("disables the button for a limit it has reached", async () => {
    seed();
    renderTimer();
    const user = userEvent.setup();
    await screen.findByText(faClock(25 * 60_000));

    // Down to the floor: the minus is then disabled rather than silently
    // doing nothing, so the range is visible.
    for (let m = 25; m > 15; m -= 5) {
      await user.click(screen.getByRole("button", { name: new RegExp(faDigits(m - 5)) }));
    }
    expect(screen.getByText(faClock(15 * 60_000))).toBeTruthy();
    const minus = screen.getByRole("button", { name: new RegExp(faDigits(10)) });
    expect(minus.getAttribute("disabled")).not.toBeNull();
  });

  it("starts with the task and the length that are on screen", async () => {
    seed();
    renderTimer();
    const user = userEvent.setup();

    await pickTask(user);
    await user.click(screen.getByRole("button", { name: /۳۰/ }));
    await user.click(screen.getByRole("button", { name: copy.timer.start }));

    // The live fact, stored: the task, the length, and an end thirty minutes
    // out. A retry cannot start a second timer — starting while one is live
    // answers with the live one.
    await waitFor(() => expect(storedLive()).not.toBeNull());
    const live = storedLive();
    expect(live?.categoryId).toBe(CATEGORY.id);
    expect(live?.durationMs).toBe(30 * 60_000);
    expect(typeof live?.id).toBe("string");
    expect(await screen.findByText(faClock(30 * 60_000))).toBeTruthy();
  });

  it("remembers the task and the length across a reload", async () => {
    seed();
    const first = renderTimer();
    const user = userEvent.setup();

    await pickTask(user);
    await user.click(screen.getByRole("button", { name: /۳۰/ }));
    first.unmount();

    renderTimer();
    expect(await screen.findByText(faClock(30 * 60_000))).toBeTruthy();
    // The task too: a refresh should not lose your place.
    expect(
      (await screen.findByRole("button", { name: copy.timer.start })).getAttribute(
        "disabled",
      ),
    ).toBeNull();
  });
});

describe("a running session", () => {
  it("shows the task, the countdown and a cancel", async () => {
    seed({ live: workSession() });
    renderTimer();

    expect(await screen.findByText("درس")).toBeTruthy();
    expect(screen.getByText(faClock(25 * 60_000))).toBeTruthy();
    expect(
      screen.getByRole("button", { name: copy.timer.cancelWork }),
    ).toBeTruthy();
    // Never a start button while one is running — that is how a second timer
    // used to get started.
    expect(screen.queryByRole("button", { name: copy.timer.start })).toBeNull();
  });

  it("counts down from the session's own facts, not from anything streamed", async () => {
    // A session that began five minutes ago. Nothing arrives to say how far
    // in it is — the countdown is computed from startedAt, endsAt and the
    // clock.
    seed({
      live: workSession({
        startedAt: NOW - 5 * 60_000,
        endsAt: NOW + 20 * 60_000,
      }),
    });
    renderTimer();

    expect(await screen.findByText(faClock(20 * 60_000))).toBeTruthy();
  });

  it("shows a generic label for a task with no name", async () => {
    seed({ live: workSession({ categoryName: null }) });
    renderTimer();

    expect(await screen.findByText(copy.timer.privateTask)).toBeTruthy();
  });

  it("cancels, and returns to the start screen", async () => {
    seed({ live: workSession() });
    renderTimer();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: copy.timer.cancelWork }),
    );

    await waitFor(() => expect(storedLive()).toBeNull());
    expect(
      await screen.findByRole("button", { name: copy.timer.start }),
    ).toBeTruthy();
  });
});

describe("the progress bar", () => {
  it("starts at zero for a new session", async () => {
    seed({ live: workSession() });
    renderTimer();

    const bar = await screen.findByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
  });

  it("never renders an invalid width at the very end", async () => {
    // A negative percentage is invalid CSS: the declaration would be dropped,
    // width would fall back to auto, and the bar would flash full white at
    // exactly the moment a session ends.
    seed({
      live: workSession({ startedAt: NOW - 25 * 60_000, endsAt: NOW + 1 }),
    });
    renderTimer();

    const bar = await screen.findByRole("progressbar");
    const width = Number.parseFloat(bar.style.width);
    expect(width).toBeGreaterThanOrEqual(0);
    expect(width).toBeLessThanOrEqual(100);
  });

  it("clamps rather than going negative before a session starts", async () => {
    seed({
      live: workSession({ startedAt: NOW + 60_000, endsAt: NOW + 26 * 60_000 }),
    });
    renderTimer();

    const bar = await screen.findByRole("progressbar");
    expect(Number.parseFloat(bar.style.width)).toBeGreaterThanOrEqual(0);
  });
});

describe("the bell", () => {
  /** A session whose nominal end was `ago` milliseconds back: ringing. */
  const ringing = (ago: number) =>
    workSession({ startedAt: NOW - 25 * 60_000 - ago, endsAt: NOW - ago });

  it("rings where the countdown was, counting up", async () => {
    seed({ live: ringing(65_000) });
    renderTimer();

    expect(await screen.findByText(copy.timer.ringWorkTitle)).toBeTruthy();
    // Up, not down, and prefixed — a clock that has stopped meaning "time
    // left" has to be unmistakable.
    expect(screen.getByText(faElapsed(65_000))).toBeTruthy();
    expect(screen.getByText("درس")).toBeTruthy();
  });

  it("is the only red in the app", async () => {
    seed({ live: ringing(1000) });
    renderTimer();

    const clock = await screen.findByText(faElapsed(1000));
    expect(clock.className.split(/\s+/)).toContain("text-rose-500");
  });

  it("cannot be cancelled: the work is complete and already credited", async () => {
    seed({ live: ringing(1000) });
    renderTimer();

    await screen.findByText(copy.timer.ringWorkTitle);
    expect(
      screen.queryByRole("button", { name: copy.timer.cancelWork }),
    ).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("ends on a deliberate tap, and hands over the break in the same one", async () => {
    seed({ live: ringing(1000) });
    renderTimer();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: copy.timer.confirmWork }),
    );

    // One tap: the pomodoro is acknowledged and the rest it earned is running.
    expect(
      await screen.findByRole("button", { name: copy.timer.skipBreak }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: copy.timer.start })).toBeNull();
    // Anchored at the bell: the break runs to the deadline the pomodoro fixed.
    expect(storedLive()?.endsAt).toBe(NOW - 1000 + SHORT_BREAK);
  });

  it("rings a session that ended while the window was shut", async () => {
    // Nothing was scheduled: the state is recomputed from `endsAt` and the
    // clock, so however long the app was away it opens into the ring rather
    // than into a finished countdown.
    seed({ live: ringing(3 * 60 * 60_000) });
    renderTimer();

    expect(await screen.findByText(copy.timer.ringWorkTitle)).toBeTruthy();
    expect(screen.getByText(faElapsed(3 * 60 * 60_000))).toBeTruthy();
  });
});

describe("the button on a ringing pomodoro", () => {
  /** A pomodoro whose bell went `ago` ago, owing a five-minute break. */
  const rang = (ago: number) =>
    workSession({ startedAt: NOW - 25 * 60_000 - ago, endsAt: NOW - ago });

  it("promises the chill while there is still some of it left", async () => {
    seed({ live: rang(SHORT_BREAK - 1000) });
    renderTimer();

    expect(
      await screen.findByRole("button", { name: copy.timer.confirmWork }),
    ).toBeTruthy();
  });

  it("says so instead once the ring has eaten the whole break", async () => {
    // Anchored at the nominal end: five minutes of ringing is five minutes of
    // break spent, so this tap buys silence and nothing else. The label has to
    // say that a moment *before* it is pressed, not after.
    seed({ live: rang(SHORT_BREAK) });
    renderTimer();

    expect(
      await screen.findByRole("button", { name: copy.timer.confirmWorkNoBreak }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: copy.timer.confirmWork }),
    ).toBeNull();
  });

  it("drops back to the start screen when nothing survived", async () => {
    seed({ live: rang(2 * 60 * 60_000) });
    renderTimer();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: copy.timer.confirmWorkNoBreak }),
    );

    await waitFor(() => expect(storedLive()).toBeNull());
    expect(
      await screen.findByRole("button", { name: copy.timer.start }),
    ).toBeTruthy();
  });
});

describe("a running break", () => {
  it("counts down what survived the ring, and offers a skip", async () => {
    // Two minutes of it were spent ringing, so three are left — the screen is
    // told nothing about that; it reads one end time like any other.
    seed({
      live: breakSession({
        startedAt: NOW - 2 * 60_000,
        endsAt: NOW + 3 * 60_000,
      }),
    });
    renderTimer();

    expect(await screen.findByText(copy.timer.kindShortBreak)).toBeTruthy();
    expect(screen.getByText(faClock(3 * 60_000))).toBeTruthy();
    expect(
      screen.getByRole("button", { name: copy.timer.skipBreak }),
    ).toBeTruthy();
    // A break belongs to no task, so it never shows one.
    expect(screen.queryByText(CATEGORY.name)).toBeNull();
  });

  it("shows the ring time as already spent", async () => {
    // The bar is measured from the break's start, which is the pomodoro's
    // nominal end — so two minutes of ringing are already behind it when it
    // first appears, rather than being quietly forgiven.
    seed({
      live: breakSession({
        startedAt: NOW - 2 * 60_000,
        endsAt: NOW + 3 * 60_000,
      }),
    });
    renderTimer();

    const bar = await screen.findByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("40");
  });

  it("names the long one as the long one", async () => {
    seed({ live: breakSession({ kind: "longBreak" }) });
    renderTimer();

    expect(await screen.findByText(copy.timer.kindLongBreak)).toBeTruthy();
  });

  it("skips back to the start screen", async () => {
    seed({ live: breakSession() });
    renderTimer();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: copy.timer.skipBreak }),
    );

    await waitFor(() => expect(storedLive()).toBeNull());
    expect(
      await screen.findByRole("button", { name: copy.timer.start }),
    ).toBeTruthy();
  });
});

describe("a ringing break", () => {
  const rang = (over: Partial<Session> = {}) =>
    breakSession({ startedAt: NOW - SHORT_BREAK, endsAt: NOW, ...over });

  it("asks the technique's own question: another one, or stop", async () => {
    seed({ live: rang() });
    renderTimer();

    expect(await screen.findByText(copy.timer.ringBreakTitle)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: copy.timer.continueWork }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: copy.timer.confirmBreak }),
    ).toBeTruthy();
  });

  it("continues on the same task at the same length", async () => {
    // Neither comes from these picks: the break carries the task and the
    // length of the pomodoro it followed, so continuing means the same work
    // rather than a guess.
    localStorage.setItem("pomodorus.minutes", JSON.stringify(15));
    seed({ live: rang({ resumeDurationMs: 30 * 60_000 }) });
    renderTimer();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: copy.timer.continueWork }),
    );

    // Acknowledged first, then started: one live session at a time.
    await waitFor(() => expect(storedLive()?.kind).toBe("work"));
    const live = storedLive();
    expect(live?.categoryId).toBe(CATEGORY.id);
    expect(live?.durationMs).toBe(30 * 60_000);
    // And the stepper behind it now agrees with what is running.
    expect(JSON.parse(localStorage.getItem("pomodorus.minutes") ?? "0")).toBe(30);
  });

  it("falls back to these picks when the break carries none", async () => {
    localStorage.setItem("pomodorus.category", JSON.stringify(CATEGORY.id));
    localStorage.setItem("pomodorus.minutes", JSON.stringify(20));
    seed({ live: rang({ resumeCategoryId: null, resumeDurationMs: null }) });
    renderTimer();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: copy.timer.continueWork }),
    );

    await waitFor(() => expect(storedLive()?.kind).toBe("work"));
    const live = storedLive();
    expect(live?.categoryId).toBe(CATEGORY.id);
    expect(live?.durationMs).toBe(20 * 60_000);
  });

  it("cannot continue onto a task that is gone", async () => {
    // The task the pomodoro was on has since been deleted, and nothing is
    // remembered to fall back to. The list is the truth.
    seed({ live: rang({ resumeCategoryId: "gone" }) });
    renderTimer();

    const button = await screen.findByRole("button", {
      name: copy.timer.continueWork,
    });
    expect(button.getAttribute("disabled")).not.toBeNull();
  });

  it("stops, with both still picked", async () => {
    localStorage.setItem("pomodorus.category", JSON.stringify(CATEGORY.id));
    seed({ live: rang() });
    renderTimer();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: copy.timer.confirmBreak }),
    );

    await waitFor(() => expect(storedLive()).toBeNull());
    // Back where it started, ready to go again on the same task.
    const start = await screen.findByRole("button", { name: copy.timer.start });
    expect(start.getAttribute("disabled")).toBeNull();
  });
});

describe("the cycle dots", () => {
  it("show how far into the cycle a running session is", async () => {
    seed({
      live: workSession(),
      history: [doneWork(NOW - 55 * 60_000), doneWork(NOW - 30 * 60_000)],
    });
    renderTimer();

    const dots = await screen.findByTitle(
      t(copy.timer.cycleTitle, { n: faDigits(2), total: faDigits(4) }),
    );
    expect(dots.childElementCount).toBe(4);
    const filled = [...dots.children].filter((dot) =>
      dot.className.includes("bg-foreground"),
    );
    expect(filled.length).toBe(2);
  });

  it("clamp rather than grow for somebody who keeps declining the long break", async () => {
    seed({
      live: workSession(),
      history: [1, 2, 3, 4, 5, 6].map((n) => doneWork(NOW - n * 26 * 60_000)),
    });
    renderTimer();

    const dots = await screen.findByTitle(
      t(copy.timer.cycleTitle, { n: faDigits(4), total: faDigits(4) }),
    );
    expect(dots.childElementCount).toBe(4);
  });

  it("are not on the start screen, where there is no session to be in one", async () => {
    seed({ history: [doneWork(NOW - 30 * 60_000), doneWork(NOW - 55 * 60_000)] });
    renderTimer();

    await screen.findByRole("button", { name: copy.timer.start });
    expect(
      screen.queryByTitle(
        t(copy.timer.cycleTitle, { n: faDigits(2), total: faDigits(4) }),
      ),
    ).toBeNull();
  });
});

describe("the settings dialog", () => {
  /** Open it from the start screen, which is the only place it is offered. */
  async function openSettings(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: copy.timer.settings }));
  }

  const stepper = (label: string, direction: "+" | "−") =>
    screen.getByRole("button", { name: `${label} ${direction}` });

  it("shows the three intervals this device is set to", async () => {
    seed({
      intervals: { shortBreakMs: 8 * 60_000, longBreakMs: 30 * 60_000, perCycle: 3 },
    });
    renderTimer();
    await openSettings(userEvent.setup());

    expect(screen.getByText(t(copy.timer.minutes, { m: faDigits(8) }))).toBeTruthy();
    expect(screen.getByText(t(copy.timer.minutes, { m: faDigits(30) }))).toBeTruthy();
    expect(screen.getByText(t(copy.timer.count, { n: faDigits(3) }))).toBeTruthy();
  });

  it("saves all three, with the one that was stepped changed", async () => {
    seed();
    renderTimer();
    const user = userEvent.setup();
    await openSettings(user);

    await user.click(stepper(copy.timer.settingsShortBreak, "+"));

    // All three every time: there is nothing to merge.
    expect(storedIntervals()).toEqual({
      shortBreakMs: 6 * 60_000,
      longBreakMs: 20 * 60_000,
      perCycle: 4,
    });
    expect(
      await screen.findByText(t(copy.timer.minutes, { m: faDigits(6) })),
    ).toBeTruthy();
  });

  it("walks each interval in its own step", async () => {
    seed();
    renderTimer();
    const user = userEvent.setup();
    await openSettings(user);

    // A minute for the short break, five for the long one, one pomodoro for
    // the cycle.
    await user.click(stepper(copy.timer.settingsLongBreak, "−"));
    expect(storedIntervals()).toMatchObject({ longBreakMs: 15 * 60_000 });

    await user.click(stepper(copy.timer.settingsPerCycle, "−"));
    expect(storedIntervals()).toMatchObject({ perCycle: 3 });
  });

  it("disables the button for a limit it has reached", async () => {
    seed({
      intervals: { shortBreakMs: 3 * 60_000, longBreakMs: 35 * 60_000, perCycle: 6 },
    });
    renderTimer();
    await openSettings(userEvent.setup());

    // The end of the band is visible rather than something you discover by
    // pressing, exactly as the pomodoro's own stepper behaves.
    expect(stepper(copy.timer.settingsShortBreak, "−").getAttribute("disabled")).not.toBeNull();
    expect(stepper(copy.timer.settingsShortBreak, "+").getAttribute("disabled")).toBeNull();
    expect(stepper(copy.timer.settingsLongBreak, "+").getAttribute("disabled")).not.toBeNull();
    expect(stepper(copy.timer.settingsPerCycle, "+").getAttribute("disabled")).not.toBeNull();
  });

  it("applies when the window looks again, so another window's edit arrives", async () => {
    seed({
      intervals: { shortBreakMs: 9 * 60_000, longBreakMs: 20 * 60_000, perCycle: 4 },
    });
    renderTimer();
    const user = userEvent.setup();
    await openSettings(user);
    expect(screen.getByText(t(copy.timer.minutes, { m: faDigits(9) }))).toBeTruthy();

    // The intervals change elsewhere; this window comes back to the front.
    localStorage.setItem(
      KEYS.intervals,
      JSON.stringify({ shortBreakMs: 4 * 60_000, longBreakMs: 20 * 60_000, perCycle: 4 }),
    );
    document.dispatchEvent(new Event("visibilitychange"));

    expect(
      await screen.findByText(t(copy.timer.minutes, { m: faDigits(4) })),
    ).toBeTruthy();
  });

  it("takes the cycle straight to the dots", async () => {
    // Pomodoros-per-cycle is read at completion rather than snapshotted, so a
    // shorter cycle is felt immediately — including by what is on screen.
    seed({ live: workSession(), history: [doneWork(NOW - 30 * 60_000)] });
    renderTimer();

    expect(
      await screen.findByTitle(t(copy.timer.cycleTitle, { n: faDigits(1), total: faDigits(4) })),
    ).toBeTruthy();
  });

  it("is not offered while something is running", async () => {
    // It is opened from the start screen, where the intervals are a decision
    // about what comes next rather than about what is already under way.
    seed({ live: workSession() });
    renderTimer();

    await screen.findByText(CATEGORY.name);
    expect(screen.queryByRole("button", { name: copy.timer.settings })).toBeNull();
  });
});

describe("opening in a second window", () => {
  it("shows the running timer rather than a start button", async () => {
    // Storage owns the timer, so "a second window" is just another reader of
    // the same facts.
    seed({ live: workSession() });
    renderTimer();

    expect(await screen.findByText(faClock(25 * 60_000))).toBeTruthy();
    expect(screen.queryByRole("button", { name: copy.timer.start })).toBeNull();
  });
});
