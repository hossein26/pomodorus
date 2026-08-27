-- name: CountCodesForEmail :one
-- The per-address rate limit: how many codes has this address asked for
-- recently? Counting requests rather than tracking a bucket keeps the limit in
-- the same table as the thing it limits, and moves with the injected clock.
SELECT count(*) FROM login_codes
WHERE email = $1 AND created_at > $2;

-- name: CountCodesForIP :one
SELECT count(*) FROM login_codes
WHERE requested_ip = $1 AND created_at > $2;

-- name: SupersedeCodesForEmail :exec
-- Asking for a new code kills the old one. Two live codes for one address
-- would mean the older email in an inbox still works, which is the thing the
-- expiry exists to prevent.
UPDATE login_codes SET consumed_at = $2
WHERE email = $1 AND consumed_at IS NULL;

-- name: CreateLoginCode :one
INSERT INTO login_codes (email, code_hash, requested_ip, created_at, expires_at)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: LiveCodeForEmail :one
-- The one code that could still be verified: unconsumed and unexpired.
SELECT * FROM login_codes
WHERE email = $1 AND consumed_at IS NULL AND expires_at > $2
ORDER BY created_at DESC
LIMIT 1;

-- name: RecordFailedAttempt :one
-- One wrong guess. Consuming the row at the limit is done in the same
-- statement so that concurrent guesses cannot both see "one attempt left".
UPDATE login_codes
SET attempts = attempts + 1,
    consumed_at = CASE WHEN attempts + 1 >= $2 THEN $3 ELSE consumed_at END
WHERE id = $1
RETURNING *;

-- name: ConsumeLoginCode :execrows
-- Single use, enforced by the WHERE rather than by the caller: two requests
-- racing with the same correct code produce one winner.
UPDATE login_codes SET consumed_at = $2
WHERE id = $1 AND consumed_at IS NULL;

-- name: UpsertUserByEmail :one
-- One flow, not two: an unknown address creates the account, a known one
-- signs in. The DO UPDATE is a no-op that exists only so RETURNING fires on
-- the conflict path too.
INSERT INTO users (email, created_at)
VALUES ($1, $2)
ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
RETURNING *;

-- name: CreateAuthSession :exec
-- last_seen_at starts equal to created_at; it is the expiry that is the
-- interesting column, and it is passed in rather than computed here so the
-- lifetime lives in one place in Go.
INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
VALUES ($1, $2, $3, $4, $3);

-- name: UserForSession :one
SELECT sqlc.embed(users), auth_sessions.expires_at
FROM auth_sessions
JOIN users ON users.id = auth_sessions.user_id
WHERE auth_sessions.token_hash = $1 AND auth_sessions.expires_at > $2;

-- name: TouchAuthSession :exec
-- The sliding expiry. Written on use rather than on a schedule, so a session
-- that is being used never lapses and one that is not eventually does.
UPDATE auth_sessions SET last_seen_at = $2, expires_at = $3
WHERE token_hash = $1;

-- name: DeleteAuthSession :exec
DELETE FROM auth_sessions WHERE token_hash = $1;

-- name: DeleteExpiredAuthSessions :execrows
-- A session past its expiry is already refused by UserForSession, which bounds
-- every read by expires_at. Deleting it is housekeeping rather than security:
-- the row is dead weight in an index that every authenticated request touches.
DELETE FROM auth_sessions WHERE expires_at <= $1;

-- name: DeleteStaleLoginCodes :execrows
-- A code far enough in the past to be no use to anybody.
--
-- The cutoff is not the code's own expiry. These rows are what the per-address
-- and per-IP limits are counted from — that is why those limits survive a
-- restart at all — so deleting one inside the rate window would hand back
-- quota that was already spent. The caller passes a cutoff well behind both
-- CodeTTL and RateWindow, and what is left is a table that does not grow
-- forever.
DELETE FROM login_codes WHERE created_at <= $1;
