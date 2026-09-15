#!/usr/bin/env bash
# Starts Postgres + Caddy (https://localhost) in Docker and the server on the host in watch mode.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -f .env ]; then cp .env.example .env; echo "created .env from .env.example"; fi
set -a; . ./.env; set +a
export DATABASE_URL="${DATABASE_URL:-postgres://loom:loom@localhost:5433/loom}"
docker compose --profile dev up -d postgres caddy-dev
echo "waiting for postgres..."
until docker compose exec -T postgres pg_isready -U loom >/dev/null 2>&1; do sleep 1; done
# `set -euo pipefail` above already stops the script if this build fails.
pnpm --filter @loom/web build
echo "Loom: https://localhost/w/<secret>  (API on http://127.0.0.1:3000)"
pnpm --filter @loom/server dev
