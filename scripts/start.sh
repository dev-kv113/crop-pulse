#!/usr/bin/env bash
# Start the whole Crop Analytics stack - database, API and web app - in Docker.
#
#   scripts/start.sh                 -> build if needed, start, wait until it answers
#   WEB_PORT=9090 scripts/start.sh   -> pick the web app's port yourself
#
# LOCAL DEVELOPMENT ONLY. It runs with whatever backend/.env says - out of the
# box that means console OTPs anyone can read. On a server use scripts/deploy.sh.
#
# It finds Docker even when it is not on your PATH (Rancher Desktop puts it in
# ~/.rd/bin), starts Docker Desktop / Rancher Desktop if the daemon is down,
# and moves the web app off 8080 if something else already holds that port.
#
# Stop everything again with:  docker compose stop

set -euo pipefail

cd "$(dirname "$0")/.."

STACK="${STACK:-crop-pulse}"
API_PORT="${API_PORT:-8010}"

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------- docker ---
for dir in "$HOME/.rd/bin" "$HOME/.docker/bin" /usr/local/bin /opt/homebrew/bin \
           "/Applications/Docker.app/Contents/Resources/bin"; do
  [[ -x "$dir/docker" ]] && PATH="$PATH:$dir"
done
command -v docker >/dev/null || fail "Docker is not installed (looked on PATH and in ~/.rd/bin)."

if ! docker info >/dev/null 2>&1; then
  if [[ "$(uname)" == "Darwin" ]]; then
    if [[ -d "/Applications/Rancher Desktop.app" ]]; then
      say "Starting Rancher Desktop..."
      open -a "Rancher Desktop"
    elif [[ -d "/Applications/Docker.app" ]]; then
      say "Starting Docker Desktop..."
      open -a Docker
    fi
  fi
  say "Waiting for the Docker daemon (this can take a couple of minutes)..."
  for _ in $(seq 1 90); do
    docker info >/dev/null 2>&1 && break
    sleep 2
  done
  docker info >/dev/null 2>&1 || fail "Docker did not come up. Start it by hand and re-run."
fi

# ---------------------------------------------------------- settings ---
if [[ ! -f backend/.env ]]; then
  say "No backend/.env - copying backend/.env.example"
  cp backend/.env.example backend/.env
fi

port_busy() {
  if command -v lsof >/dev/null; then
    lsof -iTCP:"$1" -sTCP:LISTEN -P >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
  fi
}

if [[ -z "${WEB_PORT:-}" ]]; then
  # Already running? Keep its port, or the check below would see our own
  # container holding it and move us somewhere else on every run.
  existing="$(docker port "$STACK-web" 80/tcp 2>/dev/null | head -n1 | sed 's/.*://')" || true
  if [[ -n "$existing" ]]; then
    WEB_PORT="$existing"
  else
    WEB_PORT=8080
    while port_busy "$WEB_PORT"; do WEB_PORT=$((WEB_PORT + 1)); done
    [[ "$WEB_PORT" != 8080 ]] && say "Port 8080 is taken - using $WEB_PORT for the web app"
  fi
fi
export WEB_PORT

# ------------------------------------------------------------- start ---
say "Building and starting containers..."
docker compose up -d --build

wait_for() {  # url, label
  for _ in $(seq 1 60); do
    curl -sf -o /dev/null "$1" && return 0
    sleep 2
  done
  fail "$2 did not respond at $1. See: docker compose logs"
}

say "Waiting for the API..."
wait_for "http://localhost:$API_PORT/health" "The API"
say "Waiting for the web app..."
wait_for "http://localhost:$WEB_PORT/" "The web app"

cat <<EOF

  Crop Analytics is running.

    Web app   http://localhost:$WEB_PORT
    API       http://localhost:$API_PORT      (docs: /docs)

  Admin sign-in uses the number in ADMIN_PHONES (backend/.env); with
  SMS_PROVIDER=console the code is shown on screen.

  Logs:  docker compose logs -f
  Stop:  docker compose stop

EOF
