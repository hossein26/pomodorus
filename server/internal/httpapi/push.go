package httpapi

import (
	"context"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/yazdanctx/pomodorus/server/internal/push"
	"github.com/yazdanctx/pomodorus/server/internal/store/db"
)

// The push surface is two things and no more: the key a browser needs before
// it can subscribe, and the subscription it produces. There is no unsubscribe,
// because nothing here is a subscription's only ending — a browser that drops
// one makes the push service report it gone at the next bell, and that is what
// deletes the row. One path rather than two, and the one that cannot be
// skipped by a tab that was closed before it could tell us.

type pushKeyResponse struct {
	// The VAPID public key, base64url, as applicationServerKey wants it. Empty
	// means this deployment has no keypair and the bell cannot reach a closed
	// tab — a fact about the deployment rather than a failure, so it is a 200.
	PublicKey string `json:"publicKey"`
}

func (s *Server) pushKey(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, pushKeyResponse{PublicKey: s.cfg.VAPID.PublicKey})
}

// subscribeRequest is the browser's PushSubscription, flattened.
//
// Flattened rather than accepting `subscription.toJSON()` whole because that
// object also carries an `expirationTime` nothing here has a use for, and this
// server refuses fields it does not know about — a typo in a field name should
// fail loudly rather than be quietly ignored.
type subscribeRequest struct {
	Endpoint string `json:"endpoint"`
	P256dh   string `json:"p256dh"`
	Auth     string `json:"auth"`
}

// The endpoint is a URL a push service minted, and the keys are fixed-size
// values base64url-encoded. None of them is anywhere near these bounds; the
// bounds exist so that a bug or a spiteful client cannot put a megabyte in a
// primary key.
const (
	maxEndpoint = 2048
	maxPushKey  = 256
)

// maxSubscriptionsPerUser is how many devices one account may be woken on.
//
// Generous against any real answer — a phone, a laptop, a tablet, and a couple
// of browsers on each is nowhere near it — and finite because the endpoint is
// a URL the client chooses. Without a ceiling, one account can store an
// unbounded number of them and every bell becomes an unbounded number of
// outbound requests at a destination somebody else picked.
//
// It is enforced by trimming the least recently seen rather than by refusing
// the newest, so it is never a device somebody just installed the app on that
// gets turned away. See TrimSubscriptions.
const maxSubscriptionsPerUser = 20

// subscribePush records a device that has agreed to be told when its bell goes.
//
// Idempotent on the endpoint, which is the device's own name for itself: a tab
// that re-subscribes on every load writes the same row every time. There is no
// client-minted id here for the same reason there is no id column — the push
// service already minted the only identity this row has.
func (s *Server) subscribePush(w http.ResponseWriter, r *http.Request) {
	user, ok := s.currentUser(r)
	if !ok {
		s.writeError(w, http.StatusUnauthorized, "not_signed_in")
		return
	}

	if !s.spendWrite(w, user) {
		return
	}

	var body subscribeRequest
	if err := readJSON(r, &body); err != nil {
		s.writeError(w, http.StatusBadRequest, "malformed_request")
		return
	}

	endpoint := strings.TrimSpace(body.Endpoint)
	p256dh := strings.TrimSpace(body.P256dh)
	auth := strings.TrimSpace(body.Auth)
	if !validPushEndpoint(endpoint) {
		s.writeError(w, http.StatusBadRequest, "malformed_request")
		return
	}
	if p256dh == "" || auth == "" || len(p256dh) > maxPushKey || len(auth) > maxPushKey {
		s.writeError(w, http.StatusBadRequest, "malformed_request")
		return
	}

	ctx, cancel := timeout(r, 5*time.Second)
	defer cancel()

	if err := s.q.SaveSubscription(ctx, db.SaveSubscriptionParams{
		Endpoint:  endpoint,
		UserID:    user.ID,
		P256dh:    p256dh,
		Auth:      auth,
		CreatedAt: pgTime(s.now()),
	}); err != nil {
		s.log.Error("save push subscription", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}

	// The ceiling, applied after the write rather than before it: this device
	// is the most recently seen by definition, so it is never the one trimmed,
	// and doing it in this order means the check cannot refuse the caller.
	//
	// A failure here is logged and not answered on. The subscription landed,
	// which is what was asked for; the trim is housekeeping, and the next
	// device to subscribe runs it again.
	if trimmed, err := s.q.TrimSubscriptions(ctx, db.TrimSubscriptionsParams{
		UserID: user.ID, Keep: maxSubscriptionsPerUser,
	}); err != nil {
		s.log.Error("trim push subscriptions", "error", err)
	} else if trimmed > 0 {
		s.log.Info("push: trimmed subscriptions past the ceiling", "count", trimmed)
	}

	// Answered with the timer state, like every other write, so the tab that
	// just subscribed mid-session is not left having to ask again. Nothing is
	// pushed for it: another device does not care which addresses this one
	// keeps.
	s.writeTimerState(ctx, w, user, s.now())
}

// validPushEndpoint vets what can be decided from the string alone.
//
// https only, because that is what a push service is and because the column's
// own CHECK says so — a row that failed the constraint would be a 500 for what
// is a malformed request.
//
// An endpoint written as an address rather than a name is judged here too.
// That is not the defence against a subscription pointing back inside this
// network — the dial in package push is, because only it sees what a *name*
// resolves to, and it sees it at the moment the connection is opened rather
// than twenty-five minutes earlier. This is the part that can be answered
// honestly right now, and answering it turns a subscription that would
// silently never deliver into a 400 the client can do something about.
func validPushEndpoint(raw string) bool {
	if len(raw) > maxEndpoint {
		return false
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return false
	}
	if addr, err := netip.ParseAddr(parsed.Hostname()); err == nil && !push.IsPublic(addr) {
		return false
	}
	return true
}

// --- the notifier's view of the world ---------------------------------------

// pushStore is the address book as the push package needs it. It is the whole
// of the dependency: the notifier knows about subscriptions and pending bells,
// and nothing about sessions, users or SQL.
type pushStore struct{ q *db.Queries }

func (p pushStore) SubscriptionsFor(ctx context.Context, userID uuid.UUID) ([]push.Subscription, error) {
	rows, err := p.q.SubscriptionsForUser(ctx, pgID(userID))
	if err != nil {
		return nil, err
	}
	subs := make([]push.Subscription, 0, len(rows))
	for _, row := range rows {
		subs = append(subs, push.Subscription{
			Endpoint: row.Endpoint, P256dh: row.P256dh, Auth: row.Auth,
		})
	}
	return subs, nil
}

func (p pushStore) Forget(ctx context.Context, endpoint string) error {
	return p.q.DeleteSubscription(ctx, endpoint)
}

func (p pushStore) Pending(ctx context.Context, after time.Time) ([]push.Bell, error) {
	rows, err := p.q.PendingBells(ctx, pgTime(after))
	if err != nil {
		return nil, err
	}
	bells := make([]push.Bell, 0, len(rows))
	for _, row := range rows {
		bells = append(bells, push.Bell{
			SessionID: uuid.UUID(row.ID.Bytes),
			UserID:    uuid.UUID(row.UserID.Bytes),
			Kind:      string(kindOf(row.Kind)),
			At:        row.EndsAt.Time,
		})
	}
	return bells, nil
}

// armBell keeps the pending notification in step with the timer.
//
// It is called with the state a handler just answered, so what gets armed is
// exactly what the caller was told — there is no second read that could
// disagree with it. Arming replaces, so calling this on every change is the
// whole of keeping it correct: an edit that moves nothing re-arms the same
// instant, and a state with no live session arms nothing.
//
// None of this is state. Losing every timer costs notifications and never the
// timer, which is why it is done after the answer has gone out rather than
// inside the transaction that produced it.
func (s *Server) armBell(user db.User, state sessionResponse) {
	if state.Session == nil {
		return
	}
	id, err := uuid.Parse(state.Session.ID)
	if err != nil {
		return
	}
	s.push.Arm(push.Bell{
		SessionID: id,
		UserID:    uuid.UUID(user.ID.Bytes),
		Kind:      state.Session.Kind,
		At:        time.UnixMilli(state.Session.EndsAt).UTC(),
	})
}
