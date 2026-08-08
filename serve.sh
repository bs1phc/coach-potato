#!/usr/bin/env bash
# Self-host mode: serve Coach Potato to your other devices.
#
# Unlike run.sh (local dev — loopback only, auto-reload) this binds every
# interface and REFUSES to start without an access token, because anyone who
# can reach the port would otherwise get your Riot API key out of Settings
# plus full write access to the database. See server/auth.py.
#
# Reach it over a private network (Tailscale/WireGuard/LAN). Do not port-
# forward it to the open internet without a TLS terminator in front — the
# token crosses plain HTTP.
set -euo pipefail
cd "$(dirname "$0")"

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8321}"

# The token can also live in .env, next to RIOT_API_KEY.
if [[ -z "${COACH_POTATO_TOKEN:-}" && -f .env ]]; then
  COACH_POTATO_TOKEN="$(sed -n 's/^COACH_POTATO_TOKEN=//p' .env | head -1)"
fi
if [[ -z "${COACH_POTATO_TOKEN:-}" ]]; then
  cat >&2 <<'MSG'
Refusing to start: no COACH_POTATO_TOKEN set.

This mode is reachable from other machines. Without a token, anyone who can
reach the port can read your Riot API key and write to your database.

Generate one:
  python3 -c 'import secrets; print(secrets.token_urlsafe(24))'

Then either export COACH_POTATO_TOKEN=... or add a COACH_POTATO_TOKEN= line
to .env, and re-run.
MSG
  exit 1
fi
export COACH_POTATO_TOKEN

echo "Coach Potato serving on http://${HOST}:${PORT} (token auth on)"
# No --reload: this is a long-running server, not the dev loop.
exec .venv/bin/uvicorn server.app:app --host "$HOST" --port "$PORT"
