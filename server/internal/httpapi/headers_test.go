package httpapi_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/yazdanctx/pomodorus/server/internal/apitest"
)

func TestThePageCarriesAContentSecurityPolicy(t *testing.T) {
	h := apitest.New(t, apitest.WithClient(shell))
	header := h.NewClient().GET("/").ExpectStatus(http.StatusOK).Header

	policy := header.Get("Content-Security-Policy")
	if policy == "" {
		t.Fatal("the page is served without a policy")
	}

	// The directives worth naming, because each is a specific thing this app
	// does not do and the value of the header is exactly that it says so.
	for _, directive := range []string{
		"default-src 'self'",
		// No inline script and no eval, which is the whole point.
		"script-src 'self'",
		// Claiming a handle is irreversible, so being framed is not harmless.
		"frame-ancestors 'none'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
	} {
		if !strings.Contains(policy, directive) {
			t.Errorf("the policy is missing %q: %s", directive, policy)
		}
	}

	// The one concession, and it should stay visible: two components set a
	// width from a percentage, and the toast library writes a style element.
	if !strings.Contains(policy, "style-src 'self' 'unsafe-inline'") {
		t.Errorf("style-src is not what it was: %s", policy)
	}
	// 'unsafe-inline' must never reach the script directive, which is the one
	// mistake that would make the whole header decorative.
	script, _, _ := strings.Cut(strings.TrimPrefix(policy, "default-src 'self'; "), ";")
	if strings.Contains(script, "unsafe") {
		t.Errorf("script-src has been loosened: %s", script)
	}
}

func TestEveryAnswerRefusesToBeSniffedOrFramed(t *testing.T) {
	h := apitest.New(t, apitest.WithClient(shell))
	client := h.NewClient()

	// The API and the page both, because the headers are set outside the
	// routing rather than per route.
	for _, path := range []string{"/", "/api/feed", "/api/health"} {
		header := client.GET(path).Header
		if got := header.Get("X-Content-Type-Options"); got != "nosniff" {
			t.Errorf("%s: X-Content-Type-Options = %q, want nosniff", path, got)
		}
		if got := header.Get("X-Frame-Options"); got != "DENY" {
			t.Errorf("%s: X-Frame-Options = %q, want DENY", path, got)
		}
		if got := header.Get("Referrer-Policy"); got == "" {
			t.Errorf("%s: no Referrer-Policy", path)
		}
	}
}

func TestARefusedAnswerIsHardenedToo(t *testing.T) {
	h := apitest.New(t)
	visitor := h.NewClient()

	// A response that skipped the headers because it was refused would be a gap
	// that only opens under load, which is the worst possible time for one.
	for range requestsPerMinute {
		visitor.GET("/api/feed")
	}
	refused := visitor.GET("/api/feed").ExpectError(http.StatusTooManyRequests, "rate_limited")
	if got := refused.Header.Get("Content-Security-Policy"); got == "" {
		t.Error("a rate-limited answer carries no policy")
	}
	if got := refused.Header.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("a rate-limited answer is sniffable: %q", got)
	}
}

func TestHSTSIsAssertedOnlyWhereTheConnectionIsTLS(t *testing.T) {
	plain := apitest.New(t, apitest.WithClient(shell))
	if got := plain.NewClient().GET("/").Header.Get("Strict-Transport-Security"); got != "" {
		// Asserting it in development would pin a developer's browser to
		// https://localhost for a year, which is a bad afternoon.
		t.Errorf("HSTS asserted over plain HTTP: %q", got)
	}

	secure := apitest.New(t, apitest.WithClient(shell), apitest.OverTLS())
	got := secure.NewClient().GET("/").Header.Get("Strict-Transport-Security")
	if !strings.Contains(got, "max-age=") {
		t.Errorf("no HSTS over TLS: %q", got)
	}
	// Both are promises about hostnames this server does not own and cannot
	// withdraw, and neither is needed for the downgrade this is here to stop.
	if strings.Contains(got, "includeSubDomains") || strings.Contains(got, "preload") {
		t.Errorf("HSTS claims more than this server can withdraw: %q", got)
	}
}
