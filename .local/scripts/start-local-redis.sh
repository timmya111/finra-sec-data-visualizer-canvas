#!/usr/bin/env bash
# Start the shared local Redis (127.0.0.1:6379, db0) and Redis Commander UI
# (http://127.0.0.1:8081/) used by this app. Commander is started with --noload
# so it always connects to that instance instead of a saved config.
#
# Also kicks off an incremental Upstash → local pull (prod cron is source of
# truth). Pull is backgrounded so `pnpm dev` is not blocked; never writes prod.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# scripts live in .local/scripts; repo root is one level above .local
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REDIS_START="${REDIS_START_SCRIPT:-/home/lenny/Dev/db/redis/start-redis.sh}"
REDIS_HOST="127.0.0.1"
REDIS_PORT="6379"
REDIS_DB="0"
UI_HOST="127.0.0.1"
UI_PORT="8081"
UI_URL="http://${UI_HOST}:${UI_PORT}/"
LOG="${TMPDIR:-/tmp}/redis-commander-local.log"
PULL_LOG="${TMPDIR:-/tmp}/finra-pull-from-prod.log"
PULL_LOCK="${TMPDIR:-/tmp}/finra-pull-from-prod.lock"
# Skip auto-pull when SKIP_REDIS_PULL_FROM_PROD=1 (tests / offline).
SKIP_PULL="${SKIP_REDIS_PULL_FROM_PROD:-0}"

if [[ ! -x "$REDIS_START" && ! -f "$REDIS_START" ]]; then
	echo "error: Redis start script not found at $REDIS_START" >&2
	exit 1
fi

bash "$REDIS_START"

start_prod_pull() {
	if [[ "$SKIP_PULL" == "1" || "$SKIP_PULL" == "true" ]]; then
		echo "Skipping Upstash→local pull (SKIP_REDIS_PULL_FROM_PROD=$SKIP_PULL)"
		return 0
	fi
	if [[ ! -f "$REPO_ROOT/.env.local" ]]; then
		echo "warning: no .env.local — skipping Upstash→local pull" >&2
		return 0
	fi
	# Avoid overlapping pulls when multiple terminals run pnpm dev.
	if [[ -f "$PULL_LOCK" ]]; then
		local lock_mtime
		lock_mtime=$(stat -c %Y "$PULL_LOCK" 2>/dev/null || echo 0)
		local age=$(( $(date +%s) - lock_mtime ))
		if (( age < 600 )); then
			echo "Upstash→local pull already running (${age}s) — see $PULL_LOG"
			return 0
		fi
		rm -f "$PULL_LOCK"
	fi
	touch "$PULL_LOCK"
	(
		cd "$REPO_ROOT"
		# Bound each start so cold SCAN does not run forever; cursor resumes next start.
		npx --yes tsx --env-file=.env.local .local/scripts/pull_delta_from_prod.mjs \
			--limit="${REDIS_PULL_FROM_PROD_LIMIT:-2500}" \
			--quiet \
			>>"$PULL_LOG" 2>&1 || echo "warning: Upstash→local pull failed (see $PULL_LOG)" >&2
		rm -f "$PULL_LOCK"
	) &
	disown || true
	echo "Upstash→local pull started in background (log: $PULL_LOG)"
}

start_prod_pull

if curl -sf -o /dev/null --max-time 1 "$UI_URL"; then
	echo "Redis Commander already running at $UI_URL (redis://${REDIS_HOST}:${REDIS_PORT}/${REDIS_DB})"
	exit 0
fi

cd "$ROOT"
nohup npx --yes redis-commander \
	--noload \
	--nosave \
	--redis-host "$REDIS_HOST" \
	--redis-port "$REDIS_PORT" \
	--redis-db "$REDIS_DB" \
	--redis-label local \
	--address "$UI_HOST" \
	--port "$UI_PORT" \
	>"$LOG" 2>&1 &
disown || true

for _ in $(seq 1 50); do
	if curl -sf -o /dev/null --max-time 1 "$UI_URL"; then
		echo "Redis Commander UI: $UI_URL → redis://${REDIS_HOST}:${REDIS_PORT}/${REDIS_DB}"
		exit 0
	fi
	sleep 0.2
done

echo "warning: redis-commander started but UI not yet ready at $UI_URL (see $LOG)" >&2
exit 0
