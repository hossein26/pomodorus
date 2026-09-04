/**
 * The device's facts: every slice of state the app owns, kept in localStorage.
 *
 * There is no queue of unsent writes and nothing to merge, because there is
 * nobody to send to — a write that has landed in storage has happened, on the
 * only copy that exists. Losing storage costs history, never correctness of
 * what is on screen.
 */

const PREFIX = "pomodorus.";

export const KEYS = {
  categories: `${PREFIX}categories`,
  intervals: `${PREFIX}intervals`,
  live: `${PREFIX}live`,
  history: `${PREFIX}history`,
  minutes: `${PREFIX}minutes`,
  category: `${PREFIX}category`,
  autoStart: `${PREFIX}autostart`,
} as const;

/** Read and validate, falling back to nothing on any doubt. */
export function read<T>(key: string, isValid: (value: unknown) => value is T): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist, silently surviving private mode and full quotas. */
export function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Forgetting is not worth interrupting somebody's pomodoro over.
  }
}

export function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // See above.
  }
}
