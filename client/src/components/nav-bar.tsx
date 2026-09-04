import { BellRing, Scan, Timer } from "lucide-react";
import { Link } from "react-router";

import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { copy } from "@/lib/copy";
import { faClock, faElapsed } from "@/lib/format";
import { useTick } from "@/lib/server-clock";
import { isRinging, useSession } from "@/lib/session";

/**
 * Both header CTAs and the placeholder standing in for the timer share one
 * box, so the bar is exactly as wide before the timer state resolves as
 * after.
 */
const CTA_BOX = "h-8 min-w-24";

export function NavBar() {
  return (
    // h-14 rather than padding alone: the bar keeps its height even in the
    // beat before the timer state resolves, so nothing below it ever moves.
    <header className="flex h-14 w-full shrink-0 items-center justify-between px-6">
      <Link to="/" aria-label={copy.app.name}>
        <Logo />
      </Link>
      <nav className="flex items-center gap-2 text-sm text-muted-foreground">
        <TimerCta />
        <Button asChild size="sm" variant="outline" className={CTA_BOX}>
          <Link to="/stats">{copy.header.stats}</Link>
        </Button>
      </nav>
    </header>
  );
}

/**
 * The way back to the timer, and — while one is live — what it is doing.
 *
 * A running session swaps the label for the countdown. A ringing one keeps the
 * badge rather than losing it: that is the moment you most need a way back in,
 * and on a reloaded window, where audio is suspended until you touch the page,
 * it may be the only thing saying so. It counts *up*, which is the opposite of
 * what this badge otherwise means, so it inverts — red and belled rather than
 * plain and scanned. The inversion has to be legible at a glance, not just in
 * the digits.
 *
 * The digits sit in a fixed box so the CTA beside them does not shuffle every
 * time a minute rolls over — and the badge reserves that box while the answer
 * is still on its way, rather than guessing at «تایمر» and swapping to a
 * countdown a beat later on every mid-pomodoro reload.
 */
function TimerCta() {
  const { session } = useSession();
  const now = useTick();

  // min-w rather than w: it reserves the digits' box so a rolling minute does
  // not shuffle the CTA beside it, while a ring hours old (+۱۸۰:۰۰) is still
  // allowed to grow rather than spill out of it.
  const clock = "flex min-w-10 justify-start tabular-nums";

  if (session === undefined) {
    return <Skeleton className={CTA_BOX} data-testid="nav-timer-placeholder" />;
  }

  if (session === null) {
    return (
      <Button asChild size="sm" variant="outline">
        <Link to="/app" className="hover:text-foreground">
          <Timer size={15} />
          {copy.header.timer}
        </Link>
      </Button>
    );
  }

  if (isRinging(session, now)) {
    return (
      <Button asChild size="sm" variant="outline">
        <Link to="/app" className="animate-pulse text-rose-500">
          <span className={clock} dir="ltr">
            {faElapsed(now - session.endsAt)}
          </span>
          <BellRing size={15} />
        </Link>
      </Button>
    );
  }

  // Running. The hue lands on the icon and nowhere else — v1 did the same, and
  // the restraint is what keeps the ring's inversion legible: red-icon becomes
  // red-everything, outlined becomes belled, counting down becomes counting up.
  // A badge already red all over would have nothing left to escalate into.
  return (
    <Button asChild size="sm" variant="outline">
      <Link to="/app" className="hover:text-foreground">
        <span className={clock} dir="ltr">
          {faClock(session.endsAt - now)}
        </span>
        <Scan size={15} className="animate-pulse text-rose-500" />
      </Link>
    </Button>
  );
}
