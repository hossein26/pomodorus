#!/usr/bin/env bash
# Nightly logical backup of the database, kept for two weeks.
#
# A dump on the same disk as the database survives a bad migration and a
# dropped table, and nothing else. Copy the output off the box — see the
# backups section of docs/deploy-vps.md.
set -euo pipefail

COMPOSE_DIR=${COMPOSE_DIR:-/srv/pomodorus/deploy}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/pomodorus}
KEEP_DAYS=${KEEP_DAYS:-14}

mkdir -p "$BACKUP_DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
out="$BACKUP_DIR/pomodorus-$stamp.sql.gz"

# -T because there is no terminal on a timer. Written to a .part first so a
# backup killed halfway is never mistaken for a good one.
docker compose -f "$COMPOSE_DIR/docker-compose.prod.yml" exec -T postgres \
	pg_dump -U pomodorus -d pomodorus --clean --if-exists |
	gzip -9 >"$out.part"
mv "$out.part" "$out"

find "$BACKUP_DIR" -name 'pomodorus-*.sql.gz' -mtime "+$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name '*.part' -mtime +1 -delete

echo "wrote $out ($(du -h "$out" | cut -f1))"
