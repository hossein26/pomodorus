import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { copy } from "@/lib/copy";
import { LandingRoute } from "@/routes/landing";
import { renderAt } from "@/test/render";

const renderLanding = () => renderAt(<LandingRoute />);

describe("the landing page", () => {
  it("renders for somebody opening the app", () => {
    renderLanding();

    // The wordmark, the pitch, the way in, the note — all of it, with no
    // account and no request having to succeed first.
    expect(screen.getByRole("heading", { name: copy.landing.tagline })).toBeTruthy();
    expect(screen.getByText(copy.landing.pitch)).toBeTruthy();
    expect(screen.getByText(copy.landing.sub)).toBeTruthy();
    expect(screen.getByRole("link", { name: copy.landing.goWork })).toBeTruthy();
  });

  it("sends the way in straight to the timer", () => {
    renderLanding();

    expect(
      screen.getByRole("link", { name: copy.landing.goWork }),
    ).toHaveProperty("pathname", "/app");
  });

  it("links to the source", () => {
    renderLanding();

    const link = screen.getByRole("link", { name: new RegExp(copy.landing.github) });
    expect(link.getAttribute("href")).toContain("github.com");
    // A new tab, and no window.opener handed to it.
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("paints the hero as its own box, so nothing moves when the image lands", () => {
    const { container } = renderLanding();

    const hero = container.querySelector("img");
    expect(hero?.getAttribute("src")).toContain("main.avif");
    // The wrapper owns the aspect ratio; the image has no intrinsic size here.
    expect(hero?.parentElement?.className).toContain("aspect-video");
    expect(hero?.getAttribute("fetchpriority")).toBe("high");
  });
});
