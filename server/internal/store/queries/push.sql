-- name: SaveSubscription :exec
-- Idempotent on the endpoint, which is the device's own name for itself. A tab
-- that re-subscribes on every load writes the same row every time, and a shared
-- browser that is now somebody else's moves it to them.
--
-- created_at moves on conflict, which makes it "when this device last said it
-- was here" rather than when it first appeared. That is what TrimSubscriptions
-- below sorts on, and it is the reason a device in daily use is never the one
-- trimmed: every page load refreshes it.
INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (endpoint) DO UPDATE
    SET user_id    = excluded.user_id,
        p256dh     = excluded.p256dh,
        auth       = excluded.auth,
        created_at = excluded.created_at;

-- name: TrimSubscriptions :execrows
-- Keep only the most recently seen devices for one account.
--
-- A ceiling rather than a refusal, because refusing is the wrong answer to the
-- only question a real person ever asks here: a device that subscribes is a
-- device that wants the bell, and telling the newest one "no, you have too
-- many" would break the phone somebody just installed the app on. Trimming
-- instead drops whichever device has gone longest without saying it is still
-- there, which is the one a bell was least likely to be useful to.
--
-- What it actually bounds is abuse. The endpoint is a URL the client chooses,
-- so without a ceiling one account can register an unlimited number of them
-- and turn every bell into an unlimited number of outbound requests at a
-- destination of its choosing.
DELETE FROM push_subscriptions AS stale
WHERE stale.user_id = @user_id
  AND stale.endpoint NOT IN (
      SELECT recent.endpoint FROM push_subscriptions AS recent
      WHERE recent.user_id = @user_id
      -- The endpoint breaks ties, so two devices stored in the same
      -- transaction are trimmed in a defined order rather than an arbitrary one.
      ORDER BY recent.created_at DESC, recent.endpoint DESC
      LIMIT sqlc.arg(keep)
  );

-- name: SubscriptionsForUser :many
SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1;

-- name: DeleteSubscription :exec
-- By endpoint alone, with no user_id: this is what the push service reporting
-- "gone" turns into, and by then the row's owner is beside the point. The
-- endpoint is unguessable and belongs to whoever holds it, which is the same
-- thing that makes it safe as the key.
DELETE FROM push_subscriptions WHERE endpoint = $1;

-- name: PendingBells :many
-- Every bell that has not rung yet, across all accounts, for the in-memory
-- timers to be rebuilt from at boot.
--
-- Bounded by `ends_at > $1` on purpose: a bell that went while the process was
-- down has already been missed, and a notification for it now would be an
-- alarm about something that finished during the restart. Nothing is written
-- here and nothing is written when one of these fires — the timer is a
-- courtesy laid over state that is still derived from the rows themselves.
SELECT id, user_id, kind, ends_at FROM sessions
WHERE confirmed_at IS NULL AND cancelled_at IS NULL AND ends_at > $1
ORDER BY ends_at;
