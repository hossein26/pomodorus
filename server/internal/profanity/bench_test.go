package profanity_test

import (
	"testing"

	"github.com/yazdanctx/pomodorus/server/internal/profanity"
)

// Contains sits on the hottest read in the app, and that is not obvious from
// its call sites: the feed re-checks every handle and every public task name
// on it, so one landing page runs the whole wordlist once per person working.
// A profile does the same per credited pomodoro in the range.
//
// It is benchmarked because it has already been the wrong shape once. Matching
// used to build `term + suffix` for twenty suffixes across four hundred terms
// on every call, which cost 150µs a word — a feed of a thousand people was a
// third of a second of CPU per read, on a container capped at one core, and
// the per-address rate limit sat above what the endpoint could actually serve.
// Nothing about it looked slow.
//
// So: a word should cost single-digit microseconds. If BenchmarkFeedOf1000
// climbs back into the hundreds of milliseconds, the feed is a denial of
// service again, and no test will say so.

func BenchmarkContainsHandle(b *testing.B) {
	for b.Loop() {
		profanity.Contains("loaduser1234")
	}
}

func BenchmarkContainsTaskName(b *testing.B) {
	for b.Loop() {
		profanity.Contains("نوشتن گزارش هفتگی")
	}
}

// One feed read's worth of checking: a thousand handles, and a public task
// name for the half of them that have one.
func BenchmarkFeedOf1000(b *testing.B) {
	for b.Loop() {
		for range 1000 {
			profanity.Contains("loaduser1234")
		}
		for range 500 {
			profanity.Contains("نوشتن گزارش هفتگی")
		}
	}
}
