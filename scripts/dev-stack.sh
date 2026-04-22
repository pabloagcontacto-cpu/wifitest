#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BACKEND_DIR="$ROOT_DIR/backend/MCP"
FRONTEND_DIR="$ROOT_DIR/frontend"

REDIS_STARTED=0
REDIS_PID=""
WORKER_PID=""
SERVER_PID=""
FRONTEND_PID=""
WORKER_USE_SUDO=0

cleanup() {
  echo
  echo "Parando stack local..."

  if [ -n "$FRONTEND_PID" ] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" 2>/dev/null || true
    wait "$FRONTEND_PID" 2>/dev/null || true
  fi

  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi

  if [ -n "$WORKER_PID" ] && kill -0 "$WORKER_PID" 2>/dev/null; then
    kill "$WORKER_PID" 2>/dev/null || true
    wait "$WORKER_PID" 2>/dev/null || true
  fi

  if [ "$REDIS_STARTED" -eq 1 ] && [ -n "$REDIS_PID" ] && kill -0 "$REDIS_PID" 2>/dev/null; then
    kill "$REDIS_PID" 2>/dev/null || true
    wait "$REDIS_PID" 2>/dev/null || true
  fi
}

trap 'cleanup; exit 0' INT TERM
trap 'cleanup' EXIT

start_redis_if_needed() {
  if command -v redis-cli >/dev/null 2>&1 && redis-cli ping >/dev/null 2>&1; then
    echo "Redis ya estaba levantado."
    return
  fi

  if command -v valkey-cli >/dev/null 2>&1 && valkey-cli ping >/dev/null 2>&1; then
    echo "Valkey ya estaba levantado."
    return
  fi

  if command -v redis-server >/dev/null 2>&1; then
    echo "Arrancando redis-server..."
    redis-server &
    REDIS_PID=$!
    REDIS_STARTED=1
    sleep 1
    return
  fi

  if command -v valkey-server >/dev/null 2>&1; then
    echo "Arrancando valkey-server..."
    valkey-server &
    REDIS_PID=$!
    REDIS_STARTED=1
    sleep 1
    return
  fi

  echo "No se ha encontrado Redis/Valkey instalado y no habia ninguna instancia levantada." >&2
  exit 1
}

ensure_worker_privileges() {
  if [ "$(id -u)" -eq 0 ]; then
    return
  fi

  echo "Solicitando permisos para el worker MCP..."
  sudo -v
  WORKER_USE_SUDO=1
}

run_backend_worker() {
  echo "Arrancando worker MCP..."
  (
    cd "$BACKEND_DIR"
    set -a
    . ./.env
    set +a
    if [ "$WORKER_USE_SUDO" -eq 1 ]; then
      exec sudo -n env \
        PATH="$PATH" \
        REDIS_URL="${REDIS_URL:-}" \
        MCP_WORKER_NAME="${MCP_WORKER_NAME:-worker-1}" \
        ./.venv/bin/python worker.py
    fi

    exec ./.venv/bin/python worker.py
  ) &
  WORKER_PID=$!
}

run_backend_server() {
  echo "Arrancando servidor MCP..."
  (
    cd "$BACKEND_DIR"
    set -a
    . ./.env
    set +a
    exec ./.venv/bin/python server.py
  ) &
  SERVER_PID=$!
}

run_frontend() {
  echo "Arrancando frontend Tauri..."
  (
    cd "$FRONTEND_DIR"
    exec npm run dev:safe
  ) &
  FRONTEND_PID=$!
}

start_redis_if_needed
ensure_worker_privileges
run_backend_worker
run_backend_server
run_frontend

echo
echo "Stack local levantado."
echo "  Backend MCP:  $BACKEND_DIR"
echo "  Frontend:     $FRONTEND_DIR"
echo "Pulsa Ctrl+C para pararlo todo."
echo

wait
