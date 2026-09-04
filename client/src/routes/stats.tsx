import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import { DayDetail } from "@/components/profile/day-detail";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { copy, t } from "@/lib/copy";
import { faDigits } from "@/lib/format";
import {
  buildDays,
  DEFAULT_RANGE,
  everFocused,
  RANGES,
  selectDay,
  type ChartDay,
  type Range,
} from "@/lib/stats";

/**
 * Loaded only when somebody opens the record.
 *
 * The charting library is around half the weight of everything else in the app
 * put together, and this is the one screen that uses it — the landing page and
 * the timer must not pay for it.
 */
const FocusChart = lazy(async () => ({
  default: (await import("@/components/profile/focus-chart")).FocusChart,
}));

/**
 * Your own record: how much you have focused per day.
 *
 * Read off this device's history, which is the only copy there is. Nothing
 * here leaves the machine — there is nobody to send a link to, so there is no
 * handle, no public page, and no masking.
 */
export function StatsRoute() {
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  // A generation counter rather than the days themselves: the aggregation is
  // synchronous off storage, so re-reading is re-rendering.
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const refresh = () => setGeneration((n) => n + 1);
    window.addEventListener("storage", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  const days = useMemo(() => buildDays(range), [range, generation]);
  const focused = useMemo(() => everFocused(), [generation]);
  // The day being pointed at — a gesture rather than a fact about the record,
  // so it is held here and not in the days. A day pointed at in one range and
  // still present in the next stays selected; one that falls outside gives way
  // to the most recent day with anything in it, which is what the page opens
  // on.
  const [pointed, setPointed] = useState<string | null>(null);
  const selected = selectDay(days, pointed);

  return (
    <main className="flex flex-1 flex-col gap-6 p-6">
      <h1 className="text-base font-medium">{copy.stats.title}</h1>

      <section>
        {/* The shell — the heading and the presets — never moves. Only the
            chart below falls back while its code arrives, so opening the page
            does not reflow under the finger that pressed it. */}
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-medium">{copy.profile.focusPerDay}</h2>
          <Ranges value={range} onChange={setRange} />
        </div>

        <div className="mt-4">
          {!focused ? (
            // Never focused at all, which is not the same as a range that
            // happens to be empty: a week off is a flat line, and the zero-fill
            // exists to draw it.
            <Empty />
          ) : (
            <Suspense fallback={<ChartSkeleton />}>
              <FocusChart
                days={days}
                selected={selected?.day ?? null}
                onSelect={setPointed}
              />
              <DayPanel day={selected?.detail} />
            </Suspense>
          )}
        </div>
      </section>
    </main>
  );
}

/**
 * The docked day detail, and the fade between one day and the next.
 *
 * The outgoing panel finishes leaving before the incoming one arrives, rather
 * than the two dissolving through each other: they differ in height with the
 * length of the task list, and running them together would shunt the page
 * around under whoever is reading it.
 *
 * A day with nothing in it has no panel at all — not a panel that says ۰:۰۰
 * over an empty list — so the fade is also how the panel goes away.
 */
function DayPanel({ day }: { day: ChartDay | undefined }) {
  const [shown, setShown] = useState(day);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (day?.day === shown?.day) {
      if (day !== shown) setShown(day);
      return;
    }
    setLeaving(true);
    const handover = setTimeout(() => {
      setShown(day);
      setLeaving(false);
    }, FADE_MS);
    return () => clearTimeout(handover);
  }, [day, shown]);

  if (shown === undefined) return null;

  return (
    // Keyed by the day, so each one is its own arrival: the outgoing panel
    // fades out on this element, and the incoming one is a fresh element that
    // fades in.
    <div
      key={shown.day}
      className={`duration-300 ease-out ${
        leaving ? "opacity-0 transition-opacity" : "animate-in fade-in-0"
      }`}
    >
      {/* Nothing is shared from here, so there is no owner note to read. The
          banner seed is fixed: the art is a property of the date. */}
      <DayDetail day={shown} handle="stats" owner={false} />
    </div>
  );
}

/** Matches the `duration-300` the panel fades over. */
const FADE_MS = 300;

/** The chart area's exact box, held while its code arrives. */
function ChartSkeleton() {
  return <Skeleton className="h-44 w-full" />;
}

/**
 * The three presets, and no custom picker.
 *
 * The selected one is filled and the others are quiet, which is the only
 * signal — there is no hue available to mark a selection with.
 */
function Ranges({
  value,
  onChange,
}: {
  value: Range;
  onChange: (range: Range) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {RANGES.map((days) => (
        <Button
          key={days}
          size="xs"
          variant={days === value ? "secondary" : "ghost"}
          aria-pressed={days === value}
          onClick={() => onChange(days)}
        >
          {t(copy.profile.rangeDays, { n: faDigits(days) })}
        </Button>
      ))}
    </div>
  );
}

/** Nobody has finished a pomodoro on this device yet. */
function Empty() {
  return (
    <div className="mt-6 flex flex-col items-center gap-6 border p-12 text-center sm:p-20">
      <p className="text-sm text-muted-foreground">{copy.profile.emptyTitle}</p>
    </div>
  );
}
