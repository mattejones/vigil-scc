#!/usr/bin/env bash
# Start Vigil — API/MCP server and web UI — with one command.
#
#   scripts/vigil.sh [dev|prod] [--open] [--no-install]
#
#   dev   (default)  server with auto-reload + Vite UI on :5173
#   prod             build server and UI, serve everything from the server port
#   --open           open the UI in your browser once it is up
#   --no-install     skip the dependency check
#
# Ctrl+C stops everything. Ports come from .env (PORT, MCP_PORT); PORT, MCP_PORT
# and UI_PORT set in the environment take precedence.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE=dev
OPEN=0
INSTALL=1
UI_PORT=${UI_PORT:-5173}

for arg in "$@"; do
  case "$arg" in
    dev|prod)     MODE=$arg ;;
    --open)       OPEN=1 ;;
    --no-install) INSTALL=0 ;;
    -h|--help)    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            echo "Unknown argument: $arg (see --help)" >&2; exit 2 ;;
  esac
done

# ─── Output helpers ───────────────────────────────────────────────────────────

if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_MAGENTA=$'\033[35m'
else
  C_RESET=''; C_DIM=''; C_BOLD=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_MAGENTA=''
fi

say()  { printf '%s▸%s %s\n' "$C_BLUE" "$C_RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
die()  { printf '%s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

# Prefix each line of a service's output with its name.
prefix() {
  local label=$1 color=$2 line
  while IFS= read -r line; do
    printf '%s%-4s%s %s\n' "$color" "$label" "$C_RESET" "$line"
  done
}

# ─── Environment ──────────────────────────────────────────────────────────────

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# Non-interactive WSL shells often only see the distro's (old) node; use nvm's if needed.
ensure_node() {
  if [ "$(node_major)" -lt 20 ]; then
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    if [ -s "$NVM_DIR/nvm.sh" ]; then
      # shellcheck disable=SC1091
      set +u; . "$NVM_DIR/nvm.sh"; nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || true; set -u
    fi
  fi
  [ "$(node_major)" -ge 20 ] || die "Node.js 20+ is required (found: $(node --version 2>/dev/null || echo none)). Install it with nvm."
  say "Node $(node --version)"
}

# Install when node_modules is missing or older than the lockfile.
ensure_deps() {
  local dir
  for dir in . client; do
    if [ ! -d "$dir/node_modules" ] || [ "$dir/package-lock.json" -nt "$dir/node_modules/.package-lock.json" ]; then
      say "Installing dependencies in ${dir/#./root}…"
      (cd "$dir" && npm install --no-audit --no-fund)
    fi
  done
}

ensure_env() {
  if [ ! -f .env ]; then
    cp .env.example .env
    warn "Created .env from .env.example — review it when you get a chance."
  fi
}

env_value() {
  local value
  value=$(grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"' \r' || true)
  echo "${value:-$2}"
}

port_in_use() { ss -Hltn "sport = :$1" 2>/dev/null | grep -q .; }

check_ports() {
  local port busy=0
  for port in "$@"; do
    if port_in_use "$port"; then
      warn "Port $port is already in use:"
      ss -Hltnp "sport = :$port" 2>/dev/null | sed 's/^/    /'
      busy=1
    fi
  done
  [ "$busy" = 0 ] || die "Stop whatever is using those ports (another Vigil instance?) and try again."
}

wait_for_port() {
  local port=$1 tries=${2:-120}
  while [ "$tries" -gt 0 ]; do
    (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null && return 0
    sleep 0.5; tries=$((tries - 1))
  done
  return 1
}

open_browser() {
  local url=$1
  if command -v wslview >/dev/null 2>&1; then
    wslview "$url" >/dev/null 2>&1 &
  elif [ -x /mnt/c/Windows/System32/cmd.exe ]; then
    (cd /mnt/c && /mnt/c/Windows/System32/cmd.exe /c start "" "$url" >/dev/null 2>&1) &
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 &
  fi
}

# ─── Process supervision ──────────────────────────────────────────────────────

STATE_DIR=$(mktemp -d)
SERVICES=()   # names
WATCHERS=()   # pids of the output pipelines
ANNOUNCER=''

# Runs inside each service's session: starts the service and stops the whole
# group if this script disappears without cleaning up (SIGKILL, closed window).
SERVICE_WRAPPER='
  supervisor=$1; shift
  "$@" & child=$!
  while kill -0 "$child" 2>/dev/null; do
    kill -0 "$supervisor" 2>/dev/null || { kill -TERM -- "-$$" 2>/dev/null; exit 1; }
    sleep 1
  done
  wait "$child"
'

# Run a service in its own session so the whole tree (npm → nodemon → tsx → node)
# can be stopped as one process group.
start_service() {
  local name=$1 color=$2; shift 2
  { setsid bash -c "$SERVICE_WRAPPER" "vigil-$name" "$$" "$@" 2>&1 < /dev/null & echo $! > "$STATE_DIR/$name.pid"; wait $!; } \
    | prefix "$name" "$color" &
  SERVICES+=("$name")
  WATCHERS+=($!)
}

stop_services() {
  local name pgid pids=() deadline
  for name in "${SERVICES[@]}"; do
    [ -f "$STATE_DIR/$name.pid" ] || continue
    pgid=$(cat "$STATE_DIR/$name.pid")
    kill -TERM -- "-$pgid" 2>/dev/null && pids+=("$pgid")
  done

  deadline=$((SECONDS + 8))
  for pgid in "${pids[@]}"; do
    while kill -0 -- "-$pgid" 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.2; done
    kill -KILL -- "-$pgid" 2>/dev/null || true
  done
}

CLEANED=0
cleanup() {
  [ "$CLEANED" = 1 ] && return
  CLEANED=1
  trap - INT TERM HUP
  [ -n "$ANNOUNCER" ] && kill "$ANNOUNCER" 2>/dev/null
  if [ "${#SERVICES[@]}" -gt 0 ]; then
    printf '\n'
    say "Stopping Vigil…"
    stop_services
    wait 2>/dev/null || true
    say "Stopped."
  fi
  rm -rf "$STATE_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

# ─── Main ─────────────────────────────────────────────────────────────────────

printf '%s%sVIGIL%s %s— %s mode%s\n' "$C_BOLD" "$C_YELLOW" "$C_RESET" "$C_DIM" "$MODE" "$C_RESET"

ensure_node
[ "$INSTALL" = 1 ] && ensure_deps
ensure_env

API_PORT=${PORT:-$(env_value PORT 3000)}
MCP_PORT=${MCP_PORT:-$(env_value MCP_PORT 3001)}
export PORT=$API_PORT MCP_PORT

if [ "$MODE" = dev ]; then
  check_ports "$API_PORT" "$MCP_PORT" "$UI_PORT"
  UI_URL="http://localhost:$UI_PORT"

  # File-change events don't reach WSL for Windows drives (/mnt/*); poll there instead.
  WATCH_ARGS=()
  case "$ROOT" in /mnt/*) WATCH_ARGS=(-- --legacy-watch) ;; esac

  start_service api "$C_MAGENTA" npm run dev "${WATCH_ARGS[@]}"
  start_service ui  "$C_GREEN"   npm --prefix client run dev -- --port "$UI_PORT" --strictPort
  READY_PORTS=("$API_PORT" "$MCP_PORT" "$UI_PORT")
else
  check_ports "$API_PORT" "$MCP_PORT"
  UI_URL="http://localhost:$API_PORT"

  say "Building server…"
  npm run build
  say "Building UI…"
  npm --prefix client run build

  start_service api "$C_MAGENTA" env NODE_ENV=production node dist/index.js
  READY_PORTS=("$API_PORT" "$MCP_PORT")
fi

# Announce once everything is listening.
(
  for port in "${READY_PORTS[@]}"; do
    wait_for_port "$port" || { warn "Port $port did not come up — check the output above."; exit 0; }
  done
  printf '\n%s✓ Vigil is up%s\n' "$C_GREEN$C_BOLD" "$C_RESET"
  printf '    Web UI  %s\n' "$UI_URL"
  printf '    API     http://localhost:%s/api\n' "$API_PORT"
  printf '    MCP     http://localhost:%s/mcp\n' "$MCP_PORT"
  printf '  %sCtrl+C to stop%s\n\n' "$C_DIM" "$C_RESET"
  [ "$OPEN" = 1 ] && open_browser "$UI_URL"
  exit 0
) &
ANNOUNCER=$!

# If any service exits, take the rest down with it.
set +e
wait -n "${WATCHERS[@]}"
warn "A service exited — shutting down."
exit 1
