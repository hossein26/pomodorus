import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";

import { CLASSIC } from "@/lib/intervals";
import {
  SessionProvider,
  type Session,
  type SessionValue,
} from "@/lib/session";

/**
 * Render a piece of the app at a chosen route and a chosen timer state.
 *
 * The live session is injected rather than read from storage for the states
 * that matter here, because `undefined` — the beat before storage has been
 * read — is the one that is hardest to hold still and the one the
 * layout-shift rules are actually about.
 */
export function renderAt(
  ui: ReactNode,
  { path = "/", session }: { path?: string; session?: SessionValue } = {},
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider value={session}>{ui}</SessionProvider>
    </MemoryRouter>,
  );
}

/**
 * A session context holding exactly this session, with mutations that do
 * nothing — for the components that only read it.
 *
 * Everything but the session is defaulted and overridable in one bag, because
 * these travelled as four positional optionals and the fourth could not be set
 * to `undefined` at all: passing it explicitly took the parameter's default.
 */
export function holding(
  session: Session | null | undefined,
  over: Partial<SessionValue> = {},
): SessionValue {
  return {
    session,
    cycle: { count: 0 },
    intervals: CLASSIC,
    today: { count: 0, totalMs: 0 },
    start: async () => null,
    cancel: async () => {},
    confirm: async () => null,
    save: async () => {},
    reload: async () => {},
    // Spread last so a caller can override any of it — including with an
    // explicit `undefined`, which a defaulted positional parameter would have
    // quietly replaced with its default.
    ...over,
  };
}

/** The fixture work session, twenty-five minutes ending `endsAt`. */
export function workSession(endsAt: number, over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    kind: "work",
    categoryId: "c1",
    categoryName: "درس",
    startedAt: endsAt - 25 * 60_000,
    endsAt,
    durationMs: 25 * 60_000,
    // The five minutes it owes, anchored at its own end — so a ring that
    // reaches this instant has spent the whole of it.
    breakEndsAt: endsAt + 5 * 60_000,
    resumeCategoryId: null,
    resumeDurationMs: null,
    breakSnapshot: { shortMs: 5 * 60_000, longMs: 20 * 60_000 },
    ...over,
  };
}
