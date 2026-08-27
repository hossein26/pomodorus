package auth

import (
	"testing"
	"time"
)

var base = time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)

func TestThrottleAllowsUpToLimitThenRefuses(t *testing.T) {
	th := newThrottle(time.Minute, 3)
	for i := range 3 {
		if !th.allow("a", base) {
			t.Fatalf("attempt %d refused, want allowed", i+1)
		}
	}
	if th.allow("a", base) {
		t.Fatal("fourth attempt allowed, want refused")
	}
}

// The window slides: what falls out the back is forgotten, so a caller that
// waits is served rather than punished forever.
func TestThrottleWindowSlides(t *testing.T) {
	th := newThrottle(time.Minute, 2)
	th.allow("a", base)
	th.allow("a", base.Add(30*time.Second))
	if th.allow("a", base.Add(45*time.Second)) {
		t.Fatal("allowed while window full")
	}
	// The first event is now older than a minute; the second is not.
	if !th.allow("a", base.Add(61*time.Second)) {
		t.Fatal("refused after the oldest event expired")
	}
	if th.allow("a", base.Add(62*time.Second)) {
		t.Fatal("allowed twice after only one slot freed")
	}
}

// A refused attempt must not be recorded. If it were, a caller that keeps
// hammering would hold its own window permanently full and never recover —
// which also means the real user behind a shared address never recovers.
func TestThrottleRefusalDoesNotExtendTheBan(t *testing.T) {
	th := newThrottle(time.Minute, 1)
	th.allow("a", base)
	for i := range 50 {
		if th.allow("a", base.Add(time.Duration(i)*time.Second)) {
			t.Fatal("allowed while window full")
		}
	}
	// One window after the single recorded event, not after the last refusal.
	if !th.allow("a", base.Add(61*time.Second)) {
		t.Fatal("refusals extended the window")
	}
}

func TestThrottleKeysAreIndependent(t *testing.T) {
	th := newThrottle(time.Minute, 1)
	if !th.allow("a", base) || !th.allow("b", base) {
		t.Fatal("one key consumed another's allowance")
	}
	if th.allow("a", base) {
		t.Fatal("key a not limited")
	}
}

func TestThrottleRemainingDoesNotConsume(t *testing.T) {
	th := newThrottle(time.Minute, 2)
	if got := th.remaining("a", base); got != 2 {
		t.Fatalf("remaining = %d, want 2", got)
	}
	if got := th.remaining("a", base); got != 2 {
		t.Fatalf("remaining consumed an attempt: %d, want 2", got)
	}
	th.allow("a", base)
	if got := th.remaining("a", base); got != 1 {
		t.Fatalf("remaining = %d, want 1", got)
	}
}

// The number of keys is attacker-controlled — one per source address — so
// expired keys must not accumulate forever.
func TestThrottleSweepsExpiredKeys(t *testing.T) {
	th := newThrottle(time.Minute, 1)
	for i := range sweepAbove + 1 {
		th.allow(string(rune(i))+"x", base)
	}
	if len(th.seen) <= sweepAbove {
		t.Fatalf("expected the map to have grown past %d, got %d", sweepAbove, len(th.seen))
	}
	// One window later a single new call should collect everything stale.
	th.allow("fresh", base.Add(2*time.Minute))
	if len(th.seen) != 1 {
		t.Fatalf("sweep left %d keys, want only the fresh one", len(th.seen))
	}
}
