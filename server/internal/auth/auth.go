// Package auth is the whole of signing in: there are no passwords anywhere in
// this app.
//
// One flow, not two. An address that has never been seen creates an account, a
// known one signs in, and the caller is never asked which it is doing. The
// account is created at the moment a code is *verified* rather than requested,
// which is what stops a mistyped address from quietly becoming a second, empty
// account — a code sent to an address you cannot read is a code nobody can
// enter.
package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/mail"
	"net/netip"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/yazdanctx/pomodorus/server/internal/clock"
	mailer "github.com/yazdanctx/pomodorus/server/internal/mail"
	"github.com/yazdanctx/pomodorus/server/internal/ratelimit"
	"github.com/yazdanctx/pomodorus/server/internal/store/db"
)

// The policy, in one place so the tests and the copy can both point at it.
const (
	// Six digits is what people can hold in their head between the mail app
	// and the browser. It is a small space, which is why everything below it
	// exists.
	CodeDigits = 6
	// Long enough to walk to another device, short enough that an old email in
	// an inbox stops being a way in.
	CodeTTL = 10 * time.Minute
	// Fumbling the code is ordinary; guessing it is not. At the limit the code
	// is invalidated rather than merely rejected.
	MaxAttempts = 5

	// A personal tool that asks you to sign in every fortnight is a personal
	// tool you stop using. The expiry slides on every use, so this is ninety
	// days of *disuse*, not ninety days total.
	SessionTTL = 90 * 24 * time.Hour

	// Rate limits. Per address, so a slow mail server is not a dead end but a
	// mailbox cannot be flooded; per IP, so one host cannot walk a list of
	// addresses.
	//
	// These are deliberately tight, and they can be: a session lasts ninety
	// days of disuse, so asking for a code is a rare event even for a daily
	// user. The usual argument against a low per-IP limit is carrier-grade NAT
	// — Iranian mobile networks put thousands of people behind one address —
	// but thousands of people who each sign in twice a year do not collide
	// inside a fifteen minute window.
	RateWindow       = 15 * time.Minute
	MaxCodesPerEmail = 3
	MaxCodesPerIP    = 8

	// A ceiling on the whole server, because the limits above multiply. A
	// hundred addresses at three codes each is three hundred emails from three
	// hundred different IPs, every one of them inside its own allowance, and
	// the mail plan permits five hundred a day. So the cheapest attack on this
	// app was never breaking into an account: it was spending the mail quota
	// until nobody can log in, at no cost to the attacker.
	//
	// Set below the plan so the quota is never what runs out first — hitting
	// this limit is recoverable and visible, hitting Liara's is neither.
	GlobalWindowHour = time.Hour
	MaxCodesPerHour  = 60
	GlobalWindowDay  = 24 * time.Hour
	MaxCodesPerDay   = 300

	// Verifying is cheap to send and not cheap to answer: a database read per
	// attempt, on an endpoint that requires no session. This is not what stops
	// guessing — MaxAttempts does, by destroying the code — it is what stops
	// the endpoint being free to hammer.
	VerifyWindow        = 15 * time.Minute
	MaxVerifiesPerIP    = 15
	MaxVerifiesPerEmail = 10
)

// The errors a caller has to tell apart. Everything about a code that failed —
// wrong, expired, already used, out of attempts, never issued — is one error
// on purpose: distinguishing them tells an attacker which of those it was.
var (
	ErrInvalidEmail = errors.New("auth: not an email address")
	ErrRateLimited  = errors.New("auth: too many codes requested")
	ErrBadCode      = errors.New("auth: code is wrong, expired or already used")
	ErrNoSession    = errors.New("auth: no session")
)

// globalKey is the single key the server-wide throttles are counted under. The
// throttle type is keyed because most of its uses are; this one is not.
const globalKey = "server"

type Service struct {
	q     *db.Queries
	clock clock.Clock
	mail  mailer.Mailer

	// A pepper, so that a database read alone does not hand anybody a pile of
	// live codes: the stored hash is useless without it. Generated at boot and
	// never persisted — an in-flight code stops working across a restart,
	// which costs one resend and buys one less secret to manage.
	secret []byte

	// In-memory limits, keyed as their names say. See package ratelimit for
	// why these are not database counts like the two above.
	globalHour  *ratelimit.Window
	globalDay   *ratelimit.Window
	verifyIP    *ratelimit.Window
	verifyEmail *ratelimit.Window
}

func NewService(q *db.Queries, c clock.Clock, m mailer.Mailer) *Service {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		// crypto/rand does not fail on any platform this runs on, and a
		// server that cannot generate a secret must not serve logins.
		panic("auth: no randomness available: " + err.Error())
	}
	return &Service{
		q: q, clock: c, mail: m, secret: secret,
		globalHour:  ratelimit.New(GlobalWindowHour, MaxCodesPerHour),
		globalDay:   ratelimit.New(GlobalWindowDay, MaxCodesPerDay),
		verifyIP:    ratelimit.New(VerifyWindow, MaxVerifiesPerIP),
		verifyEmail: ratelimit.New(VerifyWindow, MaxVerifiesPerEmail),
	}
}

// RequestCode mints a code for the address and mails it.
//
// It says nothing about whether the address has an account, because the
// caller's response is identical either way — that is what stops this endpoint
// being a way to find out who is registered here.
func (s *Service) RequestCode(ctx context.Context, address string, from netip.Addr) error {
	email, err := NormalizeEmail(address)
	if err != nil {
		return err
	}
	now := s.clock.Now()
	since := ts(now.Add(-RateWindow))

	// The global ceiling is checked first and answered from memory, because
	// under a flood the cheapest thing this server can do is say no without
	// touching Postgres — the queries below are exactly what a flood is trying
	// to make it spend. Checked but not consumed here: budget is spent when a
	// mail is actually sent, further down, so a refused request never eats the
	// allowance of a real one.
	if s.globalHour.Remaining(globalKey, now) <= 0 || s.globalDay.Remaining(globalKey, now) <= 0 {
		return ErrRateLimited
	}

	perEmail, err := s.q.CountCodesForEmail(ctx, db.CountCodesForEmailParams{Email: email, CreatedAt: since})
	if err != nil {
		return fmt.Errorf("count codes for address: %w", err)
	}
	if perEmail >= MaxCodesPerEmail {
		return ErrRateLimited
	}

	var ip *netip.Addr
	if from.IsValid() {
		ip = &from
		perIP, err := s.q.CountCodesForIP(ctx, db.CountCodesForIPParams{RequestedIp: ip, CreatedAt: since})
		if err != nil {
			return fmt.Errorf("count codes for ip: %w", err)
		}
		if perIP >= MaxCodesPerIP {
			return ErrRateLimited
		}
	}

	// The previous code dies here rather than at its own expiry: two live
	// codes would mean the older email in the inbox still works.
	if err := s.q.SupersedeCodesForEmail(ctx, db.SupersedeCodesForEmailParams{
		Email: email, ConsumedAt: ts(now),
	}); err != nil {
		return fmt.Errorf("supersede codes: %w", err)
	}

	code, err := newCode()
	if err != nil {
		return err
	}
	if _, err := s.q.CreateLoginCode(ctx, db.CreateLoginCodeParams{
		Email:       email,
		CodeHash:    s.hash(email, code),
		RequestedIp: ip,
		CreatedAt:   ts(now),
		ExpiresAt:   ts(now.Add(CodeTTL)),
	}); err != nil {
		return fmt.Errorf("create code: %w", err)
	}

	// Spent here rather than at the top: everything above can still refuse, and
	// a refusal that consumed budget would let an attacker exhaust the day
	// without a single mail leaving the building.
	s.globalHour.Allow(globalKey, now)
	s.globalDay.Allow(globalKey, now)

	return s.mail.Send(ctx, codeMessage(email, code))
}

// Verify checks a code and, if it is good, creates the account if there is not
// one already and opens a session.
//
// The returned token is the only time it exists in plaintext; the caller puts
// it in a cookie and the database keeps a hash.
func (s *Service) Verify(ctx context.Context, address, code string, from netip.Addr) (string, db.User, error) {
	email, err := NormalizeEmail(address)
	if err != nil {
		return "", db.User{}, err
	}
	now := s.clock.Now()

	// Guessing is already bounded by MaxAttempts, which destroys the code
	// rather than merely rejecting it. These limits are about the endpoint, not
	// the code: it needs no session, does a database read per call, and had
	// nothing at all in front of it. Keyed by address as well as by source, so
	// one address cannot be worked on from many hosts.
	if from.IsValid() && !s.verifyIP.Allow(from.String(), now) {
		return "", db.User{}, ErrRateLimited
	}
	if !s.verifyEmail.Allow(email, now) {
		return "", db.User{}, ErrRateLimited
	}

	live, err := s.q.LiveCodeForEmail(ctx, db.LiveCodeForEmailParams{Email: email, ExpiresAt: ts(now)})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", db.User{}, ErrBadCode
	}
	if err != nil {
		return "", db.User{}, fmt.Errorf("read code: %w", err)
	}

	if !hmac.Equal(live.CodeHash, s.hash(email, strings.TrimSpace(code))) {
		if _, err := s.q.RecordFailedAttempt(ctx, db.RecordFailedAttemptParams{
			ID: live.ID, Attempts: MaxAttempts, ConsumedAt: ts(now),
		}); err != nil {
			return "", db.User{}, fmt.Errorf("record attempt: %w", err)
		}
		return "", db.User{}, ErrBadCode
	}

	// Single use, decided by the database rather than by this function: two
	// requests racing with the same correct code produce exactly one winner.
	used, err := s.q.ConsumeLoginCode(ctx, db.ConsumeLoginCodeParams{ID: live.ID, ConsumedAt: ts(now)})
	if err != nil {
		return "", db.User{}, fmt.Errorf("consume code: %w", err)
	}
	if used == 0 {
		return "", db.User{}, ErrBadCode
	}

	user, err := s.q.UpsertUserByEmail(ctx, db.UpsertUserByEmailParams{Email: email, CreatedAt: ts(now)})
	if err != nil {
		return "", db.User{}, fmt.Errorf("upsert user: %w", err)
	}

	token, err := s.openSession(ctx, user.ID, now)
	if err != nil {
		return "", db.User{}, err
	}
	return token, user, nil
}

// User resolves a session token, sliding its expiry forward as it goes.
func (s *Service) User(ctx context.Context, token string) (db.User, error) {
	if token == "" {
		return db.User{}, ErrNoSession
	}
	now := s.clock.Now()
	hash := tokenHash(token)

	row, err := s.q.UserForSession(ctx, db.UserForSessionParams{TokenHash: hash, ExpiresAt: ts(now)})
	if errors.Is(err, pgx.ErrNoRows) {
		return db.User{}, ErrNoSession
	}
	if err != nil {
		return db.User{}, fmt.Errorf("read session: %w", err)
	}

	// Written on use rather than on a schedule: a session being used never
	// lapses, and one that is not eventually does. Writing on every request
	// would be a write per request, so only move it once it has drifted.
	if row.ExpiresAt.Time.Sub(now) < SessionTTL-time.Hour {
		if err := s.q.TouchAuthSession(ctx, db.TouchAuthSessionParams{
			TokenHash: hash, LastSeenAt: ts(now), ExpiresAt: ts(now.Add(SessionTTL)),
		}); err != nil {
			return db.User{}, fmt.Errorf("touch session: %w", err)
		}
	}
	return row.User, nil
}

// SignOut deletes the row, which is what makes a stolen cookie stop working.
// A self-contained signed token could not be withdrawn like this.
func (s *Service) SignOut(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	return s.q.DeleteAuthSession(ctx, tokenHash(token))
}

// StaleCodeAge is how far back a login code has to be before it is thrown
// away. Comfortably past both CodeTTL, after which it cannot be verified, and
// RateWindow, after which it no longer counts against anybody's allowance —
// deleting one inside that window would hand back quota that was already spent.
const StaleCodeAge = 24 * time.Hour

// Swept is what one sweep removed, for the log line at boot.
type Swept struct {
	Sessions int64
	Codes    int64
}

// Sweep deletes the rows in these two tables that can no longer mean anything.
//
// Neither delete changes what the app would answer. An expired session is
// already refused, because every read of one is bounded by `expires_at`; a
// login code a day old is past its own expiry and past the window the rate
// limits count in. What the sweep buys is that the two tables an unauthenticated
// caller can grow — a code row per request, a session row per sign-in — do not
// grow forever, and that the index every authenticated request touches is not
// mostly dead weight.
//
// It is deliberately not a scheduler. It runs once at boot, beside rebuilding
// the pending bells, because that is the one moment this app already has for
// work that is nobody's request. See docs/adr/0002: nothing here derives, flips
// or advances any state — a sweep that never ran would cost disk and nothing
// else, which is exactly why it is safe to do this way round.
func (s *Service) Sweep(ctx context.Context) (Swept, error) {
	now := s.clock.Now()

	sessions, err := s.q.DeleteExpiredAuthSessions(ctx, ts(now))
	if err != nil {
		return Swept{}, fmt.Errorf("sweep sessions: %w", err)
	}
	codes, err := s.q.DeleteStaleLoginCodes(ctx, ts(now.Add(-StaleCodeAge)))
	if err != nil {
		return Swept{Sessions: sessions}, fmt.Errorf("sweep codes: %w", err)
	}
	return Swept{Sessions: sessions, Codes: codes}, nil
}

func (s *Service) openSession(ctx context.Context, user pgtype.UUID, now time.Time) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("session token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)

	if err := s.q.CreateAuthSession(ctx, db.CreateAuthSessionParams{
		TokenHash: tokenHash(token),
		UserID:    user,
		CreatedAt: ts(now),
		ExpiresAt: ts(now.Add(SessionTTL)),
	}); err != nil {
		return "", fmt.Errorf("create session: %w", err)
	}
	return token, nil
}

// hash binds the code to the address, so a code minted for one inbox cannot be
// presented against another.
func (s *Service) hash(email, code string) []byte {
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(email))
	mac.Write([]byte{0})
	mac.Write([]byte(code))
	return mac.Sum(nil)
}

// A session token is 32 random bytes, so there is nothing to brute-force and a
// plain digest is enough. Only the digest is stored.
func tokenHash(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// NormalizeEmail is the one place an address is turned into the form the rest
// of the app uses. Case is folded by citext in the database as well, because
// the column is what cannot be bypassed.
func NormalizeEmail(address string) (string, error) {
	trimmed := strings.TrimSpace(address)
	parsed, err := mail.ParseAddress(trimmed)
	if err != nil {
		return "", ErrInvalidEmail
	}
	// ParseAddress accepts «Name <a@b.c>»; only the address is the identity.
	lowered := strings.ToLower(parsed.Address)
	_, domain, _ := strings.Cut(lowered, "@")
	if !strings.Contains(domain, ".") || strings.HasSuffix(domain, ".") {
		// A domain with no dot is not deliverable off this machine, and
		// accepting one would mean minting a code nobody can read.
		return "", ErrInvalidEmail
	}
	return lowered, nil
}

// newCode returns a uniformly random decimal code.
func newCode() (string, error) {
	digits := make([]byte, CodeDigits)
	for i := range digits {
		n, err := randomDigit()
		if err != nil {
			return "", err
		}
		digits[i] = byte('0' + n)
	}
	return string(digits), nil
}

func randomDigit() (int, error) {
	// Ten does not divide 256, so the top of the byte range is rejected rather
	// than folded — folding would make 0-5 fractionally likelier than 6-9.
	var b [1]byte
	for {
		if _, err := rand.Read(b[:]); err != nil {
			return 0, fmt.Errorf("random digit: %w", err)
		}
		if b[0] < 250 {
			return int(b[0]) % 10, nil
		}
	}
}

func ts(t time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: t, Valid: true}
}
