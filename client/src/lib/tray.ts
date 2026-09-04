import { useEffect } from "react";
import { useNavigate } from "react-router";

import { copy, t } from "@/lib/copy";
import { enClock, enElapsed } from "@/lib/format";
import { KEYS, read } from "@/lib/local-store";
import { serverNow, useTick } from "@/lib/server-clock";
import {
  breakSurvives,
  isBreak,
  isRinging,
  useSession,
  type Session,
} from "@/lib/session";
import type { Category } from "@/lib/categories";

/**
 * The menu bar widget, driven from the timer and driving it back.
 *
 * The shell renders the tray title and menu from the state pushed here every
 * second; menu taps come back as commands. The page stays authoritative —
 * every command resolves against the live session it finds, and the next
 * tick's state heals anything that raced.
 *
 * Outside Electron there is no bridge and all of this is a no-op, so web
 * development is unaffected.
 */

/** One menu action the shell offers, decided here where the copy lives. */
export type TrayAction = {
  /** The command the shell sends back when tapped. */
  id: TrayCommandId;
  label: string;
};

export type QuickStart = {
  categoryId: string;
  categoryName: string;
  durationMs: number;
  /** `شروع درس · 25 دقیقه` — Latin digits, like every number in the widget. */
  label: string;
};

export type TrayState =
  | { mode: "idle"; quickStart: QuickStart | null; emptyLabel: string }
  | {
      mode: "running";
      id: string;
      kind: "work" | "shortBreak" | "longBreak";
      label: string;
      /** Latin digits: the tray sits beside other apps' numbers. */
      title: string;
      endsAt: number;
      actions: TrayAction[];
    }
  | {
      mode: "ringing";
      id: string;
      kind: "work" | "shortBreak" | "longBreak";
      label: string;
      title: string;
      actions: TrayAction[];
    };

export type TrayCommandId =
  | "quick-start"
  | "cancel"
  | "confirm"
  | "continue"
  | "show-stats";

declare global {
  interface Window {
    electron?: {
      setTray?: (state: TrayState) => void;
      setAutoStart?: (enabled: boolean) => void;
      onCommand?: (handler: (id: TrayCommandId) => void) => () => void;
    };
  }
}

/** Whether the app is running inside the Mac shell. */
export function inElectron(): boolean {
  return typeof window !== "undefined" && window.electron !== undefined;
}

/** Ask the shell to launch at login — the autostart switch writes through here. */
export function setAutoStart(enabled: boolean): void {
  try {
    window.electron?.setAutoStart?.(enabled);
  } catch {
    // A preference that cannot be applied is still a preference worth keeping.
  }
}

/**
 * Apply the stored autostart choice to the shell. Called once at boot from
 * above the router, so the choice holds even if the start screen — where the
 * switch lives — is never opened.
 */
export function applyStoredAutoStart(): void {
  try {
    const raw = localStorage.getItem("pomodorus.autostart");
    setAutoStart(raw !== null && JSON.parse(raw) === true);
  } catch {
    // See above.
  }
}

const isCategories = (v: unknown): v is Category[] =>
  Array.isArray(v) &&
  v.every(
    (c): c is Category =>
      typeof c === "object" &&
      c !== null &&
      typeof (c as Category).id === "string" &&
      typeof (c as Category).name === "string",
  );

const isStringOrNull = (v: unknown): v is string | null =>
  v === null || typeof v === "string";

const isMinutes = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 15 && v <= 60 && v % 5 === 0;

/** What one tap on "start" would do with the current picks, if anything. */
export function readQuickStart(): QuickStart | null {
  const categories = read(KEYS.categories, isCategories) ?? [];
  const picked = read(KEYS.category, isStringOrNull);
  const minutes = read(KEYS.minutes, isMinutes) ?? 25;
  const category =
    picked !== null ? (categories.find((c) => c.id === picked) ?? null) : null;
  if (category === null) return null;
  return {
    categoryId: category.id,
    categoryName: category.name,
    durationMs: minutes * 60_000,
    label: `${copy.timer.start} ${category.name} · ${t(copy.timer.minutes, { m: String(minutes) })}`,
  };
}

/** What "another one" means from this break, resolved like the ring screen. */
function resolveResume(live: Session): { categoryId: string; durationMs: number } | null {
  const categories = read(KEYS.categories, isCategories) ?? [];
  const known = (id: string | null) =>
    id !== null && categories.some((c) => c.id === id) ? id : null;
  const picked = read(KEYS.category, isStringOrNull);
  const minutes = read(KEYS.minutes, isMinutes) ?? 25;
  const categoryId = known(live.resumeCategoryId) ?? known(picked);
  if (categoryId === null) return null;
  return {
    categoryId,
    durationMs: live.resumeDurationMs ?? minutes * 60_000,
  };
}

function actionsFor(live: Session, now: number): TrayAction[] {
  if (!isBreak(live)) {
    if (!isRinging(live, now)) {
      return [{ id: "cancel", label: copy.timer.cancelWork }];
    }
    return [
      {
        id: "confirm",
        label: breakSurvives(live, now)
          ? copy.timer.confirmWork
          : copy.timer.confirmWorkNoBreak,
      },
    ];
  }
  if (!isRinging(live, now)) {
    return [{ id: "cancel", label: copy.timer.skipBreak }];
  }
  const actions: TrayAction[] = [];
  if (resolveResume(live) !== null) {
    actions.push({ id: "continue", label: copy.timer.continueWork });
  }
  actions.push({ id: "confirm", label: copy.timer.confirmBreak });
  return actions;
}

export function useTraySync(): void {
  const { session } = useSession();
  const now = useTick(1000);

  useEffect(() => {
    const send = window.electron?.setTray;
    if (!send) return;
    try {
      if (session == null) {
        send({
          mode: "idle",
          quickStart: readQuickStart(),
          emptyLabel: copy.categories.firstTitle,
        });
      } else if (isRinging(session, now)) {
        send({
          mode: "ringing",
          id: session.id,
          kind: session.kind,
          label: session.categoryName ?? "",
          title: enElapsed(now - session.endsAt),
          actions: actionsFor(session, now),
        });
      } else {
        send({
          mode: "running",
          id: session.id,
          kind: session.kind,
          label: session.categoryName ?? "",
          title: enClock(session.endsAt - now),
          // The main process arms its own watchdog on this instant, which is
          // what rings on time while the window is hidden and its own timers
          // are throttled. The renderer stays authoritative: only a deliberate
          // tap — here or in the window — ends a ring.
          endsAt: session.endsAt,
          actions: actionsFor(session, now),
        });
      }
    } catch {
      // The menu bar is decoration: it must never break the timer.
    }
  }, [session, now]);
}

/**
 * Taps from the menu bar, applied to the live session found — never to an id
 * the shell remembered, which may be a second out of date.
 */
export function useTrayCommands(): void {
  const { session, start, cancel, confirm } = useSession();
  const navigate = useNavigate();

  useEffect(() => {
    const subscribe = window.electron?.onCommand;
    if (!subscribe) return;
    return subscribe((id: TrayCommandId) => {
      void (async () => {
        try {
          if (id === "show-stats") {
            navigate("/stats");
            return;
          }
          if (id === "quick-start") {
            if (session != null) return;
            const next = readQuickStart();
            if (next === null) return;
            await start(next.categoryId, next.durationMs);
            return;
          }
          if (session == null) return;
          if (id === "cancel") {
            if (isRinging(session, serverNow())) return;
            await cancel(session.id);
            return;
          }
          if (id === "confirm") {
            if (!isRinging(session, serverNow())) return;
            await confirm(session.id);
            return;
          }
          if (id === "continue") {
            if (!isBreak(session) || !isRinging(session, serverNow())) return;
            const resume = resolveResume(session);
            if (resume === null) return;
            await confirm(session.id);
            await start(resume.categoryId, resume.durationMs);
          }
        } catch {
          // Headless taps report nothing: the next tick's state is the
          // answer, and a failed tap simply leaves the menu as it was.
        }
      })();
    });
  }, [session, start, cancel, confirm, navigate]);
}
