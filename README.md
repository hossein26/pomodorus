# Pomodorus

A minimal Persian-language pomodoro app for the Mac: a timer, your own record,
a menu bar widget, and launch at login.

Fully offline, no account. Everything the app knows lives on this device, in
`localStorage`. The design is carried over unchanged from the original web
version.

## Requirements

Node 22+.

## Getting started

```bash
cd client && npm install
make dev       # Vite on :5174
```

Or the Mac shell against the same dev server — one terminal each:

```bash
make dev       # terminal one
make electron  # terminal two
```

## The Mac app

```bash
make dist   # Pomodorus-*-arm64.dmg (and .zip) in client/release/
```

What the shell owns, and the page does not:

- **Menu bar widget** — the tray title shows the countdown while running and
  the ring time while ringing (`● +mm:ss`); the menu offers showing the timer,
  the login-item switch, and quitting. Closing the window parks the app in the
  menu bar rather than quitting.
- **The bell while hidden** — a hidden window's timers are throttled, so the
  main process arms its own watchdog on the session's end and rings (dock
  bounce + notification) if the window is still hidden. Ending the ring stays
  the page's deliberate tap.
- **Launch at login** — `setLoginItemSettings`, through the switch on the start
  screen («با روشن شدن مک باز شو»), mirrored in the tray menu. Unsigned local
  builds cannot register a login item; the choice is still stored and applies
  from the first signed run.

Headless proof that the packaged app renders, with no display:

```bash
POMODORUS_SMOKE=/tmp/shot.png POMODORUS_ROUTE="#/app" ./client/release/mac-arm64/Pomodorus.app/Contents/MacOS/Pomodorus
```

## Layout

| | |
| --- | --- |
| `client/` | Vite + React + TypeScript + Tailwind v4, plus the Electron shell in `client/electron/` |
| `client/src/lib/local-timer.ts` | The pomodoro's rules as pure functions (ported from the old Go timer) |
| `client/src/lib/session.tsx` | The live session over `localStorage`: start/cancel/confirm/save |
| `client/src/routes/stats.tsx` | Your own record, aggregated on-device |
| `docs/design-tokens.md` | The design, as exact values |
| `docs/reference/` | Screenshots of v1 — the pixel target |
| `docs/adr/` | Architecture decisions and why |

## Testing

```bash
make test   # Vitest
```

The suite's seam is storage: tests seed `localStorage` and assert what is on
screen. Note: on Node 26 the global `localStorage` is an unusable experimental
stub that shadows jsdom's — `src/test/setup.ts` stands in an in-memory one.

## The previous versions

Everything up to the `v1-nextjs` tag was Next.js + Convex, with a local-first
offline timer. After that came a Go + Postgres + WebSocket backend with
accounts, a global feed and public profiles — removed in favour of this
offline Mac app (see `docs/adr/0006-offline-mac-app.md`):

```bash
git show v1-nextjs:components/timer-app.tsx
```
