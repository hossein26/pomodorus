import { useEffect } from "react";

import { faClock, faElapsed } from "@/lib/format";
import { isRinging, useSession } from "@/lib/session";
import { useTick } from "@/lib/server-clock";

/**
 * The menu bar widget, driven from the timer.
 *
 * Under Electron the app also lives in the Mac menu bar: the tray title shows
 * the countdown while running and the ring time while ringing, and its menu
 * offers the timer's own actions. This hook pushes the timer's state across
 * the preload bridge on every tick; outside Electron there is no bridge and
 * this is a no-op, so web development is unaffected.
 */

export type TrayState =
  | { mode: "idle" }
  | { mode: "running"; id: string; label: string; title: string; endsAt: number }
  | { mode: "ringing"; id: string; label: string; title: string };

declare global {
  interface Window {
    electron?: {
      setTray?: (state: TrayState) => void;
      setAutoStart?: (enabled: boolean) => void;
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

export function useTraySync(): void {
  const { session } = useSession();
  const now = useTick(1000);

  useEffect(() => {
    const send = window.electron?.setTray;
    if (!send) return;
    try {
      if (session == null) {
        send({ mode: "idle" });
      } else if (isRinging(session, now)) {
        send({
          mode: "ringing",
          id: session.id,
          label: session.categoryName ?? "",
          title: faElapsed(now - session.endsAt),
        });
      } else {
        send({
          mode: "running",
          id: session.id,
          label: session.categoryName ?? "",
          title: faClock(session.endsAt - now),
          // The main process arms its own watchdog on this instant, which is
          // what rings on time while the window is hidden and its own timers
          // are throttled. The renderer stays authoritative: only a deliberate
          // tap there ends a ring.
          endsAt: session.endsAt,
        });
      }
    } catch {
      // The menu bar is decoration: it must never break the timer.
    }
  }, [session, now]);
}
