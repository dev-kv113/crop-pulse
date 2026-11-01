#!/usr/bin/env bash
# Deploy Crop Analytics - database, API and web app - on one EC2 instance.
#
# Run it ON the server, from the repository checkout, as your normal user
# (ec2-user / ubuntu); it calls sudo where it needs to.
#
#   scripts/deploy.sh --setup app.example.com you@example.com
#       Once per server. Installs Docker, nginx and certbot, gets the HTTPS
#       certificate for the domain, and writes starting .env files with
#       generated secrets. Safe to re-run. Leave out the email to do
#       everything except the certificate (e.g. while DNS is not ready).
#
#   scripts/deploy.sh
#       Every release. Pulls, checks the settings are safe, builds the new
#       images, backs up the database, restarts, and verifies end to end.
#       If the new version does not come up healthy, it puts the previous
#       images back.
#
#   scripts/deploy.sh --no-pull            deploy exactly what is checked out
#   scripts/deploy.sh --allow-console-sms  before SMS (DLT) is approved: permit
#                                          SMS_PROVIDER=console. Never with farmers.
#
#   internet -> host nginx :443 -> web container :8080 -> /api/ -> api -> db
#
# See docs/DEPLOY.md for the whole walkthrough.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMPOSE_ENV="$ROOT/.env"
APP_ENV="$ROOT/backend/.env"
NGINX_CONF=/etc/nginx/conf.d/crop-pulse.conf
MAINTENANCE_DIR=/usr/share/nginx/crop-pulse
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
BACKUPS_KEPT=20

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

# Last `KEY=value` in a dotenv file, without surrounding quotes. Empty if absent.
env_get() {
  [[ -f "$1" ]] || return 0
  { grep -E "^[[:space:]]*$2=" "$1" || true; } | tail -n1 | cut -d= -f2- \
    | sed -E 's/^[[:space:]]*//; s/[[:space:]]*$//; s/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/'
}

# Set KEY=value in a dotenv file: replace the existing line, or append one.
env_set() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" '
    $0 ~ "^[[:space:]]*" k "=" { if (!done) print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" >"$tmp"
  cat "$tmp" >"$file" && rm -f "$tmp"
}

random_secret() { python3 -c 'import secrets; print(secrets.token_urlsafe(48))'; }

# ======================================================================
#  --setup: once per server
# ======================================================================

install_packages() {
  if command -v dnf >/dev/null; then
    # Amazon Linux 2023
    sudo dnf install -y docker git nginx python3
    if ! command -v certbot >/dev/null; then
      sudo dnf install -y certbot python3-certbot-nginx 2>/dev/null || install_certbot_pip
    fi
  elif command -v apt-get >/dev/null; then
    # Ubuntu / Debian
    sudo apt-get update -y
    sudo apt-get install -y git nginx python3 certbot python3-certbot-nginx
    # Leave an existing Docker alone: Ubuntu's docker.io conflicts with Docker's
    # own docker-ce packages, which many images and guides install instead.
    if ! command -v docker >/dev/null; then
      sudo apt-get install -y docker.io
      sudo apt-get install -y docker-compose-v2 docker-buildx 2>/dev/null || true
    fi
  else
    fail "Unsupported OS: need dnf (Amazon Linux) or apt-get (Ubuntu)."
  fi
}

# certbot's own recommended install when the distribution does not package it.
install_certbot_pip() {
  say "certbot is not packaged here; installing it into /opt/certbot"
  sudo dnf install -y augeas-libs python3-pip
  sudo python3 -m venv /opt/certbot
  sudo /opt/certbot/bin/pip install --quiet --upgrade pip certbot certbot-nginx
  sudo ln -sf /opt/certbot/bin/certbot /usr/bin/certbot
}

# Amazon Linux's docker package ships without compose and buildx.
install_docker_plugins() {
  local dir=/usr/local/lib/docker/cli-plugins arch
  sudo mkdir -p "$dir"
  if ! sudo docker compose version >/dev/null 2>&1; then
    say "Installing the docker compose plugin"
    sudo curl -fsSL -o "$dir/docker-compose" \
      "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)"
    sudo chmod +x "$dir/docker-compose"
  fi
  if ! sudo docker buildx version >/dev/null 2>&1; then
    say "Installing the docker buildx plugin"
    case "$(uname -m)" in
      x86_64)  arch=amd64 ;;
      aarch64) arch=arm64 ;;
      *) fail "Unsupported CPU: $(uname -m)" ;;
    esac
    local version
    version="$(curl -fsSL https://api.github.com/repos/docker/buildx/releases/latest \
      | python3 -c 'import sys,json; print(json.load(sys.stdin)["tag_name"])')"
    sudo curl -fsSL -o "$dir/docker-buildx" \
      "https://github.com/docker/buildx/releases/download/$version/buildx-$version.linux-$arch"
    sudo chmod +x "$dir/docker-buildx"
  fi
}

# Let's Encrypt refuses (and rate-limits) a domain that does not point here yet,
# so check first and say so plainly.
# Works for IPv4 (A record), IPv6 (AAAA record) or both - EC2 instances can be
# IPv6-only, and Let's Encrypt validates over either.
check_dns() {
  local domain="$1" v4 v6 a aaaa ip
  # A public IPv4 sits behind NAT, so ask from outside. Public IPv6 addresses
  # are on the interface itself.
  v4="$(curl -4 -fsS --max-time 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]')" || v4=""
  v6="$(ip -6 addr show scope global 2>/dev/null | awk '/inet6/ {sub(/\/.*/, "", $2); print $2}')" || v6=""
  a="$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u)" || a=""
  aaaa="$(getent ahostsv6 "$domain" 2>/dev/null | awk '{print $1}' | grep ':' | sort -u)" || aaaa=""

  [[ -n "$a$aaaa" ]] || fail "$domain does not resolve yet. Add an ${v4:+A record -> $v4}${v4:+${v6:+ and an }}${v6:+AAAA record -> $(head -n1 <<<"$v6")}, wait for it to spread, and re-run."

  # Every address the domain advertises must be this server, or Let's Encrypt
  # may validate against the wrong machine.
  for ip in $a; do
    [[ "$ip" == "$v4" ]] || fail "$domain has an A record $ip, but this server's IPv4 is ${v4:-none}. Fix or remove it and re-run."
  done
  for ip in $aaaa; do
    grep -qxF "$ip" <<<"$v6" || fail "$domain has an AAAA record $ip, which is not this server ($(tr '\n' ' ' <<<"$v6")). Fix it and re-run."
  done
  if [[ -z "$v4" ]]; then
    warn "This server has no public IPv4 address. Visitors on IPv4-only networks cannot reach it."
  fi
}

write_env_files() {
  local domain="$1"

  # Fill in whatever is missing, so a .env brought over from elsewhere (e.g. one
  # holding only SECRETS_DIR) is completed rather than skipped.
  [[ -f "$COMPOSE_ENV" ]] || echo "# Docker Compose settings for this server. Git-ignored; completed by deploy.sh --setup." >"$COMPOSE_ENV"
  [[ -n "$(env_get "$COMPOSE_ENV" STACK)" ]]    || env_set "$COMPOSE_ENV" STACK crop-prod
  [[ -n "$(env_get "$COMPOSE_ENV" API_PORT)" ]] || env_set "$COMPOSE_ENV" API_PORT 8010
  [[ -n "$(env_get "$COMPOSE_ENV" WEB_PORT)" ]] || env_set "$COMPOSE_ENV" WEB_PORT 8080
  local pg
  pg="$(env_get "$COMPOSE_ENV" POSTGRES_PASSWORD)"
  if [[ -z "$pg" || "$pg" == "croppulse" ]]; then
    say "Generating a database password in $COMPOSE_ENV"
    env_set "$COMPOSE_ENV" POSTGRES_PASSWORD "$(random_secret)"
  fi
  env_set "$COMPOSE_ENV" COMPOSE_FILE "docker-compose.yml:docker-compose.prod.yml"
  env_set "$COMPOSE_ENV" APP_DOMAIN "$domain"
  if [[ -z "$(env_get "$COMPOSE_ENV" SECRETS_DIR)" ]]; then
    # Real secrets (the MSG91 key) live outside the repository, one file each.
    mkdir -p "$HOME/crop-pulse-secrets"
    chmod 700 "$HOME/crop-pulse-secrets"
    env_set "$COMPOSE_ENV" SECRETS_DIR "$HOME/crop-pulse-secrets"
  fi
  chmod 600 "$COMPOSE_ENV"

  if [[ ! -f "$APP_ENV" ]]; then
    say "Writing $APP_ENV with a generated JWT secret"
    cp backend/.env.example "$APP_ENV"
    env_set "$APP_ENV" JWT_SECRET "$(random_secret)"
    env_set "$APP_ENV" UPLOAD_DIR /data/uploads
    # The app and its API share one origin, so the API needs no CORS allowances
    # beyond the site itself.
    env_set "$APP_ENV" CORS_ORIGINS "https://$domain"
    env_set "$APP_ENV" CORS_ORIGIN_REGEX ""
    chmod 600 "$APP_ENV"
  fi
}

# A 2 GB instance has no swap out of the box. The running stack fits in RAM
# (see docker-compose.prod.yml), but an image build on top of it may not, and
# without swap the kernel's answer is to kill something - often Postgres.
ensure_swap() {
  if [[ -n "$(swapon --show --noheadings 2>/dev/null)" ]]; then
    return 0
  fi
  say "Adding a 2 GB swap file"
  sudo fallocate -l 2G /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  # Use swap as a safety net for build spikes, not as everyday memory.
  echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/90-crop-pulse-swap.conf >/dev/null
  sudo sysctl -q -p /etc/sysctl.d/90-crop-pulse-swap.conf
}

# An IPv6-only instance (e.g. Lightsail's IPv6-only bundles) has no IPv4 route
# out, and Docker gives containers IPv4 only by default - so image builds cannot
# reach npm or PyPI, and the API cannot reach MSG91. Give Docker's default
# network IPv6 (Docker 27+ routes it out through the host), and make sure the
# host keeps its own IPv6 default route once Docker turns forwarding on.
ensure_docker_ipv6() {
  if curl -4 -fsS --max-time 5 -o /dev/null https://checkip.amazonaws.com 2>/dev/null; then
    return 0   # the host has IPv4; containers are fine as they are
  fi
  say "IPv6-only host: enabling IPv6 for Docker"

  # Router advertisements are this host's only source of a default route, and
  # the kernel ignores them once forwarding is on. systemd-networkd handles them
  # itself; pin that explicitly so a reboot or upgrade cannot change it.
  local iface netfile
  iface="$(ip -6 route show default | awk '{print $5; exit}')"
  netfile="$(networkctl status "$iface" 2>/dev/null | awk -F': ' '/Network File/ {print $2}' | xargs)" || netfile=""
  if [[ -n "$netfile" && "$netfile" != "n/a" ]]; then
    sudo mkdir -p "/etc/systemd/network/$(basename "$netfile").d"
    printf '[Network]\n# Docker enables IPv6 forwarding. Keep learning the default route from\n# router advertisements anyway: on an IPv6-only host it is the only route.\nIPv6AcceptRA=yes\n' \
      | sudo tee "/etc/systemd/network/$(basename "$netfile").d/90-keep-ipv6-ra.conf" >/dev/null
    sudo networkctl reload
  else
    # Not networkd: tell the kernel to accept RAs even while forwarding.
    echo "net.ipv6.conf.$iface.accept_ra=2" | sudo tee /etc/sysctl.d/90-crop-pulse-ipv6-ra.conf >/dev/null
    sudo sysctl -q -p /etc/sysctl.d/90-crop-pulse-ipv6-ra.conf
  fi

  # Merge into any existing daemon.json rather than overwrite it.
  sudo python3 - <<'PY_DAEMON'
import json, os
path = "/etc/docker/daemon.json"
cfg = json.load(open(path)) if os.path.exists(path) and os.path.getsize(path) else {}
cfg.setdefault("ipv6", True)
cfg.setdefault("fixed-cidr-v6", "fd00:d0c:e12::/64")
json.dump(cfg, open(path, "w"), indent=2)
PY_DAEMON
  sudo systemctl restart docker
}

setup() {
  local domain="${1:-}" email="${2:-}"
  [[ -n "$domain" ]] || fail "Usage: scripts/deploy.sh --setup <domain> [email for certificate notices]"
  [[ "$(uname)" == "Linux" ]] || fail "--setup is for the Linux server, not this machine."

  ensure_swap

  say "Installing Docker, git, nginx and certbot..."
  install_packages
  sudo systemctl enable --now docker
  install_docker_plugins
  ensure_docker_ipv6
  if ! id -nG | grep -qw docker; then
    sudo usermod -aG docker "$USER"
    NEED_RELOGIN=1
  fi

  say "Configuring nginx for $domain..."
  local web_port
  web_port="$(env_get "$COMPOSE_ENV" WEB_PORT)"; web_port="${web_port:-8080}"
  sudo mkdir -p "$MAINTENANCE_DIR"
  sudo cp frontend/public/maintenance.html "$MAINTENANCE_DIR/"
  sed -e "s/__DOMAIN__/$domain/g" -e "s/__WEB_PORT__/$web_port/g" deploy/nginx-crop-pulse.conf \
    | sudo tee "$NGINX_CONF" >/dev/null
  sudo nginx -t
  sudo systemctl enable --now nginx
  sudo systemctl reload nginx

  # Before the DNS check, so the app can be deployed (and tried over an SSH
  # tunnel) while DNS is still being set up. Re-run --setup for the certificate.
  write_env_files "$domain"

  if [[ -z "$email" ]]; then
    warn "No email given: skipping the HTTPS certificate. Re-run with: scripts/deploy.sh --setup $domain <email>"
  else
    say "Checking DNS for $domain..."
    check_dns "$domain"

    say "Getting the HTTPS certificate..."
    # --keep-until-expiring: on a re-run, reuse the certificate and just
    # re-install it into the freshly written config.
    sudo certbot --nginx -d "$domain" -m "$email" --agree-tos --non-interactive \
      --redirect --keep-until-expiring
    # Renewal: a systemd timer on both distributions, under different names.
    sudo systemctl enable --now certbot-renew.timer 2>/dev/null \
      || sudo systemctl enable --now certbot.timer 2>/dev/null \
      || { echo "0 3 * * * root certbot renew --quiet --deploy-hook 'systemctl reload nginx'" \
             | sudo tee /etc/cron.d/certbot-renew >/dev/null; }
  fi

  cat <<EOF

  Server ready. Before the first deploy:

$( [[ "${NEED_RELOGIN:-0}" == 1 ]] && echo "    0. Log out and back in, so your user can run docker without sudo." )
    1. Edit backend/.env:
         ADMIN_PHONES   the admin mobile numbers
         SMS_PROVIDER   msg91 once DLT is approved (until then deploy with
                        --allow-console-sms, and give no farmer the link)
    2. Put the MSG91 key in $(env_get "$COMPOSE_ENV" SECRETS_DIR)/msg91_auth_key
       (just the key, nothing else in the file).
    3. Run: scripts/deploy.sh

  https://$domain shows a maintenance page until then.

EOF
}

# ======================================================================
#  deploy: every release
# ======================================================================

if [[ "${1:-}" == "--setup" ]]; then
  setup "${2:-}" "${3:-}"
  exit 0
fi

PULL=1
ALLOW_CONSOLE_SMS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-pull)           PULL=0 ;;
    --allow-console-sms) ALLOW_CONSOLE_SMS=1 ;;
    -h|--help)           usage 0 ;;
    *) echo "unknown option: $1" >&2; usage 1 ;;
  esac
  shift
done

# One deploy at a time: two at once would race on the build and the backup.
LOCK="$ROOT/.deploy.lock"
mkdir "$LOCK" 2>/dev/null || fail "Another deploy is running (remove $LOCK if it is stale)."
trap 'rmdir "$LOCK"' EXIT

command -v docker >/dev/null || fail "docker is not installed. Run: scripts/deploy.sh --setup <domain> <email>"
docker info >/dev/null 2>&1   || fail "Cannot talk to Docker. Is it running, and is $USER in the docker group (log out and in after --setup)?"
docker compose version >/dev/null 2>&1 || fail "docker compose is missing. Run --setup."

# ---------------------------------------------------------------- code ---
if [[ "$PULL" == 1 ]]; then
  [[ -z "$(git status --porcelain --untracked-files=no)" ]] \
    || fail "The checkout has local changes. Commit or discard them first:
$(git status --short --untracked-files=no)"
  say "Pulling $(git rev-parse --abbrev-ref HEAD)..."
  git pull --ff-only
fi
COMMIT="$(git rev-parse --short HEAD)"
say "Deploying $COMMIT: $(git log -1 --format=%s)"

# ------------------------------------------------------------ settings ---
[[ -f "$COMPOSE_ENV" ]] || fail "Missing $COMPOSE_ENV. Run: scripts/deploy.sh --setup <domain> <email>"
[[ -f "$APP_ENV" ]]     || fail "Missing $APP_ENV. Run: scripts/deploy.sh --setup <domain> <email>"

STACK="$(env_get "$COMPOSE_ENV" STACK)";       STACK="${STACK:-crop-pulse}"
API_PORT="$(env_get "$COMPOSE_ENV" API_PORT)"; API_PORT="${API_PORT:-8010}"
WEB_PORT="$(env_get "$COMPOSE_ENV" WEB_PORT)"; WEB_PORT="${WEB_PORT:-8080}"
DOMAIN="$(env_get "$COMPOSE_ENV" APP_DOMAIN)"
SECRETS_DIR="$(env_get "$COMPOSE_ENV" SECRETS_DIR)"

problems=()

[[ "$(env_get "$COMPOSE_ENV" COMPOSE_FILE)" == *docker-compose.prod.yml* ]] \
  || problems+=("COMPOSE_FILE in $COMPOSE_ENV must include docker-compose.prod.yml (--setup writes it).")

pg_password="$(env_get "$COMPOSE_ENV" POSTGRES_PASSWORD)"
[[ -n "$pg_password" && "$pg_password" != "croppulse" ]] \
  || problems+=("Set a real POSTGRES_PASSWORD in $COMPOSE_ENV (it is the default 'croppulse').")

# The value the API will actually see: backend/.env wins, then the secrets dir.
secret_from_dir() {
  [[ -n "$SECRETS_DIR" ]] || return 0
  local f
  for f in "$SECRETS_DIR/$1" "$SECRETS_DIR/$(tr '[:lower:]' '[:upper:]' <<<"$1")"; do
    [[ -f "$f" ]] && { tr -d '\r\n' <"$f"; return 0; }
  done
}
jwt="$(env_get "$APP_ENV" JWT_SECRET)"; [[ -n "$jwt" ]] || jwt="$(secret_from_dir jwt_secret)"
if [[ -z "$jwt" || "$jwt" == dev-secret* || "$jwt" == *PASTE* || "$jwt" == *change* || ${#jwt} -lt 32 ]]; then
  problems+=("JWT_SECRET is missing, a placeholder, or shorter than 32 characters. Generate one: python3 -c \"import secrets; print(secrets.token_urlsafe(48))\"")
fi

sms="$(env_get "$APP_ENV" SMS_PROVIDER)"; sms="${sms:-console}"
if [[ "$sms" == "console" ]]; then
  if [[ "$ALLOW_CONSOLE_SMS" == 1 ]]; then
    warn "SMS_PROVIDER=console: login codes are shown to whoever asks, admin numbers included. Do not give farmers the link."
  else
    problems+=("SMS_PROVIDER=console returns the login code to anyone who asks - including for admin numbers. Set SMS_PROVIDER=msg91, or pass --allow-console-sms while you are still testing with your own team.")
  fi
fi

[[ "$(env_get "$APP_ENV" ADMIN_PHONES)" != *9999999999* ]] \
  || warn "ADMIN_PHONES still contains the example number +919999999999."
[[ -z "$(env_get "$APP_ENV" CORS_ORIGIN_REGEX)" ]] \
  || warn "CORS_ORIGIN_REGEX is set; it is for development (it allows any local-network origin). Leave it empty here."
[[ -n "$DOMAIN" ]] \
  || warn "APP_DOMAIN is not set in $COMPOSE_ENV, so the public HTTPS check is skipped. Has --setup been run?"

if (( ${#problems[@]} )); then
  printf '\033[31mNot deploying - fix these first:\033[0m\n' >&2
  printf '  - %s\n' "${problems[@]}" >&2
  exit 1
fi

# Ask compose itself what it would publish, so a typo in the override is
# caught too. Only loopback is acceptable; nginx is the one public door.
exposure_py='
import sys, json
for name, svc in json.load(sys.stdin)["services"].items():
    for p in svc.get("ports") or []:
        host = p.get("host_ip") or "0.0.0.0"
        if name == "db" or host not in ("127.0.0.1", "::1"):
            print(name, "on", host + ":" + str(p.get("published")))
'
exposure="$(docker compose config --format json | python3 -c "$exposure_py")"
[[ -z "$exposure" ]] || fail "These would be reachable from outside the server, bypassing nginx:
$exposure
Check docker-compose.prod.yml and COMPOSE_FILE in $COMPOSE_ENV."

# ---------------------------------------------------------------- build ---
# Keep the running images as :previous, so a failed release can be put back
# without a rebuild. Compose names them <stack>-<service>:latest.
for svc in api web; do
  docker image inspect "$STACK-$svc:latest" >/dev/null 2>&1 \
    && docker image tag "$STACK-$svc:latest" "$STACK-$svc:previous"
done

# Before touching anything that is running, so a broken build changes nothing.
say "Building images..."
docker compose build api web

# --------------------------------------------------------------- backup ---
BACKUP=""
if [[ "$(docker inspect -f '{{.State.Running}}' "$STACK-db" 2>/dev/null)" == "true" ]]; then
  mkdir -p "$BACKUP_DIR"
  BACKUP="$BACKUP_DIR/predeploy-$STACK-$(date +%Y%m%d-%H%M%S)-$COMMIT.sql.gz"
  say "Backing up the database to $BACKUP..."
  pg_user="$(env_get "$COMPOSE_ENV" POSTGRES_USER)"; pg_user="${pg_user:-croppulse}"
  pg_db="$(env_get "$COMPOSE_ENV" POSTGRES_DB)";     pg_db="${pg_db:-croppulse}"
  docker exec "$STACK-db" pg_dump -U "$pg_user" "$pg_db" | gzip >"$BACKUP" \
    || { rm -f "$BACKUP"; fail "Backup failed; not deploying."; }
  [[ -s "$BACKUP" ]] || fail "Backup came out empty; not deploying."
  # Keep the newest few; the nightly backups (docs/DEPLOY.md) are the archive.
  ls -1t "$BACKUP_DIR"/predeploy-"$STACK"-*.sql.gz 2>/dev/null | tail -n +$((BACKUPS_KEPT + 1)) | xargs -r rm -f
else
  warn "No running database ($STACK-db) - first deploy, nothing to back up."
fi

# --------------------------------------------------------------- deploy ---
say "Starting the new version..."
docker compose up -d --remove-orphans db api web

# Three checks, each one hop further out: the API itself, the web container,
# and the web container's pass-through to the API. A 401 from an admin
# endpoint proves the request reached FastAPI; nginx failing would be a 502.
verify() {
  local i
  for i in $(seq 1 60); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$API_PORT/health" \
       && curl -fsS -o /dev/null "http://127.0.0.1:$WEB_PORT/" \
       && [[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/api/admin/units")" =~ ^40[13]$ ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

say "Waiting for the API, the web app, and the route between them..."
if ! verify; then
  docker compose logs --tail 60 api web >&2 || true
  if docker image inspect "$STACK-api:previous" >/dev/null 2>&1; then
    warn "The new version is not healthy. Putting the previous images back..."
    for svc in api web; do
      docker image inspect "$STACK-$svc:previous" >/dev/null 2>&1 \
        && docker image tag "$STACK-$svc:previous" "$STACK-$svc:latest"
    done
    docker compose up -d --no-build api web
    if verify; then
      fail "Deploy of $COMMIT failed and was rolled back; the previous version is running.
  The log tail above shows why. Database backup from before the attempt: ${BACKUP:-none}
  (Migrations from the failed version may have run; restore the backup if the old version misbehaves.)"
    fi
    fail "Rolled back, but the previous version is not healthy either. See: docker compose logs api web
  Database backup from before this deploy: ${BACKUP:-none}"
  fi
  fail "The first deploy did not come up healthy and there is nothing to roll back to. See: docker compose logs api web"
fi

# ---------------------------------------------------------------- public ---
public="skipped (APP_DOMAIN not set)"
if [[ -n "$DOMAIN" ]]; then
  if curl -fsS -o /dev/null --max-time 10 "https://$DOMAIN/"; then
    public="https://$DOMAIN  ok"
  else
    public="https://$DOMAIN  NOT REACHABLE"
    warn "The app is running but https://$DOMAIN did not answer from this server. Check nginx (sudo nginx -t; sudo systemctl status nginx), the certificate, and that the security group allows 80 and 443."
  fi
fi

# ----------------------------------------------------------------- tidy ---
docker image prune -f >/dev/null

cat <<EOF

  Deployed $COMMIT to $STACK.
    Public   $public
    API      http://127.0.0.1:$API_PORT/health  ok
    Web      http://127.0.0.1:$WEB_PORT/  ok
    Backup   ${BACKUP:-none (first deploy)}

EOF
