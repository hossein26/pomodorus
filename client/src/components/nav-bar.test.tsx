import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { NavBar } from "@/components/nav-bar";
import { copy } from "@/lib/copy";
import { faClock, faElapsed } from "@/lib/format";
import { noteServerTime } from "@/lib/server-clock";
import { holding, renderAt, workSession } from "@/test/render";

/** The box the CTA and its placeholder must agree on, per the design tokens. */
const CTA_BOX = ["h-8", "min-w-24"];

function classesOf(el: Element): string[] {
  return el.className.split(/\s+/);
}

describe("NavBar", () => {
  it("keeps its own height", () => {
    renderAt(<NavBar />);
    expect(classesOf(screen.getByRole("banner"))).toContain("h-14");
  });

  describe("the record CTA", () => {
    it("links to the stats page", () => {
      renderAt(<NavBar />);

      const cta = screen.getByRole("link", { name: copy.header.stats });
      expect(cta).toHaveProperty("pathname", "/stats");
      expect(classesOf(cta)).toEqual(expect.arrayContaining(CTA_BOX));
    });
  });

  describe("the timer badge", () => {
    const NOW = 1_800_000_000_000;

    beforeEach(() => noteServerTime(NOW, performance.now()));

    it("offers the plain way in when nothing is live", () => {
      renderAt(<NavBar />, { session: holding(null) });

      expect(screen.getByText(copy.header.timer)).toBeTruthy();
    });

    it("reserves the box rather than guessing while the answer is on its way", () => {
      // A mid-pomodoro reload must not flash «تایمر» and swap to a countdown a
      // beat later: unknown is not the same as idle.
      renderAt(<NavBar />, { session: holding(undefined) });

      const placeholder = screen.getByTestId("nav-timer-placeholder");
      expect(classesOf(placeholder)).toEqual(expect.arrayContaining(CTA_BOX));
      expect(screen.queryByText(copy.header.timer)).toBeNull();
    });

    it("swaps the label for the countdown while a session runs", () => {
      renderAt(<NavBar />, {
        session: holding(workSession(NOW + 5 * 60_000)),
      });

      expect(screen.getByText(faClock(5 * 60_000))).toBeTruthy();
      expect(screen.queryByText(copy.header.timer)).toBeNull();
    });

    it("tints and pulses the icon while a session runs", () => {
      renderAt(<NavBar />, {
        session: holding(workSession(NOW + 5 * 60_000)),
      });

      const badge = screen.getByText(faClock(5 * 60_000));
      const link = badge.closest("a");
      expect(link).not.toBeNull();
      // An SVG's className is an SVGAnimatedString, not a string, so the
      // attribute is read directly rather than through classesOf.
      const icon = (link as Element).querySelector("svg");
      expect(icon).not.toBeNull();
      const iconClasses = (icon as Element).getAttribute("class") ?? "";
      expect(iconClasses).toContain("text-rose-500");
      expect(iconClasses).toContain("animate-pulse");
    });

    it("leaves the running badge's digits muted, so the ring still has somewhere to escalate to", () => {
      renderAt(<NavBar />, {
        session: holding(workSession(NOW + 5 * 60_000)),
      });

      const link = screen.getByText(faClock(5 * 60_000)).closest("a");
      expect(link).not.toBeNull();
      expect(classesOf(link as Element)).not.toContain("text-rose-500");
    });

    it("inverts to the ring time, and is the only red in the bar", () => {
      renderAt(<NavBar />, {
        session: holding(workSession(NOW - 65_000)),
      });

      // Counting up is the opposite of what this badge otherwise means, so
      // the inversion has to be legible at a glance, not just in the digits.
      const badge = screen.getByText(faElapsed(65_000));
      const link = badge.closest("a");
      expect(link).not.toBeNull();
      expect(classesOf(link as Element)).toEqual(
        expect.arrayContaining(["text-rose-500", "animate-pulse"]),
      );
    });
  });

  // The installed app's icon is a tile — a squircle with a gradient — because
  // it has to sit on a dock beside other tiles. In here it would be the only
  // rounded thing on screen, so the bar draws the line-art alone.
  describe("the mark", () => {
    it("is flat and untiled", () => {
      renderAt(<NavBar />);

      const mark = screen
        .getByRole("banner")
        .querySelector(`a[aria-label="${copy.app.name}"] svg`);
      expect(mark).not.toBeNull();

      // No tile: the squircle is a filled rect behind the artwork, and there
      // is no fill in the bar at all — the glyph is a stroke in currentColor,
      // so it tracks the foreground rather than carrying its own palette.
      expect(mark?.querySelector("rect")).toBeNull();
      expect(mark?.getAttribute("fill")).toBe("none");
      expect(mark?.getAttribute("stroke")).toBe("currentColor");
    });
  });
});
