# Pomodorus

A minimal Persian-language pomodoro app for the Mac: a timer, your own record,
a menu bar widget, and launch at login.

Fully offline, no account. Electron shell around a Vite + React + TypeScript +
Tailwind v4 page; everything the app knows lives in `localStorage`. The design
reference is still the tree before the `v1-nextjs` tag — do not follow its
Next.js + Convex patterns — and so is the Go + Postgres backend that came
after it, which is gone (see `docs/adr/0006-offline-mac-app.md`).

## Layout

| | |
| --- | --- |
| `client/` | The app: the page in `src/`, the Mac shell in `electron/` |
| `client/src/lib/local-timer.ts` | The pomodoro's rules as pure functions |
| `client/src/lib/session.tsx` | The live session over `localStorage` |
| `client/electron/main.cjs` | Window, tray widget, hidden-window watchdog, login item |
| `client/electron/preload.cjs` | The only bridge: `setTray` out, `setAutoStart` out, nothing back |
| `docs/design-tokens.md` | The exact design values. Read before writing UI. |
| `docs/reference/` | Screenshots of v1 — the pixel target. |
| `docs/adr/` | Why the architecture is the way it is. |
| `docs/agents/` | How the engineering skills read this repo. |

## Agent skills

### Issue tracker

Issues live as GitHub issues on `yazdanctx/pomodorus`, via the `gh` CLI. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label string equal to its name. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the repo root plus `docs/adr/`. See
`docs/agents/domain.md`.

## Running it

`make dev` runs Vite on **:5174** (5173 is taken on this machine).
`make electron` runs the Mac shell against that dev server — one terminal
each. `make dist` builds `Pomodorus-*-arm64.dmg` into `client/release/`.
`make test` runs Vitest.

The Electron binary downloads into `node_modules` at install time; if the
postinstall did not run (npm's install-scripts policy), `node
node_modules/electron/install.js` fetches it, or drop the official
darwin-arm64 zip into `node_modules/electron/dist/` with `path.txt`
containing `Electron.app/Contents/MacOS/Electron`.

## Rules that are not obvious

**The design is fixed.** The UI matches v1 pixel for pixel. Values come from
`docs/design-tokens.md`, not from taste. In particular: `--radius: 0rem`
everywhere, no shadows, monochrome — errors are white/boxed/iconned rather than
red, and the *only* hue in the entire app is `rose-500` on a ringing timer
(plus `yellow-600`, which belongs to the wordmark alone).

**The device owns the timer.** A session is a stored fact in `localStorage` —
never a ticking clock. State is *derived* from those facts plus `now()`:
before `endsAt` it is running, after it and unconfirmed it is ringing. There
is no scheduler, no cron, and no job that flips anything. Do not add one. The
only exception is the main-process watchdog, whose sole job is ringing while
the window is hidden; it owns no state, and losing it costs a notification,
never correctness. The domain rules live in pure functions in
`client/src/lib/local-timer.ts`, ported from the old server and tested without
a window.

**Clocks.** Every stored instant is absolute epoch milliseconds, never
"seconds remaining". The device clock is trusted to measure elapsed time and
never to say what time it is: `lib/server-clock.ts` keeps a monotonic anchor.
`noteServerTime` is now only the tests' seam for pinning the clock.

**One live session**, held in storage. Starting when one is already live
returns the existing session rather than erroring.

**Nothing advances on its own.** A session that reaches its end rings until an
explicit tap. Work is credited at its exact nominal end regardless of when it
is confirmed, and the break is anchored at that end — so ring time is eaten out
of the break, and a long enough ring leaves none.

**The shell never decides.** The page owns every fact; the shell renders the
tray title, bounces the dock, and registers the login item. Ending a ring
stays the page's deliberate tap — the watchdog only announces. The bridge
(`preload.cjs`) carries `setTray` and `setAutoStart` outward and nothing back;
do not grow RPC over it.

**Closing parks, quitting quits.** Closing the window hides it into the menu
bar, where the countdown lives on in the tray title. Only the tray menu's
Quit — or ⌘Q — ends the process.

**There is no server.** No fetch, no WebSocket, no accounts, no feed, no
profiles, no push infrastructure, no service worker. Do not add a network call
the timer depends on. The one outbound link (GitHub, on the landing page)
opens in the real browser via `setWindowOpenHandler`.

**Offline is the whole scope.** History is capped (`HISTORY_CAP`) because the
device holds it all. There are no queues, no replay, no conflict resolution —
there is nobody to send to.

## Style

TypeScript + React: small components, Persian copy only via `copy.json`,
`serverNow()`-derived state rather than stored booleans. Tests seed
`localStorage` and assert what is on screen — the seam is storage, never a
component's internals.

Copy is Persian and lives in `client/src/copy.json` — extremely casual
Gen-Z register, including error messages. Repo docs stay formal.
