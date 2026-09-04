import { Link } from "react-router";

import { GithubMark } from "@/components/github-mark";
import { Button } from "@/components/ui/button";
import { copy } from "@/lib/copy";

/** Where the source lives, and the only outbound link on the page. */
const REPOSITORY = "https://github.com/yazdanctx/pomodorus";

/**
 * The front door: the hero, the pitch, the way in, and the personal note.
 *
 * Nothing on it is behind anything. There is no account to make and no login
 * — the timer is one tap away, and everything the app knows lives on this
 * device.
 */
export function LandingRoute() {
  return (
    <main className="flex flex-1 flex-col">
      <Hero />

      <div className="flex flex-col gap-8 px-6 pb-10 sm:gap-10">
        <p className="text-center text-sm sm:text-base md:text-lg">
          {copy.landing.pitch}
        </p>

        <Way />

        {/* The one dividing rule in the app. Everywhere else spacing does the
            separating; here the page genuinely changes register, from a pitch
            to somebody talking. */}
        <div className="h-0.5 bg-linear-to-r from-transparent via-border to-transparent" />

        <p className="text-xs leading-7 text-muted-foreground sm:text-sm sm:leading-8">
          {copy.landing.sub}
        </p>
      </div>
    </main>
  );
}

/**
 * The fixed hero, with the wordmark in the bottom band of its scrim.
 *
 * The wrapper owns the box rather than the image's intrinsic size, so the
 * layout is settled before a byte of the image has arrived and nothing moves
 * when it lands. It is the LCP element, so it is eager and high priority and
 * served exactly as it is — one AVIF, no resizing pipeline, because there is no
 * CDN in front of this and re-encoding it would only make it bigger.
 */
function Hero() {
  return (
    <div className="relative mt-5 aspect-video w-full shrink-0 overflow-hidden">
      <img
        src={`${import.meta.env.BASE_URL}main.avif`}
        alt=""
        // Decorative: the wordmark over it is the heading, and a screen reader
        // reading a description of the artwork here would only be in the way.
        aria-hidden
        fetchPriority="high"
        decoding="async"
        className="h-full w-full object-cover"
      />
      {/* Opaque at the bottom, clear at the top: the type sits in the band
          where the gradient can carry it whatever the image is doing. */}
      <div className="absolute inset-0 z-5 flex items-end justify-center bg-linear-to-t from-background via-background/50 to-transparent px-6 pb-4">
        {/* Grows at every breakpoint the pitch below it grows at. It used to
            hold text-3xl from a phone all the way to lg while the pitch went
            sm→base→lg underneath it, so the two converged in the middle of the
            range: 2.1× the pitch on a phone, 1.67× at 768. The wordmark has to
            stay the largest thing on the screen at every width, not just the
            two ends of it. */}
        <h1 className="text-center text-4xl font-light tracking-widest uppercase text-yellow-600 sm:text-5xl lg:text-6xl">
          {copy.landing.tagline}
        </h1>
      </div>
    </div>
  );
}

/**
 * The way in, beside the way to the source.
 *
 * Both buttons are the same fixed box — the layout is settled before anything
 * has to be decided, so nothing shifts under whoever is reading it.
 */
function Way() {
  return (
    <div className="flex flex-wrap items-center justify-center gap-3">
      <Button asChild size="lg" className="w-40">
        <Link to="/app">{copy.landing.goWork}</Link>
      </Button>

      <Button asChild size="lg" variant="outline" className="w-40">
        <a href={REPOSITORY} target="_blank" rel="noreferrer noopener">
          <GithubMark />
          {copy.landing.github}
        </a>
      </Button>
    </div>
  );
}
