import { useEffect } from "react";
import { Route, Routes } from "react-router";

import { Alarm } from "@/components/alarm";
import { NavBar } from "@/components/nav-bar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SessionProvider, type SessionValue } from "@/lib/session";
import { applyStoredAutoStart, useTraySync } from "@/lib/tray";
import { LandingRoute } from "@/routes/landing";
import { StatsRoute } from "@/routes/stats";
import { TimerRoute } from "@/routes/timer";

/**
 * The frame every screen sits inside: a centred column, thin side borders on
 * large screens only, a dark stone surround on desktop and flush black on a
 * phone. It is `min-h-screen` and a flex column so a route can claim the
 * remaining height with `flex-1` without measuring anything.
 */
const FRAME =
  "mx-auto overflow-x-hidden flex min-h-screen w-full max-w-xl flex-col border-x-0 bg-background lg:border-x lg:border-border/50";

/**
 * The menu bar widget's feed: pushes the timer's state across the preload
 * bridge on every tick. Outside the Mac shell there is no bridge and this
 * renders nothing.
 */
function TrayBridge() {
  useTraySync();
  useEffect(() => {
    applyStoredAutoStart();
  }, []);
  return null;
}

export function App({ session }: { session?: SessionValue }) {
  return (
    <SessionProvider value={session}>
      <TooltipProvider>
        {/* Outside the frame on purpose: the toaster portals to the body,
            and nesting it inside a `max-w-xl overflow-x-hidden` column would
            clip it. Direction and face it inherits from <html>. */}
        <Toaster />
        <div className={FRAME}>
          {/* Above the router, because the bell is: a pomodoro that ends
              while you are on the landing page still has to reach you. */}
          <Alarm />
          <TrayBridge />
          <NavBar />
          <Routes>
            <Route path="/" element={<LandingRoute />} />
            <Route path="/app" element={<TimerRoute />} />
            <Route path="/stats" element={<StatsRoute />} />
            {/* An unknown path is a mistyped or stale link, and the landing
                is the only page that explains what this is. */}
            <Route path="*" element={<LandingRoute />} />
          </Routes>
        </div>
      </TooltipProvider>
    </SessionProvider>
  );
}
