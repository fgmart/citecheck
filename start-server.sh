#!/usr/bin/env bash
set -euo pipefail

export PORT="${PORT:-3000}"
export CROSSREF_CONCURRENCY="${CROSSREF_CONCURRENCY:-1}"
export CROSSREF_RETRIES="${CROSSREF_RETRIES:-4}"
export CROSSREF_MIN_INTERVAL_MS="${CROSSREF_MIN_INTERVAL_MS:-1500}"

exec /usr/bin/node server.js