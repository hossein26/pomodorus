package httpapi

import "net/http"

// The headers every response carries, and the reason each one is cheap here
// specifically.
//
// This app serves its own client out of its own binary, on one origin, with no
// CDN, no analytics, no fonts from Google and no embedded anything. That is
// what makes a policy this tight a statement of fact rather than a compromise:
// every one of these directives says "only this server", and there is nothing
// in the app that wanted anything else.
//
// The point is not that there is an injection to stop today. It is that the two
// places somebody else's writing reaches a stranger's screen — a handle in the
// feed, a public task name on a profile — are exactly the shape of thing that
// turns into one, and a policy written before that happens is a policy that
// bounds it to nothing.
const contentSecurityPolicy = "default-src 'self'; " +
	// No inline script, no eval. Vite emits an external module and nothing else,
	// so this costs nothing and is the directive the whole header is really for.
	"script-src 'self'; " +
	// Inline styles are allowed, and only because two components set a width
	// from a percentage and the toast library writes a <style> element when it
	// mounts. It is the one concession here; a style attribute cannot exfiltrate
	// anything on its own, and the script directive above is what matters.
	"style-src 'self' 'unsafe-inline'; " +
	// The fonts are Peyda, served from this binary out of /fonts.
	"font-src 'self'; " +
	// data: because the icon set inlines a handful of small images.
	"img-src 'self' data:; " +
	// The API and the socket, both this origin. 'self' covers ws:// and wss://
	// on the same host, which is what the timer's connection is.
	"connect-src 'self'; " +
	// The installable manifest and the service worker that receives a push.
	"manifest-src 'self'; " +
	"worker-src 'self'; " +
	// Nothing is embedded, and nothing embeds this. The second is the
	// clickjacking answer, and it matters more than it looks: claiming a handle
	// is the one irreversible thing anybody does here.
	"frame-src 'none'; " +
	"frame-ancestors 'none'; " +
	"object-src 'none'; " +
	// There is not a single <form> in the app — every mutation is fetch() — so
	// this closes a door that is already bricked up.
	"form-action 'none'; " +
	"base-uri 'none'"

// hardened sets the response headers that are the same for every route.
//
// Outermost, so that a 429 from the rate limiter and a 503 from the socket
// ceiling carry them too: a response that skipped them because it was refused
// would be a gap that only appears under load.
func (s *Server) hardened(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := w.Header()
		header.Set("Content-Security-Policy", contentSecurityPolicy)

		// The SPA handler serves whatever files are embedded, typed by their
		// extension. Sniffing is what turns a file the server called one thing
		// into a script the browser ran as another.
		header.Set("X-Content-Type-Options", "nosniff")

		// frame-ancestors above is the real answer; this is the same answer for
		// anything that does not read CSP.
		header.Set("X-Frame-Options", "DENY")

		// A profile URL has somebody's handle in it, and the feed links out to
		// nothing at all. Sending the full path to any third party would be
		// telling them whose page was open — so: the origin, cross-site, and
		// only over TLS.
		header.Set("Referrer-Policy", "strict-origin-when-cross-origin")

		// Nothing here uses a camera, a microphone, a location or a payment
		// handler, and saying so is what stops an embedded anything using one on
		// this origin's behalf. Notifications and push are deliberately absent
		// from the list: they are the one capability the app does want.
		header.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()")

		// Only when the connection actually is TLS, read the same way the
		// cookie's Secure flag is. Announcing HSTS over plain HTTP is both
		// ignored and wrong, and asserting it in development would pin a
		// developer's browser to https://localhost for a year.
		//
		// No includeSubDomains and no preload: both are promises about hostnames
		// this server does not own and cannot withdraw, and neither is needed to
		// stop the downgrade this is here for.
		if s.isHTTPS(r) {
			header.Set("Strict-Transport-Security", "max-age=31536000")
		}

		next.ServeHTTP(w, r)
	})
}
