package httpapi

import (
	"net/http"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/yazdanctx/pomodorus/server/internal/store/db"
)

// What one caller may cost this server, and why the two limits here are keyed
// differently.
//
// The audience is the reason. Iranian mobile networks put thousands of people
// behind one carrier-grade NAT address, so a per-IP limit tight enough to be
// interesting is a limit that breaks the app for a whole network at once — and
// this app is written for exactly those users. The login limits in package auth
// get away with being tight because asking for a code is a rare event; ordinary
// API traffic is not, and the same numbers here would be a different decision
// wearing the same clothes.
//
// So the tight limit is keyed by *account*, which no amount of shared address
// space can collide on, and it covers the writes — which is also where the cost
// actually is. A write pushes to every socket the person has open and, for the
// three that change who is working, reads the whole feed and pushes that to
// everybody. One cheap POST is the most expensive thing a caller can ask for,
// and it is the only place amplification lives.
//
// The per-address limit is left deliberately loose. It is a backstop against an
// unauthenticated flood of the two public reads, not a traffic policy: a carrier
// address would need ten requests a second sustained across all of its users
// before anybody noticed it.
const (
	// Per account, per minute, on every write that needs a session.
	maxWritesPerMinute = 60

	// Per source address, per minute, across everything under /api.
	maxRequestsPerMinute = 600

	// Concurrent WebSocket connections, for the whole process.
	//
	// Global rather than per address, for the reason above: any per-address
	// socket cap large enough to be safe under CGNAT is too large to bound
	// anything, and one small enough to bound something would hang up on a
	// carrier's worth of real users. What this protects is the process — each
	// socket is a goroutine, a subscription and a periodic query — so that
	// running out means refusing new connections rather than dying.
	maxOpenSockets = 5000
)

// spendWrite records one write against an account's allowance, and answers the
// caller itself when there is none left.
//
// Called by every handler that writes, after the session is resolved and before
// anything is written. It is deliberately explicit at each call site rather than
// middleware: middleware would have to resolve the session a second time to know
// whose allowance to spend, and a second session read on every write is a real
// cost paid to make a rare refusal tidier.
func (s *Server) spendWrite(w http.ResponseWriter, user db.User) bool {
	if s.writes.Allow(topicFor(user), s.now()) {
		return true
	}
	// The same code the login endpoints use, so the client already has a
	// sentence for it.
	s.writeError(w, http.StatusTooManyRequests, "rate_limited")
	return false
}

// metered is the set of paths the per-address backstop covers: everything that
// reaches the database without a session behind it.
//
// /api is the obvious half. /u is the half that is easy to miss: it is a
// client-side route, so it is served by the SPA handler rather than by the mux
// above — but rendering it looks the handle up, to decide whether the link
// previews as a person or as the app. That is a query per request on an
// unauthenticated path, which is the same thing the two public reads are, and
// it was the one way into the connection pool that nothing bounded.
//
// The client's own assets are deliberately not here, because one page load is
// a dozen of them and a cold cache is not abuse. Neither is the socket: what a
// socket costs is the connection rather than the request, and openSockets
// below is what bounds that.
func metered(path string) bool {
	return strings.HasPrefix(path, "/api/") ||
		path == "/u" || strings.HasPrefix(path, "/u/")
}

// limited is the per-address backstop, wrapped around the API.
func (s *Server) limited(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !metered(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		// An address that could not be read is its own bucket rather than a
		// free pass — every caller that cannot be identified shares one
		// allowance, which is the safe direction to be wrong in.
		if !s.requests.Allow(s.clientIP(r).String(), s.now()) {
			s.writeError(w, http.StatusTooManyRequests, "rate_limited")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// openSockets counts the live connections, and refuses to go past the ceiling.
//
// The pair is a claim and its release: `claimSocket` reports whether there was
// room and takes it if so, and the returned function gives it back. Written as
// a compare-and-swap loop rather than an increment-then-check, because the
// check and the take have to be one step — two sockets arriving together must
// not both see the last slot.
type openSockets struct{ n atomic.Int64 }

func (o *openSockets) claim(limit int64) (release func(), ok bool) {
	for {
		held := o.n.Load()
		if held >= limit {
			return nil, false
		}
		if o.n.CompareAndSwap(held, held+1) {
			var once sync.Once
			return func() { once.Do(func() { o.n.Add(-1) }) }, true
		}
	}
}

func (o *openSockets) held() int64 { return o.n.Load() }
