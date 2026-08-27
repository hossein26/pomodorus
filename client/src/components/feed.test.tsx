import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Feed } from "@/components/feed";
import { renderAt } from "@/test/render";

function server(entries: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ entries, serverNow: Date.now() }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ),
  );
}

const entry = (over: Record<string, unknown> = {}) => ({
  handle: "yazdanctx",
  kind: "work",
  task: "کدنویسی ایجنتیک",
  endsAt: Date.now() + 10 * 60_000,
  ...over,
});

async function row() {
  const link = await screen.findByRole("link", { name: "yazdanctx" });
  const p = link.closest("p");
  if (!p) throw new Error("row paragraph not found");
  return p;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The row is a Latin handle, an em dash and a task name in whichever language
 * its owner typed it. Left to the bidi algorithm those three resolve
 * differently depending on the task, and the handle changes sides — so what is
 * pinned here is the mechanism that stops it, not a rendered order jsdom
 * cannot compute.
 */
describe("feed row direction", () => {
  it("states its direction rather than inheriting it", async () => {
    server([entry()]);
    renderAt(<Feed />);
    expect((await row()).getAttribute("dir")).toBe("rtl");
  });

  it.each([
    ["Persian", "کدنویسی ایجنتیک"],
    ["English", "Agentic Coding"],
    ["mixed", "Docker یادگیری"],
    ["digit-leading", "۲۰۲۶ planning"],
  ])("isolates the handle and a %s task from each other", async (_, task) => {
    server([entry({ task })]);
    renderAt(<Feed />);

    const parts = (await row()).querySelectorAll("bdi");
    expect(parts).toHaveLength(2);
    // Handle first, task second — in that order, always, whatever the task is
    // written in. With both sides isolated this document order is also the
    // visual order, because the dash between them can no longer be folded into
    // a left-to-right run by its neighbours.
    expect(parts[0].textContent).toBe("yazdanctx");
    expect(parts[1].textContent).toBe(task);
  });

  it("isolates the break label too, which is not user-supplied but shares the row", async () => {
    server([entry({ kind: "shortBreak", task: null })]);
    renderAt(<Feed />);
    await waitFor(async () =>
      expect((await row()).querySelectorAll("bdi")).toHaveLength(2),
    );
  });
});
