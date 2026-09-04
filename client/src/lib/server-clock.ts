import { useEffect, useState } from "react";

/**
 * What time it is.
 *
 * The device's clock is trusted to measure elapsed time and never to say what
 * time it is. So this keeps an anchor — an instant paired with a reading of
 * the monotonic clock — and adds elapsed monotonic time to it. `Date.now()`
 * is deliberately not used after the first paint: it jumps when the user or
 * the OS corrects the clock, and a countdown that jumps with it would be a
 * countdown nobody could trust.
 *
 * There is no server to correct against any more, so the anchor starts at the
 * device's own clock and stays there. `noteServerTime` remains as the tests'
 * seam: pinning the clock is how a countdown becomes a statement about a
 * fixed instant rather than about when the suite happened to run.
 */
let anchorMonotonic = performance.now();
let anchorServer = Date.now();
let corrected = false;

/**
 * Fold an instant into the anchor.
 *
 * Kept for the tests, which pin the clock to their fixtures through it. The
 * round trip is split in half, which assumes the two legs took the same time.
 */
export function noteServerTime(serverNow: number, sentAtMonotonic: number) {
  const now = performance.now();
  anchorMonotonic = now;
  anchorServer = serverNow + (now - sentAtMonotonic) / 2;
  corrected = true;
}

/** The clock, in epoch milliseconds. */
export function serverNow(): number {
  return anchorServer + (performance.now() - anchorMonotonic);
}

/** Whether the clock has been pinned yet. */
export function isCorrected(): boolean {
  return corrected;
}

/**
 * Re-render on an interval, so a countdown ticks.
 *
 * The interval is the only thing repeating here — nothing is scheduled against
 * the session's end, because the end is derived from `endsAt` and this clock
 * every time it is read. A tick that is late, or that never fires because the
 * tab was asleep, therefore costs a stale frame and never a wrong state.
 */
export function useTick(everyMs = 250): number {
  const [now, setNow] = useState(serverNow);

  useEffect(() => {
    const id = setInterval(() => setNow(serverNow()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);

  return now;
}
