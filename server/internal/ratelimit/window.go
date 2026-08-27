package ratelimit

import (
	"sync"
	"time"
)

// sweepAbove bounds the memory a flood can cost. Each key holds at most `limit`
// timestamps, so the ceiling is small — but the number of *keys* is attacker
// controlled, one per source address, and nothing prunes a key that simply
// stops being used. Above this many keys every expired entry is dropped.
const sweepAbove = 10_000

// Window counts events in a sliding window, in memory.
//
// In memory rather than in Postgres, and the distinction matters. The per
// address and per IP limits on issuing login codes are database counts because
// they have to survive a restart: a code already mailed is a fact about the
// world, and forgetting it would let a restart mint fresh quota. These are
// different. They exist to make bulk abuse expensive inside a window measured
// in minutes, and losing them on a deploy costs one window of protection rather
// than any correctness. Keeping them out of the database is also the point
// under load: a flood is trying to exhaust exactly the resource a
// database-backed limiter would spend on it.
//
// One process holds the whole truth, which is true by construction rather than
// by luck — the deployment is a single instance, for the reasons in
// docs/deploy-vps.md. A second replica would each get their own allowance, and
// this would need to move behind the same seam as the broadcaster.
//
// The clock is passed in on every call rather than held, because both callers
// already have one: the auth service reasons from the injected clock, and so a
// limit that read time for itself would be a limit a test could not move.
type Window struct {
	mu     sync.Mutex
	window time.Duration
	limit  int
	seen   map[string][]time.Time
}

// New builds a window that allows `limit` events per `window` per key.
func New(window time.Duration, limit int) *Window {
	return &Window{window: window, limit: limit, seen: make(map[string][]time.Time)}
}

// Allow reports whether an event is within the limit, recording it if so.
//
// A refused event is deliberately not recorded. Recording it would let a caller
// that keeps hammering hold its own window permanently full, so the punishment
// for stopping and the punishment for continuing would be the same — and an
// attacker who never stops would never come back into service even after the
// legitimate user behind the same address gave up.
func (t *Window) Allow(key string, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()

	cutoff := now.Add(-t.window)
	live := prune(t.seen[key], cutoff)
	if len(live) >= t.limit {
		t.seen[key] = live
		return false
	}
	t.seen[key] = append(live, now)

	if len(t.seen) > sweepAbove {
		t.sweepLocked(cutoff)
	}
	return true
}

// Remaining is for tests and for saying something useful in a log line. It does
// not record anything.
func (t *Window) Remaining(key string, now time.Time) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	n := t.limit - len(prune(t.seen[key], now.Add(-t.window)))
	if n < 0 {
		return 0
	}
	return n
}

func (t *Window) sweepLocked(cutoff time.Time) {
	for key, times := range t.seen {
		live := prune(times, cutoff)
		if len(live) == 0 {
			delete(t.seen, key)
			continue
		}
		t.seen[key] = live
	}
}

// prune drops timestamps that have fallen out of the window, filtering in place
// because the result is always a prefix of the input.
func prune(times []time.Time, cutoff time.Time) []time.Time {
	live := times[:0]
	for _, at := range times {
		if at.After(cutoff) {
			live = append(live, at)
		}
	}
	return live
}
