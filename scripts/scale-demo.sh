#!/usr/bin/env sh
# Horizontal scaling, demonstrated end to end.
#
# One planner seeds the root partition and exits; three workers then share the queue through
# `FOR UPDATE SKIP LOCKED` and share the politeness budget through one `site_throttle` row. That
# second half is the point: three workers are three times the throughput and the *same* pressure
# on the site.
#
# The target is the fake tribunal, never the real one. Scaling demos are exactly the kind of
# traffic a public court server should never receive.
set -eu

WORKERS="${WORKERS:-3}"

docker compose --profile app up -d --build --scale "worker=$WORKERS"
docker compose logs -f worker &
LOGS=$!

# `wait` blocks until every worker container has stopped and reports the worst exit code.
docker compose wait worker
CODE=$?

kill "$LOGS" 2>/dev/null || true
echo ""
echo "workers finished with code $CODE; the run is in Postgres. Inspect it with:"
echo "  npm run verify -- --site fake-pje"
echo "  npm run report -- --site fake-pje"
echo ""
echo "stop the infrastructure with: npm run down"
exit "$CODE"
