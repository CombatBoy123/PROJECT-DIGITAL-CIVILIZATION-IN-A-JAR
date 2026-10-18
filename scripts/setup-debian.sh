#!/usr/bin/env bash
#
# One-command local setup for Debian-based systems (Kali, Debian, Ubuntu).
#
#   bash scripts/setup-debian.sh            # set everything up, then start the app
#   bash scripts/setup-debian.sh --no-start # set everything up only
#
# Run it from the repository root. It is safe to run again: every step checks what
# already exists. It will:
#   1. install Node.js 22 with nvm (only if Node >= 22.12 is not already available);
#   2. install PostgreSQL with apt (if missing) and start it;
#   3. create the local development role civ/civ and the databases civ_dev, civ_test
#      and civ_e2e (local development credentials only; see .env.example);
#   4. install the project's dependencies with pnpm and create .env from .env.example;
#   5. apply the database migrations;
#   6. start the server and the web app (http://localhost:5173).
#
# sudo is used for apt, systemctl and the postgres system user.
set -euo pipefail

NVM_VERSION="v0.40.1"
NODE_MAJOR=22
START=1
for arg in "$@"; do
  case "$arg" in
    --no-start) START=0 ;;
    *)
      echo "Unknown option: $arg (supported: --no-start)" >&2
      exit 2
      ;;
  esac
done

step() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
fail() {
  printf '\n\033[1;31mSetup stopped: %s\033[0m\n' "$*" >&2
  exit 1
}

[ -f package.json ] && [ -f pnpm-workspace.yaml ] && [ -d apps/server ] ||
  fail "run this script from the repository root (the folder that contains package.json)."
command -v apt-get >/dev/null 2>&1 || fail "this script needs a Debian-based system with apt-get."

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
  as_postgres() { runuser -u postgres -- "$@"; }
else
  command -v sudo >/dev/null 2>&1 || fail "sudo is required (or run the script as root)."
  SUDO="sudo"
  as_postgres() { sudo -u postgres "$@"; }
fi

# --------------------------------------------------------------------------- Node.js
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)'
}

# nvm is not written for `set -eu`, so its calls run with those options relaxed.
nvm_run() {
  set +eu
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  local status=0
  if [ "$#" -gt 0 ]; then
    "$@" || status=$?
  fi
  set -eu
  return "$status"
}

step "Node.js"
nvm_run || true
if node_ok; then
  info "Using Node $(node --version)."
else
  if ! command -v nvm >/dev/null 2>&1; then
    command -v curl >/dev/null 2>&1 || { $SUDO apt-get update && $SUDO apt-get install -y curl; }
    info "Installing nvm ${NVM_VERSION} (Node version manager, into $HOME/.nvm)…"
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash
  fi
  info "Installing Node ${NODE_MAJOR} with nvm…"
  nvm_run nvm install "$NODE_MAJOR" || fail "nvm could not install Node ${NODE_MAJOR}."
  nvm_run nvm use "$NODE_MAJOR" >/dev/null || fail "nvm could not activate Node ${NODE_MAJOR}."
  node_ok || fail "Node ${NODE_MAJOR}.12 or newer could not be activated."
  info "Using Node $(node --version). New terminals load it from ~/.nvm (set up by nvm)."
fi

# --------------------------------------------------------------------------- PostgreSQL
step "PostgreSQL"
if ! command -v pg_lsclusters >/dev/null 2>&1 && ! command -v psql >/dev/null 2>&1; then
  info "Installing PostgreSQL with apt…"
  $SUDO apt-get update
  $SUDO apt-get install -y postgresql
fi
# Kali does not start services automatically. Containers and WSL may lack systemd.
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  $SUDO systemctl enable --now postgresql >/dev/null 2>&1 || $SUDO systemctl start postgresql
else
  $SUDO service postgresql start >/dev/null
fi

# The port of the first running cluster (Debian's postgresql-common); 5432 otherwise.
PG_PORT=5432
if command -v pg_lsclusters >/dev/null 2>&1; then
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    port="$(pg_lsclusters --no-header 2>/dev/null | awk '$4 == "online" { print $3; exit }')"
    [ -n "$port" ] && break
    sleep 1
  done
  [ -n "${port:-}" ] || fail "PostgreSQL did not start. Check: $SUDO systemctl status postgresql"
  PG_PORT="$port"
fi
info "PostgreSQL is running on port ${PG_PORT}."

psql_admin() { as_postgres psql -p "$PG_PORT" -v ON_ERROR_STOP=1 -qtAc "$1"; }

if [ "$(psql_admin "SELECT 1 FROM pg_roles WHERE rolname = 'civ'")" != "1" ]; then
  info "Creating the database role civ (password civ, local development only)…"
  psql_admin "CREATE ROLE civ WITH LOGIN PASSWORD 'civ' CREATEDB"
fi
for db in civ_dev civ_test civ_e2e; do
  if [ "$(psql_admin "SELECT 1 FROM pg_database WHERE datname = '${db}'")" != "1" ]; then
    info "Creating database ${db}…"
    psql_admin "CREATE DATABASE ${db} OWNER civ"
  fi
done

# --------------------------------------------------------------------------- Project
step "Project dependencies"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
if ! command -v pnpm >/dev/null 2>&1; then
  # corepack ships with Node 22 and installs the pnpm version pinned in package.json.
  corepack enable 2>/dev/null || $SUDO env "PATH=$PATH" corepack enable
fi
# CI=true: never stop to ask (e.g. before rebuilding node_modules for another Node);
# the lockfile is used exactly as committed.
CI=true pnpm install --frozen-lockfile

if [ ! -f .env ]; then
  cp .env.example .env
  info "Created .env from .env.example."
fi
if [ "$PG_PORT" != "5432" ]; then
  sed -i "s#@localhost:5432/#@localhost:${PG_PORT}/#g" .env
  info "Pointed .env at PostgreSQL port ${PG_PORT}."
fi

step "Database migrations"
pnpm db:migrate

if [ "$START" -eq 0 ]; then
  step "Done"
  info "Start the app with: pnpm dev   (then open http://localhost:5173)"
  exit 0
fi

step "Starting the app"
info "Open http://localhost:5173 in your browser. Press Ctrl+C here to stop."
exec pnpm dev
