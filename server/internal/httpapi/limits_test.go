package httpapi_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/yazdanctx/pomodorus/server/internal/apitest"
)

// The two ceilings, written out rather than exported from the handler so that a
// test asserting about them is not agreeing with whatever they happen to be.
const (
	writesPerMinute   = 60
	requestsPerMinute = 600
)

// spendWrites starts and abandons a pomodoro until a write is refused, and says
// how many landed first.
//
// Start-then-abandon is the loop worth defending against: each pass pushes the
// timer to every socket this person has open, reads the whole feed and pushes
// that to everybody watching. It is one cheap POST turning into all of that,
// which is the only amplification in the app.
//
// Counted rather than asserted exactly, because signing in and making a task
// are writes too and the test should not have to know how many the helpers
// spent. What is being pinned down is that there *is* a ceiling near the stated
// one, not the arithmetic of getting to it.
func spendWrites(t *testing.T, h *apitest.Harness, client *apitest.Client, category string) int {
	t.Helper()
	for landed := range writesPerMinute * 2 {
		res := start(client, category, pomodoro)
		if res.Status == http.StatusTooManyRequests {
			return landed
		}
		live := payload(t, res).Session
		if res := client.POST("/api/session/"+live.ID+"/cancel", nil); res.Status == http.StatusTooManyRequests {
			return landed
		}
	}
	t.Fatalf("writes were never refused, so there is no ceiling")
	return 0
}

func TestWritesAreLimitedPerAccountRatherThanPerAddress(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)

	landed := spendWrites(t, h, client, category)
	if landed*2 > writesPerMinute {
		t.Errorf("%d start/abandon pairs landed before the ceiling of %d writes", landed, writesPerMinute)
	}
	start(client, category, pomodoro).ExpectError(http.StatusTooManyRequests, "rate_limited")

	// Somebody else is untouched, which is the whole point of keying this by
	// account. A carrier-grade NAT address is thousands of people, and an
	// allowance they shared would be one of them able to lock out a network.
	other := h.SignIn(addressN(1))
	claim(other, "someone_else").ExpectStatus(http.StatusOK)
	theirs := createdCategory(t, createCategory(other, "کار", false)).ID
	start(other, theirs, pomodoro).ExpectStatus(http.StatusOK)
}

func TestTheWriteWindowSlides(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)

	spendWrites(t, h, client, category)
	start(client, category, pomodoro).ExpectError(http.StatusTooManyRequests, "rate_limited")

	// A minute later the allowance is back. Being refused is a moment rather
	// than a punishment: somebody who put their phone down must not come back
	// to an app that still will not start a timer.
	h.Clock.Advance(time.Minute + time.Second)
	start(client, category, pomodoro).ExpectStatus(http.StatusOK)
}

func TestReadsAreNotSpentOutOfTheWriteAllowance(t *testing.T) {
	h := apitest.New(t)
	client, category := working(t, h)

	// The tight limit is on writes because that is where the cost is. Reading
	// the timer is one indexed query and pushes nothing to anybody, and a
	// client that polls it must not find itself unable to start a pomodoro.
	for range writesPerMinute * 2 {
		client.GET("/api/session").ExpectStatus(http.StatusOK)
	}
	start(client, category, pomodoro).ExpectStatus(http.StatusOK)
}

func TestThePublicReadsHaveAnAddressBackstop(t *testing.T) {
	h := apitest.New(t)

	// The feed needs no account, so there is no allowance to key by one and the
	// address is all that is left. It is deliberately loose: a backstop against
	// a flood rather than a traffic policy, because the addresses it counts are
	// shared by thousands of people at a time.
	visitor := h.NewClient()
	for range requestsPerMinute {
		visitor.GET("/api/feed").ExpectStatus(http.StatusOK)
	}
	visitor.GET("/api/feed").ExpectError(http.StatusTooManyRequests, "rate_limited")
}

func TestTheClientItselfIsNotRateLimited(t *testing.T) {
	h := apitest.New(t, apitest.WithClient("<html><head></head><body></body></html>"))

	// One page load is a dozen requests and a cold cache is not abuse, so the
	// backstop covers /api and nothing else. A limit that could refuse the app
	// its own HTML would be a limit that takes the site down.
	visitor := h.NewClient()
	for range requestsPerMinute + 10 {
		visitor.GET("/").ExpectStatus(http.StatusOK)
	}
}
