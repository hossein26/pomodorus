package httpapi

import (
	"errors"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"github.com/yazdanctx/pomodorus/server/internal/auth"
	"github.com/yazdanctx/pomodorus/server/internal/store/db"
)

// The session cookie. httpOnly so JavaScript cannot read it, SameSite=Lax so
// it is not sent on cross-site posts, and — the reason it is a cookie at all —
// attached to the WebSocket upgrade by the browser without a token in a query
// string.
const sessionCookie = "pomodorus_session"

type requestCodeRequest struct {
	Email string `json:"email"`
}

type sentResponse struct {
	Sent      bool  `json:"sent"`
	ServerNow int64 `json:"serverNow"`
}

func (s *Server) requestCode(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := timeout(r, 15*time.Second)
	defer cancel()

	var body requestCodeRequest
	if err := readJSON(r, &body); err != nil {
		s.writeError(w, http.StatusBadRequest, "malformed_request")
		return
	}

	err := s.auth.RequestCode(ctx, body.Email, s.clientIP(r))
	switch {
	case err == nil:
	case errors.Is(err, auth.ErrInvalidEmail):
		// Refusing an address that is not an address leaks nothing about who
		// has an account — it is a statement about the string, not the inbox.
		s.writeError(w, http.StatusBadRequest, "invalid_email")
		return
	case errors.Is(err, auth.ErrRateLimited):
		s.writeError(w, http.StatusTooManyRequests, "rate_limited")
		return
	default:
		s.log.Error("request code", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}

	// "We sent it", whether or not the address has an account. Anything else
	// turns this endpoint into a way of finding out who is registered here.
	writeJSON(w, http.StatusOK, sentResponse{Sent: true, ServerNow: s.now().UnixMilli()})
}

type verifyRequest struct {
	Email string `json:"email"`
	Code  string `json:"code"`
}

// meResponse is the whole of what the client needs to know about who it is.
// The email is never in it: it is the credential, and it is never displayed.
type meResponse struct {
	Handle    *string `json:"handle"`
	ServerNow int64   `json:"serverNow"`
}

func (s *Server) verifyCode(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := timeout(r, 10*time.Second)
	defer cancel()

	var body verifyRequest
	if err := readJSON(r, &body); err != nil {
		s.writeError(w, http.StatusBadRequest, "malformed_request")
		return
	}

	token, user, err := s.auth.Verify(ctx, body.Email, body.Code, s.clientIP(r))
	switch {
	case err == nil:
	case errors.Is(err, auth.ErrInvalidEmail):
		s.writeError(w, http.StatusBadRequest, "invalid_email")
		return
	case errors.Is(err, auth.ErrRateLimited):
		// Same code and status as the request endpoint, so the client already
		// has a sentence for it.
		s.writeError(w, http.StatusTooManyRequests, "rate_limited")
		return
	case errors.Is(err, auth.ErrBadCode):
		// One error for wrong, expired, already used and out of attempts:
		// telling them apart tells an attacker which it was.
		s.writeError(w, http.StatusUnauthorized, "bad_code")
		return
	default:
		s.log.Error("verify code", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}

	now := s.now()
	s.setSessionCookie(w, r, token, now.Add(auth.SessionTTL))
	writeJSON(w, http.StatusOK, meResponse{Handle: user.Handle, ServerNow: now.UnixMilli()})
}

func (s *Server) signOut(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := timeout(r, 5*time.Second)
	defer cancel()

	if cookie, err := r.Cookie(sessionCookie); err == nil {
		if err := s.auth.SignOut(ctx, cookie.Value); err != nil {
			s.log.Error("sign out", "error", err)
			s.writeError(w, http.StatusInternalServerError, "server_error")
			return
		}
	}

	// Cleared whether or not there was a row, so a stale cookie stops being
	// sent even if the session it names was already gone.
	s.clearSessionCookie(w, r)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	user, ok := s.currentUser(r)
	if !ok {
		s.writeError(w, http.StatusUnauthorized, "not_signed_in")
		return
	}
	writeJSON(w, http.StatusOK, meResponse{Handle: user.Handle, ServerNow: s.now().UnixMilli()})
}

// currentUser resolves the session cookie. It is the only way a handler learns
// who is asking.
func (s *Server) currentUser(r *http.Request) (db.User, bool) {
	cookie, err := r.Cookie(sessionCookie)
	if err != nil {
		return db.User{}, false
	}
	ctx, cancel := timeout(r, 5*time.Second)
	defer cancel()

	user, err := s.auth.User(ctx, cookie.Value)
	if err != nil {
		if !errors.Is(err, auth.ErrNoSession) {
			s.log.Error("resolve session", "error", err)
		}
		return db.User{}, false
	}
	return user, true
}

func (s *Server) setSessionCookie(w http.ResponseWriter, r *http.Request, token string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		Expires:  expires,
		MaxAge:   int(auth.SessionTTL.Seconds()),
		HttpOnly: true,
		Secure:   s.isHTTPS(r),
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Server) clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.isHTTPS(r),
		SameSite: http.SameSiteLaxMode,
	})
}

// isHTTPS reads the connection, not the environment. The Secure flag is
// security-relevant and so may not be decided by ENV; in production the app
// sits behind a TLS-terminating proxy, which is what the forwarded header is
// for — and it is only believed when there is a proxy configured to set it.
func (s *Server) isHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	proto, ok := s.forwarded(r, "X-Forwarded-Proto")
	if !ok {
		return false
	}
	return strings.EqualFold(proto, "https")
}

// clientIP is used for one thing: the per-host rate limit. It is never
// identity and is never shown.
//
// The forwarded header is believed only behind a proxy configured to set it,
// and only at the position that proxy actually wrote. Anyone can send the
// header, so trusting the value they chose would mean a caller who varies it
// per request looks like a fresh host every time — which is the per-host limit
// not existing at all.
func (s *Server) clientIP(r *http.Request) netip.Addr {
	if forwarded, ok := s.forwarded(r, "X-Forwarded-For"); ok {
		if addr, err := netip.ParseAddr(forwarded); err == nil {
			return addr.Unmap()
		}
		// A proxy that wrote something unparseable at the position we trust is
		// a proxy misconfigured, not an invitation to read further left. Fall
		// through to the peer address.
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		// An unparseable peer address is not a reason to refuse a login; the
		// per-address limit still applies.
		return netip.Addr{}
	}
	return addr.Unmap()
}

// forwarded reads the one value of a comma-separated forwarded header that a
// trusted proxy wrote, counting from the right.
//
// From the right because that is the only end anybody here controls. Each
// proxy appends what it saw, so the last entry is the nearest proxy's own
// observation and everything to the left of it is hearsay — beginning with
// whatever the caller invented before the first proxy ever saw the request. A
// proxy that overwrites the header leaves one entry and both ends agree; a
// proxy that appends leaves the caller's invention in front, and reading from
// the left is reading the caller. Counting back `TrustedProxyHops` from the
// right is correct in both cases, which is what lets this ship without first
// proving which kind of proxy is in front of it.
//
// A header with fewer entries than there are trusted hops is refused whole.
// That is a proxy chain shorter than it was configured to be, and the honest
// answer is to fall back to the peer address rather than to reach past the end
// of the list into something a client could have written.
func (s *Server) forwarded(r *http.Request, name string) (string, bool) {
	hops := s.cfg.TrustedProxyHops
	if hops < 1 {
		return "", false
	}
	raw := r.Header.Values(name)
	if len(raw) == 0 {
		return "", false
	}
	// Repeated headers are the same list as one comma-separated line, and a
	// proxy is free to send either.
	var values []string
	for _, line := range raw {
		for _, value := range strings.Split(line, ",") {
			if value = strings.TrimSpace(value); value != "" {
				values = append(values, value)
			}
		}
	}
	at := len(values) - hops
	if at < 0 {
		return "", false
	}
	return values[at], true
}
