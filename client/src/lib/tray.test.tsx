import { screen, waitFor } from "@testing-library/react";
import { render } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CLASSIC } from "@/lib/intervals";
import { KEYS } from "@/lib/local-store";
import type { Category } from "@/lib/categories";
import { noteServerTime } from "@/lib/server-clock";
import { SessionProvider, type Session } from "@/lib/session";
import {
  readQuickStart,
  useTrayCommands,
  type TrayCommandId,
} from "@/lib/tray";

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
    breakEndsAt: endsAt + SHORT_BREAK,
    resumeCategoryId: null,
    resumeDurationMs: null,
    breakSnapshot: { shortMs: SHORT_BREAK, longMs: 20 * 60_000 },
    ...over,
    endsAt,
  };
};

const breakSession = (over: Partial<Session> = {}): Session => ({
  id: "b1",
  kind: "shortBreak",
  categoryId: null,
  categoryName: null,
  startedAt: NOW - SHORT_BREAK,
  endsAt: NOW,
  durationMs: SHORT_BREAK,
  breakEndsAt: null,
  resumeCategoryId: CATEGORY.id,
  resumeDurationMs: 30 * 60_000,
  breakSnapshot: null,
  ...over,
});

function seed({
  categories = [CATEGORY],
  live = null as Session | null,
}: {
  categories?: Category[];
  live?: Session | null;
} = {}) {
  localStorage.setItem(KEYS.categories, JSON.stringify(categories));
  localStorage.setItem(KEYS.live, JSON.stringify(live));
  localStorage.setItem(KEYS.history, JSON.stringify([]));
  localStorage.setItem(KEYS.intervals, JSON.stringify(CLASSIC));
}

function storedLive(): Session | null {
  const raw = localStorage.getItem(KEYS.live);
  return raw ? (JSON.parse(raw) as Session | null) : null;
}

/** The shell's end of the bridge, held by the test. */
let command: ((id: TrayCommandId) => void) | null = null;

function Pathname() {
  return <p>{useLocation().pathname}</p>;
}

function Harness() {
  useTrayCommands();
  return <Pathname />;
}

function renderHarness() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <SessionProvider>
        <Harness />
      </SessionProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  command = null;
  window.electron = {
    onCommand: (handler) => {
      command = handler;
      return () => {
        command = null;
      };
    },
  };
  noteServerTime(NOW, performance.now());
});

afterEach(() => {
  delete window.electron;
});

function tap(id: TrayCommandId) {
  if (!command) throw new Error("the bridge was never subscribed");
  command(id);
}

describe("readQuickStart", () => {
  it("offers the picked task at the picked length", () => {
    localStorage.setItem(KEYS.categories, JSON.stringify([CATEGORY]));
    localStorage.setItem(KEYS.category, JSON.stringify(CATEGORY.id));
    localStorage.setItem(KEYS.minutes, JSON.stringify(30));

    expect(readQuickStart()).toEqual({
      categoryId: CATEGORY.id,
      categoryName: CATEGORY.name,
      durationMs: 30 * 60_000,
      label: expect.stringContaining("30") as unknown as string,
    });
  });

  it("offers nothing with no task to start on", () => {
    localStorage.setItem(KEYS.categories, JSON.stringify([]));
    expect(readQuickStart()).toBeNull();
  });
});

describe("menu taps", () => {
  it("starts the picked work headlessly", async () => {
    localStorage.setItem(KEYS.category, JSON.stringify(CATEGORY.id));
    localStorage.setItem(KEYS.minutes, JSON.stringify(25));
    seed();
    renderHarness();

    tap("quick-start");

    await waitFor(() => expect(storedLive()?.kind).toBe("work"));
    expect(storedLive()?.categoryId).toBe(CATEGORY.id);
  });

  it("does not start a second timer while one is live", async () => {
    seed({ live: workSession() });
    renderHarness();

    tap("quick-start");

    await Promise.resolve();
    expect(storedLive()?.id).toBe("s1");
  });

  it("cancels a running session", async () => {
    seed({ live: workSession() });
    renderHarness();

    tap("cancel");

    await waitFor(() => expect(storedLive()).toBeNull());
  });

  it("refuses to cancel a ring: the work is already credited", async () => {
    seed({
      live: workSession({ startedAt: NOW - 25 * 60_000 - 1000, endsAt: NOW - 1000 }),
    });
    renderHarness();

    tap("cancel");

    await Promise.resolve();
    expect(storedLive()?.id).toBe("s1");
  });

  it("confirms a ringing pomodoro into its break", async () => {
    seed({
      live: workSession({ startedAt: NOW - 25 * 60_000 - 1000, endsAt: NOW - 1000 }),
    });
    renderHarness();

    tap("confirm");

    await waitFor(() => expect(storedLive()?.kind).toBe("shortBreak"));
  });

  it("continues a ringing break onto the same work", async () => {
    seed({ live: breakSession() });
    renderHarness();

    tap("continue");

    await waitFor(() => expect(storedLive()?.kind).toBe("work"));
    expect(storedLive()?.categoryId).toBe(CATEGORY.id);
    expect(storedLive()?.durationMs).toBe(30 * 60_000);
  });

  it("opens the record", async () => {
    seed();
    renderHarness();

    tap("show-stats");

    await screen.findByText("/stats");
  });
});
