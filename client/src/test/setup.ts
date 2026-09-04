import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom implements no layout, so it has no ResizeObserver. cmdk observes its
// list to keep the selected item in view — a behaviour that needs a viewport
// to mean anything, and that a test asserting on text does not exercise. A
// no-op is the honest stand-in.
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Nor does it implement scrollIntoView, which cmdk calls for the same reason.
Element.prototype.scrollIntoView ??= () => {};

// Nor elementFromPoint, which is layout again: Sonner asks what is under the
// pointer to decide whether a toast is being hovered or swiped. It asks on a
// timer, so the throw lands *after* whichever test raised the toast has already
// passed — an uncaught exception attributed to a test that did nothing wrong.
// Nothing is under a point in a document with no layout, so null is the honest
// answer rather than a stand-in.
document.elementFromPoint ??= () => null;

// Node 26 ships an experimental global `localStorage` that is unusable without
// a `--localstorage-file` flag — and it shadows jsdom's working one, so the
// bare name resolves to `undefined` with a warning. Storage is the app's seam,
// so the suite stands one in: an in-memory map behind the Web Storage shape.
function storageUsable(): boolean {
  try {
    return (
      typeof localStorage !== "undefined" &&
      localStorage !== null &&
      typeof localStorage.getItem === "function"
    );
  } catch {
    return false;
  }
}

if (!storageUsable()) {
  const backing = new Map<string, string>();
  const standIn = {
    get length() {
      return backing.size;
    },
    key(index: number): string | null {
      return [...backing.keys()][index] ?? null;
    },
    getItem(key: string): string | null {
      return backing.has(key) ? (backing.get(key) as string) : null;
    },
    setItem(key: string, value: string): void {
      backing.set(key, String(value));
    },
    removeItem(key: string): void {
      backing.delete(key);
    },
    clear(): void {
      backing.clear();
    },
  };
  try {
    Object.defineProperty(globalThis, "localStorage", {
      value: standIn,
      configurable: true,
      writable: true,
    });
  } catch {
    // A host that will not take the stand-in keeps its own answer.
  }
}

// The timer mints ids with the platform's random UUID, which jsdom does not
// always provide. A counter is the honest stand-in: uniqueness within a test
// is all anything here relies on.
if (
  typeof globalThis.crypto === "undefined" ||
  typeof (globalThis.crypto as Crypto).randomUUID !== "function"
) {
  let next = 0;
  (globalThis as Record<string, unknown>).crypto = {
    randomUUID: () => `test-id-${++next}`,
  };
}
// Vitest is run without globals, so React Testing Library's own auto-cleanup
// never registers itself. Unmounting between tests is what stops one test's
// document from being queryable in the next.
afterEach(cleanup);

// Persisted preferences are per-device, and in a test run the device is shared
// by every test in the file. One test's remembered length must not become the
// next one's starting point.
afterEach(() => localStorage.clear());
