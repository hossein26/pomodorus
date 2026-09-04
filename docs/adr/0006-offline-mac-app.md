# 0006 — Offline Mac app, no server

## Status

Accepted. Supersedes 0001 (server-authoritative timer), 0003 (email OTP +
immutable handle) and 0005 (one binary on an Iranian host) for this product;
extends 0002 (derived state, no scheduler) and 0004 (one live session,
confirmed transitions) onto the device.

## Context

The web product — Go API, Postgres, WebSocket fan-out, OTP login, global feed,
public profiles, Web Push — served its purpose and priced every session in
operational complexity: a database, an SMTP path through sanctions, VAPID
permanence, per-account rate limits behind CGNAT, and a deploy that refuses to
boot without secrets. The actual use is one person, on one Mac, timing their
own work.

## Decision

- The timer moves back onto the device. The domain rules (bands, break
  anchoring with ring-eats-break, cycle walked from history, nominal-end
  crediting) are ported verbatim from the Go timer package into
  `client/src/lib/local-timer.ts` as pure functions; storage replaces the
  `sessions` table. 0002 and 0004 survive unchanged in behaviour.
- There are no accounts, no feed, no public profiles, no push infrastructure.
  The profile chart becomes a private on-device record (`routes/stats.tsx`).
- The Mac shell is Electron, not Tauri: this machine has no Rust toolchain and
  the UI is already a web page. The shell owns the window, the tray countdown,
  a hidden-window bell watchdog, and the login item — nothing about the timer.
- History is capped in storage (`HISTORY_CAP`); beyond the cap the oldest
  sessions fall off the cycle walk and the record together.

## Consequences

- `server/`, `deploy/`, the Docker and Liara footprint, and every client
  transport (`api`, `socket`, `auth`, `push`, `feed`, server `profile`, the
  service worker) are deleted. What remains of the backend is this ADR series
  and the semantics they pinned.
- Multi-device sync is gone by construction. A second window on the same Mac
  still agrees, because storage events re-read the same facts.
- Release is a `.dmg`, unsigned until signing is attached; an unsigned build
  cannot register a login item, so the autostart choice is stored and applied
  from the first signed run.
